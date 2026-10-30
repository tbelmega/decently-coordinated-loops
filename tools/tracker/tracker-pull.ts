// The pull: every open ticket on a tracker's board that no board item names yet becomes
// an `idea` item, so an agent with board access and no tracker access can pick the work
// up. Pure - the CLI reads the board and writes the files.
//
// Linking on judgment is never done here. A ticket links to an existing item only on a
// mechanical fact: the item quotes the ticket's URL, or the ticket's backlink names the
// item. A bare number in an item's prose could be a pull request or another tracker's
// ticket, so it is reported as a possible match for the owner and the ticket is filed.
import { isMap, isScalar, parseDocument } from "yaml";
import { resolveProjectTracker, type LoopsConfig } from "../config.ts";
import type { ItemFile } from "../types.ts";
import type { TicketComment, TicketRecord } from "./tracker-adapter.ts";
import { readBacklinkSlugs } from "./tracker-backlink.ts";
import { resolveItemTickets } from "./tracker-items.ts";
import { ticketKey, type TicketRef } from "./tracker-plan.ts";

export interface PullInput {
  tracker: string;
  /** The project new items are filed under. */
  project: string;
  config: LoopsConfig;
  /** Every item in every board folder, archive included: a dropped item still claims
   * its ticket. */
  items: ItemFile[];
  /** Item path -> file text, searched for quoted ticket URLs and numbers. */
  rawText: Map<string, string>;
  open: TicketRecord[];
}

export interface PullLink {
  ticket: TicketRef;
  slug: string;
  path: string;
  reason: "url" | "backlink";
}

export interface PullFile {
  ticket: TicketRef;
  record: TicketRecord;
  slug: string;
  path: string;
  /** Items whose prose mentions the bare ticket number; for the owner to confirm. */
  possibleMatches: string[];
}

