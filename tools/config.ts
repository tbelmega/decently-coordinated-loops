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

/** Persona brief names (C3): the legacy audit passes plus the unified confirmation
 * persona that carries rounds 2+ in the persona engine. */
export const reviewPersonaNames = ["diff", "integration", "adversarial", "confirmation"] as const;
export type ReviewPersonaName = (typeof reviewPersonaNames)[number];

/** DCL's public default round cap, shared by the round-continue gate and the persona
 * coverage validation. */
export const DEFAULT_REVIEW_MAX_ROUNDS = 3;

/** One persona of the C3 engine: a built-in brief bound to a round range, optionally
 * with its own reviewer CLI, model, and effort. Every persona whose range covers the
 * current logical round runs, concurrently - overlapping ranges are the point. */
export interface ReviewPersonaConfig {
  name: ReviewPersonaName;
  /** First logical round this persona runs in (>= 1). */
  fromRound: number;
  /** Last round, inclusive; omitted means unbounded, so the persona survives an
   * owner-raised --max-rounds. */
  toRound?: number;
  /** Per-persona adapter; omit for the review block's reviewer. */
  reviewer?: string;
  model?: string;
  effort?: string;
}

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

/** Severity floor (C1 of the convergence spec): `false` keeps today's brief and
 * terminal predicate in every round; `"round-2-plus"` makes rounds after the first
 * report only new P0/P1 as findings and return P2/P3 as non-blocking notes;
 * `"all-rounds"` applies that contract to round 1 as well (the MVP posture). The
 * code default is `false` permanently - an instance opts in when its measurement
 * window begins. */
export const reviewSeverityFloors = [false, "round-2-plus", "all-rounds"] as const;
export type ReviewSeverityFloor = (typeof reviewSeverityFloors)[number];

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
  /** Severity floor (C1). Omit for `false`: today's behavior in every round. */
  severityFloor?: ReviewSeverityFloor;
  /** Personas as first-class config (C3). Replaces `auditPasses`: declaring both is
   * a validation error, and an existing `auditPasses` config keeps today's
   * sequential engine untouched. */
  personas?: ReviewPersonaConfig[];
  /** Cap exits (C7): with `true`, an item at the round cap whose only open work is
   * P2/P3 passes with residual notes instead of blocking (open P0/P1 obligations, a
   * rejected P0/P1 awaiting its confirmation round, and deferred-to-human still
   * block), and `start` warns when the decline ratio has been non-positive for two
   * consecutive completed rounds. Omit for `false`: the cap blocks as today. */
  capExit?: boolean;
  /** Permit evidenced P1-P3 remediation at the cap without independent re-review.
   * Off unless explicitly enabled by the governing policy. */
  testBackedCapExit?: boolean;
  /** Terminal rejection (C4): with `true`, a rejected P2/P3 finding needs no
   * confirmation round - terminal and non-remediation like waived-by-policy - while
   * a rejected P0/P1 keeps one, its rejection reason handed to the reviewer as the
   * claim to refute. Omit for `false`: every rejection gets a confirmation round. */
  terminalRejection?: boolean;
  /** Named review profiles (C8), global block only. A profile bundles LOOP CONTROLS
   * exclusively - the allow-listed keys of ReviewProfileConfig - so selecting one can
   * never widen waivers, loosen staleness policy, or grant governance authority. */
  profiles?: Record<string, ReviewProfileConfig>;
  /** Profile selection (C8): the named profile is overlaid on the global block before
   * this project's remaining field overrides. Item-level selection (via an
   * owner-approved spec) takes precedence at `start`. */
  profile?: string;
}

/** The allow-listed shape of a review profile (C8): loop controls only. */
export interface ReviewProfileConfig {
  maxRounds?: number;
  severityFloor?: ReviewSeverityFloor;
  terminalRejection?: boolean;
  capExit?: boolean;
  testBackedCapExit?: boolean;
  confirmation?: ReviewConfirmation;
  personas?: ReviewPersonaConfig[];
}

const PROFILE_ALLOWED_KEYS = [
  "maxRounds",
  "severityFloor",
  "terminalRejection",
  "capExit",
  "testBackedCapExit",
  "confirmation",
  "personas",
] as const;

/** Overlays the named profile on a review block (C8). Throws on an unknown name -
 * selection fails closed, never silently falls back to the broader policy. A profile
 * that sets personas drops an inherited legacy auditPasses so the merged block stays
 * valid; the reviewer, model, effort, classes, and metadataPaths of the base block
 * are untouchable from a profile by construction. */
