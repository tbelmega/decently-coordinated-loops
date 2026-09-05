// `cli-review stats`: the review measurement report. Every definition this module
// applies is written down in the reference data repo's
// docs/specs/2026-08-26-review-measurement-definitions.md; the section names below
// ("Population", "Epochs", "Outcome", "The round clock", "Baseline", "Output contract")
// refer to it. Hold the code to that text.
//
// The module is a reporting tool, not a gate: a ledger it cannot measure is excluded
// and the exclusion is printed, and whether a review passed is asked of the gate's own
// predicate (`evaluateReviewStatus`) rather than re-derived here.
//
// Three sources, mutually exclusive:
//   - discovery (default): every schema-valid ledger with live rounds owned by the data
//     repo's registered projects and the data repo itself;
//   - --cohort FILE: exactly the listed ledger paths, strict (a missing or roundless
//     entry fails the command, because a hand-written list must not silently shrink);
//   - --snapshot-in FILE: a copy written earlier by --snapshot-out, measured verbatim.
// Cohort and snapshot paths resolve from the workspace root, the parent directory of
// the data repo, so the command works from any CWD.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_REVIEW_MAX_ROUNDS, loadConfig, resolveReviewConfig, type LoopsConfig, type ReviewClassConfig, type ReviewConfig } from "../config.ts";
import {
  effectiveMaxRounds,
  liveRounds,
  parseReviewLedger,
  type LedgerFinding,
  type ReviewLedger,
  type ReviewPassTokens,
  type ReviewRound,
  type ReviewRoundPolicy,
} from "./review-ledger.ts";
import { evaluateReviewStatus } from "./review-status.ts";
import { testExitReviewStateHash } from "./review-test-evidence.ts";

// ---------------------------------------------------------------------------
// The measured record: what a snapshot stores and what the report reads.
// ---------------------------------------------------------------------------

/** The finding fields the convergence table reads ("Baseline"). A snapshot stores
 * exactly these, so the frozen baseline is a byte-stable record of what it measured. */
export interface StatsFinding {
  priority: string | null;
  origin: string | null;
  passes: string[] | null;
  confidence: string | null;
  title: string | null;
  impact: string | null;
  disposition: {kind?: string} | null;
}

/** One reviewer invocation's measurements ("The round clock"). */
export interface StatsPass {
  pass: string;
  elapsedMs?: number;
  tokens?: number;
  model?: string;
  effort?: string;
}

export interface StatsRound {
  number: number;
  manifestFiles: number;
  manifestHunks: number;
  findings: StatsFinding[];
  /** Wall time of the blocking passes, first start to last finish. */
  elapsedMs?: number;
  /** Reviewer compute: the blocking passes' durations summed. */
  reviewerMs?: number;
  /** Tokens over the blocking passes that reported usage. */
  tokens?: number;
  noteCount?: number;
  lateHighPriority?: number;
  /** The non-blocking shadow instrument's own cost, kept apart from the figures above. */
  shadowElapsedMs?: number;
  shadowTokens?: number;
  passes?: StatsPass[];
}

export type StatsOutcome = "passed" | "cap-exit" | "test-cap-exit" | "open" | "legacy";

export interface StatsLedger {
  path: string;
  item: string | null;
  sha256: string;
  profile?: string;
  /** The active epoch's rounds only ("Epochs"). */
  rounds: StatsRound[];
  /** Rounds of superseded epochs: audit history, counted nowhere but reported. */
  supersededRounds?: number;
  /** The gate's verdict at the reviewed head ("Outcome"). Absent in snapshots written
   * before outcomes were recorded, where no outcome line is printed. */
  outcome?: StatsOutcome;
  /** The loop keys the last live round recorded: the outcome's input, kept so a
   * snapshot can be audited without the live ledger ("Outcome"). */
  policy?: ReviewRoundPolicy;
  /** The round cap the last live round recorded, owner override applied. Absent when
   * the round recorded none, which the report shows as `cap-unknown`. */
  cap?: number;
  /** Legacy snapshot field: index of the first live round. Honored on read so an older
   * snapshot measures the same rounds it was written to measure. */
  liveFrom?: number;
}

