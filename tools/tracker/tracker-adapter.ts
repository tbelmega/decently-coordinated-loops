// What the sync needs from a tracker product, and nothing more: read the tickets an item
// names or the board's open tickets, move one to a status, and write the board references.
// The write surface is deliberately this short - status, open/closed on the owner's
// answer, and the board slug and branch are the only things that may ever reach a
// collaborator's board.
import type { TicketRef, TicketSnapshot } from "./tracker-plan.ts";

export interface TicketRecord extends TicketSnapshot {
  /** The tracker's own identifier, which is what its write API takes. */
  externalId: string;
  description: string;
  title?: string;
  url?: string;
  /** The account the ticket is assigned to, absent when unassigned. */
  assignee?: string;
  /** False once the tracker considers the ticket closed; absent when the tracker has no
   * open/closed state separate from its workflow status. */
  open?: boolean;
  /** Board text fields by name, read only for the fields the tracker config names. */
  fields?: Record<string, string>;
  author?: string;
  /** ISO timestamp of the ticket's creation. */
  createdAt?: string;
}

export interface TicketComment {
  author: string;
  /** ISO timestamp. */
  createdAt: string;
  body: string;
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
  /** Write one board text field; an empty value clears it. Only a tracker with board
   * fields implements it. */
  setTextField?(ticket: TicketRecord, field: string, value: string): Promise<void>;
  /** Every open ticket on the tracker's board, for the pull. A tracker the pull does not
   * yet support leaves it out. */
  listOpenTickets?(): Promise<TicketRecord[]>;
  /** The ticket's description as the tracker holds it right now, bypassing any board
   * snapshot the adapter cached: a full-body write must start from current text. */
  fetchDescription?(ticket: TicketRecord): Promise<string>;
  /** Board entries the pull passed over because they are not tickets (pull requests,
   * drafts), so an empty pull can be told apart from a board of other things. */
  skippedEntries?(): { pullRequests: number; drafts: number } | undefined;
  /** The ticket's comments, oldest first. */
  fetchComments?(ticket: TicketRecord): Promise<TicketComment[]>;
  /** Close or reopen a ticket. Only ever on the owner's direct answer. */
  setOpen?(ticket: TicketRecord, open: boolean): Promise<void>;
}

export type { TicketRef };
