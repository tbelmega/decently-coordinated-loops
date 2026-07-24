// The review ledger: the validated, append-only record of review rounds and the
// agent's per-finding dispositions. The JSON ledger is machine state; the Markdown
// render is the human surface. Model-agnostic — a reviewer adapter (reviewers.ts)
// produces a Review; everything here is pure.

import type {ReviewAuditPass} from "../config.ts";
import type {
  FindingOrigin,
  ReviewCoverage,
  ReviewMetrics,
  ReviewObligationResult,
} from "./review-audit.ts";
import type {ReviewManifest} from "./review-manifest.ts";

export const priorities = ["P0", "P1", "P2", "P3"] as const;
export const confidenceLevels = ["high", "medium", "low"] as const;
export const dispositionKinds = ["accepted", "rejected", "already-addressed", "deferred-to-human"] as const;

export type Priority = (typeof priorities)[number];
export type Confidence = (typeof confidenceLevels)[number];
export type DispositionKind = (typeof dispositionKinds)[number];

export interface Finding {
  priority: Priority;
  title: string;
  file?: string;
  line?: number;
  evidence: string;
  impact: string;
  direction: string;
  confidence: Confidence;
  origin?: FindingOrigin;
  passes?: ReviewAuditPass[];
  identity?: string;
  firstSeenRound?: number;
  obligationId?: string;
  repeatedFrom?: string[];
}

export interface Review {
  summary: string;
  findings: Finding[];
}

export interface FindingState {
  id: string;
  disposition?: DispositionKind;
}

export interface RoundState {
  findings: FindingState[];
  headSha?: string;
}

export interface ReviewDisposition {
  kind: DispositionKind;
  reason: string;
}

export interface LedgerFinding extends Finding {
  id: string;
  disposition?: ReviewDisposition;
}

export interface ReviewRound {
  number: number;
  headSha: string;
  model: string;
  reviewedAt: string;
  summary: string;
  findings: LedgerFinding[];
  audit?: ReviewRoundAudit;
}

export interface ReviewRoundAudit {
  kind: "full" | "remediation" | "base-delta";
  manifest: ReviewManifest;
  passes: {pass: ReviewAuditPass; summary: string; coverage: ReviewCoverage}[];
  obligations: ReviewObligationResult[];
  metrics: ReviewMetrics;
}

export interface ReviewLedger {
  version: 1;
  item?: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  patchIds?: string[];
  rounds: ReviewRound[];
  failures?: ReviewFailure[];
}

export interface ReviewFailure {
  headSha: string;
  model: string;
  attemptedAt: string;
  reason: string;
}

export interface CreateLedgerInput {
  item?: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  patchIds?: string[];
}

export interface AddRoundInput {
  headSha: string;
  model: string;
  reviewedAt: string;
  review: Review;
  audit?: ReviewRoundAudit;
}

export interface AcceptedFindingObligation {
  findingId: string;
  title: string;
  evidence: string;
  direction: string;
  dispositionReason: string;
}

export function isDispositionKind(value: unknown): value is DispositionKind {
  return (dispositionKinds as readonly unknown[]).includes(value);
}

function isPriority(value: unknown): value is Priority {
  return (priorities as readonly unknown[]).includes(value);
}

function isConfidence(value: unknown): value is Confidence {
  return (confidenceLevels as readonly unknown[]).includes(value);
}

export function createReviewLedger(input: CreateLedgerInput): ReviewLedger {
  return { version: 1, ...input, rounds: [] };
}

function parseDisposition(input: unknown, path: string): ReviewDisposition | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new Error(`${path} must be an object`);
  const kind = input.kind;
  if (!isDispositionKind(kind)) throw new Error(`${path}.kind is invalid`);
  return { kind, reason: requiredString(input, "reason", path) };
}

