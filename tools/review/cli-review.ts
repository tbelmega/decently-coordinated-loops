#!/usr/bin/env bun
// `bun cli-review.ts <start|disposition|status> [options]` - drive a local, forge-independent
// code review of the committed change on the current branch, using the reviewer
// adapter this instance activated (loops.json → review). Runs from the *target* repo,
// like the participation gate; resolve the data repo via --data-repo or $LOOPS_DATA_REPO.
//
// Each `start` is independent and reviews the full base..HEAD change; the ledger under
// .reviews/ carries rounds + per-finding dispositions and fails closed on a dirty tree,
// a changed HEAD, a mismatched base, or the round cap. The reviewer never edits/commits.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  DEFAULT_REVIEW_MAX_ROUNDS,
  loadConfig,
  resolveReviewConfig,
  reviewAuditPasses,
  taxonomyEnabled,
  type LoopsConfig,
  type ReviewAuditPass,
  type ReviewClassConfig,
  type ReviewConfig,
  type ReviewConfirmation,
  type ReviewPersonaConfig,
  type ReviewPersonaName,
  type ReviewSeverityFloor,
} from "../config.ts";
import { matchingClasses } from "./review-classes.ts";
import { runStats, type StatsOptions } from "./review-stats.ts";
import { resolveDataRepo } from "./data-repo.ts";
import { parseItemFileText } from "../parse.ts";
import {validateItem} from "../validate.ts";
import { expandHome, matchProject } from "../registration.ts";
import {
  addReviewRound,
  activeReviewEpoch,
  carryForwardDispositions,
  createReviewLedger,
  effectiveMaxRounds,
  liveRounds,
  openObligations,
  parseReviewLedger,
  type ReviewAuthority,
  priorDispositionNotes,
  recordDisposition,
  recordReviewFailure,
  remediationChurnTripwire,
  renderReviewLedger,
  reviewRoundIdentifier,
  reviewCanContinue,
  supersedeLedgerBase,
  isDispositionKind,
  isFindingCausality,
  validateEvidencePath,
  type DispositionKind,
  type FindingCausality,
  type ReviewLedger,
  type ReviewRoundAudit,
  type ReviewStepBack,
} from "./review-ledger.ts";
import {
  auditFindingIdentity,
  combineReviewPasses,
  computeReviewMetrics,
  parseReviewPass,
  type PriorFindingIdentity,
  type ReviewPassResult,
  type ReviewPassStats,
} from "./review-audit.ts";
import {
  buildReviewManifest,
  matchesMetadataPath,
  type ReviewContextReference,
  type ReviewManifest,
} from "./review-manifest.ts";
import { acquireReviewLock } from "./review-lock.ts";
import { writeFileAtomically } from "./atomic-write.ts";
import { getReviewer, isReviewerId, reviewerIds, type Reviewer } from "./reviewers.ts";
import { reviewPrompt, type ReviewContextDocument } from "./review-prompt.ts";
import {
  evaluateReviewStatus,
  renderReviewStatus,
  reviewEvidencePaths,
  type ReviewStatus,
} from "./review-status.ts";

/** One reviewer invocation of a round: a persona (or legacy pass) bound to its
 * adapter, model, and effort. */
interface PlannedPass {
  pass: ReviewPersonaName;
  reviewer: Reviewer;
  model?: string;
  effort?: string;
}

interface StartOptions {
  baseRef: string;
  item?: string;
  reviewer: Reviewer;
  model?: string;
  /** Reasoning-effort override from config or `--effort`; undefined uses the CLI default. */
  effort?: string;
  /** Effective round cap from config or an owner-authorized `--max-rounds` override. */
  maxRounds?: number;
  /** Step-back note path answering an armed remediation-churn tripwire (C1). */
  stepBack?: string;
  auditPasses: ReviewAuditPass[];
  metadataPaths: string[];
  /** Resolved confirmation-round scope; undefined behaves as "full". */
  confirmation?: ReviewConfirmation;
  /** Severity floor (C1); undefined behaves as `false` - today's brief everywhere. */
  severityFloor?: ReviewSeverityFloor;
  /** Terminal rejection (C4); undefined behaves as `false` - every rejection confirms. */
  terminalRejection?: boolean;
  /** Cap exits (C7); undefined behaves as `false` - the cap blocks as today. */
  capExit?: boolean;
  /** C8: the profile the project/global selection names; an item-level selection
   * (authorized by its spec) replaces it at start. */
  profileName?: string;
  applyProfile?: (name: string) => ReviewConfig;
  /** An explicit --max-rounds keeps owner precedence over a profile's cap. */
  maxRoundsFlag?: number;
  /** Explicit run-level `--reviewer` / `--model` / `--effort`. Kept apart from the
   * resolved defaults because they outrank a persona's own values: the skill promises
   * these flags override configuration for one run, which is what makes a diagnostic
   * or fallback run possible when a configured persona choice is unavailable. */
  reviewerFlag?: Reviewer;
  modelFlag?: string;
  effortFlag?: string;
  /** Persona engine (C3); undefined keeps the legacy auditPasses engine. */
  personas?: ReviewPersonaConfig[];
  /** C2 shadow instrument: on a scoped round, also run the round-1 personas over the
   * full range, recorded under audit.shadow and never blocking. */
  shadowFull?: boolean;
  /** The policy authority to stamp on a ledger this run creates: the canonical data-repo
   * root plus the project whose review block was resolved. Undefined when no data repo
   * is resolvable, and such a ledger can never authorize a class waiver. */
  authority?: ReviewAuthority;
  dataRepo?: string;
}

