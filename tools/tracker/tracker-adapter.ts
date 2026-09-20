// What the status phase needs from a tracker product, and nothing more: read the
// tickets an item names, move one to a status, and rewrite one's description. The write
// surface is deliberately this short - status, approved text and the board slug are the
// only things that may ever reach a collaborator's board.
import type { TicketRef, TicketSnapshot } from "./tracker-plan.ts";

export interface TicketRecord extends TicketSnapshot {
  /** The tracker's own identifier, which is what its write API takes. */
  externalId: string;
  description: string;
  title?: string;
  url?: string;
  /** The account the ticket is assigned to, absent when unassigned. */
  assignee?: string;
}

export interface TrackerAdapter {
  /** The tickets named by `ids`, in whatever order the tracker returns them. An id the
   * tracker does not know is omitted rather than invented, and the planner reports it. */
  fetchTickets(ids: string[]): Promise<TicketRecord[]>;
  /** Move one ticket to a named workflow status. Fails loudly on a status the tracker
   * does not have: a renamed status is a configuration fact to fix, never something to
   * guess at. */
  setStatus(ticket: TicketRecord, status: string): Promise<void>;
  setDescription(externalId: string, description: string): Promise<void>;
}

export type { TicketRef };
