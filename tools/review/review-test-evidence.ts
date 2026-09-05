import {createHash} from "node:crypto";
import type {ReviewLedger, ReviewObligation} from "./review-ledger.ts";

export interface TestFixEvidence {
  obligationId: string;
  summary: string;
  paths: string[];
  tests: string[];
  command: string[];
  redEvidence: {kind: "observed-failure" | "not-practical"; detail: string};
  coverage: string;
}

/** Coverage, original failure, and risk are the implementer's assessments. Check
 * results below are captured by the CLI; neither claims independent confirmation. */
export interface TestCapExitRequest {
  fixes: TestFixEvidence[];
  qualityCommand: string[];
  changeSummary: string;
  risk: {remaining: string; exposure: string; recovery: string; materialUncertainty: boolean};
}

export interface TestExitCheck {
  kind: "regression" | "quality";
  obligationId?: string;
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TestCapExitEvidence {
  headSha: string;
  reviewedHeadSha: string;
  baseSha: string;
  reviewStateHash: string;
  recordedAt: string;
  maxRounds: number;
  /** Absent while the evidence file has not been read and validated. */
  request?: TestCapExitRequest;
  checks: TestExitCheck[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  return value.map((entry: unknown) => string(entry, label));
}

function paths(value: unknown, label: string): string[] {
  const result = strings(value, label);
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate paths`);
  for (const path of result) {
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`${label} requires normalized repository-relative paths`);
    }
  }
  return result;
}

export function parseTestCapExitRequest(value: unknown): TestCapExitRequest {
  const input = object(value, "test evidence");
  if (!Array.isArray(input.fixes) || input.fixes.length === 0) throw new Error("test evidence fixes must be non-empty");
  const fixes = input.fixes.map((entry: unknown): TestFixEvidence => {
    const fix = object(entry, "fix");
    const red = object(fix.redEvidence, "redEvidence");
    if (red.kind !== "observed-failure" && red.kind !== "not-practical") throw new Error("redEvidence kind must be observed-failure or not-practical");
    return {obligationId: string(fix.obligationId, "obligationId"), summary: string(fix.summary, "fix summary"),
      paths: paths(fix.paths, "fix paths"), tests: paths(fix.tests, "regression tests"), command: strings(fix.command, "regression command"),
      redEvidence: {kind: red.kind, detail: string(red.detail, "redEvidence detail")}, coverage: string(fix.coverage, "coverage rationale")};
  });
  if (new Set(fixes.map((fix) => fix.obligationId)).size !== fixes.length) throw new Error("duplicate obligation evidence");
  const risk = object(input.risk, "risk");
  if (typeof risk.materialUncertainty !== "boolean") throw new Error("risk.materialUncertainty must be a boolean");
  return {fixes, qualityCommand: strings(input.qualityCommand, "quality command"), changeSummary: string(input.changeSummary, "change summary"),
    risk: {remaining: string(risk.remaining, "remaining risk"), exposure: string(risk.exposure, "exposure"), recovery: string(risk.recovery, "recovery"),
      materialUncertainty: risk.materialUncertainty}};
}

export function parseTestCapExits(value: unknown): TestCapExitEvidence[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("testCapExits must be an array");
  return value.map((entry: unknown): TestCapExitEvidence => {
    const input = object(entry, "test cap exit");
    if (!Array.isArray(input.checks)) throw new Error("test cap exit checks must be an array");
    const checks = input.checks.map((entry: unknown): TestExitCheck => {
      const check = object(entry, "test check");
      if (check.kind !== "quality" && check.kind !== "regression") throw new Error("invalid test check kind");
      if (typeof check.exitCode !== "number" || !Number.isInteger(check.exitCode)) throw new Error("invalid test check exitCode");
      if (typeof check.stdout !== "string" || typeof check.stderr !== "string") throw new Error("invalid test check output");
      return {kind: check.kind, command: strings(check.command, "check command"), exitCode: check.exitCode, stdout: check.stdout, stderr: check.stderr,
        ...(check.obligationId !== undefined ? {obligationId: string(check.obligationId, "check obligationId")} : {})};
    });
    if (typeof input.maxRounds !== "number" || !Number.isInteger(input.maxRounds) || input.maxRounds < 1) throw new Error("invalid test cap exit maxRounds");
    const hash = (field: string, length: number): string => {
      const result = string(input[field], field);
      if (!new RegExp(`^[a-f0-9]{${length}}$`).test(result)) throw new Error(`invalid test cap exit ${field}`);
      return result;
    };
    const recordedAt = string(input.recordedAt, "recordedAt");
    if (!Number.isFinite(Date.parse(recordedAt))) throw new Error("invalid test cap exit recordedAt");
    if (input.request === undefined && checks.length > 0) throw new Error("pending test evidence cannot contain checks");
    return {headSha: hash("headSha", 40), reviewedHeadSha: hash("reviewedHeadSha", 40), baseSha: hash("baseSha", 40),
      reviewStateHash: hash("reviewStateHash", 64), recordedAt, maxRounds: input.maxRounds,
      ...(input.request !== undefined ? {request: parseTestCapExitRequest(input.request)} : {}), checks};
  });
}

/** Bind every decision-bearing part of the ledger, excluding the append-only test
 * attempts themselves. A later review, failure, or disposition invalidates the exit. */
export function testExitReviewStateHash(ledger: ReviewLedger): string {
  return createHash("sha256").update(JSON.stringify({branch: ledger.branch, item: ledger.item, authority: ledger.authority,
    profile: ledger.profile, baseSha: ledger.baseSha, baseRef: ledger.baseRef, maxRoundsOverride: ledger.maxRoundsOverride,
    rounds: ledger.rounds, failures: ledger.failures, supersessions: ledger.supersessions})).digest("hex");
}

export function testCapExitRefusal(
  ledger: ReviewLedger, headSha: string, maxRounds: number, roundCount: number,
  obligations: ReviewObligation[], requireChecks = true,
): string | undefined {
  const evidence = ledger.testCapExits?.at(-1);
  const latest = ledger.rounds.at(-1);
  if (!evidence || !latest) return "no test-backed cap exit evidence";
  if (roundCount < maxRounds) return "review round cap has not been reached";
  if (evidence.headSha !== headSha || evidence.reviewedHeadSha !== latest.headSha || evidence.baseSha !== ledger.baseSha ||
      evidence.reviewStateHash !== testExitReviewStateHash(ledger)) return "test-backed evidence is stale for this HEAD or review state";
  if (!evidence.request) return "test evidence is pending or unavailable";
  if (evidence.request.risk.materialUncertainty) return "material uncertainty requires an owner decision or further verification";
  if (obligations.length === 0) return "no open remediation obligations to verify";
  if (obligations.some((obligation) => obligation.priority === "P0")) return "P0 obligations cannot use the test-backed exit";
  if (obligations.some((obligation) => obligation.type !== "remediation")) return "non-remediation obligations require independent confirmation";
  const ids = new Set(evidence.request.fixes.map((fix) => fix.obligationId));
  if (ids.size !== obligations.length || obligations.some((obligation) => !ids.has(obligation.findingId))) return "test evidence must cover exactly every open remediation obligation";
  if (ledger.rounds.some((round) => round.findings.some((finding) => !finding.disposition || finding.disposition.kind === "deferred-to-human"))) {
    return "undispositioned or deferred findings block the test-backed exit";
  }
  if (requireChecks) {
    const expected = [
      ...evidence.request.fixes.map((fix) => ({kind: "regression", obligationId: fix.obligationId, command: fix.command})),
      {kind: "quality", obligationId: undefined, command: evidence.request.qualityCommand},
    ];
    if (evidence.checks.length !== expected.length || evidence.checks.some((check, index) => {
      const wanted = expected[index];
      return check.exitCode !== 0 || !wanted || check.kind !== wanted.kind || check.obligationId !== wanted.obligationId ||
        JSON.stringify(check.command) !== JSON.stringify(wanted.command);
    })) return "test-backed exit requires successful regression and quality checks";
  }
  return undefined;
}

export function renderTestCapExits(entries: TestCapExitEvidence[]): string[] {
  return entries.flatMap((entry) => {
    if (!entry.request) return ["", `## Test-backed cap exit attempt - ${entry.headSha}`, "",
      `- Recorded: ${entry.recordedAt}`, "- Evidence: pending or unavailable; no test-backed pass"];
    return ["", `## Test-backed cap exit attempt - ${entry.headSha}`, "",
    `- Recorded: ${entry.recordedAt}`, `- Independently reviewed: false`,
    `- Checks: ${entry.checks.length === entry.request.fixes.length + 1 && entry.checks.every((check) => check.exitCode === 0) ? "passed; run status for the current policy result" : "incomplete or failed"}`,
    `- Change summary (implementer assessment): ${entry.request.changeSummary}`,
    `- Remaining risk (implementer assessment): ${entry.request.risk.remaining}`,
    `- Exposure: ${entry.request.risk.exposure}`, `- Recovery: ${entry.request.risk.recovery}`,
    `- Material uncertainty: ${entry.request.risk.materialUncertainty}`,
    ...entry.request.fixes.flatMap((fix) => [`- ${fix.obligationId}: ${fix.summary}`, `  - Paths: ${fix.paths.join(", ")}`,
      `  - Regression tests: ${fix.tests.join(", ")}`, `  - Coverage assessment: ${fix.coverage}`,
      `  - Original failure evidence (${fix.redEvidence.kind}, implementer supplied): ${fix.redEvidence.detail}`]),
    ...entry.checks.map((check) => `- ${check.kind} check${check.obligationId ? ` ${check.obligationId}` : ""}: ${JSON.stringify(check.command)}; exit=${check.exitCode}\n\n\`\`\`text\n${check.stdout}\n${check.stderr}\n\`\`\``),
  ];
  });
}
