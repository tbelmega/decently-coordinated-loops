#!/usr/bin/env bun
// `bun cli-review.ts <start|disposition|status> [options]` — drive a local, forge-independent
// code review of the committed change on the current branch, using the reviewer
// adapter this instance activated (loops.json → review). Runs from the *target* repo,
// like the participation gate; resolve the data repo via --data-repo or $LOOPS_DATA_REPO.
//
// Each `start` is independent and reviews the full base..HEAD change; the ledger under
// .reviews/ carries rounds + per-finding dispositions and fails closed on a dirty tree,
// a changed HEAD, a mismatched base, or the round cap. The reviewer never edits/commits.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { loadConfig } from "../config.ts";
import {
  addReviewRound,
  createReviewLedger,
  parseReview,
  parseReviewLedger,
  priorDispositionNotes,
  recordDisposition,
  recordReviewFailure,
  renderReviewLedger,
  reviewCanContinue,
  isDispositionKind,
  type DispositionKind,
  type ReviewLedger,
} from "./review-ledger.ts";
import { acquireReviewLock } from "./review-lock.ts";
import { writeFileAtomically } from "./atomic-write.ts";
import { getReviewer, isReviewerId, reviewerIds, type Reviewer } from "./reviewers.ts";
import {
  evaluateReviewStatus,
  renderReviewStatus,
  reviewEvidencePaths,
  type ReviewStatus,
} from "./review-status.ts";

