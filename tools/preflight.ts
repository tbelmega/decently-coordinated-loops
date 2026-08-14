import { currentFolder, targetFolder } from "./archive.ts";
import type { Folder } from "./archive.ts";
import type { ItemFile } from "./types.ts";

export interface BoardRow {
  /** The row exactly as BOARD.md carried it, so a retained row is a copy of the
   * original line rather than a rerendering of its parsed fields. */
  raw: string;
  title: string;
  path: string;
  project: string;
  state: string;
  nextActor: string;
  awaiting: string;
  auto: string;
  assignee: string;
  updated: string;
}

export interface FieldMismatch {
  slug: string;
  field: string;
  boardValue: string;
  fileValue: string;
}

/** A BOARD.md row the owner has to recover by hand; never blocks; routed to OUTBOX.md
 * (question, source = the orphan row) by the caller, and dropped from the regenerated
 * board only once its outbox entry has been observed by a later run. `raw` is the row
 * exactly as the board carried it, so retaining it is a copy rather than a rerendering. */
export interface OrphanRow extends BoardRow {
  /** Set when the item file does exist but is stranded in `archive/`, which needs a
   * different ask: the recovery is to move that file, not to write a new one. Absent for
   * a true orphan, whose item file exists in no folder at all. */
  stranded?: { itemPath: string; belongsIn: Folder };
}

/** A BOARD.md row whose item file sits in `for-delivery/` or `archive/`. Emphatically not
 * an orphan: the item exists and is authoritative one directory over, so there is nothing
 * to ask the owner and nothing to preserve. The board renders active items only, so
 * regeneration drops the row, and if the item's state means it belongs back in `items/`,
 * sync's own move planning puts it there and the next run renders its row afresh.
 *
 * `archive/` is the one exception, because it is the one folder sync never plans a move
 * out of (`planMoves` is fed `items/` and `for-delivery/`). A file that does not belong
 * there is stranded, its board row is the last trace of it, and it keeps the orphan
 * treatment instead: row retained, owner asked. See `isStrandedInArchive`. */
export interface TerminalRow extends BoardRow {
  /** Where the item actually lives now, e.g. "archive/foo.md". */
  itemPath: string;
}

export interface PreflightReport {
  /** rows -> no item file in any folder */
  orphanRows: OrphanRow[];
  /** rows -> item file in a terminal folder (dropped on regen; not an owner question) */
  terminalRows: TerminalRow[];
  /** item files -> no row (auto-added on regen, a desirable self-heal) */
  missingRows: string[];
  /** row vs file field mismatch; item file wins on regen */
  mismatches: FieldMismatch[];
}

/** Parse BOARD.md's active table into rows. Ignores the Done section and any line
 * that isn't a data row (headers, separators, prose). */
export function parseBoardRows(boardText: string): BoardRow[] {
  const rows: BoardRow[] = [];
  for (const line of boardText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    // Split on the fixed 8-column shape rather than a single link regex: a title can
    // itself contain "[...]" (e.g. "Create Tenant [S6]"), which breaks a naive
    // `\[([^\]]+)\]` match. Instead take the outer pipes off and require exactly the
    // fixed column count; the first cell (title-link) is parsed separately below.
    const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
    // active rows: [link-cell, project, state, next-actor, awaiting, auto, assignee, updated] = 8 cells
    if (cells.length !== 8) continue; // Done rows (3 cells), headers, separators, prose all skip here
    const linkCell = cells[0];
    const linkMatch = linkCell.match(/^\[(.*)\]\(([^)]+)\)$/);
    if (!linkMatch) continue;
    const [, project, state, nextActor, awaiting, auto, assignee, updated] = cells;
    rows.push({
      raw: trimmed,
      title: linkMatch[1].trim(),
      path: linkMatch[2].trim(),
      project,
      state,
      nextActor,
      awaiting,
      auto,
      assignee,
      updated,
    });
  }
  return rows;
}

const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** A row's identity is its slug, not its link path: the link keeps naming
 * `items/<slug>.md` long after the item file has moved to `for-delivery/` or `archive/`,
 * so matching on the path alone reads every moved item's row as having no item file.
 * Mirrors the slug derivation `parse.ts` applies to a file's own path. */
