import type {ReviewAuditPass} from "../config.ts";
import {parseReview, type Finding, type Priority} from "./review-ledger.ts";
import {matchesMetadataPath, type ReviewFileCoverage, type ReviewManifest} from "./review-manifest.ts";

export const findingOrigins = ["original", "remediation", "base-delta", "unknown"] as const;
export type FindingOrigin = (typeof findingOrigins)[number];

export interface ReviewCoverage {
  files: ReviewFileCoverage[];
  instructionFiles: string[];
  callsites: string[];
}

export interface ReviewObligationResult {
  findingId: string;
  status: "fixed" | "incomplete" | "regressed";
  evidence: string;
}

export interface AuditFinding extends Finding {
  origin: FindingOrigin;
  obligationId?: string;
}

export interface ReviewPassResult {
  pass: ReviewAuditPass;
  summary: string;
  coverage: ReviewCoverage;
  obligations: ReviewObligationResult[];
  findings: AuditFinding[];
}

export interface CombinedAuditFinding extends AuditFinding {
  identity: string;
  passes: ReviewAuditPass[];
  firstSeenRound: number;
  repeatedFrom?: string[];
}

export interface PriorFindingIdentity {
  id: string;
  identity: string;
  firstSeenRound: number;
}

export interface ReviewMetrics {
  findingsByPass: Record<ReviewAuditPass, number>;
  findingsByPriority: Record<Priority, number>;
  findingsByOrigin: Record<FindingOrigin, number>;
  repeatedFindings: number;
  lateHighPriorityFindings: number;
  unchangedHeadDrift: boolean;
  declineRatio?: number;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path}.${key} must be a non-empty string`);
  return value;
}

function parseCoverageFile(input: unknown, index: number): ReviewFileCoverage {
  const path = `coverage.files[${index}]`;
  if (!isRecord(input)) throw new Error(`${path} must be an object`);
  if (!Array.isArray(input.hunks) || input.hunks.some((hunk) => typeof hunk !== "string")) {
    throw new Error(`${path}.hunks must be an array of strings`);
  }
  return {path: requiredString(input, "path", path), hunks: input.hunks};
}

function parseStringArray(input: unknown, path: string): string[] {
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
  return input;
}

function parseObligation(input: unknown, index: number): ReviewObligationResult {
  const path = `obligations[${index}]`;
  if (!isRecord(input)) throw new Error(`${path} must be an object`);
  const status = input.status;
  if (status !== "fixed" && status !== "incomplete" && status !== "regressed") {
    throw new Error(`${path}.status is invalid`);
  }
  return {
    findingId: requiredString(input, "findingId", path),
    status,
    evidence: requiredString(input, "evidence", path),
  };
}

export function auditFindingIdentity(finding: Finding): string {
  const normalize = (value: string): string => value.trim().toLowerCase().replaceAll(/\s+/g, " ");
  return [finding.file ?? "", finding.line?.toString() ?? "", finding.title, finding.evidence, finding.direction]
    .map(normalize)
    .join("|");
}

function isFindingOrigin(input: unknown): input is FindingOrigin {
  return typeof input === "string" && findingOrigins.some((origin) => origin === input);
}

export function parseReviewPass(
  input: unknown,
  expectedPass: ReviewAuditPass,
  manifest: ReviewManifest,
  requiredObligations: string[],
): ReviewPassResult {
  if (!isRecord(input)) throw new Error("review pass result must be an object");
  if (input.pass !== expectedPass) throw new Error(`review pass must be ${expectedPass}`);
  if (!isRecord(input.coverage)) throw new Error("coverage must be an object");
  if (!Array.isArray(input.coverage.files)) throw new Error("coverage.files must be an array");
  const coverageFiles = input.coverage.files.map(parseCoverageFile);
  if (new Set(coverageFiles.map((file) => file.path)).size !== coverageFiles.length) {
    throw new Error("coverage.files must not contain duplicate paths");
  }
  const byPath = new Map(coverageFiles.map((file) => [file.path, file]));
  // Fix-delta hunks are PERMITTED in coverage, manifest.files hunks stay REQUIRED. On a
  // remediation or rebased round the prompt embeds remediationFiles/baseDeltaFiles in
  // AUDIT_INPUT and instructs the reviewer to audit those ranges, and a reviewer that did
  // as it was told unioned their hunks into its coverage — the previous exact-equality
  // check then discarded the whole logical round. Measured 2026-08-09: three consecutive
  // remediation attempts died here while their passes classified every obligation fixed.
  // Same self-contradiction class as the metadata-coverage note below.
  const fixDeltaHunks = new Map<string, Set<string>>();
  for (const file of [...(manifest.remediationFiles ?? []), ...(manifest.baseDeltaFiles ?? [])]) {
    const hunks = fixDeltaHunks.get(file.path) ?? new Set<string>();
    for (const hunk of file.hunks) hunks.add(hunk);
    fixDeltaHunks.set(file.path, hunks);
  }
  for (const manifestFile of manifest.files) {
    const covered = byPath.get(manifestFile.path);
    if (!covered || manifestFile.hunks.some((hunk) => !covered.hunks.includes(hunk))) {
      throw new Error(`coverage is incomplete for ${manifestFile.path}`);
    }
    const allowed = new Set([...manifestFile.hunks, ...(fixDeltaHunks.get(manifestFile.path) ?? [])]);
    const unknown = covered.hunks.find((hunk) => !allowed.has(hunk));
    if (unknown !== undefined) {
      throw new Error(
        `coverage for ${manifestFile.path} includes a hunk outside the review manifest: ${unknown}`,
      );
    }
  }
  // Landing-metadata coverage is PERMITTED but not required: the completeness loop above
  // demands manifest.files only. Rejecting it was a self-contradiction — reviewPrompt names
  // every metadata file in the prompt and instructs the reviewer to "inspect them ... for
  // contradictions that affect the reviewed behavior", and a reviewer that did as it was
  // told had its entire logical round discarded here, findings included. Measured
  // 2026-08-06/07: with metadataPaths [".reviews/**"], rounds on two separate items died
  // this way while reporting zero defects.
  //
  // Matched against the configured PATTERNS rather than manifest.metadataFiles, so a
  // neighbouring ledger the reviewer happened to open is tolerated too. Those paths are
  // exempt from code review by configuration, so coverage of them carries no signal in
  // either direction. Everything else still fails closed — this check is what catches a
  // reviewer that audited the wrong range or invented files.
  // A path that exists only in a fix delta (e.g. a remediation commit that exactly reverts
  // a file drops it from base..head) is coverable for the same reason: the reviewer was
  // told to audit that range. Its hunks must still all come from the delta.
  const stray = coverageFiles.find(
    (file) =>
      !manifest.files.some((manifestFile) => manifestFile.path === file.path) &&
      !matchesMetadataPath(file.path, manifest.metadataPaths ?? []) &&
      !(fixDeltaHunks.has(file.path) &&
        file.hunks.every((hunk) => fixDeltaHunks.get(file.path)?.has(hunk))),
  );
  if (stray) {
    throw new Error(`coverage includes a file outside the review manifest: ${stray.path}`);
  }
  if (!Array.isArray(input.obligations)) throw new Error("obligations must be an array");
  const obligations = input.obligations.map(parseObligation);
  for (const findingId of requiredObligations) {
    if (!obligations.some((obligation) => obligation.findingId === findingId)) {
      throw new Error(`accepted-finding obligation ${findingId} is missing`);
    }
  }
  if (!Array.isArray(input.findings)) throw new Error("findings must be an array");
  const rawFindings = input.findings;
  const parsedReview = parseReview({summary: input.summary, findings: rawFindings});
  const findings = parsedReview.findings.map((finding, index): AuditFinding => {
    const rawFinding = rawFindings[index];
    if (!isRecord(rawFinding) || !isFindingOrigin(rawFinding.origin)) {
      throw new Error(`findings[${index}].origin is invalid`);
    }
    const obligationId = rawFinding.obligationId;
    if (obligationId !== undefined && obligationId !== null && typeof obligationId !== "string") {
      throw new Error(`findings[${index}].obligationId must be a string when present`);
    }
    return {
      ...finding,
      origin: rawFinding.origin,
      ...(typeof obligationId === "string" && obligationId.length > 0 ? {obligationId} : {}),
    };
  });
  const coveredInstructionFiles = parseStringArray(input.coverage.instructionFiles, "coverage.instructionFiles");
  if (JSON.stringify([...coveredInstructionFiles].sort()) !== JSON.stringify([...manifest.instructionFiles].sort())) {
    throw new Error("coverage is incomplete for repository instruction files");
  }
  return {
    pass: expectedPass,
    summary: parsedReview.summary,
    coverage: {
      files: coverageFiles,
      instructionFiles: coveredInstructionFiles,
      callsites: parseStringArray(input.coverage.callsites, "coverage.callsites"),
    },
    obligations,
    findings,
  };
}

export function combineReviewPasses(
  passResults: ReviewPassResult[],
  priorFindings: PriorFindingIdentity[],
  roundNumber = 1,
): {summary: string; findings: CombinedAuditFinding[]; obligations: ReviewObligationResult[]} {
  const findingsByIdentity = new Map<string, CombinedAuditFinding>();
  for (const passResult of passResults) {
    for (const finding of passResult.findings) {
      const identity = auditFindingIdentity(finding);
      const existing = findingsByIdentity.get(identity);
      if (existing) {
        if (!existing.passes.includes(passResult.pass)) existing.passes.push(passResult.pass);
        if (existing.origin !== finding.origin) existing.origin = "unknown";
        continue;
      }
      const repeatedFrom = priorFindings.filter((prior) => prior.identity === identity).map((prior) => prior.id);
      const firstSeenRound = Math.min(
        roundNumber,
        ...priorFindings.filter((prior) => prior.identity === identity).map((prior) => prior.firstSeenRound),
      );
      findingsByIdentity.set(identity, {
        ...finding,
        identity,
        passes: [passResult.pass],
        firstSeenRound,
        ...(repeatedFrom.length > 0 ? {repeatedFrom} : {}),
      });
    }
  }
  const obligationsById = new Map<string, ReviewObligationResult>();
  for (const passResult of passResults) {
    for (const obligation of passResult.obligations) {
      const existing = obligationsById.get(obligation.findingId);
      if (!existing || (existing.status === "fixed" && obligation.status !== "fixed")) {
        obligationsById.set(obligation.findingId, obligation);
      }
    }
  }
  return {
    summary: passResults.map((result) => `${result.pass}: ${result.summary}`).join(" | "),
    findings: [...findingsByIdentity.values()],
    obligations: [...obligationsById.values()],
  };
}

export function computeReviewMetrics(_input: {
  roundNumber: number;
  headSha: string;
  previousRound?: {headSha: string; findingCount: number; identities: string[]};
  passResults: ReviewPassResult[];
  findings: CombinedAuditFinding[];
}): ReviewMetrics {
  const input = _input;
  const findingsByPass: Record<ReviewAuditPass, number> = {diff: 0, integration: 0, adversarial: 0};
  for (const passResult of input.passResults) findingsByPass[passResult.pass] = passResult.findings.length;
  const findingsByPriority: Record<Priority, number> = {P0: 0, P1: 0, P2: 0, P3: 0};
  const findingsByOrigin: Record<FindingOrigin, number> = {
    original: 0,
    remediation: 0,
    "base-delta": 0,
    unknown: 0,
  };
  for (const finding of input.findings) {
    findingsByPriority[finding.priority] += 1;
    findingsByOrigin[finding.origin] += 1;
  }
  const currentIdentities = input.findings.map((finding) => finding.identity).sort();
  const previousIdentities = [...(input.previousRound?.identities ?? [])].sort();
  const unchangedHeadDrift =
    input.previousRound?.headSha === input.headSha &&
    JSON.stringify(currentIdentities) !== JSON.stringify(previousIdentities);
  const previousCount = input.previousRound?.findingCount;
  return {
    findingsByPass,
    findingsByPriority,
    findingsByOrigin,
    repeatedFindings: input.findings.filter((finding) => finding.repeatedFrom?.length).length,
    lateHighPriorityFindings:
      input.roundNumber > 1
        ? input.findings.filter(
            (finding) =>
              (finding.priority === "P0" || finding.priority === "P1") && !finding.repeatedFrom?.length,
          ).length
        : 0,
    unchangedHeadDrift,
    ...(previousCount && previousCount > 0
      ? {declineRatio: (previousCount - input.findings.length) / previousCount}
      : {}),
  };
}