export interface StatsExclusion {
  reason: "unparseable" | "no-rounds";
  paths: string[];
}

export interface StatsPopulation {
  ledgers: StatsLedger[];
  excluded: StatsExclusion[];
}

export interface StatsOptions {
  dataRepo: string;
  cohort?: string;
  snapshotIn?: string;
  snapshotOut?: string;
}

// ---------------------------------------------------------------------------
// Collection: live ledger file -> measured record.
// ---------------------------------------------------------------------------

/** A token record reduced to one number: the reported total, else input + output,
 * else nothing (the adapter exposed no usage). */
function tokenTotal(tokens: ReviewPassTokens | undefined): number | undefined {
  if (!tokens) return undefined;
  if (typeof tokens.total === "number") return tokens.total;
  if (tokens.input === undefined && tokens.output === undefined) return undefined;
  return (tokens.input ?? 0) + (tokens.output ?? 0);
}

function statsFinding(finding: LedgerFinding): StatsFinding {
  return {
    priority: finding.priority ?? null,
    origin: finding.origin ?? null,
    passes: finding.passes ?? null,
    confidence: finding.confidence ?? null,
    title: finding.title ?? null,
    impact: finding.impact ?? null,
    disposition: finding.disposition ? {kind: finding.disposition.kind} : null,
  };
}

function statsRound(round: ReviewRound): StatsRound {
  const audit = round.audit;
  const files = audit?.manifest.files ?? [];
  const metrics = audit?.metrics;
  const passes = (audit?.passes ?? [])
    .map((pass): StatsPass => ({
      pass: pass.pass,
      ...(pass.elapsedMs !== undefined ? {elapsedMs: pass.elapsedMs} : {}),
      ...(tokenTotal(pass.tokens) !== undefined ? {tokens: tokenTotal(pass.tokens)} : {}),
      ...(pass.model !== undefined ? {model: pass.model} : {}),
      ...(pass.effort !== undefined ? {effort: pass.effort} : {}),
    }))
    .filter((pass) => pass.elapsedMs !== undefined || pass.tokens !== undefined || pass.model !== undefined);
  const shadowTokens = tokenTotal(metrics?.shadowTokens);
  const tokens = tokenTotal(metrics?.tokens);
  return {
    number: round.number,
    manifestFiles: files.length,
    manifestHunks: files.reduce((count, file) => count + file.hunks.length, 0),
    findings: round.findings.map(statsFinding),
    ...(metrics?.elapsedMs !== undefined ? {elapsedMs: metrics.elapsedMs} : {}),
    ...(metrics?.reviewerMs !== undefined ? {reviewerMs: metrics.reviewerMs} : {}),
    ...(tokens !== undefined ? {tokens} : {}),
    ...(metrics?.noteCount !== undefined ? {noteCount: metrics.noteCount} : {}),
    ...(metrics?.lateHighPriorityFindings !== undefined ? {lateHighPriority: metrics.lateHighPriorityFindings} : {}),
    ...(metrics?.shadowElapsedMs !== undefined ? {shadowElapsedMs: metrics.shadowElapsedMs} : {}),
    ...(shadowTokens !== undefined ? {shadowTokens} : {}),
    ...(passes.length > 0 ? {passes} : {}),
  };
}

/** Tilde-expanded, resolved, symlink-free form of a path; the lexical form when it
 * does not exist, so a missing path still compares deterministically. */
function canonicalPath(path: string): string {
  const expanded = resolve(expandHome(path));
  try {
    return realpathSync.native(expanded);
  } catch {
    return expanded;
  }
}

/** The waiver classes the data repo currently resolves for a ledger ("Outcome"),
 * under the same binding the status gate enforces: the ledger's recorded authority
 * must be this data repo, its project must still be registered and still point at
 * the checkout the review started on, and its recorded profile must still resolve.
 * A ledger bound to no project is governed by the global block. A refusal is
 * returned as such: the gate treats it as "no classes, every waiver blocks" for an
 * unprofiled ledger and as blocked outright for a profiled one, and `outcomeOf`
 * applies the same split. The gate's one CWD-bound check (that it runs inside the
 * authorized checkout) has no counterpart here because stats never runs inside one. */