/** spawnSync's default maxBuffer is 1 MiB, and a review range's diff outgrows that long before
 * anything else strains. When it does, spawnSync sets `status` to null with an empty stderr -
 * so the throw below fell back to "git <args> failed" with no cause attached, and a whole round
 * died on a message that named the command and nothing else. Observed 2026-08-08 on a range
 * whose diff had reached 1,093,049 bytes; `git diff` run by hand on the same SHAs succeeded,
 * which is what makes this class of failure so slow to place.
 *
 * 16 MiB matches MAX_OUTPUT_BYTES in reviewers.ts, where the same ceiling was already fixed for
 * the reviewer subprocess - the git side simply never got the same treatment. */
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES });
  if (result.error) throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr?.toString().trim() || `git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

/** The registered project whose `repo` matches the reviewed checkout, resolved exactly
 * like the participation gate (cli-registered.ts): a linked worktree also matches via its
 * main checkout root, and both sides are canonicalized (tilde expansion, symlink
 * resolution). Not a git checkout, or no match: undefined - the global review policy,
 * which also keeps the data repo itself on the default. Never derived from the item slug:
 * the slug's project prefix is a naming convention, not an identity. */
/** Tilde-expanded, resolved, symlink-free form of a path. Falls back to the lexical
 * form when the path does not exist, because a missing path must still compare
 * deterministically rather than throw. */
function canonicalPath(path: string, home = process.env.HOME ?? homedir()): string {
  const expanded = resolve(expandHome(path, home));
  try {
    return realpathSync.native(expanded);
  } catch {
    return expanded;
  }
}

/** The review policy that governs an existing ledger, or the reason none does.
 *
 * This is the single resolution point for everything the class configuration decides:
 * waiver authorization at `disposition`, waiver re-authorization at `status`, and
 * reviewer guidance at `start`. It is one function because four review rounds each
 * found the next consumer that had been resolved somewhere else
 * - the invariant list and why this shape is the fix are in
 * docs/design/review-policy-authority.md.
 *
 * Every leg fails closed to "no classes", never to the global block, which is the
 * broader policy: no recorded authority, no resolvable data repo, a different data repo,
 * a project that has left the config, or a project whose `repo` no longer names the
 * checkout this review started on. */
function governingPolicy(
  ledger: ReviewLedger,
  dataRepoFlag: string | undefined,
): { review?: ReviewConfig; refusal: string | null } {
  const authority = ledger.authority;
  if (!authority) {
    return {refusal: "this review ledger records no policy authority"};
  }
  const home = process.env.HOME ?? homedir();
  const resolvedRoot = resolveDataRepo(dataRepoFlag, process.env, home);
  if (!resolvedRoot) return {refusal: "no data repo resolved (--data-repo or $LOOPS_DATA_REPO)"};
  const canonical = canonicalPath(resolvedRoot, home);
  if (canonical !== authority.dataRepo) {
    return {refusal: `data repo ${canonical} is not this review's policy authority ${authority.dataRepo}`};
  }
  const config = loadConfig(resolvedRoot);
  if (authority.project) {
    const entry = Object.prototype.hasOwnProperty.call(config.projects, authority.project)
      ? config.projects[authority.project]
      : undefined;
    if (!entry) {
      return {refusal: `project ${authority.project}, which authorized this review, is no longer registered in ${canonical}`};
    }
    // A registered name is not an identity. If the entry has been repointed at another
    // checkout, its policy is now somebody else's and must not govern this review.
    //
    // A recorded project always came from matching that project's `repo` against the
    // reviewed checkout, so an authority naming a project without one cannot be checked
    // and is refused rather than waved through. Skipping the check when the field is
    // absent would make a ledger in the older shape the way around it.
    if (!authority.projectRepo) {
      return {
        refusal:
          `this review's authority records project ${authority.project} without the checkout it pointed at, so a repointed project cannot be ruled out`,
      };
    }
    const entryRepo = entry.repo ? canonicalPath(entry.repo, home) : undefined;
    if (entryRepo !== authority.projectRepo) {
      return {
        refusal:
          `project ${authority.project} now points at ${entryRepo ?? "no repo"}, not the ${authority.projectRepo} this review started on`,
      };
    }
    // The same invariant from the other side: the ledger must still be consumed IN the
    // checkout the recorded project names. Checking only the config half would let an
    // otherwise valid ledger, copied into another checkout at the same branch and HEAD,
    // keep being authorized by the classes of the project it came from. A linked
    // worktree of that checkout counts, exactly as it does for the participation gate.
    if (!reviewedRoots(home).includes(authority.projectRepo)) {
      return {
        refusal:
          `this checkout is not the ${authority.projectRepo} that project ${authority.project} authorized this review for`,
      };
    }
  }
  // C8: a ledger bound to a profile is re-resolved against that binding at every
  // gate; a profile that has vanished from the config fails closed like a vanished
  // authority rather than silently reverting to the broader policy. An UNBOUND ledger
  // resolves explicitly unprofiled: a profile the project or global block selects
  // after the review started must not certify rounds that never ran under it. `start`
  // is where a changed selection is refused; here the binding simply governs.
  try {
    return {
      refusal: null,
      review: resolveReviewConfig(config, authority.project, ledger.profile ?? null),
    };
  } catch (error: unknown) {
    return {
      refusal: `this review is bound to profile ${JSON.stringify(ledger.profile ?? "")}, which no longer resolves: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The identities the current checkout can be registered under: its own root and, for a
 * linked worktree, the main checkout's - the same pair `cli-registered` matches on, so a
 * worktree of a registered repo is that repo. Canonicalized. Empty outside a checkout. */
function reviewedRoots(home: string): string[] {
  const roots = spawnSync(
    "git",
    ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  );
  if (roots.status !== 0) return [];
  const [worktreeRoot, commonDir] = roots.stdout.toString().trim().split("\n");
  if (!worktreeRoot) return [];
  const mainCheckoutRoot = commonDir ? commonDir.replace(/\/\.git\/?$/, "") : worktreeRoot;
  return [...new Set([worktreeRoot, mainCheckoutRoot].map((path) => canonicalPath(path, home)))];
}

function reviewedProjectName(config: LoopsConfig, home: string): string | undefined {
  const roots = reviewedRoots(home);
  if (roots.length === 0) return undefined;
  return matchProject(config.projects, roots, (path) => canonicalPath(path, home)) ?? undefined;
}

/** The review policy governing the CURRENT checkout: the data repo's loops.json (from
 * --data-repo or $LOOPS_DATA_REPO) with the reviewed repository's registered project
 * merged over the global block. Undefined when no data repo is resolvable. */
function resolveReviewPolicy(dataRepoFlag?: string): {
  review?: ReviewConfig;
  dataRepo?: string;
  project?: string;
  projectRepo?: string;
  profileName?: string;
  applyProfile?: (name: string) => ReviewConfig;
} {
  const home = process.env.HOME ?? homedir();
  const dataRepo = resolveDataRepo(dataRepoFlag, process.env, home);
  const config = dataRepo ? loadConfig(dataRepo) : undefined;
  const project = config ? reviewedProjectName(config, home) : undefined;
  const review = config ? resolveReviewConfig(config, project) : undefined;
  const projectEntry = project && config ? config.projects[project] : undefined;
  const projectRepo = projectEntry?.repo ? canonicalPath(projectEntry.repo, home) : undefined;
  // C8: the profile the project (or global) selection names, and a re-resolver for an
  // item-level selection - resolution order stays inside resolveReviewConfig.
  const profileName = projectEntry?.review?.profile ?? config?.review.profile;
  const loops = config;
  return {
    ...(review ? { review } : {}),
    ...(dataRepo ? { dataRepo } : {}),
    ...(project ? { project } : {}),
    ...(projectRepo ? { projectRepo } : {}),
    ...(profileName !== undefined ? { profileName } : {}),
    ...(loops
      ? { applyProfile: (name: string): ReviewConfig => resolveReviewConfig(loops, project, name) }
      : {}),
  };
}

/** Resolves which reviewer + model to use: explicit flags win, else the resolved
 * review policy (see resolveReviewPolicy). */
function resolveReviewer(flags: { reviewer?: string; dataRepo?: string; model?: string; effort?: string }): {
  reviewer: Reviewer;
  model?: string;
  effort?: string;
  maxRounds?: number;
  auditPasses: ReviewAuditPass[];
  metadataPaths: string[];
  confirmation?: ReviewConfirmation;
  severityFloor?: ReviewSeverityFloor;
  terminalRejection?: boolean;
  capExit?: boolean;
  personas?: ReviewPersonaConfig[];
  profileName?: string;
  applyProfile?: (name: string) => ReviewConfig;
  authority?: ReviewAuthority;
  dataRepo?: string;
} {
  const { review, dataRepo, project, projectRepo, profileName, applyProfile } = resolveReviewPolicy(flags.dataRepo);
  const id = flags.reviewer ?? review?.reviewer;
  if (!id) {
    throw new Error(
      "no reviewer configured - set review.reviewer in loops.json (run setup) or pass --reviewer <" +
        reviewerIds.join("|") +
        ">",
    );
  }
  if (!isReviewerId(id)) throw new Error(`unknown reviewer "${id}" - expected one of ${reviewerIds.join(", ")}`);
  return {
    reviewer: getReviewer(id),
    model: flags.model ?? review?.model,
    effort: flags.effort ?? review?.effort,
    maxRounds: review?.maxRounds,
    auditPasses: review?.auditPasses ?? [...reviewAuditPasses],
    metadataPaths: review?.metadataPaths ?? [],
    ...(review?.confirmation ? { confirmation: review.confirmation } : {}),
    ...(review?.severityFloor ? { severityFloor: review.severityFloor } : {}),
    ...(review?.terminalRejection ? { terminalRejection: review.terminalRejection } : {}),
    ...(review?.capExit ? { capExit: review.capExit } : {}),
    ...(review?.personas ? { personas: review.personas } : {}),
    ...(profileName !== undefined ? { profileName } : {}),
    ...(applyProfile ? { applyProfile } : {}),
    ...(dataRepo
      ? {
          authority: {
            dataRepo: canonicalPath(dataRepo),
            ...(project ? { project } : {}),
            ...(projectRepo ? { projectRepo } : {}),
          },
        }
      : {}),
    dataRepo,
  };
}

function parseStartOptions(args: string[]): StartOptions {
  const flags: { reviewer?: string; dataRepo?: string; model?: string; effort?: string; item?: string } = {};
  let baseRef = "";
  let maxRounds: number | undefined;
  let stepBack: string | undefined;
  let shadowFull = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--shadow-full") {
      shadowFull = true;
      continue;
    }
    if (arg === "--base" && value) baseRef = value;
    else if (arg === "--data-repo" && value) flags.dataRepo = value;
    else if (arg === "--reviewer" && value) flags.reviewer = value;
    else if (arg === "--model" && value) flags.model = value;
    else if (arg === "--effort" && value) flags.effort = value;
    else if (arg === "--item" && value) flags.item = value;
    else if (arg === "--step-back" && value) stepBack = value;
    else if (arg === "--max-rounds" && value) {
      maxRounds = Number(value);
      if (!Number.isInteger(maxRounds) || maxRounds < 1) {
        throw new Error("--max-rounds must be a positive integer");
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    } else continue;
    index += 1;
  }
  if (!baseRef) throw new Error("start requires --base <ref>");
  const configured = resolveReviewer(flags);
  return {
    baseRef,
    item: flags.item,
    reviewer: configured.reviewer,
    model: configured.model,
    effort: configured.effort,
    maxRounds: maxRounds ?? configured.maxRounds,
    ...(maxRounds !== undefined ? {maxRoundsFlag: maxRounds} : {}),
    ...(flags.reviewer !== undefined && isReviewerId(flags.reviewer)
      ? {reviewerFlag: getReviewer(flags.reviewer)}
      : {}),
    ...(flags.model !== undefined ? {modelFlag: flags.model} : {}),
    ...(flags.effort !== undefined ? {effortFlag: flags.effort} : {}),
    ...(stepBack ? {stepBack} : {}),
    auditPasses: configured.auditPasses,
    metadataPaths: configured.metadataPaths,
    ...(configured.confirmation ? {confirmation: configured.confirmation} : {}),
    ...(configured.severityFloor ? {severityFloor: configured.severityFloor} : {}),
    ...(configured.terminalRejection ? {terminalRejection: configured.terminalRejection} : {}),
    ...(configured.capExit ? {capExit: configured.capExit} : {}),
    ...(configured.personas ? {personas: configured.personas} : {}),
    ...(configured.profileName !== undefined ? {profileName: configured.profileName} : {}),
    ...(configured.applyProfile ? {applyProfile: configured.applyProfile} : {}),
    ...(shadowFull ? {shadowFull: true} : {}),
    ...(configured.authority ? {authority: configured.authority} : {}),
    dataRepo: configured.dataRepo,
  };
}

function readLedger(path: string): ReviewLedger {
  return parseReviewLedger(JSON.parse(readFileSync(path, "utf8")));
}

async function writeLedger(ledger: ReviewLedger, paths: { jsonPath: string; markdownPath: string }): Promise<void> {
  mkdirSync(dirname(paths.jsonPath), { recursive: true });
  await writeFileAtomically(paths.jsonPath, `${JSON.stringify(ledger, null, 2)}\n`);
  await writeFileAtomically(paths.markdownPath, renderReviewLedger(ledger));
}

/** A snapshot COPY, not a move: the live ledger continues at the same path with every
 * round and decision carried (enforcement contract rule 5); the copy preserves the
 * pre-supersession state of the evidence for human diffing. */
function snapshotReviewEvidence(
  ledger: ReviewLedger,
  paths: { jsonPath: string; markdownPath: string },
): void {
  const suffix = `${ledger.baseSha.slice(0, 12)}-${Date.now()}`;
  for (const path of [paths.jsonPath, paths.markdownPath]) {
    if (!existsSync(path)) continue;
    copyFileSync(path, join(dirname(path), `superseded-${suffix}-${basename(path)}`));
  }
}

function assertBaseRefreshCanSupersede(ledger: ReviewLedger, headSha: string): void {
  const latestRound = ledger.rounds.at(-1);
  if (
    latestRound?.headSha === headSha &&
    latestRound.findings.some((finding) => finding.disposition?.kind === "accepted")
  ) {
    throw new Error("review base changed while the latest round has an accepted finding awaiting confirmation");
  }
  for (const round of ledger.rounds) {
    for (const finding of round.findings) {
      if (!finding.disposition) throw new Error(`${finding.id} has no disposition`);
      if (finding.disposition.kind === "deferred-to-human") {
        throw new Error("review base changed while a finding is deferred to the owner");
      }
    }
  }
}

// Anchor at the repo root: pathspecs are cwd-relative, so an unanchored check run
// from a subdirectory would miss dirty files elsewhere. Review evidence under
// .reviews is excluded - the tool writes it itself, and it must not wedge the next
// round in repos that don't gitignore it.
function dirtyOutsideReviewEvidence(repository: string): string {
  return git([
    "-C",
    repository,
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).reviews/**",
  ]);
}

function assertTrackedRegularFile(repository: string, treeSha: string, path: string, label: string): void {
  let entry = "";
  try {
    entry = git(["-C", repository, "ls-tree", treeSha, "--", path]);
  } catch {
    entry = "";
  }
  const match = entry.match(/^(\d{6}) blob /);
  if (!match || (match[1] !== "100644" && match[1] !== "100755")) {
    throw new Error(`${label} ${path}, which does not resolve to a tracked regular file at the reviewed HEAD`);
  }
}

function gitPatchIds(repository: string, baseSha: string, headSha: string): string[] {
  const commits = git(["-C", repository, "rev-list", "--reverse", `${baseSha}..${headSha}`])
    .split("\n")
    .filter(Boolean);
  const patchIds: string[] = [];
  for (const commit of commits) {
    // Same ceiling as git() above: a single large commit's patch overflows the 1 MiB default.
    const patch = spawnSync("git", ["-C", repository, "show", "--pretty=format:", "--patch", commit], {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    if (patch.error) throw new Error(`git show ${commit} failed: ${patch.error.message}`);
    if (patch.status !== 0) throw new Error(patch.stderr?.toString().trim() || `git show ${commit} failed`);
    const identity = spawnSync("git", ["patch-id", "--stable"], {
      encoding: "utf8",
      input: patch.stdout,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    if (identity.error) throw new Error(`git patch-id failed: ${identity.error.message}`);
    if (identity.status !== 0) throw new Error(identity.stderr?.toString().trim() || "git patch-id failed");
    const patchId = identity.stdout.trim().split(/\s+/)[0];
    if (patchId) patchIds.push(patchId);
  }
  return patchIds.sort();
}

/** The repository's rule files: what the reviewer must read as authority, what an item
 * may declare under `review.rewrites`, and what the no-spec-reference instruction covers.
 * The three questions share one set deliberately - a file that is authority in one and
 * invisible in another is exactly the gap that let a governance rewrite of a skill be
 * judged against the rule it was rewriting.
 *
 * `skills/<name>/SKILL.md` is in the set because a skill is executed prose: its text
 * tells an agent what to do next, which is the same test the change classes apply. The
 * cost is real and deliberate - every round's coverage must repeat every path here. */
function discoverInstructionFiles(repository: string): string[] {
  return git(["-C", repository, "ls-files"])
    .split("\n")
    .filter((path) =>
      path === "AGENTS.md" ||
      path.endsWith("/AGENTS.md") ||
      path === "CLAUDE.md" ||
      path.endsWith("/CLAUDE.md") ||
      /(?:^|\/)skills\/[^/]+\/SKILL\.md$/.test(path) ||
      path.startsWith(".cursor/rules/") && path.endsWith(".mdc"),
    )
    .sort();
}

function contextDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The item's declared change surface (front-matter `review.rewrites`): instruction
 * files this change is authorized to rewrite. Parsed strictly and failing closed: a
 * malformed declaration aborts the review rather than silently running without the
 * authorization the author thought they declared. */
function parseReviewRewrites(itemText: string, itemPath: string): string[] {
  const match = itemText.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  const frontmatter = parseYaml(match[1]) as Record<string, unknown>;
  const review = frontmatter.review;
  if (review === undefined) return [];
  if (typeof review !== "object" || review === null || Array.isArray(review)) {
    throw new Error(`review front-matter in ${itemPath} must be a mapping`);
  }
  const rewrites = (review as Record<string, unknown>).rewrites;
  if (rewrites === undefined) return [];
  if (
    !Array.isArray(rewrites) ||
    rewrites.length === 0 ||
    new Set(rewrites).size !== rewrites.length ||
    rewrites.some((path) => typeof path !== "string" || path !== validateEvidencePath(path))
  ) {
    throw new Error(
      `review.rewrites in ${itemPath} must be a non-empty list of unique repository-relative paths`,
    );
  }
  return rewrites as string[];
}

/** The leading YAML front-matter block of a markdown document, or {} when absent or
 * unparsable - the C8 gate then simply finds no profile named. */
function parseFrontMatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    const parsed: unknown = parseYaml(match[1]!);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function loadReviewContext(
  repository: string,
  dataRepo: string | undefined,
  item: string | undefined,
): {
  documents: ReviewContextDocument[];
  references: ReviewContextReference[];
  rewrites: string[];
  hasSpec: boolean;
  /** C8: the profile the item's front matter selects (`review.profile`). */
  itemReviewProfile?: string;
  /** C8: whether the item's own selection - its `review.profile` and `links.spec` -
   * is what the data repo holds at HEAD, rather than a worktree-only edit. */
  itemSelectionCommitted?: boolean;
  /** C8: the linked spec's authorization state for that selection. */
  specGate?: {path: string; tracked: boolean; reviewProfile?: string};
} {
  if (!dataRepo || !item) return {documents: [], references: [], rewrites: [], hasSpec: false};
  const itemPath = ["items", "for-delivery", "archive"]
    .map((directory) => join(dataRepo, directory, `${item}.md`))
    .find(existsSync);
  if (!itemPath) throw new Error(`tracked review item ${item} was not found in the data repo`);
  const itemContent = readFileSync(itemPath, "utf8");
  const documents: ReviewContextDocument[] = [{label: "item", path: itemPath, content: itemContent}];
  const parsedItem = parseItemFileText(relative(dataRepo, itemPath), itemContent);
  const itemFrontMatter = parseFrontMatter(itemContent);
  const itemReview = itemFrontMatter.review;
  const itemReviewProfile =
    itemReview && typeof itemReview === "object" && !Array.isArray(itemReview) &&
    typeof (itemReview as Record<string, unknown>).profile === "string"
      ? ((itemReview as Record<string, unknown>).profile as string)
      : undefined;
  // C8: the item half of the selection has to be durable too. A worktree-only edit
  // adding `review.profile` - or repointing `links.spec` at some other feature's
  // already-approved spec - would otherwise select the lighter policy with nothing
  // committed. Only these two fields are compared: every other item field changes
  // freely mid-work, as the board requires.
  const committedItem = committedRegularFile(dataRepo, relative(dataRepo, itemPath));
  const committedFrontMatter: Record<string, unknown> =
    committedItem !== undefined ? parseFrontMatter(committedItem) : {};
  const committedReview = committedFrontMatter.review;
  const committedProfile =
    committedReview && typeof committedReview === "object" && !Array.isArray(committedReview) &&
    typeof (committedReview as Record<string, unknown>).profile === "string"
      ? ((committedReview as Record<string, unknown>).profile as string)
      : undefined;
  const committedSpecLink =
    committedItem !== undefined
      ? parseItemFileText(relative(dataRepo, itemPath), committedItem).links.spec
      : undefined;
  let specGate: {path: string; tracked: boolean; reviewProfile?: string} | undefined;
  const specLink = parsedItem.links.spec;
  if (specLink) {
    // `~/...` is how item files record links by convention, and --data-repo is already
    // expanded that way. Expand first, then resolve: an unexpanded "~" resolves against
    // the data repo as a literal directory, so a correctly-recorded spec never matched.
    const link = expandHome(specLink, process.env.HOME ?? homedir());
    const specPath = [resolve(dataRepo, link), resolve(repository, link)].find(existsSync);
    if (!specPath) throw new Error(`linked review spec ${specLink} was not found`);
    const specContent = readFileSync(specPath, "utf8");
    documents.push({label: "spec", path: specPath, content: specContent});
    // C8 authorization gate for item-level profile selection: the spec must be a
    // tracked file at HEAD of its containing repo, and its own front matter must
    // name the profile - a machine-checkable statement inside the owner-approved
    // artifact, not an agent-editable item field alone. Authorization parses the
    // HEAD blob, not the worktree: a staged spec or an uncommitted edit adding
    // `review-profile` must not select a lighter policy.
    const specRoot = !relative(dataRepo, specPath).startsWith("..") ? dataRepo : repository;
    const committed = committedRegularFile(specRoot, relative(specRoot, specPath));
    const tracked = committed !== undefined;
    const specFrontMatter: Record<string, unknown> = committed !== undefined ? parseFrontMatter(committed) : {};
    specGate = {
      path: specPath,
      tracked,
      ...(typeof specFrontMatter["review-profile"] === "string"
        ? {reviewProfile: specFrontMatter["review-profile"] as string}
        : {}),
    };
  }
  return {
    rewrites: parseReviewRewrites(itemContent, relative(dataRepo, itemPath)),
    hasSpec: Boolean(specLink),
    ...(itemReviewProfile !== undefined ? {itemReviewProfile} : {}),
    itemSelectionCommitted: committedProfile === itemReviewProfile && committedSpecLink === specLink,
    ...(specGate ? {specGate} : {}),
    documents,
    references: documents.map((document) => {
      const dataRepoPath = relative(dataRepo, document.path);
      const repositoryPath = relative(repository, document.path);
      const portablePath = !dataRepoPath.startsWith("..")
        ? dataRepoPath
        : !repositoryPath.startsWith("..")
          ? repositoryPath
          : basename(document.path);
      return {
        label: document.label,
        path: portablePath,
        digest: contextDigest(document.content),
      };
    }),
  };
}

function createManifest(
  repository: string,
  baseSha: string,
  headSha: string,
  metadataPaths: string[],
  contextReferences: ReviewContextReference[],
  patchIds: string[],
  baseDeltaRange?: {baseSha: string; headSha: string},
  remediationRange?: {baseSha: string; headSha: string},
  instructionFilesUnderRevision?: string[],
): ReviewManifest {
  const primaryDiff = git([
    "-C",
    repository,
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--unified=0",
    `${baseSha}..${headSha}`,
    "--",
  ]);
  const baseDeltaDiff = baseDeltaRange
    ? git([
        "-C",
        repository,
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--unified=0",
        `${baseDeltaRange.baseSha}..${baseDeltaRange.headSha}`,
        "--",
      ])
    : "";
  const remediationDiff = remediationRange
    ? git([
        "-C",
        repository,
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--unified=0",
        `${remediationRange.baseSha}..${remediationRange.headSha}`,
        "--",
      ])
    : "";
  return buildReviewManifest({
    baseSha,
    headSha,
    diffText: [primaryDiff, baseDeltaDiff].filter(Boolean).join("\n"),
    remediationDiffText: remediationDiff,
    baseDeltaDiffText: baseDeltaDiff,
    metadataPaths,
    instructionFiles: discoverInstructionFiles(repository),
    ...(instructionFilesUnderRevision?.length ? {instructionFilesUnderRevision} : {}),
    contextReferences,
    patchIds,
  });
}

function patchSeriesEqual(left: string[] | undefined, right: string[]): boolean {
  return Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}

function priorFindingIdentities(ledger: ReviewLedger): PriorFindingIdentity[] {
  return ledger.rounds.flatMap((round) =>
    round.findings.map((finding) => ({
      id: finding.id,
      identity: auditFindingIdentity(finding),
      firstSeenRound: round.number,
    })),
  );
}

/** Optional capture of what the reviewer was actually asked, for diagnosing a rejected
 * round. The ledger records a bare reason string, so an invalidated round leaves no trace
 * of its input: "coverage includes a file outside the review manifest" cost two items a
 * day of guessing in 2026-08, and the prompt had to be reconstructed by reading this
 * tool's source instead of the run.
 *
 * Off unless LOOPS_REVIEW_DUMP_PROMPT names a directory - a prompt embeds the whole
 * base..HEAD diff, so dumping every pass of every round unconditionally would leave
 * hundreds of KB behind on runs nobody ever looks at.
 *
 * Writes OUTSIDE the repository by design. .reviews/ is committed evidence, and on an
 * instance whose review.metadataPaths covers it (the default shape) a dump landing there
 * would be swept into the next round's manifest and handed back to the reviewer as a file
 * to inspect - feeding it its own previous prompt. */
/** The committed content of `relativePath` at HEAD of `root`, or undefined when HEAD
 * holds no regular file there (C8). A symlink is a blob too and `git show` prints its
 * target happily, so the tree entry's mode is what separates an owner-approved
 * artifact from a pointer at one; anything but a regular blob fails the gate. */
function committedRegularFile(root: string, relativePath: string): string | undefined {
  const entry = spawnSync("git", ["-C", root, "ls-tree", "-z", "HEAD", "--", relativePath], {
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (entry.status !== 0) return undefined;
  const mode = entry.stdout.split(" ", 1)[0];
  if (mode !== "100644" && mode !== "100755") return undefined;
  const blob = spawnSync("git", ["-C", root, "show", `HEAD:${relativePath}`], {
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  return blob.status === 0 ? blob.stdout : undefined;
}

function dumpReviewPrompt(
  item: string | undefined,
  epoch: number,
  round: number,
  pass: ReviewPersonaName,
  prompt: string,
): void {
  const directory = process.env.LOOPS_REVIEW_DUMP_PROMPT;
  if (!directory) return;
  mkdirSync(directory, {recursive: true});
  // `item` is optional - an owner-requested review need not have a board item - so the
  // name falls back rather than dropping the dump for exactly the ad-hoc run most likely
  // to be the one being debugged.
  writeFileSync(
    join(directory, `${item ?? "review"}-epoch${epoch}-round${round}-${pass}.prompt.txt`),
    prompt,
  );
}

async function startReview(options: StartOptions): Promise<void> {
  const branch = git(["branch", "--show-current"]);
  if (!branch) throw new Error("review requires a named branch");
  const repository = git(["rev-parse", "--show-toplevel"]);
  if (dirtyOutsideReviewEvidence(repository)) {
    throw new Error("working tree must be clean before review");
  }
  const releaseLock = await acquireReviewLock(repository, branch);
  try {
    const resolvedBaseSha = git(["rev-parse", "--verify", `${options.baseRef}^{commit}`]);
    const headSha = git(["rev-parse", "--verify", "HEAD^{commit}"]);
    git(["merge-base", "--is-ancestor", resolvedBaseSha, headSha]);
    const paths = reviewEvidencePaths(repository, branch, options.item);
    const modelLabel = options.model ?? `${options.reviewer.id} (default)`;
    const context = loadReviewContext(repository, options.dataRepo, options.item);
    // C8 item-level profile selection: honored only when the linked spec is a tracked
    // file at HEAD whose own front matter names the profile. A selection failing any
    // check aborts by name; an undeclared item keeps the project/global resolution.
    let selectedProfile = options.profileName;
    if (context.itemReviewProfile !== undefined) {
      const wanted = context.itemReviewProfile;
      if (!context.specGate) {
        throw new Error(
          `item declares review.profile "${wanted}" but links no spec; item-level profile selection requires links.spec whose front matter names review-profile: ${wanted}`,
        );
      }
      if (!context.specGate.tracked) {
        throw new Error(
          `item declares review.profile "${wanted}" but the linked spec ${context.specGate.path} is not a tracked file at HEAD`,
        );
      }
      if (context.specGate.reviewProfile !== wanted) {
        throw new Error(
          `item declares review.profile "${wanted}" but the linked spec does not name review-profile: ${wanted}`,
        );
      }
      if (!context.itemSelectionCommitted) {
        throw new Error(
          `item declares review.profile "${wanted}" in the worktree only; commit the item's review.profile and links.spec so the selection is a durable artifact`,
        );
      }
      if (!options.applyProfile) {
        throw new Error(`item declares review.profile "${wanted}" but no data repo config resolves profiles`);
      }
      const review = options.applyProfile(wanted);
      selectedProfile = wanted;
      options = {
        ...options,
        maxRounds: options.maxRoundsFlag ?? review.maxRounds,
        auditPasses: review.auditPasses ?? [...reviewAuditPasses],
        ...(review.severityFloor ? {severityFloor: review.severityFloor} : {severityFloor: undefined}),
        ...(review.terminalRejection ? {terminalRejection: true} : {terminalRejection: undefined}),
        ...(review.capExit ? {capExit: true} : {capExit: undefined}),
        ...(review.confirmation ? {confirmation: review.confirmation} : {confirmation: undefined}),
        ...(review.personas ? {personas: review.personas} : {personas: undefined}),
      };
    } else if (selectedProfile !== undefined && options.applyProfile) {
      // Project/global selection is already folded into the resolved options; the
      // name is validated here so an unknown profile fails the start, not the gate.
      options.applyProfile(selectedProfile);
    }
    const currentPatchIds = gitPatchIds(repository, resolvedBaseSha, headSha);
    let ledger: ReviewLedger;
    let baseSha: string;
    let auditKind: ReviewRoundAudit["kind"] = "full";
    let baseDeltaRange: {baseSha: string; headSha: string} | undefined;
    try {
      ledger = readLedger(paths.jsonPath);
      if (ledger.branch !== branch) throw new Error(`review ledger branch is ${ledger.branch}, expected ${branch}`);
      if (ledger.item !== options.item) throw new Error("review item does not match the existing ledger");
      if ((ledger.profile ?? null) !== (selectedProfile ?? null)) {
        throw new Error(
          `review is bound to profile ${JSON.stringify(ledger.profile ?? "none")} and the current selection is ${JSON.stringify(selectedProfile ?? "none")}; a mid-review profile change is refused - supersede the base to change it`,
        );
      }
      if (ledger.baseSha !== resolvedBaseSha) {
        assertBaseRefreshCanSupersede(ledger, headSha);
        if (patchSeriesEqual(ledger.patchIds, currentPatchIds)) {
          const baseDeltaCap = effectiveMaxRounds(ledger, options.maxRounds ?? DEFAULT_REVIEW_MAX_ROUNDS);
          if (liveRounds(ledger).length >= baseDeltaCap) {
            throw new Error(`review round limit of ${baseDeltaCap} reached`);
          }
          baseDeltaRange = {baseSha: ledger.baseSha, headSha: resolvedBaseSha};
          baseSha = resolvedBaseSha;
          ledger = {...ledger, baseRef: options.baseRef, baseSha, patchIds: currentPatchIds};
          auditKind = "base-delta";
        } else {
          snapshotReviewEvidence(ledger, paths);
          baseSha = resolvedBaseSha;
          ledger = supersedeLedgerBase(ledger, {
            baseRef: options.baseRef,
            baseSha,
            patchIds: currentPatchIds,
            archivedAt: new Date().toISOString(),
          });
        }
      } else {
        baseSha = ledger.baseSha;
        const continuation = reviewCanContinue(
          liveRounds(ledger).map((round) => ({
            headSha: round.headSha,
            findings: round.findings.map((finding) => ({ id: finding.id, disposition: finding.disposition?.kind })),
          })),
          effectiveMaxRounds(ledger, options.maxRounds ?? DEFAULT_REVIEW_MAX_ROUNDS),
          headSha,
          openObligations(ledger),
        );
        if (!continuation.allowed) throw new Error(continuation.reason || "review cannot continue");
        ledger = {...ledger, baseRef: options.baseRef, patchIds: currentPatchIds};
      }
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        baseSha = resolvedBaseSha;
        ledger = createReviewLedger({
          item: options.item,
          ...(options.authority ? {authority: options.authority} : {}),
          ...(selectedProfile !== undefined ? {profile: selectedProfile} : {}),
          branch,
          baseRef: options.baseRef,
          baseSha,
          patchIds: currentPatchIds,
        });
      } else {
        throw error;
      }
    }

    // C7: an explicit --max-rounds is an owner authorization, so it outlives this
    // invocation: persist it on the ledger and let later starts and `status` honor
    // it instead of falling back to the lower configured cap. Recorded monotonically -
    // a later, lower flag never retracts an authorization already given, so nothing
    // can bring the cap-exit threshold down to where residual work ships early.
    if (options.maxRoundsFlag !== undefined) {
      const authorized = Math.max(ledger.maxRoundsOverride ?? 0, options.maxRoundsFlag);
      if (ledger.maxRoundsOverride !== authorized) ledger = {...ledger, maxRoundsOverride: authorized};
    }

    // Recorded at creation and never rewritten or backfilled: a binding a later run can
    // supply or move is not a binding. A ledger that already names an authority must be
    // driven with that one.
    if (ledger.authority && options.authority && ledger.authority.dataRepo !== options.authority.dataRepo) {
      throw new Error(
        `review policy authority is ${ledger.authority.dataRepo}, not the supplied ${options.authority.dataRepo}`,
      );
    }

    // The third class consumer, bound to the same authority as the two disposition-side
    // gates. It fails closed to "no classes": no reviewer guidance, so the range is
    // reviewed under no policy rather than under one that is no longer this review's.
    // Announced rather than silent - a policy vanishing without a word reads as a
    // config typo.
    const governing = governingPolicy(ledger, options.dataRepo);
    if (governing.refusal && ledger.authority) {
      process.stderr.write(
        `review classes are not applied this round: ${governing.refusal}\n`,
      );
    }
    const classes = governing.review?.classes;

    try {
      const obligations = openObligations(ledger);
      // The same-HEAD remediation guard holds on EVERY path, not only same-base: a
      // base refresh (either kind) must not reach the reviewer while a remediation
      // obligation is open at the exact HEAD the last round already reviewed - an
      // owner reversal creates such an obligation without moving HEAD.
      if (
        ledger.rounds.at(-1)?.headSha === headSha &&
        obligations.some((obligation) => obligation.type === "remediation")
      ) {
        throw new Error(
          "latest round has accepted findings - implement and commit them before the next round",
        );
      }
      // Enforcement contract rule 1: a documentation obligation's evidence resolves at
      // consumption. From the first gate after the disposition on, the named doc must be
      // a tracked regular file in the reviewed tree - a directory proves nothing was
      // written, and a tracked symlink can point outside the reviewed tree.
      for (const obligation of obligations) {
        if (obligation.type !== "documentation" || !obligation.doc) continue;
        assertTrackedRegularFile(
          repository,
          headSha,
          obligation.doc,
          `documentation obligation ${obligation.findingId} names`,
        );
      }
      if (auditKind === "full" && obligations.length > 0) auditKind = "remediation";
      // C1: two consecutive remediation-dominated rounds force a written step-back
      // before the next round opens. The note must resolve at the HEAD under review and
      // must differ from the newer triggering round's tree - a file written before the
      // tripwire fired cannot prove analysis of the rounds that fired it.
      const tripwire = remediationChurnTripwire(ledger);
      let stepBack: ReviewStepBack | undefined;
      if (tripwire.armed && !options.stepBack) {
        const [older, newer] = tripwire.rounds;
        const olderId = reviewRoundIdentifier(ledger, older.number);
        const newerId = reviewRoundIdentifier(ledger, newer.number);
        throw new Error(
          `remediation-churn tripwire: rounds ${olderId} and ${newerId} are both remediation-dominated ` +
            `(${older.remediationCount}/${older.findingCount} and ${newer.remediationCount}/${newer.findingCount} findings remediation-origin). ` +
            "Write the step-back analysis (full invariant list; remove, rewrite, or continue-patching decision with reasoning; covered obligations) and re-run with --step-back <path>.",
        );
      }
      if (!tripwire.armed && options.stepBack) {
        throw new Error("no remediation-churn tripwire is armed - omit --step-back");
      }
      if (tripwire.armed && options.stepBack) {
        const notePath = validateEvidencePath(options.stepBack);
        assertTrackedRegularFile(repository, headSha, notePath, "step-back note");
        const [older, newer] = tripwire.rounds;
        const newerId = reviewRoundIdentifier(ledger, newer.number);
        const currentBlob = git(["-C", repository, "rev-parse", `${headSha}:${notePath}`]);
        // Only a path missing from a RESOLVABLE triggering tree counts as fresh. An
        // unavailable tree (e.g. the pre-rebase commit was pruned) must fail closed,
        // or any stale note would pass the freshness check unverified.
        try {
          git(["-C", repository, "rev-parse", "--verify", `${newer.headSha}^{tree}`]);
        } catch {
          throw new Error(
            `round ${newerId}'s reviewed tree (${newer.headSha}) is not available in this repository - step-back freshness cannot be verified`,
          );
        }
        let triggerBlob: string | undefined;
        try {
          triggerBlob = git(["-C", repository, "rev-parse", `${newer.headSha}:${notePath}`]);
        } catch {
          triggerBlob = undefined;
        }
        if (triggerBlob === currentBlob) {
          throw new Error(
            `step-back note ${notePath} is unchanged from round ${newerId}'s reviewed tree - a note written before the tripwire fired cannot prove analysis of the rounds that fired it`,
          );
        }
        stepBack = {
          path: notePath,
          triggerRounds: [older.number, newer.number],
          triggerRoundIds: [reviewRoundIdentifier(ledger, older.number), newerId],
        };
      }
      const previousHeadSha = ledger.rounds.at(-1)?.headSha;
      const remediationRange = obligations.length > 0 && previousHeadSha && previousHeadSha !== headSha
        ? {baseSha: previousHeadSha, headSha}
        : undefined;
      // Validated before the manifest is built, because the manifest itself now refuses
      // to persist an under-revision list that is not a subset of the instruction files -
      // and it would report that generic failure instead of the named one the author
      // needs. The remaining leg (the path must actually change) needs the manifest and
      // runs below.
      if (context.rewrites.length > 0) {
        if (!context.hasSpec) {
          throw new Error(
            "review.rewrites declares a governance change surface, but the item has no links.spec; an owner-approved spec is what authorizes rewriting instruction files",
          );
        }
        const discovered = discoverInstructionFiles(repository);
        for (const path of context.rewrites) {
          if (!discovered.includes(path)) {
            throw new Error(`review.rewrites names ${path}, which is not an instruction file of this repository`);
          }
        }
      }
      const manifest = createManifest(
        repository,
        baseSha,
        headSha,
        options.metadataPaths,
        context.references,
        currentPatchIds,
        baseDeltaRange,
        remediationRange,
        context.rewrites,
      );
      // The declared change surface fails closed on every leg: a rewrite declaration
      // that names a non-instruction file, an unchanged file, or arrives without an
      // owner-approved spec aborts the round instead of silently narrowing (or
      // silently granting) the authority the author declared.
      if (context.rewrites.length > 0) {
        // The item's OWN range, deliberately not manifest.files: on a patch-equivalent
        // rebase the manifest folds in the base delta, so a rule file touched only by
        // the integration-base update would otherwise satisfy a declaration the item's
        // patch never earns. Named separately from the manifest for the same reason the
        // error message names this range.
        const changedPaths = new Set(
          git(["-C", repository, "diff", "--name-only", `${baseSha}..${headSha}`, "--"])
            .split("\n")
            .filter(Boolean),
        );
        for (const path of context.rewrites) {
          if (!changedPaths.has(path)) {
            throw new Error(`review.rewrites names ${path}, which is not changed in ${baseSha}..${headSha}`);
          }
        }
      }
      const pendingEpoch = activeReviewEpoch(ledger);
      const pendingLogicalRound = liveRounds(ledger).length + 1;
      // C7 early warning: two consecutive completed rounds without decline suggest
      // the loop is churning, and the mechanism-suspicion hatch (a step-back note)
      // is cheaper now than at the cap.
      if (options.capExit) {
        const ratios = liveRounds(ledger)
          .map((round) => round.audit?.metrics.declineRatio)
          .filter((ratio): ratio is number => typeof ratio === "number");
        const lastTwo = ratios.slice(-2);
        if (lastTwo.length === 2 && lastTwo.every((ratio) => ratio <= 0)) {
          process.stdout.write(
            `warning: finding counts are not declining (decline ratios ${lastTwo.join(", ")} over the last two completed rounds). Consider the mechanism-suspicion hatch now - a step-back note (--step-back) re-examining the approach - rather than riding the loop to the cap.\n`,
          );
        }
      }
      const usingPersonas = options.personas !== undefined;
      const personaCovers = (persona: ReviewPersonaConfig, round: number): boolean =>
        persona.fromRound <= round && (persona.toRound === undefined || round <= persona.toRound);
      // Precedence per persona: an explicit run-level flag first (one-run override),
      // then the persona's own value, then the resolved review block.
      const plannedPersona = (persona: ReviewPersonaConfig): PlannedPass => {
        const reviewer = options.reviewerFlag
          ?? (persona.reviewer !== undefined && isReviewerId(persona.reviewer)
            ? getReviewer(persona.reviewer)
            : options.reviewer);
        const model = options.modelFlag ?? persona.model ?? options.model;
        const effort = options.effortFlag ?? persona.effort ?? options.effort;
        return {
          pass: persona.name,
          reviewer,
          ...(model ? {model} : {}),
          ...(effort ? {effort} : {}),
        };
      };
      // C3: every persona whose range covers this logical round runs, concurrently;
      // a round no persona covers fails closed. The legacy auditPasses path keeps
      // today's sequential engine untouched.
      let roundPersonas: ReviewPersonaConfig[] = [];
      if (usingPersonas) {
        roundPersonas = (options.personas ?? []).filter((persona) =>
          personaCovers(persona, pendingLogicalRound),
        );
        if (auditKind === "base-delta" && obligations.length === 0) {
          roundPersonas = roundPersonas.filter((persona) => persona.name !== "diff");
        }
        if (roundPersonas.length === 0) {
          throw new Error(`no configured persona covers round ${pendingLogicalRound}`);
        }
      }
      const configuredPasses = auditKind === "base-delta" && obligations.length === 0
        ? options.auditPasses.filter((pass) => pass !== "diff")
        : options.auditPasses;
      if (!usingPersonas && configuredPasses.length === 0) {
        throw new Error("base-delta audit requires integration or adversarial pass");
      }
      const confirmationPersona = roundPersonas.find((persona) => persona.name === "confirmation");
      const obligationPass: ReviewPersonaName = usingPersonas
        ? (confirmationPersona ? "confirmation" : roundPersonas[0]!.name)
        : configuredPasses.includes("diff") ? "diff" : configuredPasses[0]!;
      // Scoped confirmation, opt-in via review.confirmation. A round that owes nothing
      // but remediation, whose predecessor is fully dispositioned, may audit the fix
      // delta alone with the obligation-classifying pass. Every leg is load-bearing: an
      // undispositioned predecessor finding or a documentation obligation still needs
      // the full range, and with no fix delta there is nothing narrower to review. What
      // it buys is the round's cost; what it gives up is the fix-induced regression
      // outside the fix, which is why the default stays "full" and the audit record
      // marks the narrowed round.
      const scopedEligible =
        options.confirmation === "scoped" &&
        // The narrowed round IS the obligation-classifying pass: legacy narrows to the
        // diff pass, the persona engine to the confirmation persona. Without one there
        // is nothing the contract allows narrowing to, so full rounds continue.
        (usingPersonas ? confirmationPersona !== undefined : configuredPasses.includes("diff")) &&
        auditKind === "remediation" &&
        obligations.length > 0 &&
        obligations.every((obligation) => obligation.type === "remediation") &&
        (ledger.rounds.at(-1)?.findings ?? []).every((finding) => finding.disposition !== undefined)
          ? remediationRange
          : undefined;
      // C2 widening (persona engine only): a scoped-eligible round runs full anyway,
      // recorded as "full-widened", when the fix delta touches more files than the
      // original range or an open obligation is P0 - the two conditions under which
      // the narrow round would prove too little.
      let widenedScope = false;
      if (usingPersonas && scopedEligible) {
        const fixDeltaFileCount = git([
          "-C",
          repository,
          "diff",
          "--name-only",
          `${scopedEligible.baseSha}..${headSha}`,
          "--",
        ])
          .split("\n")
          .filter(Boolean).length;
        // "The original range" is the range as the previous round reviewed it - the
        // current manifest already contains the fix delta and would never compare
        // larger. A legacy predecessor without an audit manifest leaves the original
        // size unknown, and unknown fails toward the full (safer) round: 0 makes any
        // non-empty fix delta widen.
        const originalRangeFileCount = ledger.rounds.at(-1)?.audit?.manifest.files.length ?? 0;
        widenedScope =
          fixDeltaFileCount > originalRangeFileCount ||
          obligations.some((obligation) => obligation.priority === "P0");
      }
      const scopedRange = widenedScope ? undefined : scopedEligible;
      const plannedPasses: PlannedPass[] = usingPersonas
        ? (scopedRange && confirmationPersona
            ? [plannedPersona(confirmationPersona)]
            : roundPersonas.map(plannedPersona))
        : (scopedRange ? [obligationPass] : configuredPasses).map((pass) => ({
            pass,
            reviewer: options.reviewer,
            ...(options.model ? {model: options.model} : {}),
            ...(options.effort ? {effort: options.effort} : {}),
          }));
      // The reviewer sees, and the ledger records, exactly the range that was audited:
      // a manifest still spanning base..head would demand coverage of files this round
      // never asked about, and would overstate what the round proves.
      const reviewedManifest = scopedRange
        ? createManifest(
            repository,
            scopedRange.baseSha,
            headSha,
            options.metadataPaths,
            context.references,
            currentPatchIds,
            baseDeltaRange,
            scopedRange,
            context.rewrites,
          )
        : manifest;
      const docArtifacts = obligations
        .filter((obligation) => obligation.type === "documentation" && obligation.doc)
        .map((obligation) => ({
          findingId: obligation.findingId,
          path: obligation.doc as string,
          content: git(["-C", repository, "show", `${headSha}:${obligation.doc}`]),
        }));
      // Guidance lines for classes whose paths this range touches; enforcement stays on
      // the disposition side, so this only steers the reviewer's attention and cost.
      const classGuidance = (classes ?? [])
        .filter((entry) => entry.guidance)
        .map((entry) => ({
          name: entry.name,
          guidance: entry.guidance as string,
          files: reviewedManifest.files
            .map((file) => file.path)
            .filter((path) => matchingClasses(path, [entry]).length > 0),
        }))
        .filter((entry) => entry.files.length > 0);
      const passResults: ReviewPassResult[] = [];
      const passStats: ReviewPassStats[] = [];
      // C1: the severity floor gates by round; the taxonomy is emitted whenever any
      // dependent key is on, so a floored round never grades against undefined levels.
      const severityFloorActive =
        options.severityFloor === "all-rounds" ||
        (options.severityFloor === "round-2-plus" && pendingLogicalRound >= 2);
      const taxonomy = taxonomyEnabled({
        ...(options.severityFloor !== undefined ? {severityFloor: options.severityFloor} : {}),
        ...(options.terminalRejection !== undefined ? {terminalRejection: options.terminalRejection} : {}),
        ...(options.capExit !== undefined ? {capExit: options.capExit} : {}),
        ...(options.personas !== undefined ? {personas: options.personas} : {}),
        ...(options.confirmation !== undefined ? {confirmation: options.confirmation} : {}),
      });
      // C4: a rejected P0/P1 owes exactly one confirmation round, and the reviewer is
      // handed the rejection as the claim to refute (its reason rides in priorNotes).
      const refuteRejections =
        Boolean(options.terminalRejection) &&
        (liveRounds(ledger).at(-1)?.findings ?? []).some(
          (finding) =>
            finding.disposition?.kind === "rejected" &&
            (finding.priority === "P0" || finding.priority === "P1"),
        );
      const runPlannedPass = async (
        planned: PlannedPass,
        passManifest: ReviewManifest,
        classify: boolean,
      ): Promise<{result: ReviewPassResult; stats: ReviewPassStats}> => {
        const prompt = reviewPrompt({
          pass: planned.pass,
          manifest: passManifest,
          contextDocuments: context.documents,
          priorNotes: priorDispositionNotes(ledger),
          obligations,
          classifyObligations: classify,
          ...(classGuidance.length > 0 ? {classGuidance} : {}),
          ...(classify && docArtifacts.length > 0 ? {docArtifacts} : {}),
          ...(remediationRange
            ? {remediationBaseSha: remediationRange.baseSha}
            : {}),
          ...(baseDeltaRange ? {baseDeltaRange} : {}),
          ...(taxonomy ? {taxonomy: true} : {}),
          ...(severityFloorActive ? {severityFloorActive: true} : {}),
          ...(refuteRejections ? {refuteRejections: true} : {}),
          ...(usingPersonas ? {personaBriefs: true} : {}),
        });
        dumpReviewPrompt(options.item, pendingEpoch, pendingLogicalRound, planned.pass, prompt);
        const passStarted = Date.now();
        const invocation = await planned.reviewer.invoke({
          prompt,
          model: planned.model,
          effort: planned.effort,
          cwd: repository,
        });
        const stats: ReviewPassStats = {
          elapsedMs: Date.now() - passStarted,
          ...(invocation.tokens ? {tokens: invocation.tokens} : {}),
        };
        const headAfterPass = git(["-C", repository, "rev-parse", "--verify", "HEAD^{commit}"]);
        if (headAfterPass !== headSha) throw new Error("HEAD changed during review; result is invalid");
        const result = parseReviewPass(
          invocation.review,
          planned.pass,
          passManifest,
          classify
            ? obligations.map((obligation) => ({findingId: obligation.findingId, type: obligation.type}))
            : [],
        );
        return {result, stats};
      };
      // The round's own clock, measured around the passes: with personas running
      // concurrently the sum of their durations is reviewer compute, not the wall time
      // the loop paid, and wall time is what C2/C3 are judged on.
      const roundStarted = Date.now();
      if (usingPersonas) {
        // Concurrent by design (C2/C3): each persona is an independent read-only
        // process. allSettled lets every pass run to completion, so one failure
        // fails the attempt without killing the sibling processes mid-flight.
        const settled = await Promise.allSettled(
          plannedPasses.map((planned) =>
            runPlannedPass(planned, reviewedManifest, planned.pass === obligationPass),
          ),
        );
        const failures = settled
          .map((outcome, index) => ({outcome, planned: plannedPasses[index]!}))
          .filter((entry) => entry.outcome.status === "rejected");
        if (failures.length > 0) {
          throw new Error(
            failures
              .map((entry) => {
                const reason = (entry.outcome as PromiseRejectedResult).reason;
                return `${entry.planned.pass} pass failed: ${reason instanceof Error ? reason.message : String(reason)}`;
              })
              .join("; "),
          );
        }
        for (const outcome of settled as PromiseFulfilledResult<{result: ReviewPassResult; stats: ReviewPassStats}>[]) {
          passResults.push(outcome.value.result);
          passStats.push(outcome.value.stats);
        }
      } else {
        for (const planned of plannedPasses) {
          const {result, stats} = await runPlannedPass(
            planned,
            reviewedManifest,
            planned.pass === obligationPass,
          );
          passResults.push(result);
          passStats.push(stats);
        }
      }
      const roundElapsedMs = Date.now() - roundStarted;
      // C2 shadow instrument: on a scoped round started with --shadow-full, the
      // round-1 personas also audit the full range. Recorded, never blocking: a
      // shadow failure lands in audit.shadow.errors instead of failing the attempt.
      let shadow: ReviewRoundAudit["shadow"];
      // Measured on its own clock, not folded into the round's: waiting for a scoped
      // round is what the loop pays, running the shadow on top of it is what the
      // measurement window costs, and C2 is decided by comparing both.
      let shadowElapsedMs: number | undefined;
      const shadowStats: ReviewPassStats[] = [];
      if (usingPersonas && scopedRange && options.shadowFull) {
        const shadowPlanned = (options.personas ?? [])
          .filter((persona) => personaCovers(persona, 1) && persona.name !== "confirmation")
          .map(plannedPersona);
        if (shadowPlanned.length > 0) {
          const shadowStarted = Date.now();
          const settledShadow = await Promise.allSettled(
            shadowPlanned.map((planned) => runPlannedPass(planned, manifest, false)),
          );
          shadowElapsedMs = Date.now() - shadowStarted;
          const shadowPassEntries: ReviewRoundAudit["passes"] = [];
          const shadowResults: ReviewPassResult[] = [];
          const shadowErrors: string[] = [];
          settledShadow.forEach((outcome, index) => {
            const planned = shadowPlanned[index]!;
            if (outcome.status === "fulfilled") {
              shadowResults.push(outcome.value.result);
              shadowStats.push(outcome.value.stats);
              shadowPassEntries.push({
                pass: outcome.value.result.pass,
                summary: outcome.value.result.summary,
                coverage: outcome.value.result.coverage,
                elapsedMs: outcome.value.stats.elapsedMs,
                ...(outcome.value.stats.tokens ? {tokens: outcome.value.stats.tokens} : {}),
                ...(planned.model ? {model: planned.model} : {}),
                ...(planned.effort ? {effort: planned.effort} : {}),
              });
            } else {
              const reason = outcome.reason;
              shadowErrors.push(
                `${planned.pass}: ${reason instanceof Error ? reason.message : String(reason)}`,
              );
            }
          });
          shadow = {
            passes: shadowPassEntries,
            findings: combineReviewPasses(shadowResults, [], pendingLogicalRound).findings,
            ...(shadowErrors.length > 0 ? {errors: shadowErrors} : {}),
          };
        }
      }
      const combined = combineReviewPasses(
        passResults,
        priorFindingIdentities(ledger),
        pendingLogicalRound,
        severityFloorActive,
      );
      for (const result of combined.obligations) {
        const obligation = obligations.find((open) => open.findingId === result.findingId);
        const terminal = obligation?.type === "documentation" ? "documented" : "fixed";
        if (result.status === terminal) continue;
        // A finding answers every obligation it names, not just its primary. One defect
        // reported once per pass yields several obligations, and the reviewer's single
        // follow-up must be able to keep all of them actionable at once.
        const answered = combined.findings.some((finding) =>
          (finding.obligationIds ?? (finding.obligationId ? [finding.obligationId] : [])).includes(
            result.findingId,
          ),
        );
        if (!answered) {
          // Name the pass: with duplicates the operator otherwise cannot see which pass
          // disagreed, and the reason string is all the ledger keeps of a failed attempt.
          const source = passResults.find((passResult) =>
            passResult.obligations.some(
              (candidate) => candidate.findingId === result.findingId && candidate.status !== terminal,
            ),
          )?.pass;
          throw new Error(
            `incomplete or regressed obligation ${result.findingId} must remain an actionable finding${
              source ? ` (reported by the ${source} pass)` : ""
            }`,
          );
        }
      }
      const previousRound = ledger.rounds.at(-1);
      const metrics = computeReviewMetrics({
        roundNumber: pendingLogicalRound,
        headSha,
        ...(previousRound
          ? {
              previousRound: {
                headSha: previousRound.headSha,
                findingCount: previousRound.findings.length,
                identities: previousRound.findings.map(auditFindingIdentity),
              },
            }
          : {}),
        passResults,
        findings: combined.findings,
        passStats,
        elapsedMs: roundElapsedMs,
        ...(shadowElapsedMs !== undefined ? {shadowElapsedMs} : {}),
        ...(shadowStats.length > 0 ? {shadowPassStats: shadowStats} : {}),
        ...(severityFloorActive ? {notes: combined.notes} : {}),
      });
      ledger = addReviewRound(ledger, {
        headSha,
        model: modelLabel,
        reviewedAt: new Date().toISOString(),
        review: {summary: combined.summary, findings: combined.findings},
        ...(severityFloorActive && combined.notes.length ? {notes: combined.notes} : {}),
        audit: {
          kind: auditKind,
          ...(scopedRange ? {scope: "remediation-range" as const} : {}),
          ...(widenedScope ? {scope: "full-widened" as const} : {}),
          manifest: reviewedManifest,
          passes: passResults.map((result, index) => ({
            pass: result.pass,
            summary: result.summary,
            coverage: result.coverage,
            ...(passStats[index] ? {elapsedMs: passStats[index].elapsedMs} : {}),
            ...(passStats[index]?.tokens ? {tokens: passStats[index].tokens} : {}),
            ...(plannedPasses[index]?.model ? {model: plannedPasses[index].model} : {}),
            ...(plannedPasses[index]?.effort ? {effort: plannedPasses[index].effort} : {}),
          })),
          obligations: combined.obligations,
          // The loop controls this round ran under, so a later measurement can tell a
          // cap exit from a stall without guessing at today's configuration.
          policy: {
            // Always the effective cap, including the built-in default. A cap exit at an
            // unconfigured cap is still a cap exit, and a measurement that only records
            // an explicitly configured number reads those rounds as stalls.
            maxRounds: effectiveMaxRounds(ledger, options.maxRounds ?? DEFAULT_REVIEW_MAX_ROUNDS),
            ...(options.severityFloor ? {severityFloor: options.severityFloor} : {}),
            ...(options.terminalRejection ? {terminalRejection: true} : {}),
            ...(options.capExit ? {capExit: true} : {}),
            ...(options.confirmation ? {confirmation: options.confirmation} : {}),
          },
          metrics,
          ...(shadow ? {shadow} : {}),
        },
        ...(stepBack ? {stepBack} : {}),
      });
      ledger = carryForwardDispositions(ledger);
      await writeLedger(ledger, paths);
      process.stdout.write(
        `Review round ${pendingLogicalRound} (epoch ${pendingEpoch}) written to ${paths.markdownPath}\n`,
      );
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      ledger = recordReviewFailure(ledger, {
        headSha,
        model: modelLabel,
        attemptedAt: new Date().toISOString(),
        reason,
      });
      await writeLedger(ledger, paths);
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

interface DispositionOptions {
  item?: string;
  findingId: string;
  kind: DispositionKind;
  reason: string;
  doc?: string;
  owner?: boolean;
  /** Authorizing class name for waived-by-policy (`--class`). */
  waivedClass?: string;
  /** Pointer to where the fix lands, for tracked-elsewhere (`--tracks`). */
  tracks?: string;
  urgency?: "normal" | "urgent";
  escalation?: string;
  causality?: FindingCausality;
  dataRepo?: string;
}

function parseDispositionOptions(args: string[]): DispositionOptions {
  const values = new Map<string, string>();
  let owner = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--owner") {
      owner = true;
      continue;
    }
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error(`unknown or incomplete argument: ${flag ?? ""}`);
    values.set(flag, value);
    index += 1;
  }
  const findingId = values.get("--finding");
  const status = values.get("--status");
  const reason = values.get("--reason");
  if (!findingId || !status || !reason) {
    throw new Error("disposition requires --finding <id> --status <status> --reason <reason>");
  }
  if (!isDispositionKind(status)) throw new Error(`invalid disposition: ${status}`);
  const urgency = values.get("--urgency");
  if (urgency !== undefined && urgency !== "normal" && urgency !== "urgent") {
    throw new Error("--urgency must be normal or urgent");
  }
  const causality = values.get("--causality");
  if (causality !== undefined && !isFindingCausality(causality)) {
    throw new Error(`invalid causality: ${causality}`);
  }
  return {
    item: values.get("--item"),
    findingId,
    kind: status,
    reason,
    ...(values.get("--doc") ? {doc: values.get("--doc")} : {}),
    ...(values.get("--class") ? {waivedClass: values.get("--class")} : {}),
    ...(values.get("--tracks") ? {tracks: values.get("--tracks")} : {}),
    ...(urgency === "normal" || urgency === "urgent" ? {urgency} : {}),
    ...(values.get("--escalation") ? {escalation: values.get("--escalation")} : {}),
    ...(isFindingCausality(causality) ? {causality} : {}),
    ...(values.get("--data-repo") ? {dataRepo: values.get("--data-repo")} : {}),
    ...(owner ? {owner: true} : {}),
  };
}

