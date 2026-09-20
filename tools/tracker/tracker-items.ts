// The item side of tracker integration: which tickets an item advances, and which items
// have not yet said anything about tickets at all. Pure - no IO.
import { resolveProjectTracker, type LoopsConfig } from "../config.ts";
import { BOARD_STATE_LADDER } from "../types.ts";
import type { ItemFile } from "../types.ts";
import type { TicketRef } from "./tracker-plan.ts";

/** The tickets an item advances, qualified by the tracker its project names. An item
 * marked `local`, one that has decided nothing, and one in a project with no tracker all
 * name none - which is what keeps a board-only work-stream from ever reaching a tracker. */
export function resolveItemTickets(item: ItemFile, config: LoopsConfig): TicketRef[] {
  if (!Array.isArray(item.tickets)) return [];
  const resolved = resolveProjectTracker(config, item.project);
  if (!resolved) return [];
  return item.tickets.map((id) => ({ tracker: resolved.name, id }));
}

/** The point from which a work-stream is real enough to be worth a collaborator's
 * attention. Before it, the nudge would fire on every passing thought on the board. */
const DECISION_DUE_FROM = BOARD_STATE_LADDER.indexOf("spec-filed");

/** Slugs of items in a tracker project that have neither named a ticket nor declared
 * themselves local. The encouragement half of "encourage, do not enforce": reported,
 * never enforced, and silenced for good by `tickets: local`. */
export function missingTicketDecisions(items: ItemFile[], config: LoopsConfig): string[] {
  return items
    .filter((item) => {
      if (item.tickets !== undefined) return false;
      if (!resolveProjectTracker(config, item.project)) return false;
      const rank = (BOARD_STATE_LADDER as readonly string[]).indexOf(item.state);
      return rank >= DECISION_DUE_FROM;
    })
    .map((item) => item.slug);
}