function classesFor(
  config: LoopsConfig | undefined,
  dataRepo: string,
  ledger: ReviewLedger,
): {classes: ReviewClassConfig[] | undefined; review: ReviewConfig} | {refused: true} {
  const authority = ledger.authority;
  if (!config || !authority || authority.dataRepo !== canonicalPath(dataRepo)) return {refused: true};
  if (authority.project !== undefined) {
    const entry = Object.prototype.hasOwnProperty.call(config.projects, authority.project)
      ? config.projects[authority.project]
      : undefined;
    if (!entry || !authority.projectRepo) return {refused: true};
    if ((entry.repo ? canonicalPath(entry.repo) : undefined) !== authority.projectRepo) return {refused: true};
  }
  try {
    const review = resolveReviewConfig(config, authority.project, ledger.profile ?? null);
    return {classes: review.classes, review};
  } catch {
    return {refused: true};
  }
}

/** The gate's verdict at the reviewed head, under the keys the last live round ran
 * with ("Outcome"). A round that recorded no policy ran before the keys existed and is
 * evaluated with them off. A ledger written before causal classification is `legacy`:
 * the gate's current rules cannot certify it and it was certified by the rules of its
 * day, so asking the gate would report a retroactive rule, not the review's result. */
function outcomeOf(
  ledger: ReviewLedger,
  live: ReviewRound[],
  binding: {classes: ReviewClassConfig[] | undefined; review: ReviewConfig} | {refused: true},
): {outcome: StatsOutcome; cap?: number; policy?: ReviewRoundPolicy} {
  const last = live.at(-1)!;
  const policy = last.audit?.policy;
  const policyCap = policy?.maxRounds !== undefined ? effectiveMaxRounds(ledger, policy.maxRounds) : undefined;
  const provenance = {...(policyCap !== undefined ? {cap: policyCap} : {}), ...(policy ? {policy} : {})};
  if (ledger.causalScopeVersion === undefined) return {outcome: "legacy", ...provenance};
  // The gate's split: with the binding unresolvable, the loop controls a profiled
  // review ran under are unknown and it blocks outright; an unprofiled ledger is
  // evaluated with no classes, so only its waivers block.
  if ("refused" in binding && ledger.profile !== undefined) return {outcome: "open", ...provenance};
  const classes = "refused" in binding ? undefined : binding.classes;
  const review = "refused" in binding ? undefined : binding.review;
  const capExit = policy?.capExit
    ? {maxRounds: effectiveMaxRounds(ledger, policy.maxRounds ?? DEFAULT_REVIEW_MAX_ROUNDS)}
    : undefined;
  const testCapExit = review?.testBackedCapExit
    ? {maxRounds: effectiveMaxRounds(ledger, review.maxRounds ?? DEFAULT_REVIEW_MAX_ROUNDS)}
    : undefined;
  const evidence = ledger.testCapExits?.at(-1);
  // A later independent round invalidates the evidence's state hash. Its reviewed head
  // must remain the status input so a clean confirmation is never made stale by an
  // earlier test attempt.
  const currentEvidence = evidence?.reviewStateHash === testExitReviewStateHash(ledger) ? evidence : undefined;
  const currentHeadSha = currentEvidence?.headSha ?? last.headSha;
  const status = evaluateReviewStatus(
    ledger,
    currentHeadSha,
    "",
    classes,
    policy?.terminalRejection ?? false,
    capExit,
    testCapExit,
  );
  const isTestCapExit = status.kind === "passed" && status.testCapExit;
  const outcome: StatsOutcome = status.kind !== "passed"
    ? "open"
    : isTestCapExit
      ? "test-cap-exit"
      : status.capExit
        ? "cap-exit"
        : "passed";
  return {
    outcome,
    ...(isTestCapExit && currentEvidence ? {cap: currentEvidence.maxRounds} : provenance),
  };
}

