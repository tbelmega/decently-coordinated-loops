// The shape of an external task tracker as declared in the data repo's `loops.json`,
// and the parse-time validation of that block. Pure - no IO.
import { CANONICAL_STATES } from "../types.ts";

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

/** The id form each tracker issues. Used both to validate what an item claims and to
 * keep a key belonging to one product off an item whose project points at another. */
const TICKET_ID_PATTERNS: Record<TrackerKind, RegExp> = {
  linear: /^[A-Z][A-Z0-9]*-\d+$/,
  "github-projects": /^#\d+$/,
};

/** How to describe a well-formed id of this kind in an error message. */
export const TICKET_ID_FORMS: Record<TrackerKind, string> = {
  linear: "a team key and a number, e.g. ACM-123",
  "github-projects": 'a hash and a number, e.g. "#123" (quoted, or YAML reads it as a comment)',
};

export function isTicketId(kind: TrackerKind, id: string): boolean {
  return TICKET_ID_PATTERNS[kind].test(id);
}

/** The words that make each tracker's own Git integration move a ticket. A commit
 * reference must never contain one: the board decides status, and a commit that closes
 * a ticket takes that decision away from it - and away from the sibling work-streams the
 * same ticket may serve. */
const CLOSING_KEYWORDS: Record<TrackerKind, string[]> = {
  linear: ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved", "complete", "completes", "completed"],
  "github-projects": ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"],
};

/** The default commit convention per kind. Linear links a commit only after a magic
 * word, so it gets a relation line that links without moving the ticket; GitHub
 * cross-references on the bare number in the subject and needs nothing more. */
const DEFAULT_COMMIT: Record<TrackerKind, TrackerCommitConfig> = {
  linear: { subject: "[{id}]", body: "Related to {id}" },
  "github-projects": { subject: "[{id}]" },
};

/** The commit reference templates in force for a tracker: its kind's defaults with the
 * declared overrides on top. */
export function commitTemplates(tracker: TrackerConfig): TrackerCommitConfig {
  const base = DEFAULT_COMMIT[tracker.kind];
  return {
    ...base,
    ...(tracker.commit?.subject !== undefined ? { subject: tracker.commit.subject } : {}),
    ...(tracker.commit?.body !== undefined ? { body: tracker.commit.body } : {}),
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

const TRACKER_KEYS = ["kind", "workspace", "team", "url", "owner", "statusMap", "pull", "tokenFile", "commit"];

function validateCommit(commit: unknown, kind: TrackerKind, label: string): void {
  if (typeof commit !== "object" || commit === null || Array.isArray(commit)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(commit)) {
    if (key !== "subject" && key !== "body") throw new Error(`${label}.${key} is not allowed (subject, body)`);
  }
  for (const key of ["subject", "body"] as const) {
    const template = (commit as TrackerCommitConfig)[key];
    if (template === undefined) continue;
    if (!nonEmptyString(template)) throw new Error(`${label}.${key} must be a non-empty string`);
    if (!template.includes("{id}")) {
      throw new Error(`${label}.${key} must contain the {id} placeholder, or the reference names no ticket`);
    }
    const words = template.toLowerCase().match(/[a-z]+/g) ?? [];
    const closing = words.find((word) => CLOSING_KEYWORDS[kind].includes(word));
    if (closing) {
      throw new Error(
        `${label}.${key} contains the closing keyword "${closing}", which would let a commit move the ticket instead of the board`,
      );
    }
  }
}

/** Parse-time validation of the data repo's `trackers` block. Fails closed on every
 * malformed shape, including a misspelled key: a tracker that silently ignored half its
 * declaration would write to a collaborator's board under rules nobody wrote. */
export function validateTrackers(trackers: unknown, label = "trackers"): Record<string, TrackerConfig> {
  if (trackers === undefined) return {};
  if (typeof trackers !== "object" || trackers === null || Array.isArray(trackers)) {
    throw new Error(`${label} must be an object of named trackers`);
  }
  for (const [name, entry] of Object.entries(trackers as Record<string, unknown>)) {
    const path = `${label}.${name}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${path} must be an object`);
    const candidate = entry as Record<string, unknown>;
    const unknown = Object.keys(candidate).find((key) => !TRACKER_KEYS.includes(key));
    if (unknown) throw new Error(`${path}.${unknown} is not a tracker field (${TRACKER_KEYS.join(", ")})`);
    if (!trackerKinds.includes(candidate.kind as TrackerKind)) {
      throw new Error(`${path}.kind must be one of ${trackerKinds.join(", ")}`);
    }
    const kind = candidate.kind as TrackerKind;
    for (const key of ["workspace", "team"] as const) {
      if (!nonEmptyString(candidate[key])) throw new Error(`${path}.${key} must be a non-empty string`);
    }
    for (const key of ["url", "tokenFile"] as const) {
      if (candidate[key] !== undefined && !nonEmptyString(candidate[key])) {
        throw new Error(`${path}.${key} must be a non-empty string when present`);
      }
    }
    if (candidate.owner !== undefined) {
      const owner = candidate.owner as Record<string, unknown>;
      if (typeof owner !== "object" || owner === null || Array.isArray(owner) || !nonEmptyString(owner.account)) {
        throw new Error(`${path}.owner.account must be a non-empty string (an account name, or "viewer")`);
      }
      const unknownOwnerKey = Object.keys(owner).find((key) => key !== "account");
      if (unknownOwnerKey) throw new Error(`${path}.owner.${unknownOwnerKey} is not allowed (account)`);
    }
    const statusMap = candidate.statusMap;
    if (typeof statusMap !== "object" || statusMap === null || Array.isArray(statusMap)) {
      throw new Error(`${path}.statusMap must be an object mapping board states to tracker statuses`);
    }
    for (const [state, status] of Object.entries(statusMap as Record<string, unknown>)) {
      if (!CANONICAL_STATES.has(state)) {
        throw new Error(`${path}.statusMap.${state} is not a board state - an unknown key maps nothing`);
      }
      if (!nonEmptyString(status)) throw new Error(`${path}.statusMap.${state} must be a non-empty status name`);
    }
    if (candidate.pull !== undefined) {
      const pull = candidate.pull as Record<string, unknown>;
      if (typeof pull !== "object" || pull === null || Array.isArray(pull)) throw new Error(`${path}.pull must be an object`);
      const unknownPullKey = Object.keys(pull).find((key) => key !== "unstartedStatuses");
      if (unknownPullKey) throw new Error(`${path}.pull.${unknownPullKey} is not allowed (unstartedStatuses)`);
      const statuses = pull.unstartedStatuses;
      if (!Array.isArray(statuses) || statuses.length === 0 || statuses.some((status) => !nonEmptyString(status))) {
        throw new Error(`${path}.pull.unstartedStatuses must be a non-empty array of status names`);
      }
    }
    if (candidate.commit !== undefined) validateCommit(candidate.commit, kind, `${path}.commit`);
  }
  return trackers as Record<string, TrackerConfig>;
}
