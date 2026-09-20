// The writes a status run performs on the board side, and the backlink writes it
// performs on the tracker side. Pure - the CLI does the IO around these.
import type { LoopsConfig } from "../config.ts";
import type { ItemFile } from "../types.ts";
import { planStatusSync, ticketKey } from "./tracker-plan.ts";
import type { ItemNote, PlannerItem, TicketHold, TicketRef, TicketTransition, UnresolvedTicket } from "./tracker-plan.ts";
import { applyBacklinks } from "./tracker-backlink.ts";
import { resolveItemTickets } from "./tracker-items.ts";
import type { TicketRecord, TrackerAdapter } from "./tracker-adapter.ts";

/** The item text with one dated line appended to its log, or undefined when the item
 * already records that line. Undated matching is what keeps a standing mismatch from
 * writing a fresh line on every run: the fact has not changed, so neither does the item. */
export function appendItemNote(rawText: string, text: string, today: string): string | undefined {
  if (rawText.includes(`: ${text}`)) return undefined;
  const line = `- ${today}: ${text}`;
  const body = rawText.endsWith("\n") ? rawText : `${rawText}\n`;
  return body.includes("\n## Log") ? `${body}${line}\n` : `${body}\n## Log\n${line}\n`;
}

export interface BacklinkWrite {
  ticket: TicketRef;
  /** The tracker's own identifier for the ticket, as the adapter needs it for a write. */
  externalId: string;
  description: string;
}

/** The description updates that make each ticket name the work-streams it serves.
 * Tickets no item links are left alone: their description is a collaborator's text and
 * none of the board's business. */
export function planBacklinks(records: TicketRecord[], slugsByTicket: Map<string, string[]>): BacklinkWrite[] {
  const writes: BacklinkWrite[] = [];
  for (const record of records) {
    const slugs = slugsByTicket.get(ticketKey(record.ref));
    if (!slugs || slugs.length === 0) continue;
    const description = applyBacklinks(record.description, slugs);
    if (description === undefined) continue;
    writes.push({ ticket: record.ref, externalId: record.externalId, description });
  }
  return writes;
}

export interface StatusRunInput {
  items: ItemFile[];
  config: LoopsConfig;
  /** One adapter per configured tracker name. A tracker with no adapter is not synced. */
  adapters: Map<string, TrackerAdapter>;
  /** Item path -> file text, for the items that may earn a note. */
  rawText: Map<string, string>;
  today: string;
  /** False plans and writes nothing, anywhere. The default, because the first writes
   * land on a board collaborators are looking at. */
  apply: boolean;
}

export interface TrackerFailure {
  tracker: string;
  message: string;
}

export interface StatusRunReport {
  transitions: TicketTransition[];
  backlinks: BacklinkWrite[];
  notes: ItemNote[];
  holds: TicketHold[];
  unresolved: UnresolvedTicket[];
  /** Item files to write, empty unless applying. */
  itemWrites: { path: string; rawText: string }[];
  /** Trackers that could not be read or written. Their items are left out of the plan
   * entirely rather than planned against a half-read board. */
  failures: TrackerFailure[];
  applied: boolean;
}

/** One status run: read every referenced ticket, plan against the board, and - only
 * when applying - push the transitions, refresh the backlinks, and prepare the item
 * notes. Adapters are injected, so the rules above are exercised without a network.
 *
 * A tracker that cannot be read fails alone: its items drop out of the plan, the other
 * trackers still sync, and the board is left untouched for that tracker. */
export async function runStatusPhase(input: StatusRunInput): Promise<StatusRunReport> {
  const { items, config, adapters, rawText, today, apply } = input;

  const ticketsByItem = new Map(items.map((item) => [item.slug, resolveItemTickets(item, config)]));
  const idsByTracker = new Map<string, Set<string>>();
  for (const tickets of ticketsByItem.values()) {
    for (const ref of tickets) {
      if (!adapters.has(ref.tracker)) continue;
      const ids = idsByTracker.get(ref.tracker) ?? new Set<string>();
      ids.add(ref.id);
      idsByTracker.set(ref.tracker, ids);
    }
  }

  const failures: TrackerFailure[] = [];
  const records: TicketRecord[] = [];
  for (const [tracker, ids] of [...idsByTracker].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      records.push(...(await adapters.get(tracker)!.fetchTickets([...ids].sort())));
    } catch (cause) {
      failures.push({ tracker, message: (cause as Error).message });
    }
  }
  const failed = new Set(failures.map((failure) => failure.tracker));

  const plannerItems: PlannerItem[] = items.map((item) => ({
    slug: item.slug,
    state: item.state,
    tickets: (ticketsByItem.get(item.slug) ?? []).filter((ref) => adapters.has(ref.tracker) && !failed.has(ref.tracker)),
  }));
  const trackers = Object.fromEntries(
    Object.entries(config.trackers).filter(([name]) => adapters.has(name) && !failed.has(name)),
  );
  const plan = planStatusSync(plannerItems, records, trackers);

  const slugsByTicket = new Map<string, string[]>();
  for (const item of plannerItems) {
    for (const ref of item.tickets) {
      const key = ticketKey(ref);
      slugsByTicket.set(key, [...(slugsByTicket.get(key) ?? []), item.slug]);
    }
  }
  const backlinks = planBacklinks(records, slugsByTicket);

  const report: StatusRunReport = { ...plan, backlinks, itemWrites: [], failures, applied: apply };
  if (!apply) return report;

  const recordsByKey = new Map(records.map((record) => [ticketKey(record.ref), record]));
  for (const transition of plan.transitions) {
    const key = ticketKey(transition.ticket);
    const adapter = adapters.get(transition.ticket.tracker)!;
    try {
      await adapter.setStatus(recordsByKey.get(key)!, transition.to);
    } catch (cause) {
      failures.push({ tracker: transition.ticket.tracker, message: `${key}: ${(cause as Error).message}` });
    }
  }
  for (const backlink of backlinks) {
    const adapter = adapters.get(backlink.ticket.tracker)!;
    try {
      await adapter.setDescription(backlink.externalId, backlink.description);
    } catch (cause) {
      failures.push({ tracker: backlink.ticket.tracker, message: `${ticketKey(backlink.ticket)}: ${(cause as Error).message}` });
    }
  }

  const itemsBySlug = new Map(items.map((item) => [item.slug, item]));
  const pending = new Map<string, string>();
  for (const note of plan.notes) {
    const item = itemsBySlug.get(note.slug);
    if (!item) continue;
    const current = pending.get(item.path) ?? rawText.get(item.path);
    if (current === undefined) continue;
    const next = appendItemNote(current, note.text, today);
    if (next !== undefined) pending.set(item.path, next);
  }
  report.itemWrites = [...pending].map(([path, text]) => ({ path, rawText: text }));
  return report;
}
