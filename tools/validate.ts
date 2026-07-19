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

/** The only valid value of the optional `spec:` field — the owner's explicit waiver
 * of the loops-pickup spec gate. A typo fails closed (no waiver), so this check is
 * about surfacing the ignored intent, not about closing a bypass. */
export const CANONICAL_SPEC = new Set(["waived"]);

export const CANONICAL_AWAITING = new Set([
  "unblock",
  "review-merge",
  "deliver",
  "accept",
  "approve",
  "decide",
]);

/** The mandatory scalar frontmatter fields (loops-board schema), paired with the
 * frontmatter key name to report on. `owner` and `autonomy` are omitted deliberately:
 * parse.ts defaults both to "-", so they are never empty (and "-" is a valid owner /
 * autonomy sentinel). A blank required field is a broken item, not an enum typo, so it
 * is flagged with its own message instead of "'' is not canonical". */
const REQUIRED_FIELDS: ReadonlyArray<{ key: string; get: (item: ItemFile) => string }> = [
  { key: "title", get: (item) => item.title },
  { key: "project", get: (item) => item.project },
  { key: "state", get: (item) => item.state },
  { key: "next-actor", get: (item) => item.nextActor },
  { key: "next-step", get: (item) => item.nextStep },
  { key: "updated", get: (item) => item.updated },
];

/** Pure: every schema violation on one item, as human-readable messages — a blank
 * mandatory field, or a closed-set enum value outside its canonical set. Empty array =
 * the item is well-formed. Empty required fields are reported first; the enum checks
 * then skip empty values so a blank field isn't also flagged as "not canonical". */
export function validateItem(item: ItemFile): string[] {
  const messages: string[] = [];

  for (const { key, get } of REQUIRED_FIELDS) {
    if (get(item).trim() === "") {
      messages.push(`${key} is required but empty`);
    }
  }

  if (item.state.trim() !== "" && !CANONICAL_STATES.has(item.state)) {
    const hint = CANONICAL_AWAITING.has(item.state)
      ? ` — looks like an awaiting sub-bucket, not a state; did you mean \`awaiting: ${item.state}\`?`
      : "";
    messages.push(`state "${item.state}" is not a canonical state${hint}`);
  }

  if (item.nextActor.trim() !== "" && !CANONICAL_NEXT_ACTORS.has(item.nextActor)) {
    messages.push(`next-actor "${item.nextActor}" is not canonical (expected owner or agent)`);
  }

  if (!CANONICAL_AUTONOMY.has(item.autonomy)) {
    messages.push(`autonomy "${item.autonomy}" is not canonical (expected auto or supervised)`);
  }

  if (item.awaiting != null && !CANONICAL_AWAITING.has(item.awaiting)) {
    messages.push(`awaiting "${item.awaiting}" is not canonical`);
  }

  if (item.spec != null && !CANONICAL_SPEC.has(item.spec)) {
    messages.push(`spec "${item.spec}" is not canonical (expected waived, or omit the field)`);
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

export interface DuplicateSlug {
  slug: string;
  /** Every file path carrying this slug, sorted. */
  paths: string[];
}

/** Pure: slugs that occur on more than one item file across the loaded folders
 * (items/, for-delivery/, archive/). A slug is a file identity — the folder move
 * writes `<slug>.md`, and depends-on resolves by slug — so a collision means one
 * item's file can overwrite another's on a move, and a dependency can resolve to the
 * wrong target. An integrity error: sync must stop before writing, and check must
 * fail. Sorted by slug; each entry's paths sorted for deterministic output. */
export function findDuplicateSlugs(items: ItemFile[]): DuplicateSlug[] {
  const pathsBySlug = new Map<string, string[]>();
  for (const item of items) {
    const paths = pathsBySlug.get(item.slug) ?? [];
    paths.push(item.path);
    pathsBySlug.set(item.slug, paths);
  }
  return [...pathsBySlug.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([slug, paths]) => ({ slug, paths: [...paths].sort() }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}