interface StartOptions {
  baseRef: string;
  item?: string;
  reviewer: Reviewer;
  model?: string;
  /** Owner-authorized round-cap extension (`--max-rounds`); default cap is 3. */
  maxRounds?: number;
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr?.toString().trim() || `git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

/** Resolves which reviewer + model to use: explicit flags win, else the data repo's
 * loops.json `review` block (from --data-repo or $LOOPS_DATA_REPO). */
function resolveReviewer(flags: { reviewer?: string; dataRepo?: string; model?: string }): {
  reviewer: Reviewer;
  model?: string;
} {
  const home = process.env.HOME ?? homedir();
  const config = flags.dataRepo ? loadConfig(resolve(expandHome(flags.dataRepo, home))) : undefined;
  const id = flags.reviewer ?? config?.review.reviewer;
  if (!id) {
    throw new Error(
      "no reviewer configured — set review.reviewer in loops.json (run setup) or pass --reviewer <" +
        reviewerIds.join("|") +
        ">",
    );
  }
  if (!isReviewerId(id)) throw new Error(`unknown reviewer "${id}" — expected one of ${reviewerIds.join(", ")}`);
  return { reviewer: getReviewer(id), model: flags.model ?? config?.review.model };
}

function parseStartOptions(args: string[]): StartOptions {
  const flags: { reviewer?: string; dataRepo?: string; model?: string; item?: string } = {};
  let baseRef = "";
  let maxRounds: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--base" && value) baseRef = value;
    else if (arg === "--data-repo" && value) flags.dataRepo = value;
    else if (arg === "--reviewer" && value) flags.reviewer = value;
    else if (arg === "--model" && value) flags.model = value;
    else if (arg === "--item" && value) flags.item = value;
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
  const { reviewer, model } = resolveReviewer(flags);
  return { baseRef, item: flags.item, reviewer, model, maxRounds };
}

function reviewPrompt(baseSha: string, headSha: string, priorNotes: string[]): string {
  return [
    `Review exactly the committed change ${baseSha}..${headSha} in the current repository.`,
    "Use git diff and inspect relevant call sites and tests.",
    "Report only actionable correctness, security, data-loss, concurrency, compatibility, or material maintainability defects; omit style preferences.",
    "Do not edit files, commit, push, fetch, or use the network. Ignore files under .reviews because they are review evidence.",
    ...(priorNotes.length > 0
      ? [
          "Earlier rounds already dispositioned these findings; re-raise one only if you can show its recorded reason is factually wrong:",
          priorNotes.join("; ") + ".",
        ]
      : []),
    "Return only the requested structured result. An empty findings array means no actionable findings.",
  ].join(" ");
}

function readLedger(path: string): ReviewLedger {
  return parseReviewLedger(JSON.parse(readFileSync(path, "utf8")));
}

async function writeLedger(ledger: ReviewLedger, paths: { jsonPath: string; markdownPath: string }): Promise<void> {
  mkdirSync(dirname(paths.jsonPath), { recursive: true });
  await writeFileAtomically(paths.jsonPath, `${JSON.stringify(ledger, null, 2)}\n`);
  await writeFileAtomically(paths.markdownPath, renderReviewLedger(ledger));
}

// Anchor at the repo root: pathspecs are cwd-relative, so an unanchored check run
// from a subdirectory would miss dirty files elsewhere. Review evidence under
// .reviews is excluded — the tool writes it itself, and it must not wedge the next
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
    const paths = reviewEvidencePaths(repository, branch, options.item);
    const modelLabel = options.model ?? `${options.reviewer.id} (default)`;
    let ledger: ReviewLedger;
    let baseSha: string;
    try {
      ledger = readLedger(paths.jsonPath);
      if (ledger.branch !== branch) throw new Error(`review ledger branch is ${ledger.branch}, expected ${branch}`);
      if (ledger.item !== options.item) throw new Error("review item does not match the existing ledger");
      if (ledger.baseRef !== options.baseRef) throw new Error("review base ref does not match the existing ledger");
      baseSha = ledger.baseSha;
      const continuation = reviewCanContinue(
        ledger.rounds.map((round) => ({
          headSha: round.headSha,
          findings: round.findings.map((finding) => ({ id: finding.id, disposition: finding.disposition?.kind })),
        })),
        options.maxRounds,
        headSha,
      );
      if (!continuation.allowed) throw new Error(continuation.reason || "review cannot continue");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        baseSha = resolvedBaseSha;
        ledger = createReviewLedger({ item: options.item, branch, baseRef: options.baseRef, baseSha });
      } else {
        throw error;
      }
    }

    try {
      const raw = options.reviewer.invoke({
        prompt: reviewPrompt(baseSha, headSha, priorDispositionNotes(ledger)),
        model: options.model,
        cwd: repository,
      });
      const headAfterReview = git(["rev-parse", "--verify", "HEAD^{commit}"]);
      if (headAfterReview !== headSha) throw new Error("HEAD changed during review; result is invalid");
      const review = parseReview(raw);
      ledger = addReviewRound(ledger, {
        headSha,
        model: modelLabel,
        reviewedAt: new Date().toISOString(),
        review,
      });
      await writeLedger(ledger, paths);
      process.stdout.write(`Review round ${ledger.rounds.length} written to ${paths.markdownPath}\n`);
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
}

function parseDispositionOptions(args: string[]): DispositionOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error(`unknown or incomplete argument: ${flag ?? ""}`);
    values.set(flag, value);
  }
  const findingId = values.get("--finding");
  const status = values.get("--status");
  const reason = values.get("--reason");
  if (!findingId || !status || !reason) {
    throw new Error("disposition requires --finding <id> --status <status> --reason <reason>");
  }
  if (!isDispositionKind(status)) throw new Error(`invalid disposition: ${status}`);
  return { item: values.get("--item"), findingId, kind: status, reason };
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
    const ledger = recordDisposition(existingLedger, options.findingId, options.kind, options.reason);
    await writeLedger(ledger, paths);
    process.stdout.write(`${options.findingId} marked ${options.kind}\n`);
  } finally {
    await releaseLock();
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function currentReviewStatus(item?: string): ReviewStatus {
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
    // accidents — a copied ledger must not certify a different branch's review.
    if (ledger.branch !== branch) {
      throw new Error(`review ledger branch is ${ledger.branch}, expected ${branch}`);
    }
    return { ...evaluateReviewStatus(ledger, headSha, ledgerPath), ...(item ? { item } : {}) };
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

function printReviewStatus(item?: string): void {
  const status = currentReviewStatus(item);
  process.stdout.write(`${renderReviewStatus(status)}\n`);
  if (status.kind !== "passed") process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "start") {
    await startReview(parseStartOptions(args));
  } else if (command === "disposition") {
    await addDisposition(parseDispositionOptions(args));
  } else if (command === "status") {
    if (args.length === 0) printReviewStatus();
    else if (args.length === 2 && args[0] === "--item" && args[1]) printReviewStatus(args[1]);
    else throw new Error("status accepts only --item <item-slug>");
  } else {
    throw new Error("usage: cli-review <start|disposition|status> [options]");
  }
}

main().catch((error: unknown): void => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
