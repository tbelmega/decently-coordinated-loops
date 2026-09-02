import type { ItemFile } from "./types.ts";
import type { LoopsConfig } from "./config.ts";
import { makePriorityCompare } from "./priority.ts";
import { itemTargetFolder } from "./archive.ts";

const ACTIVE_TABLE_HEADER = `| Item | Project | State | Next-actor | Awaiting | Auto | Assignee | Updated |
| --- | --- | --- | --- | --- | --- | --- | --- |`;

/** The "Priorities: ..." line, built from the configured ranking. Falls back to a
 * plain "most recent activity" note when no priority projects are configured. */
function priorityLine(priorityProjects: string[]): string {
  if (priorityProjects.length === 0) return "most recent activity first.";
  const ranked = priorityProjects.map((project, i) => `${i + 1}. ${project}`);
  return `${ranked.join(" - ")} - ${priorityProjects.length + 1}. everything else by most recent activity.`;
}

function header(config: LoopsConfig): string {
  return `# Board

One row per active work-stream. Contract and update rules: the loops-board skill.
Unattended pickup: the loops-pickup skill.

Priorities: ${priorityLine(config.priorityProjects)}
`;
}

function auto(item: ItemFile): string {
  return item.autonomy === "auto" ? "auto" : "-";
}

export function activeRow(item: ItemFile): string {
  return `| [${item.title}](${item.path}) | ${item.project} | ${item.state} | ${item.nextActor} | ${
    item.awaiting ?? "-"
  } | ${auto(item)} | ${item.assignee} | ${item.updated} |`;
}

/** Replace the BOARD.md active-table row for `item` (matched by its item path) with
 * a freshly rendered row, leaving every other line untouched. Used by targeted
 * writers that update a few rows without a full regen. Returns the text unchanged
 * when no row matches the item's path. */
export function replaceActiveRow(boardText: string, item: ItemFile): string {
  const lines = boardText.split("\n");
  const index = lines.findIndex((line) => line.includes(`](${item.path})`));
  if (index === -1) return boardText;
  lines[index] = activeRow(item);
  return lines.join("\n");
}

/** Render BOARD.md text from parsed item files, normalized to the configured
 * priority order (see priority.ts), then most recent `updated`. Only items whose
 * state keeps them in items/ are rendered - for-delivery (tested/delivered) and
 * terminal (accepted/dropped) items belong in for-delivery/ and ARCHIVE.md
 * respectively, which the caller moves them to before regenerating BOARD.md. This
 * filter is defense-in-depth, not the primary move mechanism. */
export function renderBoardMd(items: ItemFile[], config: LoopsConfig): string {
  const compare = makePriorityCompare(config.priorityProjects);
  const active = items.filter((i) => itemTargetFolder(i, config) === "items").sort(compare);

  const parts = [header(config), ACTIVE_TABLE_HEADER, ...active.map(activeRow), ""];
  return parts.join("\n");
}
