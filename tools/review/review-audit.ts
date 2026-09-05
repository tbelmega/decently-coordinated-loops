import type {ReviewPersonaName} from "../config.ts";
import {
  isFindingCausality,
  parseReview,
  type Finding,
  type FindingCausality,
  type Priority,
  type ReviewObligationType,
} from "./review-ledger.ts";
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
  status: "fixed" | "documented" | "incomplete" | "regressed";
  evidence: string;
  /** Stamped from the required obligation at validation time (never reviewer-supplied),
   * so the audit history keeps the typed distinction even after a later supersession
   * changes what the finding's current decision is. Absent on legacy results. */
  type?: ReviewObligationType;
}

export interface AuditFinding extends Finding {
  origin: FindingOrigin;
  causality: FindingCausality;
  obligationId?: string;
  /** Every obligation this one finding answers. One defect reported once per pass becomes
   * several accepted findings and therefore several obligations, and a single follow-up
   * finding has to be able to keep all of them actionable. `obligationId` stays the
   * primary for existing readers; this is the full set including it. */
  obligationIds?: string[];
}

export interface ReviewPassResult {
  pass: ReviewPersonaName;
  summary: string;
  coverage: ReviewCoverage;
  obligations: ReviewObligationResult[];
  findings: AuditFinding[];
  notes: ReviewPassNote[];
}

/** A non-blocking P2/P3 observation returned under the severity floor (C1): no
 * obligation, no disposition, rendered in the ledger's own section. */
export interface ReviewPassNote {
  priority: "P2" | "P3";
  title: string;
  file?: string;
  line?: number;
  detail?: string;
}

/** A note as the round stores it, attributed to the pass that raised it. */
export interface CombinedAuditNote extends ReviewPassNote {
  pass: ReviewPersonaName;
}

export interface CombinedAuditFinding extends AuditFinding {
  identity: string;
  passes: ReviewPersonaName[];
  firstSeenRound: number;
  repeatedFrom?: string[];
}

export interface PriorFindingIdentity {
  id: string;
  identity: string;
  firstSeenRound: number;
}

export interface ReviewMetrics {
  /** Legacy rounds carry the three audit passes; persona rounds add confirmation. */
  findingsByPass: Record<"diff" | "integration" | "adversarial", number> &
    Partial<Record<"confirmation", number>>;
  findingsByPriority: Record<Priority, number>;
  findingsByOrigin: Record<FindingOrigin, number>;
  repeatedFindings: number;
  lateHighPriorityFindings: number;
  unchangedHeadDrift: boolean;
  declineRatio?: number;
  /** Wall time of the round's reviewer invocations: the outer duration from the first
   * pass starting to the last one finishing (C0). With personas running concurrently
   * this is what the round actually cost the loop, which is the whole point of the
   * measurement; `reviewerMs` keeps the summed reviewer compute. Absent on rounds
   * recorded before instrumentation. */
  elapsedMs?: number;
  /** Reviewer compute summed over the round's passes. Equal to `elapsedMs` for the
   * sequential engine and larger than it whenever passes ran in parallel. */
  reviewerMs?: number;
  /** Token usage summed over the passes that reported any; absent when none did. */
  tokens?: {input?: number; output?: number; total?: number};
  /** Non-blocking notes this round returned under the severity floor (C1); absent
   * on rounds run without the notes channel. */
  noteCount?: number;
  /** What the round's non-blocking `--shadow-full` instrument cost, kept apart from the
   * blocking numbers above so `elapsedMs` stays the time the loop actually waited. The
   * measurement window needs both: a scoped round that shadows the full range is cheap
   * to wait for and expensive to run, and comparing only the blocking half would credit
   * C2 with a speed-up it did not deliver. Absent on rounds that ran no shadow. */
  shadowElapsedMs?: number;
  /** Reviewer compute summed over the shadow passes. */
  shadowReviewerMs?: number;
  /** Token usage summed over the shadow passes that reported any. */
  shadowTokens?: {input?: number; output?: number; total?: number};
}