function assertDelegatedFollowUp(
  ledger: ReviewLedger,
  dataRepo: string | undefined,
  sourceItem: string | undefined,
  findingId: string,
  tracks: string | undefined,
): void {
  if (!sourceItem) throw new Error("delegated-follow-up requires --item so the follow-up can name its source");
  if (!tracks || !/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(tracks)) {
    throw new Error("delegated-follow-up --tracks must name an active board item slug");
  }
  if (tracks === sourceItem) {
    throw new Error("delegated-follow-up must name a separate board item, not the source item");
  }
  const authority = ledger.authority;
  const resolvedDataRepo = resolveDataRepo(dataRepo, process.env, process.env.HOME ?? homedir());
  if (!resolvedDataRepo) {
    throw new Error("delegated-follow-up requires --data-repo or LOOPS_DATA_REPO so its board item can be verified");
  }
  const canonicalDataRepo = canonicalPath(resolvedDataRepo);
  if (!authority || canonicalDataRepo !== authority.dataRepo) {
    throw new Error(
      `delegated-follow-up data repo ${canonicalDataRepo} is not this review's policy authority ${authority?.dataRepo ?? "(none)"}`,
    );
  }
  const finding = ledger.rounds.flatMap((round) => round.findings).find((candidate) => candidate.id === findingId);
  if (!finding) throw new Error(`finding ${findingId} not found`);
  const relativeFollowUpPath = `items/${tracks}.md`;
  const committedEntry = spawnSync("git", ["-C", canonicalDataRepo, "ls-tree", "HEAD", "--", relativeFollowUpPath], {
    encoding: "utf8",
  });
  const entry = committedEntry.stdout.trim();
  if (committedEntry.status !== 0 || !entry) {
    throw new Error(`delegated follow-up item ${tracks} must be tracked and committed in the policy authority`);
  }
  if (!/^100(?:644|755) blob [0-9a-f]+\t/.test(entry)) {
    throw new Error(`delegated follow-up item ${tracks} must be a committed regular file`);
  }
  const text = git(["-C", canonicalDataRepo, "show", `HEAD:${relativeFollowUpPath}`]);
  const item = parseItemFileText(relativeFollowUpPath, text);
  const inactiveStates = new Set(["tested", "delivered", "accepted", "dropped"]);
  if (inactiveStates.has(item.state)) {
    throw new Error(`delegated follow-up item ${tracks} must remain active, found state ${item.state}`);
  }
  const validationErrors = validateItem(item);
  if (validationErrors.length > 0) {
    throw new Error(`delegated follow-up item ${tracks} is invalid: ${validationErrors.join("; ")}`);
  }
  const sourceMarker = `Review source: \`${sourceItem}#${findingId}\``;
  const location = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "Not anchored";
  const requiredContext = [
    sourceMarker,
    `Review finding: ${finding.title}`,
    `Review location: ${location}`,
    `Review evidence: ${finding.evidence}`,
    `Review impact: ${finding.impact}`,
    `Review direction: ${finding.direction}`,
  ];
  const missing = requiredContext.find((line) => !text.includes(line));
  if (missing) {
    throw new Error(`delegated follow-up item ${tracks} must contain ${missing}`);
  }
}