export function parseReviewLedger(input: unknown): ReviewLedger {
  if (!isRecord(input)) throw new Error("review ledger must be an object");
  if (input.version !== 1) throw new Error("review ledger version must be 1");
  if (!Array.isArray(input.rounds)) throw new Error("review ledger rounds must be an array");
  const rounds = input.rounds.map((roundInput, roundIndex): ReviewRound => {
    const path = `rounds[${roundIndex}]`;
    if (!isRecord(roundInput)) throw new Error(`${path} must be an object`);
    const roundFindings = roundInput.findings;
    if (!Array.isArray(roundFindings)) throw new Error(`${path}.findings must be an array`);
    const parsedReview = parseReview({ summary: roundInput.summary, findings: roundFindings });
    const findings = parsedReview.findings.map((finding, findingIndex): LedgerFinding => {
      const findingInput = roundFindings[findingIndex];
      if (!isRecord(findingInput)) throw new Error(`${path}.findings[${findingIndex}] must be an object`);
      const disposition = parseDisposition(findingInput.disposition, `${path}.findings[${findingIndex}].disposition`);
      return {
        ...finding,
        id: requiredString(findingInput, "id", `${path}.findings[${findingIndex}]`),
        ...(isFindingOrigin(findingInput.origin) ? {origin: findingInput.origin} : {}),
        ...(isReviewAuditPassArray(findingInput.passes) ? {passes: findingInput.passes} : {}),
        ...(optionalString(findingInput, "identity", `${path}.findings[${findingIndex}]`)
          ? {identity: String(findingInput.identity)}
          : {}),
        ...(typeof findingInput.firstSeenRound === "number" &&
        Number.isInteger(findingInput.firstSeenRound) &&
        findingInput.firstSeenRound > 0
          ? {firstSeenRound: findingInput.firstSeenRound}
          : {}),
        ...(optionalString(findingInput, "obligationId", `${path}.findings[${findingIndex}]`)
          ? {obligationId: String(findingInput.obligationId)}
          : {}),
        ...(isStringArray(findingInput.repeatedFrom) ? {repeatedFrom: findingInput.repeatedFrom} : {}),
        ...(disposition ? { disposition } : {}),
      };
    });
    const number = roundInput.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number !== roundIndex + 1) {
      throw new Error(`${path}.number must be ${roundIndex + 1}`);
    }
    return {
      number,
      headSha: requiredString(roundInput, "headSha", path),
      model: requiredString(roundInput, "model", path),
      reviewedAt: requiredString(roundInput, "reviewedAt", path),
      summary: parsedReview.summary,
      findings,
      ...(isReviewRoundAudit(roundInput.audit) ? {audit: roundInput.audit} : {}),
    };
  });
  if (input.failures !== undefined && !Array.isArray(input.failures)) {
    throw new Error("review ledger failures must be an array when present");
  }
  const failures = Array.isArray(input.failures)
    ? input.failures.map((failureInput, failureIndex): ReviewFailure => {
        const path = `failures[${failureIndex}]`;
        if (!isRecord(failureInput)) throw new Error(`${path} must be an object`);
        return {
          headSha: requiredString(failureInput, "headSha", path),
          model: requiredString(failureInput, "model", path),
          attemptedAt: requiredString(failureInput, "attemptedAt", path),
          reason: requiredString(failureInput, "reason", path),
        };
      })
    : undefined;
  return {
    version: 1,
    ...(optionalString(input, "item", "review ledger") ? { item: String(input.item) } : {}),
    branch: requiredString(input, "branch", "review ledger"),
    baseRef: requiredString(input, "baseRef", "review ledger"),
    baseSha: requiredString(input, "baseSha", "review ledger"),
    ...(isStringArray(input.patchIds) ? {patchIds: input.patchIds} : {}),
    rounds,
    ...(failures ? { failures } : {}),
  };
}

export function recordReviewFailure(ledger: ReviewLedger, failure: ReviewFailure): ReviewLedger {
  return { ...ledger, failures: [...(ledger.failures ?? []), failure] };
}

export function addReviewRound(ledger: ReviewLedger, input: AddRoundInput): ReviewLedger {
  const number = ledger.rounds.length + 1;
  return {
    ...ledger,
    rounds: [
      ...ledger.rounds,
      {
        number,
        headSha: input.headSha,
        model: input.model,
        reviewedAt: input.reviewedAt,
        summary: input.review.summary,
        findings: input.review.findings.map((finding, index) => ({
          ...finding,
          id: `R${number}-F${index + 1}`,
        })),
        ...(input.audit ? {audit: input.audit} : {}),
      },
    ],
  };
}

export function acceptedFindingObligations(_ledger: ReviewLedger): AcceptedFindingObligation[] {
  const fixedFindingIds = new Set(
    _ledger.rounds.flatMap((round) =>
      round.audit?.obligations
        .filter((obligation) => obligation.status === "fixed")
        .map((obligation) => obligation.findingId) ?? [],
    ),
  );
  return _ledger.rounds.flatMap((round) =>
    round.findings.flatMap((finding) =>
      finding.disposition?.kind === "accepted" && !fixedFindingIds.has(finding.id)
        ? [{
            findingId: finding.id,
            title: finding.title,
            evidence: finding.evidence,
            direction: finding.direction,
            dispositionReason: finding.disposition.reason,
          }]
        : [],
    ),
  );
}