export function applyReviewProfile(review: ReviewConfig, name: string): ReviewConfig {
  const profile =
    review.profiles && Object.prototype.hasOwnProperty.call(review.profiles, name)
      ? review.profiles[name]
      : undefined;
  if (!profile) throw new Error(`review profile "${name}" is not defined in review.profiles`);
  const merged: ReviewConfig = { ...review };
  if (profile.maxRounds !== undefined) merged.maxRounds = profile.maxRounds;
  if (profile.severityFloor !== undefined) merged.severityFloor = profile.severityFloor;
  if (profile.terminalRejection !== undefined) merged.terminalRejection = profile.terminalRejection;
  if (profile.capExit !== undefined) merged.capExit = profile.capExit;
  if (profile.testBackedCapExit !== undefined) merged.testBackedCapExit = profile.testBackedCapExit;
  if (profile.confirmation !== undefined) merged.confirmation = profile.confirmation;
  if (profile.personas !== undefined) {
    merged.personas = profile.personas;
    delete merged.auditPasses;
  }
  return merged;
}

/** Whether the resolved policy needs the priority taxonomy in the prompt: on
 * whenever any key that depends on the P0-P3 definitions is enabled, derived here
 * rather than keyed separately so a dependent feature never runs against undefined
 * priorities. Scoped confirmation under personas depends on it too: its mandatory
 * widening reads obligation P0 grades. */
export function taxonomyEnabled(review: Pick<ReviewConfig, "severityFloor" | "terminalRejection" | "capExit" | "testBackedCapExit" | "personas" | "confirmation">): boolean {
  return (
    Boolean(review.severityFloor) ||
    Boolean(review.terminalRejection) ||
    Boolean(review.capExit) ||
    Boolean(review.testBackedCapExit) ||
    (review.personas !== undefined && review.confirmation === "scoped")
  );
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
export function resolveReviewConfig(
  config: LoopsConfig,
  project?: string,
  /** A profile name selects that profile; `null` is the explicit no-profile state,
   * which suppresses the project/global selection instead of falling back to it. A
   * review that started unprofiled has to keep resolving unprofiled, whatever the
   * configuration selects later. */
  profileOverride?: string | null,
): ReviewConfig {
  const entry = project && Object.prototype.hasOwnProperty.call(config.projects, project)
    ? config.projects[project]
    : undefined;
  const override = entry?.review;
  // C8 resolution order: global block, then the named profile overlaid, then the
  // project's remaining field overrides. An item-level selection (profileOverride,
  // authorized at `start` by the owner-approved spec) beats the project's own.
  const profileName =
    profileOverride === null ? undefined : profileOverride ?? override?.profile ?? config.review.profile;
  const base = profileName !== undefined ? applyReviewProfile(config.review, profileName) : config.review;
  if (!override) return base;
  const merged: ReviewConfig = { ...base };
  if (override.reviewer !== undefined) merged.reviewer = override.reviewer;
  if (override.model !== undefined) merged.model = override.model;
  if (override.effort !== undefined) merged.effort = override.effort;
  if (override.maxRounds !== undefined) merged.maxRounds = override.maxRounds;
  if (override.metadataPaths !== undefined) merged.metadataPaths = override.metadataPaths;
  if (override.classes !== undefined) merged.classes = override.classes;
  if (override.confirmation !== undefined) merged.confirmation = override.confirmation;
  if (override.severityFloor !== undefined) merged.severityFloor = override.severityFloor;
  if (override.terminalRejection !== undefined) merged.terminalRejection = override.terminalRejection;
  if (override.capExit !== undefined) merged.capExit = override.capExit;
  if (override.testBackedCapExit !== undefined) merged.testBackedCapExit = override.testBackedCapExit;
  // The two pass engines are one replace-wholesale field: an override selecting either
  // engine clears the other, so a merged policy can never carry both (block-level
  // validation already rejects a single block declaring both).
  if (override.personas !== undefined) {
    merged.personas = override.personas;
    delete merged.auditPasses;
  } else if (override.auditPasses !== undefined) {
    merged.auditPasses = override.auditPasses;
    delete merged.personas;
  }
  if (merged.personas !== undefined) validateReviewPersonas(merged, "resolved review.personas");
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
  if (review.severityFloor !== undefined && !reviewSeverityFloors.includes(review.severityFloor)) {
    throw new Error(`${label}.severityFloor must be one of false, "round-2-plus", "all-rounds"`);
  }
  if (review.terminalRejection !== undefined && typeof review.terminalRejection !== "boolean") {
    throw new Error(`${label}.terminalRejection must be a boolean`);
  }
  if (review.capExit !== undefined && typeof review.capExit !== "boolean") {
    throw new Error(`${label}.capExit must be a boolean`);
  }
  if (review.testBackedCapExit !== undefined && typeof review.testBackedCapExit !== "boolean") {
    throw new Error(`${label}.testBackedCapExit must be a boolean`);
  }
  if (review.personas !== undefined) validateReviewPersonas(review, `${label}.personas`);
  if (review.profile !== undefined && (typeof review.profile !== "string" || review.profile.trim() === "")) {
    throw new Error(`${label}.profile must be a non-empty string`);
  }
  if (review.profiles !== undefined) {
    if (label !== "review") {
      throw new Error(`${label}.profiles: profiles are defined on the global review block only`);
    }
    if (typeof review.profiles !== "object" || review.profiles === null || Array.isArray(review.profiles)) {
      throw new Error(`${label}.profiles must be an object of named profiles`);
    }
    for (const [name, profile] of Object.entries(review.profiles)) {
      const path = `${label}.profiles.${name}`;
      if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
        throw new Error(`${path} must be an object`);
      }
      for (const key of Object.keys(profile)) {
        if (!(PROFILE_ALLOWED_KEYS as readonly string[]).includes(key)) {
          // classes, metadataPaths, rewrites, reviewer - every non-loop-control by name:
          // a profile must never widen waivers, loosen staleness policy, or grant
          // governance authority.
          throw new Error(`${path}.${key} is not an allowed profile field (loop controls only: ${PROFILE_ALLOWED_KEYS.join(", ")})`);
        }
      }
      validateReviewConfig(profile as ReviewConfig, path);
    }
  }
  if (review.classes !== undefined) validateReviewClasses(review.classes, `${label}.classes`);
  return review;
}

