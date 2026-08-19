import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where a project's lifecycle ends. `deploy` keeps the full tail
 * (`tested -> delivered -> accepted`): the owner releases the change and accepts it, and
 * sync parks verified items in `for-delivery/` until then. `no-deploy` declares that no
 * such event exists for this project, so `tested` is terminal and sync archives the item
 * as `tested` - archived, never rewritten to `accepted`, because nothing may record an
 * owner action that did not happen (the loops-board skill). */
export const projectLifecycles = ["deploy", "no-deploy"] as const;
export type ProjectLifecycle = (typeof projectLifecycles)[number];

/** The tail an undeclared project keeps: today's behavior, and the conservative one - it
 * costs the owner a manual advance, where guessing `no-deploy` would archive verified work
 * behind their back. */
export const DEFAULT_PROJECT_LIFECYCLE: ProjectLifecycle = "deploy";

export interface ProjectConfig {
  repo?: string;
  integrationBranch?: string;
  landedAdapter?: "github" | "git";
  /** Omit for the default `deploy` tail. */
  lifecycle?: ProjectLifecycle;
  /** Per-project review policy: the same partial shape as the top-level `review` block,
   * merged over it field by field (see `resolveReviewConfig`). Omit to use the global
   * policy unchanged. */
  review?: ReviewConfig;
}

export const reviewAuditPasses = ["diff", "integration", "adversarial"] as const;
export type ReviewAuditPass = (typeof reviewAuditPasses)[number];

export const reviewPriorities = ["P0", "P1", "P2", "P3"] as const;
export type ReviewPriority = (typeof reviewPriorities)[number];

/** How a confirmation round is scoped once the previous round is fully dispositioned and
 * only remediation obligations remain open. "full" runs every configured audit pass over
 * the whole reviewed range - today's behavior, and the one that has caught fix-induced
 * regressions outside the fix. "scoped" runs the obligation-classifying diff pass over the
 * remediation range alone and skips integration and adversarial. Opt-in precisely because
 * the saving and the blind spot are the same thing. */
export const reviewConfirmations = ["full", "scoped"] as const;
export type ReviewConfirmation = (typeof reviewConfirmations)[number];

/** What an undeclared project confirms with: full rounds, so adding the key is the only
 * way to narrow a confirmation round. */
export const DEFAULT_REVIEW_CONFIRMATION: ReviewConfirmation = "full";

/** A review change class: paths matched by function (record-keeping vs executed), never
 * by extension, because a doc whose text gets executed is executable surface. A class
 * waives reviewer findings up to the listed priorities; the waiver is recorded per
 * finding and authorized by this config. */
export interface ReviewClassConfig {
  name: string;
  /** Same pattern shape as `metadataPaths`: exact path or `dir/**`. */
  match: string[];
  /** Priorities a finding on a matched path may be waived at (`waived-by-policy`). */
  waivablePriorities: ReviewPriority[];
  /** Optional reviewer steering for matched paths; cost reduction only; the
   * disposition-side waiver is the enforcement. */
  guidance?: string;
}

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
  /** Change classes authorizing finding-level waivers. Absent: every finding blocks
   * until dispositioned, exactly the pre-class behavior. */
  classes?: ReviewClassConfig[];
  /** Confirmation-round scope. Omit for `DEFAULT_REVIEW_CONFIRMATION`. */
  confirmation?: ReviewConfirmation;
}

function validateProjects(projects: Record<string, ProjectConfig>): Record<string, ProjectConfig> {
  for (const [name, project] of Object.entries(projects)) {
    const lifecycle = project?.lifecycle;
    if (lifecycle !== undefined && !projectLifecycles.includes(lifecycle)) {
      // Named, because an instance carries a dozen projects and a bare "invalid lifecycle"
      // leaves the owner hunting. Thrown rather than defaulted: a typo that silently kept
      // the deploy tail would look exactly like a collapsed tail that quietly did nothing.
      throw new Error(`projects.${name}.lifecycle must be one of ${projectLifecycles.join(", ")}`);
    }
    if (project?.review !== undefined) validateReviewConfig(project.review, `projects.${name}.review`);
  }
  return projects;
}

/** The review policy that governs `project`: the project's `review` block merged over the
 * global one, field by field. List-valued fields replace wholesale (no concatenation - a
 * project that overrides `metadataPaths` states its complete set). No project name, an
 * unregistered name, or a project without an override: the global block unchanged, so
 * behavior without config edits is exactly the pre-override one. Own-property lookup for
 * the same reason as `projectLifecycle`. */
export function resolveReviewConfig(config: LoopsConfig, project?: string): ReviewConfig {
  const entry = project && Object.prototype.hasOwnProperty.call(config.projects, project)
    ? config.projects[project]
    : undefined;
  const override = entry?.review;
  if (!override) return config.review;
  const merged: ReviewConfig = { ...config.review };
  if (override.reviewer !== undefined) merged.reviewer = override.reviewer;
  if (override.model !== undefined) merged.model = override.model;
  if (override.effort !== undefined) merged.effort = override.effort;
  if (override.maxRounds !== undefined) merged.maxRounds = override.maxRounds;
  if (override.auditPasses !== undefined) merged.auditPasses = override.auditPasses;
  if (override.metadataPaths !== undefined) merged.metadataPaths = override.metadataPaths;
  if (override.classes !== undefined) merged.classes = override.classes;
  if (override.confirmation !== undefined) merged.confirmation = override.confirmation;
  return merged;
}

