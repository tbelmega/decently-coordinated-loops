import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectConfig {
  repo?: string;
  integrationBranch?: string;
  landedAdapter?: "github" | "git";
}

export const reviewAuditPasses = ["diff", "integration", "adversarial"] as const;
export type ReviewAuditPass = (typeof reviewAuditPasses)[number];

/** Local code-review adapter selection. Empty (no `reviewer`) means review is not
 * activated for this instance; `bun run setup` offers to fill it in. */
export interface ReviewConfig {
  /** Which bundled reviewer adapter to drive: "codex" | "claude" | "cursor". */
  reviewer?: string;
  /** Optional model id override; omit to use the reviewer CLI's own default. */
  model?: string;
  /** Reasoning-effort override passed to the reviewer CLI (codex: model_reasoning_effort);
   * omit to use the CLI's own default. */
  effort?: string;
  /** Maximum review rounds for one item and patch series. A patch-equivalent rebase
   * retains the count while a changed patch series starts new evidence, so a reused
   * or long-lived branch does not inherit an earlier item's rounds. Omit to use DCL's
   * public default. */
  maxRounds?: number;
  /** Independent audit passes combined into one logical review round. */
  auditPasses?: ReviewAuditPass[];
  /** Repo-relative landing metadata paths that may change after terminal review. */
  metadataPaths?: string[];
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
  review: ReviewConfig;
}

function defaults(): LoopsConfig {
  return {
    owner: "",
    priorityProjects: [],
    integrationBranch: "master",
    landedAdapter: "git",
    githubTokens: {},
    projects: {},
    review: {},
  };
}

function validateReviewConfig(review: ReviewConfig): ReviewConfig {
  if (
    review.maxRounds !== undefined &&
    (typeof review.maxRounds !== "number" || !Number.isInteger(review.maxRounds) || review.maxRounds < 1)
  ) {
    throw new Error("review.maxRounds must be a positive integer");
  }
  if (review.effort !== undefined && (typeof review.effort !== "string" || review.effort.trim() === "")) {
    throw new Error("review.effort must be a non-empty string");
  }
  if (
    review.auditPasses !== undefined &&
    (!Array.isArray(review.auditPasses) ||
      review.auditPasses.length === 0 ||
      new Set(review.auditPasses).size !== review.auditPasses.length ||
      review.auditPasses.some((pass) => !reviewAuditPasses.includes(pass)))
  ) {
    throw new Error(`review.auditPasses must be a non-empty array containing only ${reviewAuditPasses.join(", ")}`);
  }
  if (
    review.metadataPaths !== undefined &&
    (!Array.isArray(review.metadataPaths) ||
      review.metadataPaths.length === 0 ||
      new Set(review.metadataPaths).size !== review.metadataPaths.length ||
      review.metadataPaths.some(
        (pattern) =>
          typeof pattern !== "string" ||
          pattern.trim() === "" ||
          pattern.startsWith("/") ||
          pattern.split("/").includes("..") ||
          pattern.includes("\\") ||
          (pattern.includes("*") && (!pattern.endsWith("/**") || pattern.slice(0, -3).includes("*"))),
      ))
  ) {
    throw new Error("review.metadataPaths must be a non-empty array of safe repo-relative patterns");
  }
  return review;
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
    review: validateReviewConfig(raw.review ?? base.review),
  };
}