/** One live ledger file measured, or the reason it is excluded ("Population"). */
export function collectLedger(
  absolutePath: string,
  workspacePath: string,
  config: LoopsConfig | undefined,
  dataRepo: string,
): {ledger: StatsLedger} | {excluded: StatsExclusion["reason"]} {
  const raw = readFileSync(absolutePath);
  let ledger: ReviewLedger;
  try {
    ledger = parseReviewLedger(JSON.parse(raw.toString("utf8")));
  } catch {
    return {excluded: "unparseable"};
  }
  const live = liveRounds(ledger);
  if (live.length === 0) return {excluded: "no-rounds"};
  const superseded = ledger.rounds.length - live.length;
  return {
    ledger: {
      path: workspacePath,
      item: ledger.item ?? null,
      sha256: createHash("sha256").update(raw).digest("hex"),
      ...(ledger.profile !== undefined ? {profile: ledger.profile} : {}),
      rounds: live.map(statsRound),
      ...(superseded > 0 ? {supersededRounds: superseded} : {}),
      ...outcomeOf(ledger, live, classesFor(config, dataRepo, ledger)),
    },
  };
}

function expandHome(path: string): string {
  return path.startsWith("~/") || path === "~" ? join(homedir(), path.slice(1)) : path;
}

/** Live ledger paths (workspace-relative) owned by the data repo's registered projects
 * and the data repo itself ("Population"): each root's `.reviews/*.json` plus every
 * worktree's, superseded copies skipped, one entry per filesystem identity, sorted. */
export function discoverLedgers(dataRepo: string, workspaceRoot: string): string[] {
  const roots = new Set<string>([resolve(dataRepo)]);
  const configPath = join(dataRepo, "loops.json");
  if (existsSync(configPath)) {
    const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof config === "object" && config !== null && "projects" in config) {
      const projects = (config as {projects: unknown}).projects;
      if (typeof projects === "object" && projects !== null) {
        for (const project of Object.values(projects as Record<string, unknown>)) {
          if (typeof project === "object" && project !== null && typeof (project as {repo?: unknown}).repo === "string") {
            roots.add(resolve(expandHome((project as {repo: string}).repo)));
          }
        }
      }
    }
  }
  // Identity is the real path, never the spelling: a root's own `.reviews` is collected
  // directly and again as the primary worktree git lists, and a symlinked checkout is
  // collected under its link while git reports the physical path. First spelling wins.
  const found = new Map<string, string>();
  const collect = (reviewsDir: string): void => {
    if (!existsSync(reviewsDir)) return;
    for (const entry of readdirSync(reviewsDir)) {
      if (!entry.endsWith(".json") || entry.startsWith("superseded-")) continue;
      const path = resolve(reviewsDir, entry);
      let identity: string;
      try {
        identity = realpathSync(path);
      } catch {
        identity = path;
      }
      if (!found.has(identity)) found.set(identity, path);
    }
  };
  for (const root of roots) {
    collect(join(root, ".reviews"));
    const listed = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], {encoding: "utf8"});
    if (listed.status === 0) {
      for (const line of listed.stdout.split("\n")) {
        if (line.startsWith("worktree ")) collect(join(line.slice("worktree ".length).trim(), ".reviews"));
      }
      continue;
    }
    const worktrees = join(root, ".worktrees");
    if (existsSync(worktrees)) {
      for (const entry of readdirSync(worktrees, {withFileTypes: true})) {
        if (entry.isDirectory()) collect(join(worktrees, entry.name, ".reviews"));
      }
    }
  }
  const prefix = `${workspaceRoot}/`;
  return [...found.values()]
    .map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Cohort entries reduced to one per filesystem identity, first spelling kept: a
 * hand-written list that names one ledger twice, or under two spellings, still
 * measures it once ("Population"). */
function uniqueByIdentity(paths: string[], fromWorkspace: (path: string) => string): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const path of paths) {
    let identity: string;
    try {
      identity = realpathSync(fromWorkspace(path));
    } catch {
      identity = fromWorkspace(path);
    }
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push(path);
  }
  return kept;
}

