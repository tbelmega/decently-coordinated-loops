#!/usr/bin/env bun
// `bun cli-review.ts <start|disposition> [options]` — drive a local, forge-independent
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
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../config.ts";
import {
  addReviewRound,
  createReviewLedger,
  parseReview,
  parseReviewLedger,
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

interface StartOptions {
  baseRef: string;
  reviewer: Reviewer;
  model?: string;
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
  const flags: { reviewer?: string; dataRepo?: string; model?: string } = {};
  let baseRef = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--base" && value) baseRef = value;
    else if (arg === "--data-repo" && value) flags.dataRepo = value;
    else if (arg === "--reviewer" && value) flags.reviewer = value;
    else if (arg === "--model" && value) flags.model = value;
    else if (arg.startsWith("--")) {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    } else continue;
    index += 1;
  }
  if (!baseRef) throw new Error("start requires --base <ref>");
  const { reviewer, model } = resolveReviewer(flags);
  return { baseRef, reviewer, model };
}

function reviewPrompt(baseSha: string, headSha: string): string {
  return [
    `Review exactly the committed change ${baseSha}..${headSha} in the current repository.`,
    "Use git diff and inspect relevant call sites and tests.",
    "Report only actionable correctness, security, data-loss, concurrency, compatibility, or material maintainability defects; omit style preferences.",
    "Do not edit files, commit, push, fetch, or use the network. Ignore files under .reviews because they are review evidence.",
    "Return only the requested structured result. An empty findings array means no actionable findings.",
  ].join(" ");
}

function reviewPaths(repository: string, branch: string): { jsonPath: string; markdownPath: string } {
  const reviewDirectory = join(repository, ".reviews");
  const slug = branch.replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
  const branchHash = createHash("sha256").update(branch).digest("hex").slice(0, 10);
  const filename = `${slug}--${branchHash}`;
  return {
    jsonPath: join(reviewDirectory, `${filename}.json`),
    markdownPath: join(reviewDirectory, `${filename}.md`),
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

async function startReview(options: StartOptions): Promise<void> {
  if (git(["status", "--porcelain"])) throw new Error("working tree must be clean before review");
  const branch = git(["branch", "--show-current"]);
  if (!branch) throw new Error("review requires a named branch");
  const repository = git(["rev-parse", "--show-toplevel"]);
  const releaseLock = await acquireReviewLock(repository, branch);
  try {
    const resolvedBaseSha = git(["rev-parse", "--verify", `${options.baseRef}^{commit}`]);
    const headSha = git(["rev-parse", "--verify", "HEAD^{commit}"]);
    const paths = reviewPaths(repository, branch);
    const modelLabel = options.model ?? `${options.reviewer.id} (default)`;
    let ledger: ReviewLedger;
    let baseSha: string;
    try {
      ledger = readLedger(paths.jsonPath);
      if (ledger.branch !== branch) throw new Error(`review ledger branch is ${ledger.branch}, expected ${branch}`);
      if (ledger.baseRef !== options.baseRef) throw new Error("review base ref does not match the existing ledger");
      baseSha = ledger.baseSha;
      const continuation = reviewCanContinue(
        ledger.rounds.map((round) => ({
          findings: round.findings.map((finding) => ({ id: finding.id, disposition: finding.disposition?.kind })),
        })),
      );
      if (!continuation.allowed) throw new Error(continuation.reason || "review cannot continue");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        baseSha = resolvedBaseSha;
        ledger = createReviewLedger({ branch, baseRef: options.baseRef, baseSha });
      } else {
        throw error;
      }
    }

    try {
      const raw = options.reviewer.invoke({ prompt: reviewPrompt(baseSha, headSha), model: options.model, cwd: repository });
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
  return { findingId, kind: status, reason };
}

async function addDisposition(options: DispositionOptions): Promise<void> {
  const branch = git(["branch", "--show-current"]);
  if (!branch) throw new Error("disposition requires a named branch");
  const repository = git(["rev-parse", "--show-toplevel"]);
  const releaseLock = await acquireReviewLock(repository, branch);
  try {
    const paths = reviewPaths(repository, branch);
    const existingLedger = readLedger(paths.jsonPath);
    if (existingLedger.branch !== branch) {
      throw new Error(`review ledger branch is ${existingLedger.branch}, expected ${branch}`);
    }
    const ledger = recordDisposition(existingLedger, options.findingId, options.kind, options.reason);
    await writeLedger(ledger, paths);
    process.stdout.write(`${options.findingId} marked ${options.kind}\n`);
  } finally {
    await releaseLock();
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "start") {
    await startReview(parseStartOptions(args));
  } else if (command === "disposition") {
    await addDisposition(parseDispositionOptions(args));
  } else {
    throw new Error("usage: cli-review <start|disposition> [options]");
  }
}

main().catch((error: unknown): void => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