async function addDisposition(options: DispositionOptions): Promise<void> {
  const branch = git(["branch", "--show-current"]);
  if (!branch) throw new Error("disposition requires a named branch");
  const repository = git(["rev-parse", "--show-toplevel"]);
  const releaseLock = await acquireReviewLock(repository, branch);
  try {
    const paths = reviewEvidencePaths(repository, branch, options.item);
    const existingLedger = readLedger(paths.jsonPath);
    if (existingLedger.branch !== branch) {
      throw new Error(`review ledger branch is ${existingLedger.branch}, expected ${branch}`);
    }
    if (existingLedger.item !== options.item) throw new Error("review item does not match the existing ledger");
    // Resolved lazily and only for a waiver: every other disposition kind must keep
    // working without a data repo, and a waiver without one must fail closed, not pass.
    // The supplied repo must be the authority this ledger recorded, so a waiver cannot
    // be authorized by a loops.json the caller chose after the fact.
    let classes: ReviewClassConfig[] | undefined;
    if (options.kind === "waived-by-policy") {
      const governing = governingPolicy(existingLedger, options.dataRepo);
      if (governing.refusal) throw new Error(`waiver is not authorized: ${governing.refusal}`);
      classes = governing.review?.classes;
    }
    if (options.kind === "delegated-follow-up") {
      assertDelegatedFollowUp(existingLedger, options.dataRepo, options.item, options.findingId, options.tracks);
    }
    const ledger = recordDisposition(existingLedger, options.findingId, options.kind, options.reason, {
      ...(options.doc ? {doc: options.doc} : {}),
      ...(options.waivedClass ? {waivedClass: options.waivedClass} : {}),
      ...(options.tracks ? {tracks: options.tracks} : {}),
      ...(options.urgency ? {urgency: options.urgency} : {}),
      ...(options.escalation ? {escalation: options.escalation} : {}),
      ...(options.causality ? {causality: options.causality} : {}),
      ...(classes ? {classes} : {}),
      ...(options.owner ? {owner: true} : {}),
    });
    await writeLedger(ledger, paths);
    process.stdout.write(`${options.findingId} marked ${options.kind}\n`);
  } finally {
    await releaseLock();
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** The current-HEAD gate. Two resolution invariants hold here and are the reason
 * `dataRepo` is a parameter rather than an ambient lookup:
 *
 * 1. The policy this gate binds against must be the one `start` and `disposition` used.
 *    Both take `--data-repo`, so `status` must too; resolving from the environment alone
 *    left every waiver recorded through the documented flow unauthorized here.
 * 2. Authorization binds against the RESOLVED classes, never the recorded waiver. No
 *    resolvable data repo means no classes, and no classes means waivers block. */
function currentReviewStatus(item?: string, dataRepo?: string): ReviewStatus {
  const branch = git(["branch", "--show-current"]);
  if (!branch) throw new Error("review status requires a named branch");
  const repository = git(["rev-parse", "--show-toplevel"]);
  const headSha = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  const paths = reviewEvidencePaths(repository, branch, item);
  const ledgerPath = relative(repository, paths.markdownPath);
  if (dirtyOutsideReviewEvidence(repository)) {
    return {
      kind: "blocked",
      ...(item ? { item } : {}),
      headSha,
      ledgerPath,
      reason: "working tree has uncommitted changes outside .reviews",
    };
  }
  try {
    const ledger = readLedger(paths.jsonPath);
    if (ledger.item !== item) throw new Error("review item does not match the selected ledger");
    // The evidence path hashes the branch name, but that only guards against
    // accidents - a copied ledger must not certify a different branch's review.
    if (ledger.branch !== branch) {
      throw new Error(`review ledger branch is ${ledger.branch}, expected ${branch}`);
    }
    for (const round of ledger.rounds) {
      for (const finding of round.findings) {
        if (finding.disposition?.kind !== "delegated-follow-up") continue;
        assertDelegatedFollowUp(
          ledger,
          dataRepo,
          item,
          finding.disposition.carriedFrom ?? finding.id,
          finding.disposition.tracks,
        );
      }
    }
    // Waiver authorization binds at this gate against the currently resolved classes
    // (--data-repo, else $LOOPS_DATA_REPO), and only when that repo is the authority the
    // ledger recorded. Any other repo, or none, yields no classes and every waiver
    // blocks - the same fail-closed direction as an absent config.
    const governing = governingPolicy(ledger, dataRepo);
    // C8: a ledger bound to a profile is re-resolved at every gate, and status is one.
    // With the binding unresolvable the loop controls this review ran under are unknown,
    // so it blocks rather than certifying under whatever the config says now. A ledger
    // with no profile keeps today's behavior, including status outside a data repo.
    if (ledger.profile !== undefined && governing.refusal) {
      return {
        kind: "blocked",
        ...(item ? { item } : {}),
        headSha,
        ledgerPath,
        reason: governing.refusal,
      };
    }
    const policy = governing.review;
    const classes = policy?.classes;
    const terminalRejection = policy?.terminalRejection ?? false;
    const capExit = policy?.capExit
      ? {maxRounds: effectiveMaxRounds(ledger, policy.maxRounds ?? DEFAULT_REVIEW_MAX_ROUNDS)}
      : undefined;
    const status = evaluateReviewStatus(ledger, headSha, ledgerPath, classes, terminalRejection, capExit);
    const latestRound = ledger.rounds.at(-1);
    if (
      status.kind === "blocked" &&
      status.reason.startsWith("latest review covers ") &&
      latestRound?.headSha !== headSha &&
      latestRound?.audit?.manifest.metadataPaths?.length
    ) {
      const reviewedStatus = evaluateReviewStatus(ledger, latestRound.headSha, ledgerPath, classes, terminalRejection, capExit);
      const ancestor = spawnSync(
        "git",
        ["-C", repository, "merge-base", "--is-ancestor", latestRound.headSha, headSha],
        {encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES},
      );
      const changedFiles = ancestor.status === 0
        ? git(["-C", repository, "diff", "--name-only", `${latestRound.headSha}..${headSha}`, "--"])
            .split("\n")
            .filter(Boolean)
        : [];
      if (
        reviewedStatus.kind === "passed" &&
        changedFiles.length > 0 &&
        changedFiles.every((path) => matchesMetadataPath(path, latestRound.audit?.manifest.metadataPaths ?? []))
      ) {
        return {...reviewedStatus, headSha, ...(item ? {item} : {})};
      }
    }
    return { ...status, ...(item ? { item } : {}) };
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return {
        kind: "not_run",
        ...(item ? { item } : {}),
        headSha,
        ledgerPath,
        reason: item ? "no review ledger for current item" : "no review ledger for current branch",
      };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: "blocked",
      ...(item ? { item } : {}),
      headSha,
      ledgerPath,
      reason: `review evidence is invalid: ${reason}`,
    };
  }
}

function printReviewStatus(item?: string, dataRepo?: string): void {
  const status = currentReviewStatus(item, dataRepo);
  process.stdout.write(`${renderReviewStatus(status)}\n`);
  if (status.kind !== "passed") process.exitCode = 1;
}

/** `status [--item <slug>] [--data-repo <path>]`, order-independent. Strict about
 * unknown and incomplete flags for the same reason the other parsers are: a silently
 * ignored `--data-repo` here reports a waived round as blocked. */
function parseStatusOptions(args: string[]): [string | undefined, string | undefined] {
  let item: string | undefined;
  let dataRepo: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--item" && value) item = value;
    else if (flag === "--data-repo" && value) dataRepo = value;
    else throw new Error("status accepts only --item <item-slug> and --data-repo <path>");
  }
  return [item, dataRepo];
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "start") {
    await startReview(parseStartOptions(args));
  } else if (command === "disposition") {
    await addDisposition(parseDispositionOptions(args));
  } else if (command === "status") {
    printReviewStatus(...parseStatusOptions(args));
  } else if (command === "stats") {
    process.stdout.write(runStats(parseStatsOptions(args)));
  } else {
    throw new Error("usage: cli-review <start|disposition|status|stats> [options]");
  }
}