export interface PullPlan {
  alreadyLinked: number;
  linkExisting: PullLink[];
  file: PullFile[];
  /** Tickets whose backlink names slugs no board item has. Not filed: the backlink says
   * a work-stream existed, so a second item would duplicate it. */
  staleBacklinks: { ticket: TicketRef; slugs: string[] }[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The slugs a ticket's backlink names: the configured field and any description lines,
 * deduplicated. Description lines stay authoritative after a tracker moves its slug into a
 * field, so a ticket linked before the move is never pulled as new. */
function ticketBacklinkSlugs(record: TicketRecord, slugField?: string): string[] {
  const fromField = slugField
    ? (record.fields?.[slugField] ?? "")
        .split(",")
        .map((slug) => slug.trim())
        .filter(Boolean)
    : [];
  return [...new Set([...fromField, ...readBacklinkSlugs(record.description)])];
}

/** Whether an item's text quotes this ticket's URL (the whole number, so issue 12 does not
 * match a quote of issue 123). */
function quotesTicketUrl(record: TicketRecord, text: string): boolean {
  return record.url ? new RegExp(`${escapeRegExp(record.url)}(?![0-9])`).test(text) : false;
}

/** Whether a planned link still rests on its mechanical evidence: the item still belongs
 * to a project on the ticket's tracker, and still quotes the ticket's URL or is still named
 * by the ticket's backlink. The pull checks this again against the item as it reads under
 * the board lock, because the item may have changed while the tracker was being read. */
export function linkStillJustified(
  link: PullLink,
  record: TicketRecord,
  current: ItemFile,
  currentText: string,
  config: LoopsConfig,
): boolean {
  if (current.slug !== link.slug) return false;
  if (resolveProjectTracker(config, current.project)?.name !== link.ticket.tracker) return false;
  if (link.reason === "url") return quotesTicketUrl(record, currentText);
  return ticketBacklinkSlugs(record, config.trackers[link.ticket.tracker]?.backlink?.slugField).includes(link.slug);
}

export function planPull(input: PullInput): PullPlan {
  const { tracker, project, config, items, rawText, open } = input;
  const slugField = config.trackers[tracker]?.backlink?.slugField;

  const linked = new Set<string>();
  for (const item of items) {
    for (const ref of resolveItemTickets(item, config)) linked.add(ticketKey(ref));
  }
  const searchable = items.filter((item) => resolveProjectTracker(config, item.project)?.name === tracker);
  // Only this tracker's items may be named by its tickets: ticket text is written by
  // collaborators, and a slug from another project must not attach that item to the
  // ticket or publish its branch there.
  const bySlug = new Map(searchable.map((item) => [item.slug, item]));
  const taken = new Set(items.map((item) => item.slug));

  const plan: PullPlan = { alreadyLinked: 0, linkExisting: [], file: [], staleBacklinks: [] };
  const sorted = [...open].sort((a, b) => a.ref.id.localeCompare(b.ref.id, undefined, { numeric: true }));
  for (const record of sorted) {
    if (record.open === false) continue;
    if (linked.has(ticketKey(record.ref))) {
      plan.alreadyLinked += 1;
      continue;
    }

    const backlinkSlugs = ticketBacklinkSlugs(record, slugField);
    if (backlinkSlugs.length) {
      const known = backlinkSlugs.filter((slug) => bySlug.has(slug));
      for (const slug of known) {
        plan.linkExisting.push({ ticket: record.ref, slug, path: bySlug.get(slug)!.path, reason: "backlink" });
      }
      if (known.length === 0) plan.staleBacklinks.push({ ticket: record.ref, slugs: backlinkSlugs });
      continue;
    }

    const quoting = searchable.filter((item) => quotesTicketUrl(record, rawText.get(item.path) ?? ""));
    if (quoting.length) {
      for (const item of quoting) plan.linkExisting.push({ ticket: record.ref, slug: item.slug, path: item.path, reason: "url" });
      continue;
    }

    const numberPattern = new RegExp(`(?<![\\w/])${escapeRegExp(record.ref.id)}(?![0-9])`);
    const possibleMatches = searchable
      .filter((item) => numberPattern.test(rawText.get(item.path) ?? ""))
      .map((item) => item.slug)
      .sort();
    const slug = itemSlugForTicket(project, record, taken);
    taken.add(slug);
    plan.file.push({ ticket: record.ref, record, slug, path: `items/${slug}.md`, possibleMatches });
  }
  return plan;
}

const SLUG_MAX = 60;

/** A board slug for a pulled ticket: the project, then the title in kebab case. A slug
 * already on the board gets the ticket number appended, which is stable across runs. */
export function itemSlugForTicket(project: string, record: TicketRecord, taken: Set<string>): string {
  const number = record.ref.id.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  const words = (record.title ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let slug = words ? `${project}-${words}` : `${project}-ticket-${number}`;
  if (slug.length > SLUG_MAX) {
    const cut = slug.slice(0, SLUG_MAX + 1);
    slug = cut.slice(0, cut.lastIndexOf("-") > project.length ? cut.lastIndexOf("-") : SLUG_MAX).replace(/-+$/, "");
  }
  return taken.has(slug) ? `${slug}-${number}` : slug;
}

function quote(text: string, indent = ""): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => `${indent}>${line ? ` ${line}` : ""}`)
    .join("\n");
}

function day(timestamp?: string): string {
  return timestamp ? timestamp.slice(0, 10) : "an unknown date";
}

const ATTACHMENT = /!\[[^\]]*\]\([^)]+\)|<img\s|user-attachments\//i;

export interface PulledItemInput {
  tracker: string;
  project: string;
  ticket: TicketRecord;
  comments: TicketComment[];
  possibleMatches: string[];
  today: string;
}

/** The item file for one pulled ticket. The description and comments are quoted
 * verbatim, the way inbox entries are, so a board-only agent works from the reporter's
 * own words rather than a paraphrase. */
