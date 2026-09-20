// The shape of an external task tracker as declared in the data repo's `loops.json`.
// Types only here plus the kind list; the parse-time validation lives with the config
// reader. Pure - no IO.

/** The tracker products with an adapter. Adding one means adding its adapter, so the
 * list is deliberately short. */
export const trackerKinds = ["linear", "github-projects"] as const;
export type TrackerKind = (typeof trackerKinds)[number];

/** Whose tickets the pull considers besides unassigned ones. `viewer` means whoever the
 * token authenticates as; the owner is a different identity in every tracker, so the
 * mapping has to be declared rather than derived from the board's owner name. */
export interface TrackerOwnerConfig {
  account: string;
}

export interface TrackerPullConfig {
  /** Tracker status names that count as not yet started. Not derivable from
   * `statusMap`: a tracker's intake statuses need not map to any board state. */
  unstartedStatuses: string[];
}

/** Commit-reference templates. `{id}` is the ticket id; both default from the kind. */
export interface TrackerCommitConfig {
  /** Appended to the commit subject, e.g. "[{id}]". */
  subject?: string;
  /** A body line linking the commit without moving the ticket, e.g. "Related to {id}". */
  body?: string;
}

export interface TrackerConfig {
  kind: TrackerKind;
  /** linear: the workspace slug; github-projects: "Org/repo". */
  workspace: string;
  /** linear: the team key; github-projects: the project number. */
  team: string;
  /** The board a human should open; display only. */
  url?: string;
  owner?: TrackerOwnerConfig;
  /** Board state -> tracker workflow status. An absent state means "leave the ticket
   * alone", which is why `idea` and `blocked` are normally absent. */
  statusMap: Record<string, string>;
  pull?: TrackerPullConfig;
  /** Path to the file holding this tracker's API token ("~" expanded by the reader). */
  tokenFile?: string;
  commit?: TrackerCommitConfig;
}