/** The population the options select, with its exclusions ("Population"). */
export function collectStats(options: StatsOptions): StatsPopulation {
  const dataRepo = resolve(expandHome(options.dataRepo));
  const workspaceRoot = dirname(dataRepo);
  const fromWorkspace = (path: string): string => (isAbsolute(path) ? path : join(workspaceRoot, path));
  if (options.snapshotIn) {
    const parsed: unknown = JSON.parse(readFileSync(fromWorkspace(options.snapshotIn), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as {ledgers?: unknown}).ledgers)) {
      throw new Error("snapshot file has no ledgers array");
    }
    const ledgers = ((parsed as {ledgers: StatsLedger[]}).ledgers).map((ledger) =>
      ledger.liveFrom ? {...ledger, rounds: ledger.rounds.slice(ledger.liveFrom), supersededRounds: ledger.liveFrom} : ledger,
    );
    return {ledgers, excluded: []};
  }
  const config = existsSync(join(dataRepo, "loops.json")) ? loadConfig(dataRepo) : undefined;
  const paths = options.cohort
    ? uniqueByIdentity(
        readFileSync(fromWorkspace(options.cohort), "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith("#")),
        fromWorkspace,
      )
    : discoverLedgers(dataRepo, workspaceRoot);
  const ledgers: StatsLedger[] = [];
  const excludedBy = new Map<StatsExclusion["reason"], string[]>();
  for (const path of paths) {
    const absolute = fromWorkspace(path);
    if (!existsSync(absolute)) throw new Error(`cohort member missing: ${path}`);
    const collected = collectLedger(absolute, path, config, dataRepo);
    if ("ledger" in collected) ledgers.push(collected.ledger);
    else excludedBy.set(collected.excluded, [...(excludedBy.get(collected.excluded) ?? []), path]);
  }
  if (options.cohort && excludedBy.size > 0) {
    const listed = [...excludedBy.entries()].map(([reason, members]) => `${reason}: ${members.join(", ")}`);
    throw new Error(`cohort member(s) excluded: ${listed.join("; ")}`);
  }
  const excluded: StatsExclusion[] = [...excludedBy.entries()]
    .map(([reason, members]) => ({reason, paths: members}))
    .sort((a, b) => (a.reason < b.reason ? -1 : 1));
  if (options.snapshotOut) {
    writeFileSync(fromWorkspace(options.snapshotOut), `${JSON.stringify({ledgers}, null, 1)}\n`);
  }
  return {ledgers, excluded};
}

