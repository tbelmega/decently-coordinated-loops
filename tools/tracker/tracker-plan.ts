// The status-push planner: board items plus a snapshot of their tickets in, transitions
// and item notes out. Pure - every rule that can move a collaborator's ticket lives here,
// where it is testable without a network.
import { BOARD_STATE_LADDER } from "../validate.ts";
import type { TrackerConfig } from "./tracker-config.ts";

/** A ticket is identified by its tracker plus the tracker's own id, never by the id
 * alone: `#12` on one board and `#12` on another are different tickets. */
export interface TicketRef {
  tracker: string;
  id: string;
}

/** The comparison and display form of a ticket identity. */
export function ticketKey(ref: TicketRef): string {
  return `${ref.tracker}/${ref.id}`;
}

/** An item as the planner needs it: its board state and the tickets it advances,
 * already qualified by the caller from the item's project. */
export interface PlannerItem {
  slug: string;
  state: string;
  tickets: TicketRef[];
}

/** One ticket as the tracker currently holds it. */
export interface TicketSnapshot {
  ref: TicketRef;
  /** The tracker's workflow status name, verbatim. */
  status: string;
}

export interface TicketTransition {
  ticket: TicketRef;
  from: string;
  to: string;
  /** Every item linked to the ticket, sorted by slug. */
  items: string[];
  /** `advance` moves along the lifecycle ladder; `cancel` is the off-ladder move a
   * ticket reaches only when every item linked to it is dropped. */
  reason: "advance" | "cancel";
}

/** A line to record on an item. Undated: the writer stamps it and drops it when the
 * item already carries the same text, so an unchanged state repeats no note. */
export interface ItemNote {
  slug: string;
  ticket: TicketRef;
  kind: "ticket-ahead" | "unranked-status";
  text: string;
}

/** A ticket left where it is because a linked item's state maps to nothing, so no
 * target can be named without reporting a sibling's progress as the ticket's own. */
export interface TicketHold {
  ticket: TicketRef;
  items: string[];
  /** The linked items whose state has no mapped status. */
  heldBy: string[];
}

export interface UnresolvedTicket {
  ticket: TicketRef;
  items: string[];
  reason: "not-in-snapshot" | "unknown-tracker";
}

export interface StatusPlan {
  transitions: TicketTransition[];
  notes: ItemNote[];
  holds: TicketHold[];
  unresolved: UnresolvedTicket[];
}

/** How far along the lifecycle a board state sits, or undefined for the off-ladder
 * states (`blocked`, `dropped`) and anything unrecognized. */
function stateRank(state: string): number | undefined {
  const index = (BOARD_STATE_LADDER as readonly string[]).indexOf(state);
  return index === -1 ? undefined : index;
}

/** How far along a tracker status sits: the highest rank among the board states mapped
 * to it, so several states sharing one status collapse into a single rank and neither
 * can pull the ticket back to the other. A status nothing ranked - one outside the map,
 * or the cancelled status - yields undefined, which is what makes the sync leave it
 * alone. */
function statusRank(tracker: TrackerConfig, status: string): number | undefined {
  let best: number | undefined;
  for (const [state, mapped] of Object.entries(tracker.statusMap)) {
    if (mapped !== status) continue;
    const rank = stateRank(state);
    if (rank !== undefined && (best === undefined || rank > best)) best = rank;
  }
  return best;
}

interface TicketGroup {
  ref: TicketRef;
  items: PlannerItem[];
}