export function renderPulledItem(input: PulledItemInput): string {
  const { tracker, project, ticket, comments, possibleMatches, today } = input;
  const id = ticket.ref.id;
  const title = ticket.title?.trim() || `Ticket ${id}`;
  const body = ticket.description.trim();
  const hasAttachment = ATTACHMENT.test(body) || comments.some((comment) => ATTACHMENT.test(comment.body));
  const lines = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `project: ${project}`,
    "state: idea",
    'assignee: "-"',
    "autonomy: supervised",
    "next-actor: agent",
    `tickets: [${JSON.stringify(id)}]`,
    `next-step: ${JSON.stringify(`Refine the pulled ticket ${id} toward a spec-ready description; questions only the reporter can answer go to the owner, who relays them on the ticket`)}`,
    `updated: ${today}`,
    "---",
    "",
    `Pulled from ${tracker} ticket ${id}${ticket.url ? `: ${ticket.url}` : ""}.`,
    `Reported by ${ticket.author ?? "an unknown author"} on ${day(ticket.createdAt)}; tracker status at pull: ${ticket.status || "none"}.`,
  ];
  if (possibleMatches.length) {
    lines.push(
      `Possible duplicate of ${possibleMatches.map((slug) => `[${slug}](${slug}.md)`).join(", ")} (that item mentions ${id}); confirm with the owner before merging.`,
    );
  }
  if (hasAttachment) {
    lines.push("Attachments are linked, not copied: opening them needs tracker access, so ask rather than guess at what they show.");
  }
  lines.push("", "## Ticket description", "", body ? quote(body) : "> (empty)");
  if (comments.length) {
    lines.push("", "## Comments at pull time", "");
    for (const comment of comments) lines.push(`- ${comment.author}, ${day(comment.createdAt)}:`, quote(comment.body, "  "));
  }
  lines.push("", "## Log", `- ${today}: Pulled from ${tracker} ticket ${id} by \`tracker-sync pull\`.`, "");
  return lines.join("\n");
}

/** The item text with these tickets added to its `tickets` list, or undefined when it
 * already names them all. A `local` marker is replaced: linking a ticket is the decision
 * that the work-stream is tracked after all. Only the `tickets` entry's own text span is
 * rewritten, whatever YAML form it took, so every other frontmatter line keeps its exact
 * formatting; the result is reparsed before it is returned. */
export function setItemTickets(rawText: string, ids: string[]): string | undefined {
  const match = /^---\n([\s\S]*?)\n---/.exec(rawText);
  if (!match) throw new Error("item has no frontmatter to add tickets to");
  const front = match[1]!;
  const offset = 4;
  const doc = parseDocument(front);
  if (doc.errors.length || !isMap(doc.contents)) throw new Error("item frontmatter is not a valid YAML mapping");
  const pair = doc.contents.items.find((candidate) => isScalar(candidate.key) && candidate.key.value === "tickets");
  const declared = (doc.toJSON() as Record<string, unknown>).tickets;
  const current = Array.isArray(declared) ? declared.map(String) : [];
  const next = [...current, ...ids.filter((id) => !current.includes(id))];
  if (Array.isArray(declared) && next.length === current.length) return undefined;
  const line = `tickets: [${next.map((id) => JSON.stringify(id)).join(", ")}]`;
  let result: string;
  if (pair) {
    const start = (pair.key as { range?: [number, number, number] }).range![0];
    const valueRange = (pair.value as { range?: [number, number, number] } | null)?.range;
    const end = valueRange ? valueRange[1] : (pair.key as { range: [number, number, number] }).range[1];
    // A block value's range ends after its trailing newline, a flow value's does not;
    // either way exactly one line break must follow the rewritten entry. A comment left on
    // the same line as a flow value belonged to the old list and is dropped with it.
    const keepBreak = end < front.length && front[end - 1] === "\n" ? "\n" : "";
    const tail = front.slice(end).replace(/^[ \t]*#[^\n]*/, "");
    const rebuilt = `${front.slice(0, start)}${line}${keepBreak}${tail}`;
    result = `${rawText.slice(0, offset)}${rebuilt}${rawText.slice(offset + front.length)}`;
  } else {
    const withLine = /^next-step:/m.test(front) ? front.replace(/^next-step:/m, `${line}\nnext-step:`) : `${front}\n${line}`;
    result = `${rawText.slice(0, offset)}${withLine}${rawText.slice(offset + front.length)}`;
  }
  const check = /^---\n([\s\S]*?)\n---/.exec(result);
  const reparsed = check ? parseDocument(check[1]!) : undefined;
  const written = reparsed && !reparsed.errors.length ? (reparsed.toJSON() as Record<string, unknown>).tickets : undefined;
  if (JSON.stringify(written) !== JSON.stringify(next)) {
    throw new Error("could not add the ticket without breaking the item's frontmatter - add it by hand");
  }
  return result;
}