// ---------------------------------------------------------------------------
// Rendering: measured records -> the report ("Output contract").
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function secs(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function defined<T>(values: (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined);
}

function bump(bucket: Map<string, number>, key: string, by = 1): void {
  bucket.set(key, (bucket.get(key) ?? 0) + by);
}

/** Rounds beyond the sixth bucket as R6 ("Baseline"). */
function roundBucket(index: number): number {
  return Math.min(index + 1, 6);
}

/** The convergence table: the lines the frozen baseline binds ("Baseline"). */
function renderTable(ledgers: StatsLedger[]): string[] {
  const byRound = new Map<number, Map<string, number>>();
  const seqs: {item: string | null; counts: number[]}[] = [];
  const growth: {first: [number, number]; last: [number, number]}[] = [];
  const confidence = new Map<string, number>();
  let singlePass = 0;
  let total = 0;
  let docLike = 0;
  let testLike = 0;
  for (const ledger of ledgers) {
    if (!ledger.rounds.length) continue;
    seqs.push({item: ledger.item, counts: ledger.rounds.map((round) => round.findings.length)});
    const sizes: [number, number][] = [];
    ledger.rounds.forEach((round, index) => {
      if (round.manifestFiles) sizes.push([round.manifestFiles, round.manifestHunks]);
      const bucket = byRound.get(roundBucket(index)) ?? new Map<string, number>();
      byRound.set(roundBucket(index), bucket);
      bump(bucket, "rounds");
      for (const finding of round.findings) {
        total += 1;
        bump(bucket, "findings");
        bump(bucket, `prio:${String(finding.priority)}`);
        bump(bucket, `orig:${String(finding.origin)}`);
        bump(bucket, `disp:${String(finding.disposition?.kind ?? "none")}`);
        bump(confidence, String(finding.confidence));
        if (finding.passes?.length === 1) singlePass += 1;
        const text = `${String(finding.title)} ${String(finding.impact)}`.toLowerCase();
        if (text.includes("regression") && (text.includes("test") || text.includes("coverage"))) testLike += 1;
        const docWords = ["contradict", "stale", "comment", "prose", "document", "wording", "still says"];
        if (docWords.some((word) => text.includes(word))) docLike += 1;
      }
    });
    if (sizes.length >= 2) growth.push({first: sizes[0]!, last: sizes.at(-1)!});
  }
  const lines: string[] = [];
  lines.push(`ledgers ${seqs.length} rounds ${sum(seqs.map((s) => s.counts.length))} findings ${total}`);
  const perLedger = new Map<string, number>();
  for (const s of seqs) bump(perLedger, String(s.counts.length));
  const roundCounts = [...perLedger.entries()].map(([k, v]) => [Number(k), v] as [number, number]).sort((a, b) => a[0] - b[0]);
  lines.push(`rounds-per-ledger ${roundCounts.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  lines.push(`ended clean ${seqs.filter((s) => s.counts.at(-1) === 0).length}`);
  const confidenceParts = [...confidence.entries()].sort().map(([k, v]) => `${k}=${v}`);
  lines.push(`single-pass findings ${singlePass} confidence ${confidenceParts.join(" ")}`);
  lines.push(`test-like ${testLike} doc-like ${docLike}`);
  if (growth.length) {
    lines.push(`median files R1->last ${num(median(growth.map((g) => g.first[0])))} ${num(median(growth.map((g) => g.last[0])))}`);
    lines.push(`median hunks R1->last ${num(median(growth.map((g) => g.first[1])))} ${num(median(growth.map((g) => g.last[1])))}`);
  }
  for (const key of [...byRound.keys()].sort((a, b) => a - b)) {
    const bucket = byRound.get(key)!;
    const rounds = bucket.get("rounds") ?? 0;
    const findings = bucket.get("findings") ?? 0;
    const detail = [...bucket.entries()].filter(([k]) => k.includes(":")).sort().map(([k, v]) => `${k}=${v}`).join(" ");
    lines.push(`R${key}: rounds=${rounds} findings=${findings} per-round=${(findings / rounds).toFixed(1)}${detail ? ` ${detail}` : ""}`);
  }
  for (const s of [...seqs].sort((a, b) => b.counts.length - a.counts.length)) {
    lines.push(`${String(s.counts.length).padStart(2)} ${s.counts.join("-").padEnd(24)} ${s.item ?? ""}`);
  }
  return lines;
}

/** Wall time, compute, tokens, notes, shadow cost and per-pass attribution ("The round
 * clock"), printed only over ledgers that carry a measurement. */
function renderTelemetry(ledgers: StatsLedger[]): string[] {
  const instrumented = (round: StatsRound): boolean =>
    round.elapsedMs !== undefined ||
    round.reviewerMs !== undefined ||
    round.tokens !== undefined ||
    round.noteCount !== undefined ||
    round.shadowElapsedMs !== undefined ||
    round.shadowTokens !== undefined ||
    round.passes !== undefined;
  const measured = ledgers.filter((ledger) => ledger.rounds.some(instrumented));
  if (measured.length === 0) return [];
  const rounds = measured.flatMap((ledger) => ledger.rounds);
  const wall = defined(rounds.map((round) => round.elapsedMs));
  // Compute beside wall over the SAME rounds: only rounds recorded after the split carry
  // reviewerMs, and summing the pair over different populations compares nothing.
  const paired = rounds.filter((round) => round.reviewerMs !== undefined && round.elapsedMs !== undefined);
  const tokens = defined(rounds.map((round) => round.tokens));
  const notes = defined(rounds.map((round) => round.noteCount));
  const shadowWall = defined(rounds.map((round) => round.shadowElapsedMs));
  const shadowTokens = defined(rounds.map((round) => round.shadowTokens));
  const lines: string[] = [];
  lines.push(
    [
      `telemetry ledgers=${measured.length} rounds=${rounds.length}`,
      ...(wall.length ? [`wall-s=${secs(sum(wall))} wall-s-per-round-median=${secs(median(wall))}`] : []),
      ...(paired.length ? [`reviewer-s=${secs(sum(paired.map((r) => r.reviewerMs!)))} of-wall-s=${secs(sum(paired.map((r) => r.elapsedMs!)))}`] : []),
      ...(tokens.length ? [`tokens=${sum(tokens)} tokens-rounds=${tokens.length} tokens-per-round-median=${num(median(tokens))}`] : []),
      ...(notes.length ? [`notes=${sum(notes)}`] : []),
      ...(shadowWall.length ? [`shadow-s=${secs(sum(shadowWall))} total-s=${secs(sum(wall) + sum(shadowWall))}`] : []),
      ...(shadowTokens.length ? [`shadow-tokens=${sum(shadowTokens)} total-tokens=${sum(tokens) + sum(shadowTokens)}`] : []),
    ].join(" "),
  );
  const byRound = new Map<number, StatsRound[]>();
  for (const ledger of measured) {
    ledger.rounds.forEach((round, index) => byRound.set(roundBucket(index), [...(byRound.get(roundBucket(index)) ?? []), round]));
  }
  for (const key of [...byRound.keys()].sort((a, b) => a - b)) {
    const bucket = byRound.get(key)!;
    const wallBucket = defined(bucket.map((round) => round.elapsedMs));
    const tokenBucket = defined(bucket.map((round) => round.tokens));
    const noteBucket = defined(bucket.map((round) => round.noteCount));
    if (!wallBucket.length && !tokenBucket.length && !noteBucket.length) continue;
    lines.push(
      [
        `telemetry-R${key} rounds=${bucket.length}`,
        ...(wallBucket.length ? [`wall-s-median=${secs(median(wallBucket))}`] : []),
        ...(tokenBucket.length ? [`tokens-median=${num(median(tokenBucket))}`] : []),
        ...(noteBucket.length ? [`notes=${sum(noteBucket)}`] : []),
      ].join(" "),
    );
  }
  const byPass = new Map<string, StatsPass[]>();
  for (const round of rounds) {
    for (const pass of round.passes ?? []) byPass.set(pass.pass, [...(byPass.get(pass.pass) ?? []), pass]);
  }
  for (const name of [...byPass.keys()].sort()) {
    const bucket = byPass.get(name)!;
    const wallBucket = defined(bucket.map((pass) => pass.elapsedMs));
    const tokenBucket = defined(bucket.map((pass) => pass.tokens));
    const models = [...new Set(defined(bucket.map((pass) => pass.model)))].sort();
    const efforts = [...new Set(defined(bucket.map((pass) => pass.effort)))].sort();
    lines.push(
      [
        `telemetry-pass ${name} passes=${bucket.length}`,
        ...(wallBucket.length ? [`wall-s-median=${secs(median(wallBucket))}`] : []),
        ...(tokenBucket.length ? [`tokens-median=${num(median(tokenBucket))}`] : []),
        ...(models.length ? [`model=${models.join(",")}`] : []),
        ...(efforts.length ? [`effort=${efforts.join(",")}`] : []),
      ].join(" "),
    );
  }
  for (const ledger of measured) {
    const wallLedger = defined(ledger.rounds.map((round) => round.elapsedMs));
    const tokenLedger = defined(ledger.rounds.map((round) => round.tokens));
    lines.push(
      [
        `telemetry-item ${ledger.item ?? ledger.path} rounds=${ledger.rounds.length}`,
        ...(wallLedger.length ? [`wall-s=${secs(sum(wallLedger))}`] : []),
        ...(tokenLedger.length ? [`tokens=${sum(tokenLedger)}`] : []),
      ].join(" "),
    );
  }
  return lines;
}

function terminal(ledger: StatsLedger): boolean {
  return independentlyReviewedTerminal(ledger) || ledger.outcome === "test-cap-exit";
}

function independentlyReviewedTerminal(ledger: StatsLedger): boolean {
  return ledger.outcome === "passed" || ledger.outcome === "cap-exit";
}

/** The gate's verdicts over the population ("Outcome"), printed only when the
 * population carries them. */
function renderOutcome(ledgers: StatsLedger[]): string[] {
  const decided = ledgers.filter((ledger) => ledger.outcome !== undefined);
  if (decided.length === 0) return [];
  const count = (outcome: StatsOutcome): number => decided.filter((ledger) => ledger.outcome === outcome).length;
  const testCapExits = count("test-cap-exit");
  const toPassed = decided.filter(independentlyReviewedTerminal).map((ledger) => ledger.rounds.length);
  const capped = decided.filter((ledger) => ledger.cap !== undefined);
  const withinCap = capped.filter((ledger) => terminal(ledger) && ledger.rounds.length <= ledger.cap!).length;
  return [
    [
      [
        `outcome passed=${count("passed")} cap-exit=${count("cap-exit")}`,
        ...(testCapExits ? [`test-cap-exit=${testCapExits}`] : []),
        `open=${count("open")} legacy=${count("legacy")}`,
      ].join(" "),
      ...(toPassed.length ? [`rounds-to-passed-median=${num(median(toPassed))}`] : []),
      `within-cap=${withinCap} cap-unknown=${decided.length - capped.length}`,
    ].join(" "),
  ];
}

/** The per-profile split ("Windows after the bundled enablement"): the only grouping
 * the recorded policies support, read against the unprofiled population ("none"). */
function renderProfiles(ledgers: StatsLedger[]): string[] {
  if (!ledgers.some((ledger) => ledger.profile !== undefined)) return [];
  const byProfile = new Map<string, StatsLedger[]>();
  for (const ledger of ledgers) {
    const key = ledger.profile ?? "none";
    byProfile.set(key, [...(byProfile.get(key) ?? []), ledger]);
  }
  const lines: string[] = [];
  for (const name of [...byProfile.keys()].sort()) {
    const bucket = byProfile.get(name)!;
    const toClean = bucket.filter((ledger) => ledger.rounds.at(-1)!.findings.length === 0).map((ledger) => ledger.rounds.length);
    const toPassed = bucket.filter(terminal).map((ledger) => ledger.rounds.length);
    const late = sum(bucket.flatMap((ledger) => defined(ledger.rounds.map((round) => round.lateHighPriority))));
    const perItem = defined(
      bucket.map((ledger) => {
        const tokens = defined(ledger.rounds.map((round) => round.tokens));
        return tokens.length ? sum(tokens) : undefined;
      }),
    );
    lines.push(
      [
        `profile ${name} ledgers=${bucket.length} clean=${toClean.length}`,
        ...(toClean.length ? [`rounds-to-clean-median=${num(median(toClean))}`] : []),
        `passed=${toPassed.length}`,
        ...(toPassed.length ? [`rounds-to-passed-median=${num(median(toPassed))}`] : []),
        `late-p0p1=${late}`,
        ...(perItem.length ? [`tokens-per-item-median=${num(median(perItem))}`] : []),
      ].join(" "),
    );
  }
  return lines;
}

/** The full report in the "Output contract" order. */
export function renderStats(population: StatsPopulation): string {
  const ledgers = population.ledgers.filter((ledger) => ledger.rounds.length > 0);
  const superseded = ledgers.filter((ledger) => (ledger.supersededRounds ?? 0) > 0).length;
  const lines = [
    ...renderTable(ledgers),
    ...population.excluded.map((exclusion) => `excluded ${exclusion.paths.length} ${exclusion.reason}`),
    ...(superseded > 0 ? [`epochs superseded=${superseded}`] : []),
    ...renderTelemetry(ledgers),
    ...renderOutcome(ledgers),
    ...renderProfiles(ledgers),
  ];
  return `${lines.join("\n")}\n`;
}

export function runStats(options: StatsOptions): string {
  return renderStats(collectStats(options));
}
