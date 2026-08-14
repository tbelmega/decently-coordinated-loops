import type { ItemFile } from "./types.ts";

/** States collected in `for-delivery/`: agent-verified, awaiting the owner's
 * delivery/acceptance. Out of the active board, not yet terminal (the loops-board
 * skill). */
export const FOR_DELIVERY_STATES = new Set(["tested", "delivered"]);

/** States that move an item out of the board entirely, into `archive/`. */
export const TERMINAL_STATES = new Set(["accepted", "dropped"]);

export type Folder = "items" | "for-delivery" | "archive";

/** The folder an item's file belongs in, derived from its `state`. `items/` holds
 * everything in-flight/pickable (idea … merged, blocked); `for-delivery/` holds
 * verified work awaiting delivery; `archive/` holds terminal work. */
export function targetFolder(state: string): Folder {
  if (TERMINAL_STATES.has(state)) return "archive";
  if (FOR_DELIVERY_STATES.has(state)) return "for-delivery";
  return "items";
}

/** The folder an item's file currently sits in, derived from its repo-relative path. */
export function currentFolder(path: string): Folder {
  if (path.startsWith("for-delivery/")) return "for-delivery";
  if (path.startsWith("archive/")) return "archive";
  return "items";
}

export interface ItemMove {
  item: ItemFile;
  from: Folder;
  to: Folder;
}

/** Pure: given every loaded item across `items/` and `for-delivery/`, the file
 * moves the next sync must perform — each item whose state-implied folder differs
 * from where its file currently sits (items/→for-delivery/ on `tested`, →archive/
 * on `accepted`, for-delivery/→archive/ on `accepted`, etc.). The caller does the
 * file move and the ARCHIVE.md row append (for moves into archive/). */
export function planMoves(items: ItemFile[]): ItemMove[] {
  return items
    .map((item) => ({ item, from: currentFolder(item.path), to: targetFolder(item.state) }))
    .filter((move) => move.from !== move.to);
}

const ARCHIVE_TABLE_HEADER = `| Item | Project | Finished |
| --- | --- | --- |`;

function archiveRow(item: ItemFile): string {
  return `| [${item.title}](archive/${item.slug}.md) | ${item.project} | ${item.updated} |`;
}

/** Reconcile ARCHIVE.md against the set of archived items — derived and idempotent.
 * A row for an item already indexed (matched by its `archive/<slug>.md` link) is left
 * untouched; only items with no row yet are appended, sorted most-recently-finished
 * first. Because it reconciles against the archive/ folder rather than a one-shot
 * "just moved" batch, a sync that crashed after moving a file but before indexing it
 * is repaired on the next run — the move and the index become recoverable as one
 * derived operation. No-op (returns `archiveText` unchanged) when nothing is missing.
 *
 * Only files whose state actually belongs in `archive/` are indexed. Sitting in the folder
 * is not the same as being terminal: an item hand-moved there while still live is stranded,
 * and preflight keeps its board row and asks the owner to move it back. Indexing it would
 * record live work as finished in the one file whose entire contract is terminal work, and
 * the two derived indexes would then contradict each other. The rule lives here rather than
 * at the call site because ARCHIVE.md's contract is this function's to keep. */
export function reconcileArchiveRows(archiveText: string, archivedItems: ItemFile[]): string {
  const missing = archivedItems.filter(
    (item) => targetFolder(item.state) === "archive" && !archiveText.includes(`](archive/${item.slug}.md)`),
  );
  if (!missing.length) return archiveText;
  const rows = [...missing].sort((a, b) => b.updated.localeCompare(a.updated)).map(archiveRow);
  const hasTable = archiveText.includes(ARCHIVE_TABLE_HEADER);
  const trimmed = archiveText.replace(/\n+$/, "");
  const prefix = hasTable ? trimmed : `${trimmed}\n\n${ARCHIVE_TABLE_HEADER}`;
  return `${prefix}\n${rows.join("\n")}\n`;
}
