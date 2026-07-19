// The review ledger: the validated, append-only record of review rounds and the
// agent's per-finding dispositions. The JSON ledger is machine state; the Markdown
// render is the human surface. Model-agnostic — a reviewer adapter (reviewers.ts)
// produces a Review; everything here is pure.

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
}

export interface ReviewLedger {
  version: 1;
  branch: string;
  baseRef: string;
  baseSha: string;
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
  branch: string;
  baseRef: string;
  baseSha: string;
}

export interface AddRoundInput {
  headSha: string;
  model: string;
  reviewedAt: string;
  review: Review;
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
    branch: requiredString(input, "branch", "review ledger"),
    baseRef: requiredString(input, "baseRef", "review ledger"),
    baseSha: requiredString(input, "baseSha", "review ledger"),
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
      },
    ],
  };
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
      if (finding.disposition) throw new Error(`${findingId} already has a disposition`);
      return { ...finding, disposition: { kind, reason } };
    }),
  }));
  if (!found) throw new Error(`finding ${findingId} not found`);
  return { ...ledger, rounds };
}

export function renderReviewLedger(ledger: ReviewLedger): string {
  const lines = [
    "# Local review",
    "",
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
        `- Evidence: ${finding.evidence}`,
        `- Impact: ${finding.impact}`,
        `- Direction: ${finding.direction}`,
        `- Disposition: ${finding.disposition ? `**${finding.disposition.kind}** — ${finding.disposition.reason}` : "pending"}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
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

export function reviewCanContinue(rounds: RoundState[], limit = 3): { allowed: boolean; reason?: string } {
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
  return { allowed: true };
}