export function rowSlug(path: string): string {
  return path.replace(/^(items|for-delivery|archive)\//, "").replace(/\.md$/, "");
}

/** An item stranded in `archive/`: its file is there while its state puts it anywhere
 * else. `archive/` is a one-way door for sync (`planMoves` is fed `items/` and
 * `for-delivery/` only), so nothing repairs the placement, and the state is canonical so
 * no integrity check objects either. Its board row is the last trace of a live
 * work-stream and must be preserved and asked about rather than dropped as stale.
 *
 * The test is "does not belong in archive/", not "belongs in items/": a `tested` or
 * `delivered` item stranded there is just as invisible as an `in-progress` one. Every
 * misplacement outside `archive/` is one `planMoves` performs, in the same sync run. */
function isStrandedInArchive(item: ItemFile): boolean {
  return currentFolder(item.path) === "archive" && targetFolder(item.state) !== "archive";
}

/** Pure diff: BOARD.md rows vs item files -> orphan-row / terminal-row / missing-row /
 * field-mismatch report. `items` is the active set (`items/`), which is also what the
 * board renders; `terminalItems` are the `for-delivery/` and `archive/` files, passed so
 * that a row whose item has legitimately moved on can be told apart from a genuinely
 * orphaned one. Every row resolves against both sets; only `items` produces missing rows
 * and field comparisons. */
export function runPreflight(boardText: string, items: ItemFile[], terminalItems: ItemFile[]): PreflightReport {
  const rows = parseBoardRows(boardText);
  const itemsBySlug = new Map(items.map((i) => [i.slug, i]));
  const terminalBySlug = new Map(terminalItems.map((i) => [i.slug, i]));
  const rowSlugs = new Set(rows.map((r) => rowSlug(r.path)));

  const orphanRows: OrphanRow[] = [];
  const terminalRows: TerminalRow[] = [];
  for (const row of rows) {
    const slug = rowSlug(row.path);
    if (itemsBySlug.has(slug)) continue;
    const terminal = terminalBySlug.get(slug);
    if (!terminal) {
      orphanRows.push(row);
    } else if (isStrandedInArchive(terminal)) {
      // The file exists, so the recovery is to move it, not to write a new one. Carry
      // where it is and where it belongs, or the entry would tell the owner to create an
      // item whose slug archive/ already holds, which the duplicate-slug guard then
      // refuses to sync past.
      orphanRows.push({ ...row, stranded: { itemPath: terminal.path, belongsIn: targetFolder(terminal.state) } });
    } else {
      terminalRows.push({ ...row, itemPath: terminal.path });
    }
  }
  const missingRows = items.filter((i) => !rowSlugs.has(i.slug)).map((i) => i.slug);

  const mismatches: FieldMismatch[] = [];
  for (const row of rows) {
    const item = itemsBySlug.get(rowSlug(row.path));
    // Not an active item: either an orphan or a row whose item has moved on, both
    // already reported. Neither can drift against a board row that regeneration drops.
    if (!item) continue;
    const cmp = (field: string, boardValue: string, fileValue: string) => {
      if (norm(boardValue).toLowerCase() !== norm(fileValue).toLowerCase()) {
        mismatches.push({ slug: item.slug, field, boardValue: norm(boardValue), fileValue: norm(fileValue) });
      }
    };
    // The link itself is a field, and resolving identity by slug is what makes checking it
    // necessary: a row reading `for-delivery/<slug>.md` for a file in `items/` now matches
    // instead of being reported, so without this the only trace of a broken link would be
    // gone from every report. An active item's canonical link is `items/<slug>.md`, which
    // is what regeneration writes, so this drifts and self-heals exactly like the others.
    cmp("link", row.path, `items/${item.slug}.md`);
    cmp("project", row.project, item.project);
    cmp("state", row.state, item.state);
    cmp("next-actor", row.nextActor, item.nextActor);
    cmp("awaiting", row.awaiting, item.awaiting ?? "-");
    cmp("auto", row.auto, item.autonomy === "auto" ? "auto" : "-");
    cmp("assignee", row.assignee, item.assignee);
    cmp("updated", row.updated, item.updated);
  }

  return { orphanRows, terminalRows, missingRows, mismatches };
}