/** The lifecycle tail that governs `project`. An unregistered name, or a registered project
 * that declares none, gets `DEFAULT_PROJECT_LIFECYCLE`. Uses an own-property lookup, so a
 * project named after something on `Object.prototype` ("constructor") reads as undeclared
 * rather than resolving to an inherited member. */
export function projectLifecycle(config: LoopsConfig, project: string): ProjectLifecycle {
  const entry = Object.prototype.hasOwnProperty.call(config.projects, project)
    ? config.projects[project]
    : undefined;
  return entry?.lifecycle ?? DEFAULT_PROJECT_LIFECYCLE;
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

/** The pattern shape shared by `metadataPaths` and class `match` lists: an exact
 * repo-relative path or a `dir/**` prefix, nothing absolute, traversing, or fancier. */
function isSafePathPattern(pattern: unknown): pattern is string {
  return (
    typeof pattern === "string" &&
    pattern.trim() !== "" &&
    !pattern.startsWith("/") &&
    !pattern.split("/").includes("..") &&
    !pattern.includes("\\") &&
    (!pattern.includes("*") || (pattern.endsWith("/**") && !pattern.slice(0, -3).includes("*")))
  );
}

function validateReviewClasses(classes: unknown, label: string): void {
  if (!Array.isArray(classes) || classes.length === 0) {
    throw new Error(`${label} must be a non-empty array of class objects`);
  }
  const names = new Set<string>();
  for (const [index, entry] of classes.entries()) {
    const path = `${label}[${index}]`;
    const candidate = entry as Partial<ReviewClassConfig> | null;
    if (typeof candidate !== "object" || candidate === null) throw new Error(`${path} must be an object`);
    if (typeof candidate.name !== "string" || candidate.name.trim() === "") {
      throw new Error(`${path}.name must be a non-empty string`);
    }
    if (names.has(candidate.name)) {
      // Waivers name their authorizing class, so two classes sharing a name would make
      // the recorded authorization ambiguous.
      throw new Error(`${path}.name duplicates class ${JSON.stringify(candidate.name)}`);
    }
    names.add(candidate.name);
    if (
      !Array.isArray(candidate.match) ||
      candidate.match.length === 0 ||
      new Set(candidate.match).size !== candidate.match.length ||
      candidate.match.some((pattern) => !isSafePathPattern(pattern))
    ) {
      throw new Error(`${path}.match must be a non-empty array of safe repo-relative patterns`);
    }
    if (
      !Array.isArray(candidate.waivablePriorities) ||
      candidate.waivablePriorities.length === 0 ||
      new Set(candidate.waivablePriorities).size !== candidate.waivablePriorities.length ||
      candidate.waivablePriorities.some((priority) => !reviewPriorities.includes(priority))
    ) {
      throw new Error(
        `${path}.waivablePriorities must be a non-empty array containing only ${reviewPriorities.join(", ")}`,
      );
    }
    if (candidate.guidance !== undefined && (typeof candidate.guidance !== "string" || candidate.guidance.trim() === "")) {
      throw new Error(`${path}.guidance must be a non-empty string when present`);
    }
  }
}

/** `label` names the block in errors: the global "review", or "projects.<name>.review" -
 * an instance carries a dozen projects, and a bare message leaves the owner hunting. */
function validateReviewConfig(review: ReviewConfig, label = "review"): ReviewConfig {
  // Guarded before any field is read: a string, number or array exposes no checked
  // field, so it would validate clean and then resolve to the GLOBAL policy - a
  // misconfigured project silently getting the broader one, which is the wrong
  // direction for this file to fail in.
  if (typeof review !== "object" || review === null || Array.isArray(review)) {
    throw new Error(`${label} must be an object`);
  }
  if (
    review.maxRounds !== undefined &&
    (typeof review.maxRounds !== "number" || !Number.isInteger(review.maxRounds) || review.maxRounds < 1)
  ) {
    throw new Error(`${label}.maxRounds must be a positive integer`);
  }
  if (review.effort !== undefined && (typeof review.effort !== "string" || review.effort.trim() === "")) {
    throw new Error(`${label}.effort must be a non-empty string`);
  }
  if (
    review.auditPasses !== undefined &&
    (!Array.isArray(review.auditPasses) ||
      review.auditPasses.length === 0 ||
      new Set(review.auditPasses).size !== review.auditPasses.length ||
      review.auditPasses.some((pass) => !reviewAuditPasses.includes(pass)))
  ) {
    throw new Error(`${label}.auditPasses must be a non-empty array containing only ${reviewAuditPasses.join(", ")}`);
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
    throw new Error(`${label}.metadataPaths must be a non-empty array of safe repo-relative patterns`);
  }
  if (review.confirmation !== undefined && !reviewConfirmations.includes(review.confirmation)) {
    throw new Error(`${label}.confirmation must be one of ${reviewConfirmations.join(", ")}`);
  }
  if (review.classes !== undefined) validateReviewClasses(review.classes, `${label}.classes`);
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
    projects: validateProjects(raw.projects ?? base.projects),
    review: validateReviewConfig(raw.review ?? base.review),
  };
}