export function recordDisposition(
  ledger: ReviewLedger,
  findingId: string,
  kind: DispositionKind,
  reason: string,
): ReviewLedger {
  if (!reason) throw new Error("disposition reason must not be empty");
  let found = false;
  const rounds = ledger.rounds.map((round) => ({
    ...round,
    findings: round.findings.map((finding) => {
      if (finding.id !== findingId) return finding;
      found = true;
      // Only a deferred-to-human disposition may be superseded — it parks a finding on
      // the owner, and the owner's eventual decision needs a sanctioned way back into
      // the ledger (hand-editing is forbidden). All other dispositions are immutable.
      if (finding.disposition && finding.disposition.kind !== "deferred-to-human") {
        throw new Error(`${findingId} already has a disposition`);
      }
      return { ...finding, disposition: { kind, reason } };
    }),
  }));
  if (!found) throw new Error(`finding ${findingId} not found`);
  return { ...ledger, rounds };
}

/** Prompt notes about previously dispositioned findings. Each round runs a fresh
 *  reviewer with no memory, so without these a rejected false positive gets re-raised
 *  every round and a clean confirmation round is unreachable — every disagreement
 *  would dead-end at the round cap. Accepted findings are omitted: their fixes are new
 *  code the next round must genuinely re-review. */
export function priorDispositionNotes(ledger: ReviewLedger): string[] {
  return ledger.rounds.flatMap((round) =>
    round.findings.flatMap((finding) =>
      finding.disposition && finding.disposition.kind !== "accepted"
        ? [`${finding.id} "${finding.title}" — ${finding.disposition.kind}: ${finding.disposition.reason}`]
        : [],
    ),
  );
}

