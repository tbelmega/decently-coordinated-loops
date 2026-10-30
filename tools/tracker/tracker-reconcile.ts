// Reconcile: every way a linked ticket and its items disagree that the forward-only
// status push will not settle by itself, each with a recommended resolution for both
// sides. Pure. The CLI prints the list; the owner's answer in an attended interview is
// what authorizes a write against a human's change (loops-board → External trackers).
import { BOARD_STATE_LADDER } from "../types.ts";
import type { TicketRecord } from "./tracker-adapter.ts";
import type { TrackerConfig } from "./tracker-config.ts";
import { leastAdvanced, planStatusSync, statusRank, ticketKey } from "./tracker-plan.ts";
import type { PlannerItem, TicketRef } from "./tracker-plan.ts";

export type MismatchKind = "ticket-ahead" | "unranked-status" | "closed-while-active" | "open-while-finished" | "missing";

export interface Mismatch {
  ticket: TicketRef;
  kind: MismatchKind;
  /** Linked items, sorted by slug. */
  items: string[];
  /** What disagrees, in one line. */
  detail: string;
  /** The suggested resolution for both sides, as options for the owner. */
  recommendation: string;
  /** True when the status push already records this disagreement as an item note, so
   * recording it again would only repeat it. */
  notedByPush: boolean;
}

/** Board states before work starts. A ticket linked only to such items - typically one
 * the pull just filed as an idea - is held by the push, so reconcile judges it on its own:
 * past the tracker's unstarted statuses, the ticket claims work the board has not seen. */
const PRE_WORK = new Set(["idea", "spec-filed"]);

const FINISHED = new Set(["accepted", "dropped"]);

/** The furthest board state mapped to a tracker status: what the ticket claims. */
function stateFor(tracker: TrackerConfig, status: string): string | undefined {
  const rank = statusRank(tracker, status);
  return rank === undefined || rank < 0 ? undefined : BOARD_STATE_LADDER[rank];
}