function parseStatsOptions(args: string[]): StatsOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error(`unknown or incomplete argument: ${flag ?? ""}`);
    values.set(flag, value);
  }
  const known = ["--data-repo", "--cohort", "--snapshot-in", "--snapshot-out"];
  for (const flag of values.keys()) {
    if (!known.includes(flag)) {
      throw new Error("usage: cli-review stats --data-repo <repo> [--cohort <file> | --snapshot-in <file>] [--snapshot-out <file>]");
    }
  }
  const dataRepo = values.get("--data-repo") ?? process.env.LOOPS_DATA_REPO;
  if (!dataRepo) throw new Error("stats requires --data-repo <repo> (or LOOPS_DATA_REPO)");
  if (values.get("--cohort") && values.get("--snapshot-in")) {
    throw new Error("--cohort and --snapshot-in are mutually exclusive");
  }
  if (values.get("--snapshot-in") && values.get("--snapshot-out")) {
    throw new Error("--snapshot-out has nothing to write when measuring an existing snapshot");
  }
  return {
    dataRepo,
    ...(values.get("--cohort") ? {cohort: values.get("--cohort")} : {}),
    ...(values.get("--snapshot-in") ? {snapshotIn: values.get("--snapshot-in")} : {}),
    ...(values.get("--snapshot-out") ? {snapshotOut: values.get("--snapshot-out")} : {}),
  };
}

main().catch((error: unknown): void => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
