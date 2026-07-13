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

/** Append rows for newly archived items to ARCHIVE.md's text. Existing rows are left
 * untouched (append-only); the new batch is sorted most-recently-finished first,
 * matching the table's existing convention. No-op (returns `archiveText` unchanged)
 * when there's nothing new to archive. */
export function appendArchiveRows(archiveText: string, newlyArchived: ItemFile[]): string {
  if (!newlyArchived.length) return archiveText;
  const rows = [...newlyArchived].sort((a, b) => b.updated.localeCompare(a.updated)).map(archiveRow);
  const hasTable = archiveText.includes(ARCHIVE_TABLE_HEADER);
  const trimmed = archiveText.replace(/\n+$/, "");
  const prefix = hasTable ? trimmed : `${trimmed}\n\n${ARCHIVE_TABLE_HEADER}`;
  return `${prefix}\n${rows.join("\n")}\n`;
}