export function planReconcile(
  items: PlannerItem[],
  records: TicketRecord[],
  trackers: Record<string, TrackerConfig>,
): Mismatch[] {
  const plan = planStatusSync(items, records, trackers);
  const byKey = new Map(records.map((record) => [ticketKey(record.ref), record]));
  const itemsByKey = new Map<string, PlannerItem[]>();
  for (const item of items) {
    for (const ref of item.tickets) {
      const key = ticketKey(ref);
      itemsByKey.set(key, [...(itemsByKey.get(key) ?? []), item]);
    }
  }
  const slugsOf = (key: string) => (itemsByKey.get(key) ?? []).map((item) => item.slug).sort();
  const mismatches: Mismatch[] = [];
  const seen = new Set<string>();

  for (const note of plan.notes) {
    const key = ticketKey(note.ticket);
    if (seen.has(`${note.kind}:${key}`)) continue;
    seen.add(`${note.kind}:${key}`);
    const tracker = trackers[note.ticket.tracker]!;
    const record = byKey.get(key)!;
    const linked = itemsByKey.get(key) ?? [];
    const live = linked.filter((item) => item.state !== "dropped" && tracker.statusMap[item.state] !== undefined);
    const target = live.length ? leastAdvanced(tracker, live) : undefined;
    const slugs = slugsOf(key);
    if (note.kind === "ticket-ahead") {
      const claimed = stateFor(tracker, record.status);
      mismatches.push({
        ticket: note.ticket,
        kind: "ticket-ahead",
        items: slugs,
        detail: `ticket is at ${record.status}${record.open === false ? " and closed" : ""}; ${linked.map((item) => `${item.slug} is ${item.state}`).join(", ")}`,
        recommendation: [
          claimed ? `if the work really is that far, move ${slugs.join(", ")} to ${claimed}` : undefined,
          target ? `if the ticket moved by mistake, move the ticket back to ${target}` : undefined,
          "or leave both and keep the note",
        ]
          .filter(Boolean)
          .join("; "),
        notedByPush: true,
      });
    } else {
      mismatches.push({
        ticket: note.ticket,
        kind: "unranked-status",
        items: slugs,
        detail: `ticket is at ${record.status}, which no board state maps to`,
        recommendation: [
          `add "${record.status}" to the statusMap under the board state it means`,
          target ? `or move the ticket to ${target}` : undefined,
          "or leave it",
        ]
          .filter(Boolean)
          .join("; "),
        notedByPush: true,
      });
    }
  }

  for (const unresolved of plan.unresolved) {
    if (unresolved.reason !== "not-in-snapshot") continue;
    mismatches.push({
      ticket: unresolved.ticket,
      kind: "missing",
      items: [...unresolved.items].sort(),
      detail: "ticket is not on the tracker's board (deleted, moved, or never added)",
      recommendation: "add the ticket to the board, or unlink it from the item (tickets field)",
      notedByPush: false,
    });
  }

  // A ticket held because some linked item has not started (typically one the pull just
  // filed as an idea) gets no push note, so reconcile judges the not-started items on
  // their own: a ticket past the tracker's intake statuses claims work they have not seen.
  for (const hold of plan.holds) {
    const key = ticketKey(hold.ticket);
    const tracker = trackers[hold.ticket.tracker]!;
    const record = byKey.get(key);
    const linked = (itemsByKey.get(key) ?? []).filter((item) => item.state !== "dropped");
    const notStarted = linked.filter((item) => PRE_WORK.has(item.state) && tracker.statusMap[item.state] === undefined);
    if (!record || notStarted.length === 0) continue;
    const unstarted = tracker.pull?.unstartedStatuses ?? [];
    if (unstarted.includes(record.status)) continue;
    const claimed = stateFor(tracker, record.status);
    if (!claimed) continue;
    const started = linked.filter((item) => tracker.statusMap[item.state] !== undefined);
    const waiting = notStarted.map((item) => item.slug).sort();
    seen.add(`ticket-ahead:${key}`);
    mismatches.push({
      ticket: hold.ticket,
      kind: "ticket-ahead",
      items: slugsOf(key),
      detail: `ticket is at ${record.status}${record.open === false ? " and closed" : ""}; ${linked.map((item) => `${item.slug} is ${item.state}`).join(", ")}`,
      recommendation: [
        `if work is already under way, move ${waiting.join(", ")} to ${claimed}`,
        started.length
          ? `if not, unlink ${waiting.join(", ")} from the ticket so it follows ${started.map((item) => item.slug).sort().join(", ")}`
          : unstarted[0]
            ? `if not, move the ticket back to ${unstarted[0]}`
            : undefined,
        "or leave both until the item is refined",
      ]
        .filter(Boolean)
        .join("; "),
      notedByPush: false,
    });
  }

  for (const record of [...records].sort((a, b) => ticketKey(a.ref).localeCompare(ticketKey(b.ref)))) {
    if (record.open === undefined) continue;
    const key = ticketKey(record.ref);
    const linked = itemsByKey.get(key) ?? [];
    if (linked.length === 0) continue;
    const finished = linked.every((item) => FINISHED.has(item.state));
    const slugs = slugsOf(key);
    // A closed ticket already reported as ahead of its items is the same disagreement;
    // listing it twice would make the interview ask the same question twice.
    if (!record.open && !finished && !seen.has(`ticket-ahead:${key}`)) {
      mismatches.push({
        ticket: record.ref,
        kind: "closed-while-active",
        items: slugs,
        detail: `ticket is closed; ${linked.map((item) => `${item.slug} is ${item.state}`).join(", ")}`,
        recommendation: `if the work is finished, move ${slugs.join(", ")} to accepted (or dropped); otherwise reopen the ticket`,
        notedByPush: false,
      });
    } else if (record.open && finished) {
      mismatches.push({
        ticket: record.ref,
        kind: "open-while-finished",
        items: slugs,
        detail: `ticket is open; every linked item is accepted or dropped`,
        recommendation: "close the ticket; or, if work remains, file or reopen a work-stream for it",
        notedByPush: false,
      });
    }
  }

  return mismatches.sort((a, b) => ticketKey(a.ticket).localeCompare(ticketKey(b.ticket)) || a.kind.localeCompare(b.kind));
}

/** The dated item lines an unattended run records instead of interviewing: one per
 * linked item and mismatch, so the next attended sync can collect them from the board.
 * Disagreements the status push already notes are left to it. */
export function mismatchNotes(mismatches: Mismatch[]): { slug: string; text: string }[] {
  return mismatches
    .filter((mismatch) => !mismatch.notedByPush)
    .flatMap((mismatch) =>
      mismatch.items.map((slug) => ({
        slug,
        text: `tracker reconcile: ticket ${mismatch.ticket.id} [${mismatch.kind}] ${mismatch.detail}; options: ${mismatch.recommendation}`,
      })),
    );
}