/** Fails closed on every malformed persona shape (C3): an unknown name or reviewer,
 * a broken round range, a missing or duplicated confirmation persona, a confirmation
 * range that does not cover every round from 2 up, a round inside the configured cap
 * that no persona covers, or `auditPasses` declared alongside. Migration to personas
 * means writing the block, never a mechanical translation. */
function validateReviewPersonas(review: ReviewConfig, label: string): void {
  const personas = review.personas!;
  if (review.auditPasses !== undefined) {
    throw new Error(`${label} and auditPasses are mutually exclusive - migrate by writing a personas block`);
  }
  if (!Array.isArray(personas) || personas.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  personas.forEach((persona, index) => {
    const path = `${label}[${index}]`;
    if (typeof persona !== "object" || persona === null || Array.isArray(persona)) {
      throw new Error(`${path} must be an object`);
    }
    if (!reviewPersonaNames.includes(persona.name)) {
      throw new Error(`${path}.name must be one of ${reviewPersonaNames.join(", ")}`);
    }
    if (typeof persona.fromRound !== "number" || !Number.isInteger(persona.fromRound) || persona.fromRound < 1) {
      throw new Error(`${path}.fromRound must be an integer >= 1`);
    }
    if (
      persona.toRound !== undefined &&
      (typeof persona.toRound !== "number" || !Number.isInteger(persona.toRound) || persona.toRound < persona.fromRound)
    ) {
      throw new Error(`${path}.toRound must be an integer >= fromRound when present`);
    }
    if (persona.reviewer !== undefined && !["codex", "claude", "cursor"].includes(persona.reviewer)) {
      throw new Error(`${path}.reviewer must be one of codex, claude, cursor`);
    }
    for (const key of ["model", "effort"] as const) {
      const value = persona[key];
      if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
        throw new Error(`${path}.${key} must be a non-empty string when present`);
      }
    }
  });
  const confirmations = personas.filter((persona) => persona.name === "confirmation");
  if (confirmations.length !== 1) {
    throw new Error(`${label} must declare exactly one confirmation persona`);
  }
  const confirmation = confirmations[0]!;
  if (confirmation.fromRound > 2 || confirmation.toRound !== undefined) {
    throw new Error(`${label}: the confirmation persona must cover every round from 2 up (fromRound <= 2, no toRound)`);
  }
  const cap = review.maxRounds ?? DEFAULT_REVIEW_MAX_ROUNDS;
  for (let round = 1; round <= cap; round += 1) {
    const covered = personas.some(
      (persona) => persona.fromRound <= round && (persona.toRound === undefined || round <= persona.toRound),
    );
    if (!covered) throw new Error(`${label}: no persona covers round ${round} (cap ${cap})`);
  }
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
