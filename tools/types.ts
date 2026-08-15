// Shared types for the board core (parse / validate / render / preflight).
// Pure domain logic only — no file IO here (see parse.ts for the IO boundary).

export interface Links {
  [key: string]: string | undefined;
  spec?: string;
  branch?: string;
  pr?: string;
  ticket?: string;
  repo?: string;
  stackParent?: string;
  baseSha?: string;
  headSha?: string;
}

export interface ExecutionLocation {
  host?: string;
  worktree?: string;
}

/** One item file under items/*.md, parsed. */
export interface ItemFile {
  /** Filename without extension, e.g. "atlas-search-index". Also the depends-on target id. */
  slug: string;
  /** Repo-relative path, e.g. "items/atlas-search-index.md". */
  path: string;
  title: string;
  project: string;
  state: string;
  /** Durable harness/account-or-slot lane responsible for advancing the item. */
  assignee: string;
  /** Present only when frontmatter carries both `assignee` and legacy `owner`. */
  legacyOwner?: string;
  /** Which key the assignment was read from, or undefined when the item carries neither.
   *  Identifies the schema generation an item was last written under: `owner` predates the
   *  assignee/execution split, so rules introduced with `execution` do not bind it. */
  assignmentKey?: "assignee" | "owner";
  /** Last-recorded location of live work; descriptive, not a liveness signal. */
  execution?: ExecutionLocation;
  /** YAML-boundary violations retained for the schema validator. */
  frontmatterErrors?: string[];
  /** "auto" | "supervised" | "-" (a few legacy items use "-") */
  autonomy: string;
  /** "owner" | "agent" */
  nextActor: string;
  /** Only set when nextActor === "owner": unblock | review-merge | deliver | accept | approve | decide */
  awaiting?: string;
  fit?: string;
  /** "waived" — the owner's explicit call that no spec is needed despite the item's
   *  size (loops-pickup → Spec gate). Absent for every other item. */
  spec?: string;
  dependsOn: string[];
  nextStep: string;
  /** YYYY-MM-DD */
  updated: string;
  links: Links;
}
