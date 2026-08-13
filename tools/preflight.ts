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

/** A BOARD.md row with no matching items/*.md file — never blocks; routed to OUTBOX.md
 * (question, source = the orphan row) by the caller, and dropped from the regenerated
 * board only once its outbox entry has been observed by a later run. `raw` is the row
 * exactly as the board carried it, so retaining it is a copy rather than a rerendering. */
export interface OrphanRow extends BoardRow {}

export interface PreflightReport {
  /** rows -> no item file */
  orphanRows: OrphanRow[];
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

/** Pure diff: BOARD.md rows vs item files -> orphan-row / missing-row / field-mismatch report. */
export function runPreflight(boardText: string, items: ItemFile[]): PreflightReport {
  const rows = parseBoardRows(boardText);
  const itemsByPath = new Map(items.map((i) => [i.path, i]));
  const rowPaths = new Set(rows.map((r) => r.path));

  const orphanRows = rows.filter((r) => !itemsByPath.has(r.path));
  const missingRows = items.filter((i) => !rowPaths.has(i.path)).map((i) => i.slug);

  const mismatches: FieldMismatch[] = [];
  for (const row of rows) {
    const item = itemsByPath.get(row.path);
    if (!item) continue; // orphan, already reported
    const cmp = (field: string, boardValue: string, fileValue: string) => {
      if (norm(boardValue).toLowerCase() !== norm(fileValue).toLowerCase()) {
        mismatches.push({ slug: item.slug, field, boardValue: norm(boardValue), fileValue: norm(fileValue) });
      }
    };
    cmp("project", row.project, item.project);
    cmp("state", row.state, item.state);
    cmp("next-actor", row.nextActor, item.nextActor);
    cmp("awaiting", row.awaiting, item.awaiting ?? "-");
    cmp("auto", row.auto, item.autonomy === "auto" ? "auto" : "-");
    cmp("assignee", row.assignee, item.assignee);
    cmp("updated", row.updated, item.updated);
  }

  return { orphanRows, missingRows, mismatches };
}
