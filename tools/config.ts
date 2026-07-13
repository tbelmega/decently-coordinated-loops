import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectConfig {
  repo?: string;
  integrationBranch?: string;
  landedAdapter?: "github" | "git";
}

export interface LoopsConfig {
  /** The human owner's name. */
  owner: string;
  /** Board priority ranking, highest first. */
  priorityProjects: string[];
  integrationBranch: string;
  landedAdapter: "github" | "git";
  /** GitHub org -> token file path ("~" expanded by the reader, not here). */
  githubTokens: Record<string, string>;
  projects: Record<string, ProjectConfig>;
}

function defaults(): LoopsConfig {
  return {
    owner: "",
    priorityProjects: [],
    integrationBranch: "master",
    landedAdapter: "git",
    githubTokens: {},
    projects: {},
  };
}

/** Loads `loops.json` from the data-repo root. A missing file yields all defaults
 * (owner ""). A present file is merged field-by-field over the defaults, so a
 * partial config (e.g. just `{"owner": "casey"}`) still gets sane values for
 * everything it doesn't set. Pure aside from the one file read. */
export function loadConfig(root: string): LoopsConfig {
  const path = join(root, "loops.json");
  const base = defaults();
  if (!existsSync(path)) return base;

  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LoopsConfig>;
  return {
    owner: raw.owner ?? base.owner,
    priorityProjects: raw.priorityProjects ?? base.priorityProjects,
    integrationBranch: raw.integrationBranch ?? base.integrationBranch,
    landedAdapter: raw.landedAdapter ?? base.landedAdapter,
    githubTokens: raw.githubTokens ?? base.githubTokens,
    projects: raw.projects ?? base.projects,
  };
}
