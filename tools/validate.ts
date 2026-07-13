// Closed-set validation for the frontmatter enum fields (the loops-board skill).
// The `state:`/`next-actor:`/`autonomy:`/`awaiting:` fields are free text in the
// item files, so typos ("review-merge" as a state, "done", "nobody") would
// otherwise be bucketed silently. This turns any out-of-set value into a visible
// anomaly — surfaced by the CLI and failing the check command. Pure: no IO.
import type { ItemFile } from "./types.ts";

/** The one authoritative list of `state` values (the loops-board skill). */
export const CANONICAL_STATES = new Set([
  "idea",
  "spec-filed",
  "in-progress",
  "implemented",
  "merged",
  "tested",
  "delivered",
  "accepted",
  "blocked",
  "dropped",
]);

export const CANONICAL_NEXT_ACTORS = new Set(["owner", "agent"]);

/** "-" is the accepted sentinel for "unset" (legacy items and freshly-filed ideas). */
export const CANONICAL_AUTONOMY = new Set(["auto", "supervised", "-"]);

export const CANONICAL_AWAITING = new Set([
  "unblock",
  "review-merge",
  "deliver",
  "accept",
  "approve",
  "decide",
]);

/** Pure: every closed-set violation on one item, as human-readable messages.
 * Empty array = the item's enum fields are all canonical. Empty `next-actor` is
 * left to the caller (which already flags it) so the messages don't double up. */
export function validateItem(item: ItemFile): string[] {
  const messages: string[] = [];

  if (!CANONICAL_STATES.has(item.state)) {
    const hint = CANONICAL_AWAITING.has(item.state)
      ? ` — looks like an awaiting sub-bucket, not a state; did you mean \`awaiting: ${item.state}\`?`
      : "";
    messages.push(`state "${item.state}" is not a canonical state${hint}`);
  }

  if (item.nextActor !== "" && !CANONICAL_NEXT_ACTORS.has(item.nextActor)) {
    messages.push(`next-actor "${item.nextActor}" is not canonical (expected owner or agent)`);
  }

  if (!CANONICAL_AUTONOMY.has(item.autonomy)) {
    messages.push(`autonomy "${item.autonomy}" is not canonical (expected auto or supervised)`);
  }

  if (item.awaiting != null && !CANONICAL_AWAITING.has(item.awaiting)) {
    messages.push(`awaiting "${item.awaiting}" is not canonical`);
  }

  return messages;
}

export interface ItemAnomaly {
  slug: string;
  messages: string[];
}

/** Pure: run validateItem across a set and keep only the ones with violations. */
export function validateItems(items: ItemFile[]): ItemAnomaly[] {
  return items
    .map((item) => ({ slug: item.slug, messages: validateItem(item) }))
    .filter((entry) => entry.messages.length > 0);
}