export function renderReviewLedger(ledger: ReviewLedger): string {
  const lines = [
    "# Local review",
    "",
    ...(ledger.item ? [`- Item: \`${ledger.item}\``] : []),
    `- Branch: \`${ledger.branch}\``,
    `- Base ref: \`${ledger.baseRef}\``,
    `- Base SHA: \`${ledger.baseSha}\``,
  ];
  if (ledger.failures?.length) {
    lines.push("", "## Incomplete attempts");
    for (const failure of ledger.failures) {
      lines.push(
        "",
        `- ${failure.attemptedAt} — \`${failure.headSha.slice(0, 12)}\` with \`${failure.model}\`: ${failure.reason}`,
      );
    }
  }
  for (const round of ledger.rounds) {
    lines.push(
      "",
      `## Round ${round.number} — \`${round.headSha.slice(0, 12)}\``,
      "",
      `- Head SHA: \`${round.headSha}\``,
      `- Model: \`${round.model}\``,
      `- Reviewed at: ${round.reviewedAt}`,
      "",
      round.summary,
    );
    if (round.findings.length === 0) lines.push("", "No findings.");
    for (const finding of round.findings) {
      const location = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "Not anchored";
      lines.push(
        "",
        `### ${finding.id} — ${finding.priority}: ${finding.title}`,
        "",
        `- Location: ${location}`,
        `- Confidence: ${finding.confidence}`,
        ...(finding.origin ? [`- Origin: ${finding.origin}`] : []),
        ...(finding.passes?.length ? [`- Passes: ${finding.passes.join(", ")}`] : []),
        ...(finding.repeatedFrom?.length ? [`- Repeated from: ${finding.repeatedFrom.join(", ")}`] : []),
        ...(finding.firstSeenRound ? [`- First seen round: ${finding.firstSeenRound}`] : []),
        ...(finding.obligationId ? [`- Remediation obligation: ${finding.obligationId}`] : []),
        `- Evidence: ${finding.evidence}`,
        `- Impact: ${finding.impact}`,
        `- Direction: ${finding.direction}`,
        `- Disposition: ${finding.disposition ? `**${finding.disposition.kind}** — ${finding.disposition.reason}` : "pending"}`,
      );
    }
    if (round.audit) {
      const metrics = round.audit.metrics;
      lines.push(
        "",
        "### Audit evidence",
        "",
        `- Kind: ${round.audit.kind}`,
        `- Passes: ${round.audit.passes.map((pass) => pass.pass).join(", ")}`,
        `- Coverage: complete for ${round.audit.manifest.files.length} reviewable files, ${round.audit.manifest.files.reduce((count, file) => count + file.hunks.length, 0)} hunks, and ${round.audit.manifest.instructionFiles.length} instruction files`,
        `- Remediation focus: ${round.audit.manifest.remediationFiles?.length ?? 0} files`,
        `- Base-delta focus: ${round.audit.manifest.baseDeltaFiles?.length ?? 0} files`,
        `- Findings by pass: diff=${metrics.findingsByPass.diff}, integration=${metrics.findingsByPass.integration}, adversarial=${metrics.findingsByPass.adversarial}`,
        `- Findings by priority: P0=${metrics.findingsByPriority.P0}, P1=${metrics.findingsByPriority.P1}, P2=${metrics.findingsByPriority.P2}, P3=${metrics.findingsByPriority.P3}`,
        `- Findings by origin: original=${metrics.findingsByOrigin.original}, remediation=${metrics.findingsByOrigin.remediation}, base-delta=${metrics.findingsByOrigin["base-delta"]}, unknown=${metrics.findingsByOrigin.unknown}`,
        `- Repeated findings: ${metrics.repeatedFindings}`,
        `- Late P0/P1 findings: ${metrics.lateHighPriorityFindings}`,
        `- Unchanged-HEAD drift: ${metrics.unchangedHeadDrift ? "yes" : "no"}`,
        ...(metrics.declineRatio === undefined ? [] : [`- Decline ratio: ${metrics.declineRatio}`]),
      );
      if (round.audit.obligations.length === 0) {
        lines.push("- Remediation obligations: none");
      } else {
        for (const obligation of round.audit.obligations) {
          lines.push(`- Remediation obligation ${obligation.findingId}: ${obligation.status} — ${obligation.evidence}`);
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isStringArray(input: unknown): input is string[] {
  return Array.isArray(input) && input.every((value) => typeof value === "string");
}

function isReviewAuditPassArray(input: unknown): input is ReviewAuditPass[] {
  return Array.isArray(input) && input.every((value) =>
    value === "diff" || value === "integration" || value === "adversarial"
  );
}

function isFindingOrigin(input: unknown): input is FindingOrigin {
  return input === "original" || input === "remediation" || input === "base-delta" || input === "unknown";
}

function isReviewFileCoverage(input: unknown): input is {path: string; hunks: string[]} {
  return isRecord(input) && typeof input.path === "string" && isStringArray(input.hunks);
}

function isReviewCoverage(input: unknown): input is ReviewCoverage {
  return (
    isRecord(input) &&
    Array.isArray(input.files) &&
    input.files.every(isReviewFileCoverage) &&
    isStringArray(input.instructionFiles) &&
    isStringArray(input.callsites)
  );
}

function isReviewManifest(input: unknown): input is ReviewManifest {
  return (
    isRecord(input) &&
    typeof input.baseSha === "string" &&
    typeof input.headSha === "string" &&
    Array.isArray(input.files) &&
    input.files.every(isReviewFileCoverage) &&
    Array.isArray(input.metadataFiles) &&
    input.metadataFiles.every(isReviewFileCoverage) &&
    (input.metadataPaths === undefined || isStringArray(input.metadataPaths)) &&
    (input.remediationFiles === undefined ||
      (Array.isArray(input.remediationFiles) && input.remediationFiles.every(isReviewFileCoverage))) &&
    (input.baseDeltaFiles === undefined ||
      (Array.isArray(input.baseDeltaFiles) && input.baseDeltaFiles.every(isReviewFileCoverage))) &&
    isStringArray(input.instructionFiles) &&
    Array.isArray(input.contextReferences) &&
    input.contextReferences.every(
      (reference) =>
        isRecord(reference) &&
        typeof reference.label === "string" &&
        typeof reference.path === "string" &&
        typeof reference.digest === "string",
    ) &&
    isStringArray(input.patchIds)
  );
}

function isReviewObligationResult(input: unknown): input is ReviewObligationResult {
  return (
    isRecord(input) &&
    typeof input.findingId === "string" &&
    (input.status === "fixed" || input.status === "incomplete" || input.status === "regressed") &&
    typeof input.evidence === "string"
  );
}

function isNumericRecord(input: unknown, keys: string[]): boolean {
  return isRecord(input) && keys.every((key) => typeof input[key] === "number");
}

function isReviewMetrics(input: unknown): input is ReviewMetrics {
  return (
    isRecord(input) &&
    isNumericRecord(input.findingsByPass, ["diff", "integration", "adversarial"]) &&
    isNumericRecord(input.findingsByPriority, ["P0", "P1", "P2", "P3"]) &&
    isNumericRecord(input.findingsByOrigin, ["original", "remediation", "base-delta", "unknown"]) &&
    typeof input.repeatedFindings === "number" &&
    typeof input.lateHighPriorityFindings === "number" &&
    typeof input.unchangedHeadDrift === "boolean" &&
    (input.declineRatio === undefined || typeof input.declineRatio === "number")
  );
}

function isReviewRoundAudit(input: unknown): input is ReviewRoundAudit {
  return (
    isRecord(input) &&
    (input.kind === "full" || input.kind === "remediation" || input.kind === "base-delta") &&
    isReviewManifest(input.manifest) &&
    Array.isArray(input.passes) &&
    input.passes.every(
      (pass) =>
        isRecord(pass) &&
        (pass.pass === "diff" || pass.pass === "integration" || pass.pass === "adversarial") &&
        typeof pass.summary === "string" &&
        isReviewCoverage(pass.coverage),
    ) &&
    Array.isArray(input.obligations) &&
    input.obligations.every(isReviewObligationResult) &&
    isReviewMetrics(input.metrics)
  );
}

function requiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path}.${key} must be a non-empty string when present`);
  }
  return value;
}

function parseFinding(input: unknown, index: number): Finding {
  const path = `findings[${index}]`;
  if (!isRecord(input)) throw new Error(`${path} must be an object`);

  const priority = input.priority;
  if (!isPriority(priority)) throw new Error(`${path}.priority must be one of "P0", "P1", "P2", "P3"`);
  const confidence = input.confidence;
  if (!isConfidence(confidence)) throw new Error(`${path}.confidence must be one of "high", "medium", "low"`);
  const line = input.line;
  if (line !== undefined && line !== null && (!Number.isInteger(line) || typeof line !== "number" || line < 1)) {
    throw new Error(`${path}.line must be a positive integer when present`);
  }
  const file = optionalString(input, "file", path);

  return {
    priority,
    title: requiredString(input, "title", path),
    ...(file ? { file } : {}),
    ...(typeof line === "number" ? { line } : {}),
    evidence: requiredString(input, "evidence", path),
    impact: requiredString(input, "impact", path),
    direction: requiredString(input, "direction", path),
    confidence,
  };
}

export function parseReview(input: unknown): Review {
  if (!isRecord(input)) throw new Error("review result must be an object");
  if (!Array.isArray(input.findings)) throw new Error("review result findings must be an array");
  return {
    summary: requiredString(input, "summary", "review result"),
    findings: input.findings.map(parseFinding),
  };
}

// `rounds` is a single item+patch-series ledger (a changed patch series starts fresh;
// a patch-equivalent rebase retains it), so `limit` bounds one unit of work — not a branch's lifetime. It
// breaks the accept-fix-reintroduce loop where each round's fix spawns the next round's
// finding; it is not a budget across the several units a long-lived branch may carry.
export function reviewCanContinue(
  rounds: RoundState[],
  limit = 3,
  currentHeadSha?: string,
): { allowed: boolean; reason?: string } {
  for (const round of rounds) {
    for (const finding of round.findings) {
      if (!finding.disposition) return { allowed: false, reason: `${finding.id} has no disposition` };
    }
  }
  if (rounds.length >= limit) return { allowed: false, reason: `review round limit of ${limit} reached` };
  const latestRound = rounds.at(-1);
  if (latestRound && latestRound.findings.length === 0) {
    return { allowed: false, reason: "latest review round has no actionable findings" };
  }
  if (latestRound?.findings.some((finding) => finding.disposition === "deferred-to-human")) {
    return { allowed: false, reason: "latest review round has a finding deferred to the owner" };
  }
  // Accepting a finding is a commitment to fix it. Re-running at the same HEAD would
  // let a clean round certify the branch with the accepted defect still in the tree
  // (a fresh reviewer isn't guaranteed to re-find it) — the fix must be committed first.
  if (
    currentHeadSha &&
    latestRound?.headSha === currentHeadSha &&
    latestRound.findings.some((finding) => finding.disposition === "accepted")
  ) {
    return {
      allowed: false,
      reason: "latest round has accepted findings — implement and commit them before the next round",
    };
  }
  return { allowed: true };
}
