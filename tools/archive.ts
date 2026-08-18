import { DEFAULT_PROJECT_LIFECYCLE, projectLifecycle } from "./config.ts";
import type { LoopsConfig, ProjectLifecycle } from "./config.ts";
import type { ItemFile } from "./types.ts";

/** States collected in `for-delivery/`: agent-verified, awaiting the owner's
 * delivery/acceptance. Out of the active board, not yet terminal (the loops-board
 * skill). */
export const FOR_DELIVERY_STATES = new Set(["tested", "delivered"]);

/** States that move an item out of the board entirely, into `archive/`. */
export const TERMINAL_STATES = new Set(["accepted", "dropped"]);

export type Folder = "items" | "for-delivery" | "archive";

/** The folder an item's file belongs in, derived from its `state` and the lifecycle tail
 * of the project that owns it. `items/` holds everything in-flight/pickable (idea … merged,
 * blocked); `for-delivery/` holds verified work awaiting delivery; `archive/` holds work
 * that is finished.
 *
 * Under `no-deploy` there is no release the owner could make, so `tested` is finished and
 * routes to `archive/` - as `tested`, since nothing here rewrites a state. `delivered` and
 * `accepted` stay valid states under either tail (the owner may still set them by hand) and
 * route as they always have; the state vocabulary is global and closed, and only the tail's
 * termination point is per-project.
 *
 * `lifecycle` defaults to the deploy tail for callers that hold a state without a project
 * context. Anything item-shaped should call `itemTargetFolder` instead, so the item's own
 * `project:` decides. */
export function targetFolder(state: string, lifecycle: ProjectLifecycle = DEFAULT_PROJECT_LIFECYCLE): Folder {
  if (TERMINAL_STATES.has(state)) return "archive";
  if (lifecycle === "no-deploy" && state === "tested") return "archive";
  if (FOR_DELIVERY_STATES.has(state)) return "for-delivery";
  return "items";
}

/** `targetFolder` for a parsed item: resolves the tail from the item's `project:` against
 * the instance config. An unregistered project keeps the deploy tail (see
 * `projectLifecycle`), so a typo in `project:` never archives verified work early. */
export function itemTargetFolder(item: ItemFile, config: LoopsConfig): Folder {
  return targetFolder(item.state, projectLifecycle(config, item.project));
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
 * on `accepted`, for-delivery/→archive/ on `accepted`, etc.). Each item's destination is
 * resolved against its own project's lifecycle tail, so a no-deploy project's `tested` item
 * goes to `archive/` from wherever it currently sits - which is also the whole migration
 * for items already parked in `for-delivery/` when a project's tail is collapsed. The caller
 * does the file move and the ARCHIVE.md row append (for moves into archive/). */
export function planMoves(items: ItemFile[], config: LoopsConfig): ItemMove[] {
  return items
    .map((item) => ({ item, from: currentFolder(item.path), to: itemTargetFolder(item, config) }))
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
 * Only files that actually belong in `archive/` - state plus the owning project's lifecycle
 * tail - are indexed. Sitting in the folder is not the same as being finished: an item hand-moved there while still live is stranded,
 * and preflight keeps its board row and asks the owner to move it back. Indexing it would
 * record live work as finished in the one file whose entire contract is terminal work, and
 * the two derived indexes would then contradict each other. The rule lives here rather than
 * at the call site because ARCHIVE.md's contract is this function's to keep.
 *
 * A row already written for a file that later goes stranded is deliberately NOT removed.
 * Removing it read as the tidier rule and is the worse one: an item archived the ordinary
 * way has no board row left, so its ARCHIVE.md row is its last derived trace, and deleting
 * that on a state edit left a live work-stream in no index at all. This function only ever
 * appends. The stale row is a reporting problem, and `validateItem` reports it from the
 * file, where the condition is actually visible. */
export function reconcileArchiveRows(archiveText: string, archivedItems: ItemFile[], config: LoopsConfig): string {
  const missing = archivedItems.filter(
    (item) => itemTargetFolder(item, config) === "archive" && !archiveText.includes(`](archive/${item.slug}.md)`),
  );
  if (!missing.length) return archiveText;
  const rows = [...missing].sort((a, b) => b.updated.localeCompare(a.updated)).map(archiveRow);
  const hasTable = archiveText.includes(ARCHIVE_TABLE_HEADER);
  const trimmed = archiveText.replace(/\n+$/, "");
  const prefix = hasTable ? trimmed : `${trimmed}\n\n${ARCHIVE_TABLE_HEADER}`;
  return `${prefix}\n${rows.join("\n")}\n`;
}
