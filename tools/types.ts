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

/** One item file under items/*.md, parsed. */
export interface ItemFile {
  /** Filename without extension, e.g. "atlas-search-index". Also the depends-on target id. */
  slug: string;
  /** Repo-relative path, e.g. "items/atlas-search-index.md". */
  path: string;
  title: string;
  project: string;
  state: string;
  owner: string;
  /** "auto" | "supervised" | "-" (a few legacy items use "-") */
  autonomy: string;
  /** "owner" | "agent" */
  nextActor: string;
  /** Only set when nextActor === "owner": unblock | review-merge | deliver | accept | approve | decide */
  awaiting?: string;
  fit?: string;
  dependsOn: string[];
  nextStep: string;
  /** YYYY-MM-DD */
  updated: string;
  links: Links;
}