function groupByTicket(items: PlannerItem[]): TicketGroup[] {
  const groups = new Map<string, TicketGroup>();
  for (const item of items) {
    for (const ref of item.tickets) {
      const key = ticketKey(ref);
      const group = groups.get(key) ?? { ref, items: [] };
      if (!group.items.some((linked) => linked.slug === item.slug)) group.items.push(item);
      groups.set(key, group);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => ({ ref: group.ref, items: [...group.items].sort((a, b) => a.slug.localeCompare(b.slug)) }));
}

/** Pure: what the status push would do. Forward-only along the lifecycle ladder, and
 * silent about everything it cannot rank - a ticket a human moved ahead of the board, or
 * one sitting in a status the map does not name, earns a line on the item and no write. */
export function planStatusSync(
  items: PlannerItem[],
  snapshots: TicketSnapshot[],
  trackers: Record<string, TrackerConfig>,
): StatusPlan {
  const byKey = new Map(snapshots.map((snapshot) => [ticketKey(snapshot.ref), snapshot]));
  const plan: StatusPlan = { transitions: [], notes: [], holds: [], unresolved: [] };

  for (const group of groupByTicket(items)) {
    const slugs = group.items.map((item) => item.slug);
    const tracker = Object.prototype.hasOwnProperty.call(trackers, group.ref.tracker)
      ? trackers[group.ref.tracker]
      : undefined;
    if (!tracker) {
      plan.unresolved.push({ ticket: group.ref, items: slugs, reason: "unknown-tracker" });
      continue;
    }
    const snapshot = byKey.get(ticketKey(group.ref));
    if (!snapshot) {
      plan.unresolved.push({ ticket: group.ref, items: slugs, reason: "not-in-snapshot" });
      continue;
    }

    const current = snapshot.status;
    const currentRank = statusRank(tracker, current);
    const live = group.items.filter((item) => item.state !== "dropped");

    if (live.length === 0) {
      const cancelled = tracker.statusMap.dropped;
      // No cancelled status configured means the project never expressed what an
      // abandoned work-stream looks like on its board; inventing one is not ours to do.
      if (!cancelled || cancelled === current) continue;
      if (currentRank === undefined) {
        plan.notes.push(...group.items.map((item) => unrankedNote(item, group.ref, current)));
        continue;
      }
      plan.transitions.push({ ticket: group.ref, from: current, to: cancelled, items: slugs, reason: "cancel" });
      continue;
    }

    if (currentRank === undefined) {
      plan.notes.push(...live.map((item) => unrankedNote(item, group.ref, current)));
      continue;
    }

    const heldBy = live.filter((item) => tracker.statusMap[item.state] === undefined).map((item) => item.slug);
    if (heldBy.length > 0) {
      plan.holds.push({ ticket: group.ref, items: slugs, heldBy });
      continue;
    }

    const target = leastAdvanced(tracker, live);
    const targetRank = statusRank(tracker, target)!;
    if (targetRank > currentRank) {
      plan.transitions.push({ ticket: group.ref, from: current, to: target, items: slugs, reason: "advance" });
    } else if (targetRank < currentRank) {
      plan.notes.push(
        ...live.map((item) => ({
          slug: item.slug,
          ticket: group.ref,
          kind: "ticket-ahead" as const,
          text: `ticket ${group.ref.id} is at ${current} while this item is ${item.state}`,
        })),
      );
    }
  }

  plan.notes.sort((a, b) => a.slug.localeCompare(b.slug) || ticketKey(a.ticket).localeCompare(ticketKey(b.ticket)));
  return plan;
}

function unrankedNote(item: PlannerItem, ticket: TicketRef, status: string): ItemNote {
  return {
    slug: item.slug,
    ticket,
    kind: "unranked-status",
    text: `ticket ${ticket.id} is at ${status}, which no board state ranks - leaving it alone`,
  };
}

/** The status of the least advanced linked item: a ticket several work-streams serve
 * reports the one furthest from done, so no sibling can call it delivered while another
 * is still building. Ties break by name, for a deterministic plan. */
function leastAdvanced(tracker: TrackerConfig, live: PlannerItem[]): string {
  const candidates = live.map((item) => tracker.statusMap[item.state]!);
  return candidates.reduce((best, status) => {
    const a = statusRank(tracker, status)!;
    const b = statusRank(tracker, best)!;
    if (a !== b) return a < b ? status : best;
    return status.localeCompare(best) < 0 ? status : best;
  });
}