/** Per-pass invocation stats the round runner measured around each reviewer call. */
export interface ReviewPassStats {
  elapsedMs: number;
  tokens?: {input?: number; output?: number; total?: number};
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

/** What the reviewer must classify this pass, typed so the terminal result can be
 * validated against the decision that created the obligation: `fixed` is terminal only
 * for remediation obligations, `documented` only for documentation obligations. */
export interface RequiredReviewObligation {
  findingId: string;
  type: ReviewObligationType;
}

const validStatusesByType: Record<ReviewObligationType, readonly ReviewObligationResult["status"][]> = {
  remediation: ["fixed", "incomplete", "regressed"],
  documentation: ["documented", "incomplete", "regressed"],
};

function parseObligation(input: unknown, index: number): ReviewObligationResult {
  const path = `obligations[${index}]`;
  if (!isRecord(input)) throw new Error(`${path} must be an object`);
  const status = input.status;
  if (status !== "fixed" && status !== "documented" && status !== "incomplete" && status !== "regressed") {
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

export type ReviewCoverageManifest = Pick<ReviewManifest,
  "files" | "instructionFiles" | "metadataPaths" | "remediationFiles" | "baseDeltaFiles">;

export function parseReviewPass(
  input: unknown,
  expectedPass: ReviewPersonaName,
  manifest: ReviewCoverageManifest,
  requiredObligations: RequiredReviewObligation[],
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
  // as it was told unioned their hunks into its coverage - the previous exact-equality
  // check then discarded the whole logical round. Measured 2026-08-09: three consecutive
  // remediation attempts died here while their passes classified every obligation fixed.
  // Same self-contradiction class as the metadata-coverage note below.
  const fixDeltaHunks = new Map<string, Set<string>>();
  for (const file of [...(manifest.remediationFiles ?? []), ...(manifest.baseDeltaFiles ?? [])]) {
    const hunks = fixDeltaHunks.get(file.path) ?? new Set<string>();
    for (const hunk of file.hunks) hunks.add(hunk);
    fixDeltaHunks.set(file.path, hunks);
  }
  for (const file of coverageFiles) {
    if (new Set(file.hunks).size !== file.hunks.length) {
      throw new Error(`coverage for ${file.path} must not repeat hunks`);
    }
  }
  // Only two covered sets are compliant behavior per file: exactly the manifest hunks
  // (reviewer left the fix delta out of its coverage list) or their complete union with
  // the fix-delta hunks (reviewer counted the audited delta in). A partial union would
  // persist an audit of a range the reviewer did not finish, so it fails closed too.
  for (const manifestFile of manifest.files) {
    const covered = byPath.get(manifestFile.path);
    if (!covered || manifestFile.hunks.some((hunk) => !covered.hunks.includes(hunk))) {
      throw new Error(`coverage is incomplete for ${manifestFile.path}`);
    }
    const union = new Set([...manifestFile.hunks, ...(fixDeltaHunks.get(manifestFile.path) ?? [])]);
    const unknown = covered.hunks.find((hunk) => !union.has(hunk));
    if (unknown !== undefined) {
      throw new Error(
        `coverage for ${manifestFile.path} includes a hunk outside the review manifest: ${unknown}`,
      );
    }
    if (covered.hunks.length !== manifestFile.hunks.length && covered.hunks.length !== union.size) {
      throw new Error(
        `coverage for ${manifestFile.path} must be exactly the manifest hunks or their complete union with the fix delta`,
      );
    }
  }
  // Landing-metadata coverage is PERMITTED but not required: the completeness loop above
  // demands manifest.files only. Rejecting it was a self-contradiction - reviewPrompt names
  // every metadata file in the prompt and instructs the reviewer to "inspect them ... for
  // contradictions that affect the reviewed behavior", and a reviewer that did as it was
  // told had its entire logical round discarded here, findings included. Measured
  // 2026-08-06/07: with metadataPaths [".reviews/**"], rounds on two separate items died
  // this way while reporting zero defects.
  //
  // Matched against the configured PATTERNS rather than manifest.metadataFiles, so a
  // neighbouring ledger the reviewer happened to open is tolerated too. Those paths are
  // exempt from code review by configuration, so coverage of them carries no signal in
  // either direction. Everything else still fails closed - this check is what catches a
  // reviewer that audited the wrong range or invented files.
  // A path that exists only in a fix delta (e.g. a remediation commit that exactly reverts
  // a file drops it from base..head) is coverable for the same reason: the reviewer was
  // told to audit that range. When reported it needs the complete delta hunk set - an
  // empty or partial list is not evidence of an audit.
  const stray = coverageFiles.find((file) => {
    if (manifest.files.some((manifestFile) => manifestFile.path === file.path)) return false;
    if (matchesMetadataPath(file.path, manifest.metadataPaths ?? [])) return false;
    const delta = fixDeltaHunks.get(file.path);
    if (!delta) return true;
    return file.hunks.length !== delta.size || file.hunks.some((hunk) => !delta.has(hunk));
  });
  if (stray) {
    throw new Error(`coverage includes a file outside the review manifest: ${stray.path}`);
  }
  if (!Array.isArray(input.obligations)) throw new Error("obligations must be an array");
  const rawObligations = input.obligations.map(parseObligation);
  const requiredById = new Map(requiredObligations.map((required) => [required.findingId, required]));
  for (const required of requiredObligations) {
    if (!rawObligations.some((obligation) => obligation.findingId === required.findingId)) {
      throw new Error(`open obligation ${required.findingId} is missing a classification`);
    }
  }
  if (new Set(rawObligations.map((obligation) => obligation.findingId)).size !== rawObligations.length) {
    // A contradictory response (documented AND incomplete for one obligation) must not
    // let the terminal half retire it.
    throw new Error("obligations must not contain duplicate findingIds");
  }
  // No result may be PERSISTED for an obligation that was not open when this round
  // ran - an unsolicited result could pre-close an obligation a later decision
  // creates. A pass that was never asked to classify may still echo classifications
  // (the prompt shows every obligation to every pass), so its results are discarded
  // rather than fatal; on the classifying pass an unknown id stays an audit error.
  const obligations = requiredObligations.length === 0
    ? []
    : rawObligations.map((obligation): ReviewObligationResult => {
        const required = requiredById.get(obligation.findingId);
        if (!required) {
          throw new Error(`obligation result ${obligation.findingId} was not required by this pass`);
        }
        if (!validStatusesByType[required.type].includes(obligation.status)) {
          throw new Error(
            `obligation ${obligation.findingId} is a ${required.type} obligation and cannot be classified ${obligation.status}`,
          );
        }
        return {...obligation, type: required.type};
      });
  if (!Array.isArray(input.findings)) throw new Error("findings must be an array");
  const rawFindings = input.findings;
  const parsedReview = parseReview({summary: input.summary, findings: rawFindings});
  const findings = parsedReview.findings.map((finding, index): AuditFinding => {
    const rawFinding = rawFindings[index];
    if (!isRecord(rawFinding) || !isFindingOrigin(rawFinding.origin)) {
      throw new Error(`findings[${index}].origin is invalid`);
    }
    if (!isFindingCausality(rawFinding.causality)) {
      throw new Error(`findings[${index}].causality is invalid`);
    }
    const obligationId = rawFinding.obligationId;
    if (obligationId !== undefined && obligationId !== null && typeof obligationId !== "string") {
      throw new Error(`findings[${index}].obligationId must be a string when present`);
    }
    const rawObligationIds = rawFinding.obligationIds;
    if (rawObligationIds !== undefined && rawObligationIds !== null) {
      if (
        !Array.isArray(rawObligationIds) ||
        rawObligationIds.some((value) => typeof value !== "string" || value.length === 0)
      ) {
        throw new Error(`findings[${index}].obligationIds must be an array of non-empty strings`);
      }
    }
    const primary = typeof obligationId === "string" && obligationId.length > 0 ? [obligationId] : [];
    const listed = Array.isArray(rawObligationIds) ? (rawObligationIds as string[]) : [];
    const obligationIds = [...new Set([...primary, ...listed])];
    return {
      ...finding,
      origin: rawFinding.origin,
      causality: rawFinding.causality,
      ...(obligationIds.length > 0 ? {obligationId: obligationIds[0], obligationIds} : {}),
    };
  });
  const coveredInstructionFiles = parseStringArray(input.coverage.instructionFiles, "coverage.instructionFiles");
  if (JSON.stringify([...coveredInstructionFiles].sort()) !== JSON.stringify([...manifest.instructionFiles].sort())) {
    throw new Error("coverage is incomplete for repository instruction files");
  }
  // Notes (C1): tolerated absent - reviewers without native schema enforcement and
  // pre-floor transcripts return none. A P0/P1 smuggled into notes fails the pass:
  // the floor demotes only what the taxonomy calls P2/P3, never a blocking defect.
  const rawNotes = input.notes;
  if (rawNotes !== undefined && !Array.isArray(rawNotes)) throw new Error("notes must be an array when present");
  const notes: ReviewPassNote[] = (Array.isArray(rawNotes) ? rawNotes : []).map((rawNote, index) => {
    if (!isRecord(rawNote)) throw new Error(`notes[${index}] must be an object`);
    if (rawNote.priority !== "P2" && rawNote.priority !== "P3") {
      throw new Error(`notes[${index}].priority must be P2 or P3 - blocking priorities are findings, never notes`);
    }
    if (typeof rawNote.title !== "string" || rawNote.title.length === 0) {
      throw new Error(`notes[${index}].title must be a non-empty string`);
    }
    if (rawNote.file !== undefined && rawNote.file !== null && typeof rawNote.file !== "string") {
      throw new Error(`notes[${index}].file must be a string when present`);
    }
    if (rawNote.line !== undefined && rawNote.line !== null && typeof rawNote.line !== "number") {
      throw new Error(`notes[${index}].line must be a number when present`);
    }
    if (rawNote.detail !== undefined && rawNote.detail !== null && typeof rawNote.detail !== "string") {
      throw new Error(`notes[${index}].detail must be a string when present`);
    }
    return {
      priority: rawNote.priority,
      title: rawNote.title,
      ...(typeof rawNote.file === "string" ? {file: rawNote.file} : {}),
      ...(typeof rawNote.line === "number" ? {line: rawNote.line} : {}),
      ...(typeof rawNote.detail === "string" ? {detail: rawNote.detail} : {}),
    };
  });
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
    notes,
  };
}

export function combineReviewPasses(
  passResults: ReviewPassResult[],
  priorFindings: PriorFindingIdentity[],
  roundNumber = 1,
  /** C1: with the round's severity floor active, a P2/P3 finding is moved into the
   * notes channel unless it is the actionable carrier of an obligation this round left
   * open. The decision belongs here, after the obligation results are consolidated: a
   * pass on its own cannot tell whether the obligation it names ends the round
   * incomplete (its finding has to survive) or fixed (nothing needs an actionable
   * finding, so the observation is just a new low-priority one). */
  severityFloorActive = false,
): {
  summary: string;
  findings: CombinedAuditFinding[];
  obligations: ReviewObligationResult[];
  notes: CombinedAuditNote[];
} {
  const findingsByIdentity = new Map<string, CombinedAuditFinding>();
  for (const passResult of passResults) {
    for (const finding of passResult.findings) {
      const identity = auditFindingIdentity(finding);
      const existing = findingsByIdentity.get(identity);
      if (existing) {
        if (!existing.passes.includes(passResult.pass)) existing.passes.push(passResult.pass);
        if (existing.origin !== finding.origin) existing.origin = "unknown";
        if (existing.causality !== finding.causality) existing.causality = "unknown";
        // Passes may thread the same finding to different subsets of the duplicate
        // obligations; the union is what keeps every one of them answered.
        const merged = [...new Set([...(existing.obligationIds ?? []), ...(finding.obligationIds ?? [])])];
        if (merged.length > 0) {
          existing.obligationIds = merged;
          existing.obligationId = merged[0];
        }
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
  const terminalStatuses: readonly ReviewObligationResult["status"][] = ["fixed", "documented"];
  const obligationsById = new Map<string, ReviewObligationResult>();
  for (const passResult of passResults) {
    for (const obligation of passResult.obligations) {
      const existing = obligationsById.get(obligation.findingId);
      // A non-terminal classification always beats a terminal one - a disagreement
      // between passes must keep the obligation open, whatever its type.
      if (
        !existing ||
        (terminalStatuses.includes(existing.status) && !terminalStatuses.includes(obligation.status))
      ) {
        obligationsById.set(obligation.findingId, obligation);
      }
    }
  }
  const obligations = [...obligationsById.values()];
  const notes: CombinedAuditNote[] = passResults.flatMap((result) =>
    result.notes.map((note) => ({...note, pass: result.pass})),
  );
  const combined = [...findingsByIdentity.values()];
  // Obligations this round did NOT close. Only a finding answering one of these has to
  // stay actionable; every other P2/P3 is a new observation the floor demotes. An id
  // the reviewer invented names nothing here, so it buys no exemption - reviewer output
  // is the input boundary for the floor.
  const openAfterRound = new Set(
    obligations
      .filter((obligation) => obligation.status === "incomplete" || obligation.status === "regressed")
      .map((obligation) => obligation.findingId),
  );
  const demotable = (finding: CombinedAuditFinding): boolean =>
    (finding.priority === "P2" || finding.priority === "P3") &&
    !(finding.obligationIds ?? []).some((id) => openAfterRound.has(id));
  // Demotion lowers the round's finding count, so declineRatio and the churn tripwire
  // read a floored round as converging faster than an unfloored one would. That is the
  // intended trade; the observations survive as notes and are counted as `noteCount`.
  const demoted = severityFloorActive ? combined.filter(demotable) : [];
  return {
    summary: passResults.map((result) => `${result.pass}: ${result.summary}`).join(" | "),
    findings: demoted.length > 0 ? combined.filter((finding) => !demotable(finding)) : combined,
    obligations,
    notes: [
      ...notes,
      ...demoted.map((finding): CombinedAuditNote => ({
        priority: finding.priority as "P2" | "P3",
        title: finding.title,
        ...(finding.file !== undefined ? {file: finding.file} : {}),
        ...(finding.line !== undefined ? {line: finding.line} : {}),
        detail: `${finding.evidence} Impact: ${finding.impact}`,
        // The pass that raised it; a corroborated observation keeps its first reporter,
        // which is enough to read the notes section against the round's passes.
        pass: finding.passes[0]!,
      })),
    ],
  };
}

export function computeReviewMetrics(_input: {
  roundNumber: number;
  headSha: string;
  previousRound?: {headSha: string; findingCount: number; identities: string[]};
  passResults: ReviewPassResult[];
  findings: CombinedAuditFinding[];
  passStats?: ReviewPassStats[];
  notes?: CombinedAuditNote[];
  /** Outer wall time the runner measured around the round's passes. Absent only when
   * the caller has no measurement, in which case the summed compute stands in. */
  elapsedMs?: number;
  /** Outer wall time around the round's `--shadow-full` passes, and their per-pass
   * stats. Both absent on a round that ran no shadow. */
  shadowElapsedMs?: number;
  shadowPassStats?: ReviewPassStats[];
}): ReviewMetrics {
  const input = _input;
  const stats = input.passStats ?? [];
  const reviewerMs = stats.length ? stats.reduce((sum, stat) => sum + stat.elapsedMs, 0) : undefined;
  const elapsedMs = input.elapsedMs ?? reviewerMs;
  const sumTokens = (
    entries: ReviewPassStats[],
  ): {input?: number; output?: number; total?: number} | undefined => {
    const reported = entries.filter((stat) => stat.tokens);
    if (reported.length === 0) return undefined;
    return {
      input: reported.reduce((sum, stat) => sum + (stat.tokens?.input ?? 0), 0),
      output: reported.reduce((sum, stat) => sum + (stat.tokens?.output ?? 0), 0),
      total: reported.reduce((sum, stat) => sum + (stat.tokens?.total ?? 0), 0),
    };
  };
  const tokens = sumTokens(stats);
  const shadowStats = input.shadowPassStats ?? [];
  const shadowReviewerMs = shadowStats.length
    ? shadowStats.reduce((sum, stat) => sum + stat.elapsedMs, 0)
    : undefined;
  const shadowTokens = sumTokens(shadowStats);
  const findingsByPass: Record<ReviewPersonaName, number> = {
    diff: 0,
    integration: 0,
    adversarial: 0,
    confirmation: 0,
  };
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
    ...(elapsedMs !== undefined ? {elapsedMs} : {}),
    ...(reviewerMs !== undefined ? {reviewerMs} : {}),
    ...(tokens ? {tokens} : {}),
    ...(input.notes !== undefined ? {noteCount: input.notes.length} : {}),
    ...(input.shadowElapsedMs !== undefined ? {shadowElapsedMs: input.shadowElapsedMs} : {}),
    ...(shadowReviewerMs !== undefined ? {shadowReviewerMs} : {}),
    ...(shadowTokens ? {shadowTokens} : {}),
  };
}
