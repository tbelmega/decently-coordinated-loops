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
export const dispositionKinds = [
  "accepted",
  "rejected",
  "already-addressed",
  "deferred-to-human",
  "accepted-as-limitation",
] as const;

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
  /** Documentation evidence path (accepted-as-limitation only): repository-relative,
   * recorded normalized; resolution binds at each consuming gate, not at recording. */
  doc?: string;
  /** Owner attribution — required for accepted-as-limitation on P0/P1 findings and for
   * the accepted disposition that reverses a limitation. */
  owner?: boolean;
  /** Completed-round count when this decision was recorded. An obligation result can
   * only close the obligation from a round after its creating decision — a terminal
   * result that pre-dates the decision proves nothing about it. Absent on legacy
   * dispositions, where the finding's own round is the fallback lower bound. */
  decidedAfterRound?: number;
}

export interface LedgerFinding extends Finding {
  id: string;
  disposition?: ReviewDisposition;
  /** Superseded decisions, chronological. Both sides of a supersession stay auditable;
   * obligations belong to the decision that created them, so this history is what makes
   * a reversal-created obligation distinguishable from the retired one. */
  history?: ReviewDisposition[];
}

export interface ReviewStepBack {
  path: string;
  /** The remediation-dominated round pair that armed the tripwire this note answers. */
  triggerRounds: [number, number];
}

export interface ReviewRound {
  number: number;
  headSha: string;
  model: string;
  reviewedAt: string;
  summary: string;
  findings: LedgerFinding[];
  audit?: ReviewRoundAudit;
  stepBack?: ReviewStepBack;
}

export interface ReviewRoundAudit {
  kind: "full" | "remediation" | "base-delta";
  manifest: ReviewManifest;
  passes: {pass: ReviewAuditPass; summary: string; coverage: ReviewCoverage}[];
  obligations: ReviewObligationResult[];
  metrics: ReviewMetrics;
}

export interface ReviewSupersession {
  /** rounds[0..afterRound-1] reviewed the superseded base recorded here. */
  afterRound: number;
  baseRef: string;
  baseSha: string;
  patchIds?: string[];
  archivedAt: string;
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
  supersessions?: ReviewSupersession[];
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
  stepBack?: ReviewStepBack;
}

export type ReviewObligationType = "remediation" | "documentation";

export interface ReviewObligation {
  /** Obligation id the reviewer classifies against: the finding id, qualified with
   * `#<decision>` when a superseding decision created it. An obligation belongs to the
   * decision, so a result recorded against a retired decision's id can never satisfy a
   * live one. */
  findingId: string;
  type: ReviewObligationType;
  title: string;
  evidence: string;
  direction: string;
  dispositionReason: string;
  /** Documentation obligations carry the recorded doc path, consumed by the start gate
   * and handed to the confirmation pass as the artifact to verify. */
  doc?: string;
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

/** Evidence paths (--doc, --step-back) are recorded normalized and repository-relative;
 * absolute and traversal forms are rejected at recording time, and resolution to a
 * tracked regular file binds at each consuming gate (enforcement contract rule 1). */
export function validateEvidencePath(path: string): string {
  const normalized = path.startsWith("./") ? path.slice(2) : path;
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    path.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`evidence path must be repository-relative without traversal: ${JSON.stringify(path)}`);
  }
  return normalized;
}

function parseDisposition(input: unknown, path: string): ReviewDisposition | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new Error(`${path} must be an object`);
  const kind = input.kind;
  if (!isDispositionKind(kind)) throw new Error(`${path}.kind is invalid`);
  if (input.owner !== undefined && typeof input.owner !== "boolean") {
    throw new Error(`${path}.owner must be a boolean when present`);
  }
  const decidedAfterRound = input.decidedAfterRound;
  if (
    decidedAfterRound !== undefined &&
    (typeof decidedAfterRound !== "number" || !Number.isInteger(decidedAfterRound) || decidedAfterRound < 0)
  ) {
    throw new Error(`${path}.decidedAfterRound must be a non-negative integer when present`);
  }
  const doc = optionalString(input, "doc", path);
  return {
    kind,
    reason: requiredString(input, "reason", path),
    ...(doc ? {doc} : {}),
    ...(input.owner === true ? {owner: true} : {}),
    ...(typeof decidedAfterRound === "number" ? {decidedAfterRound} : {}),
  };
}

/** Invariant 5: a persisted decision honors the recording rules even when the ledger
 * arrived from disk — a malformed ledger must fail closed, not certify silently. */
function assertDecisionInvariants(decision: ReviewDisposition, priority: Priority, path: string): void {
  if (decision.kind === "accepted-as-limitation") {
    if (!decision.doc) {
      throw new Error(`${path} is accepted-as-limitation and must carry a doc path`);
    }
    if (decision.doc !== validateEvidencePath(decision.doc)) {
      throw new Error(`${path}.doc must be a normalized repository-relative path`);
    }
    if ((priority === "P0" || priority === "P1") && decision.owner !== true) {
      throw new Error(`${path} is a ${priority} limitation and must carry owner attribution`);
    }
  } else if (decision.doc) {
    throw new Error(`${path}.doc is only valid on an accepted-as-limitation disposition`);
  }
}

function parseStepBack(input: unknown, path: string): ReviewStepBack | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new Error(`${path} must be an object`);
  const triggerRounds = input.triggerRounds;
  if (
    !Array.isArray(triggerRounds) ||
    triggerRounds.length !== 2 ||
    triggerRounds.some((value) => typeof value !== "number" || !Number.isInteger(value) || value < 1)
  ) {
    throw new Error(`${path}.triggerRounds must be two positive round numbers`);
  }
  return {
    path: requiredString(input, "path", path),
    triggerRounds: [triggerRounds[0], triggerRounds[1]],
  };
}

export function parseReviewLedger(input: unknown): ReviewLedger {
  if (!isRecord(input)) throw new Error("review ledger must be an object");
  if (input.version !== 1) throw new Error("review ledger version must be 1");
  if (!Array.isArray(input.rounds)) throw new Error("review ledger rounds must be an array");
  const totalRounds = input.rounds.length;
  const rounds = input.rounds.map((roundInput, roundIndex): ReviewRound => {
    const path = `rounds[${roundIndex}]`;
    if (!isRecord(roundInput)) throw new Error(`${path} must be an object`);
    const roundFindings = roundInput.findings;
    if (!Array.isArray(roundFindings)) throw new Error(`${path}.findings must be an array`);
    const parsedReview = parseReview({ summary: roundInput.summary, findings: roundFindings });
    const findings = parsedReview.findings.map((finding, findingIndex): LedgerFinding => {
      const findingInput = roundFindings[findingIndex];
      if (!isRecord(findingInput)) throw new Error(`${path}.findings[${findingIndex}] must be an object`);
      const findingPath = `${path}.findings[${findingIndex}]`;
      const disposition = parseDisposition(findingInput.disposition, `${findingPath}.disposition`);
      if (disposition) {
        assertDecisionInvariants(disposition, finding.priority, `${findingPath}.disposition`);
      }
      if (findingInput.history !== undefined && !Array.isArray(findingInput.history)) {
        throw new Error(`${findingPath}.history must be an array when present`);
      }
      const history = Array.isArray(findingInput.history)
        ? findingInput.history.map((entry, historyIndex) => {
            const historyPath = `${findingPath}.history[${historyIndex}]`;
            const parsed = parseDisposition(entry, historyPath);
            if (!parsed) throw new Error(`${historyPath} must be an object`);
            assertDecisionInvariants(parsed, finding.priority, historyPath);
            return parsed;
          })
        : undefined;
      if (history?.length && !disposition) {
        throw new Error(`${findingPath}.history requires a live disposition to have superseded it`);
      }
      // The recorder permits exactly two supersessions; a persisted chain claiming any
      // other transition is malformed, not merely unusual.
      const decisions = [...(history ?? []), ...(disposition ? [disposition] : [])];
      for (const decision of decisions) {
        // No decision can be recorded before its finding's round exists or after more
        // rounds than the ledger holds — a forged stamp would let a pre-decision
        // result close the obligation (openObligations trusts this value).
        if (
          decision.decidedAfterRound !== undefined &&
          (decision.decidedAfterRound < roundIndex + 1 || decision.decidedAfterRound > totalRounds)
        ) {
          throw new Error(
            `${findingPath} has a decision whose decidedAfterRound (${decision.decidedAfterRound}) lies outside the finding's possible decision window`,
          );
        }
      }
      for (let decisionIndex = 0; decisionIndex + 1 < decisions.length; decisionIndex += 1) {
        const predecessor = decisions[decisionIndex];
        const successor = decisions[decisionIndex + 1];
        if (
          predecessor.decidedAfterRound !== undefined &&
          successor.decidedAfterRound !== undefined &&
          successor.decidedAfterRound < predecessor.decidedAfterRound
        ) {
          throw new Error(`${findingPath} has a supersession chain whose decidedAfterRound stamps run backwards`);
        }
        const permitted =
          predecessor.kind === "deferred-to-human" ||
          (predecessor.kind === "accepted-as-limitation" &&
            successor.kind === "accepted" &&
            successor.owner === true);
        if (!permitted) {
          throw new Error(
            `${findingPath} has an unsupported disposition supersession: ${predecessor.kind} may only be superseded by ${predecessor.kind === "accepted-as-limitation" ? "an owner-attributed accepted disposition" : "nothing"}`,
          );
        }
      }
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
        ...(history?.length ? {history} : {}),
      };
    });
    const number = roundInput.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number !== roundIndex + 1) {
      throw new Error(`${path}.number must be ${roundIndex + 1}`);
    }
    const stepBack = parseStepBack(roundInput.stepBack, `${path}.stepBack`);
    // A present audit must parse or the ledger fails closed: silently dropping it
    // would erase the round's persisted review evidence on the next rewrite and turn
    // a malformed terminal classification into a fresh attempt.
    let audit: ReviewRoundAudit | undefined;
    if (roundInput.audit !== undefined) {
      if (!isReviewRoundAudit(roundInput.audit)) {
        throw new Error(`${path}.audit is present but invalid`);
      }
      audit = roundInput.audit;
    }
    return {
      number,
      headSha: requiredString(roundInput, "headSha", path),
      model: requiredString(roundInput, "model", path),
      reviewedAt: requiredString(roundInput, "reviewedAt", path),
      summary: parsedReview.summary,
      findings,
      ...(audit ? {audit} : {}),
      ...(stepBack ? {stepBack} : {}),
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
  if (input.supersessions !== undefined && !Array.isArray(input.supersessions)) {
    throw new Error("review ledger supersessions must be an array when present");
  }
  const supersessions = Array.isArray(input.supersessions)
    ? input.supersessions.map((supersessionInput, supersessionIndex): ReviewSupersession => {
        const path = `supersessions[${supersessionIndex}]`;
        if (!isRecord(supersessionInput)) throw new Error(`${path} must be an object`);
        const afterRound = supersessionInput.afterRound;
        if (
          typeof afterRound !== "number" ||
          !Number.isInteger(afterRound) ||
          afterRound < 0 ||
          afterRound > rounds.length
        ) {
          throw new Error(`${path}.afterRound must be a completed-round count`);
        }
        return {
          afterRound,
          baseRef: requiredString(supersessionInput, "baseRef", path),
          baseSha: requiredString(supersessionInput, "baseSha", path),
          ...(isStringArray(supersessionInput.patchIds) ? {patchIds: supersessionInput.patchIds} : {}),
          archivedAt: requiredString(supersessionInput, "archivedAt", path),
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
    ...(supersessions?.length ? {supersessions} : {}),
  };
}

export function liveRounds(ledger: ReviewLedger): ReviewRound[] {
  const latest = ledger.supersessions?.at(-1);
  return latest ? ledger.rounds.slice(latest.afterRound) : ledger.rounds;
}

/** Enforcement contract rule 5: a changed patch series resets round mechanics only. The
 * same ledger continues — every disposition, obligation, and the tripwire's round
 * history stay in place by construction — while the superseded base context is recorded
 * here and the live window restarts after the last completed round. */
export function supersedeLedgerBase(
  ledger: ReviewLedger,
  next: {baseRef: string; baseSha: string; patchIds?: string[]; archivedAt: string},
): ReviewLedger {
  return {
    ...ledger,
    baseRef: next.baseRef,
    baseSha: next.baseSha,
    ...(next.patchIds ? {patchIds: next.patchIds} : {}),
    supersessions: [
      ...(ledger.supersessions ?? []),
      {
        afterRound: ledger.rounds.length,
        baseRef: ledger.baseRef,
        baseSha: ledger.baseSha,
        ...(ledger.patchIds ? {patchIds: ledger.patchIds} : {}),
        archivedAt: next.archivedAt,
      },
    ],
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
        ...(input.stepBack ? {stepBack: input.stepBack} : {}),
      },
    ],
  };
}

// The obligation contract's invariant list (C3 artifact; the C1/C2 enforcement contract
// in the containment spec is the source). Every fix in this space is verified against
// the whole list, not only against the finding that prompted it:
//   1. Evidence paths are normalized repo-relative; resolution to a tracked regular
//      file binds at each consuming gate, not at recording.
//   2. Obligations are typed by the decision that created them; `fixed` is terminal
//      only for remediation, `documented` only for documentation.
//   3. Obligation ids are decision-specific; a result recorded against a retired
//      decision's id never satisfies a live obligation.
//   4. A result may only be recorded for an obligation that was open when its round
//      ran (parseReviewPass rejects unsolicited ids), so every persisted result
//      post-dates the decision that opened its obligation.
//   5. Persisted decision state is parser-enforced, not only recorder-enforced: doc
//      presence and shape, P0/P1 owner attribution, the permitted supersession chain,
//      and each decision's round stamp (bounded by the finding's round and the round
//      count, monotonic along the chain) hold for live decisions and history alike.
//   6. Base supersession resets round mechanics only; decisions, obligations, and
//      tripwire state carry forward by construction.
//   7. Each persisted result carries its obligation type; a result whose status
//      contradicts its stamped type is malformation and never closes anything.
const obligationBearingKinds: readonly DispositionKind[] = ["accepted", "accepted-as-limitation"];

/** The obligation id a finding's CURRENT decision owns. The first obligation-bearing
 * decision keeps the bare finding id (every legacy ledger recorded results that way);
 * a superseding decision gets `#<decision-number>`, so no result recorded against a
 * retired decision can satisfy the live obligation (enforcement contract rule 4). */
function currentObligationId(finding: LedgerFinding): string {
  const priorBearing = (finding.history ?? []).filter((decision) =>
    obligationBearingKinds.includes(decision.kind),
  ).length;
  return priorBearing === 0 ? finding.id : `${finding.id}#${priorBearing + 1}`;
}

const terminalStatusByType: Record<ReviewObligationType, "fixed" | "documented"> = {
  remediation: "fixed",
  documentation: "documented",
};

/** Every open obligation across the whole ledger, typed by the decision that created it:
 * `accepted` creates a remediation obligation (terminal: fixed), `accepted-as-limitation`
 * a documentation obligation (terminal: documented). Supersession of the review base
 * never drops these — the rounds carrying the decisions stay in the ledger. */
export function openObligations(ledger: ReviewLedger): ReviewObligation[] {
  const terminalResults = ledger.rounds.flatMap((round) =>
    round.audit?.obligations
      .filter((result) => result.status === "fixed" || result.status === "documented")
      // A result's stamped type must agree with what its status closes; the status
      // itself types a legacy unstamped result.
      .map((result) => ({
        round: round.number,
        key: `${result.status}:${result.findingId}:${result.type ?? (result.status === "documented" ? "documentation" : "remediation")}`,
      })) ?? [],
  );
  return ledger.rounds.flatMap((round) =>
    round.findings.flatMap((finding): ReviewObligation[] => {
      const decision = finding.disposition;
      if (!decision || !obligationBearingKinds.includes(decision.kind)) return [];
      const type: ReviewObligationType = decision.kind === "accepted" ? "remediation" : "documentation";
      const id = currentObligationId(finding);
      // A result closes the obligation only from a round after its creating decision:
      // a terminal result that pre-dates the decision (a legacy unsolicited result)
      // proves nothing about it. Legacy decisions carry no round stamp; the finding's
      // own round is the lower bound then, since no decision precedes its finding.
      const decidedAfterRound = decision.decidedAfterRound ?? round.number;
      const closed = terminalResults.some(
        (result) =>
          result.key === `${terminalStatusByType[type]}:${id}:${type}` && result.round > decidedAfterRound,
      );
      if (closed) return [];
      return [{
        findingId: id,
        type,
        title: finding.title,
        evidence: finding.evidence,
        direction: finding.direction,
        dispositionReason: decision.reason,
        ...(type === "documentation" && decision.doc ? {doc: decision.doc} : {}),
      }];
    }),
  );
}

export interface TripwireRound {
  number: number;
  headSha: string;
  remediationCount: number;
  findingCount: number;
}

export type TripwireState = {armed: false} | {armed: true; rounds: [TripwireRound, TripwireRound]};

/** C1: a completed round is remediation-dominated when it has at least one finding and
 * strictly more than half carry `origin: remediation`. The tripwire arms when the two
 * most recently completed rounds are both dominated. It reads the full round history —
 * base supersession resets round mechanics, not containment state. */
export function remediationChurnTripwire(ledger: ReviewLedger): TripwireState {
  if (ledger.rounds.length < 2) return {armed: false};
  const [older, newer] = ledger.rounds.slice(-2).map((round): TripwireRound => ({
    number: round.number,
    headSha: round.headSha,
    remediationCount: round.findings.filter((finding) => finding.origin === "remediation").length,
    findingCount: round.findings.length,
  }));
  const dominated = [older, newer].every(
    (round) => round.findingCount > 0 && round.remediationCount * 2 > round.findingCount,
  );
  return dominated ? {armed: true, rounds: [older, newer]} : {armed: false};
}

export interface RecordDispositionOptions {
  doc?: string;
  owner?: boolean;
}

export function recordDisposition(
  ledger: ReviewLedger,
  findingId: string,
  kind: DispositionKind,
  reason: string,
  options: RecordDispositionOptions = {},
): ReviewLedger {
  if (!reason) throw new Error("disposition reason must not be empty");
  if (options.doc !== undefined && kind !== "accepted-as-limitation") {
    throw new Error("a doc path is only valid on an accepted-as-limitation disposition");
  }
  let doc: string | undefined;
  if (kind === "accepted-as-limitation") {
    if (!options.doc) {
      throw new Error("accepted-as-limitation requires a doc path naming where the limitation is documented");
    }
    doc = validateEvidencePath(options.doc);
  }
  const next: ReviewDisposition = {
    kind,
    reason,
    ...(doc ? {doc} : {}),
    ...(options.owner ? {owner: true} : {}),
    decidedAfterRound: ledger.rounds.length,
  };
  let found = false;
  const rounds = ledger.rounds.map((round) => ({
    ...round,
    findings: round.findings.map((finding) => {
      if (finding.id !== findingId) return finding;
      found = true;
      if (
        kind === "accepted-as-limitation" &&
        (finding.priority === "P0" || finding.priority === "P1") &&
        !options.owner
      ) {
        throw new Error(
          `${findingId} is ${finding.priority}: accepted-as-limitation requires owner attribution`,
        );
      }
      if (!finding.disposition) return { ...finding, disposition: next };
      // Two dispositions may be superseded, and both sides always stay in the ledger
      // (hand-editing is forbidden): deferred-to-human parks a finding on the owner,
      // whose eventual decision needs a sanctioned way back in; accepted-as-limitation
      // may be reversed, but only by the owner converting it into a fix commitment,
      // which creates a fresh obligation the retired decision's results cannot satisfy.
      const supersedable =
        finding.disposition.kind === "deferred-to-human" ||
        (finding.disposition.kind === "accepted-as-limitation" && kind === "accepted" && options.owner === true);
      if (!supersedable) {
        if (finding.disposition.kind === "accepted-as-limitation") {
          throw new Error(
            `${findingId} is accepted-as-limitation — only an owner-attributed accepted disposition may supersede it`,
          );
        }
        throw new Error(`${findingId} already has a disposition`);
      }
      return {
        ...finding,
        history: [...(finding.history ?? []), finding.disposition],
        disposition: next,
      };
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

function renderDisposition(disposition: ReviewDisposition): string {
  const attribution = disposition.owner ? " (owner-attributed)" : "";
  const doc = disposition.doc ? ` (documented at: ${disposition.doc})` : "";
  return `**${disposition.kind}**${attribution} — ${disposition.reason}${doc}`;
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
  if (ledger.supersessions?.length) {
    lines.push("", "## Base supersessions");
    for (const supersession of ledger.supersessions) {
      lines.push(
        "",
        `- Base superseded after round ${supersession.afterRound}: was \`${supersession.baseSha.slice(0, 12)}\` (${supersession.baseRef}), archived ${supersession.archivedAt}`,
      );
    }
  }
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
      ...(round.stepBack
        ? [`- Step-back note: ${round.stepBack.path} (triggered by rounds ${round.stepBack.triggerRounds.join(", ")})`]
        : []),
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
        `- Disposition: ${finding.disposition ? renderDisposition(finding.disposition) : "pending"}`,
        ...(finding.history?.length
          ? [`- Superseded decisions: ${finding.history.map(renderDisposition).join("; ")}`]
          : []),
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
        lines.push("- Obligations: none");
      } else {
        for (const obligation of round.audit.obligations) {
          // Label from the persisted type; the status heuristic only covers legacy
          // results recorded before results carried their type.
          const type = obligation.type ?? (obligation.status === "documented" ? "documentation" : "remediation");
          const label = type === "documentation" ? "Documentation obligation" : "Remediation obligation";
          lines.push(`- ${label} ${obligation.findingId}: ${obligation.status} — ${obligation.evidence}`);
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
    (input.status === "fixed" ||
      input.status === "documented" ||
      input.status === "incomplete" ||
      input.status === "regressed") &&
    typeof input.evidence === "string" &&
    (input.type === undefined || input.type === "remediation" || input.type === "documentation") &&
    // A terminal status belongs to exactly one obligation type; a contradictory stamp
    // is malformation, not data.
    !(input.status === "fixed" && input.type === "documentation") &&
    !(input.status === "documented" && input.type === "remediation")
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
  obligations: ReviewObligation[] = [],
): { allowed: boolean; reason?: string } {
  for (const round of rounds) {
    for (const finding of round.findings) {
      if (!finding.disposition) return { allowed: false, reason: `${finding.id} has no disposition` };
    }
  }
  if (rounds.length >= limit) return { allowed: false, reason: `review round limit of ${limit} reached` };
  const latestRound = rounds.at(-1);
  // A clean latest round is terminal only when nothing is owed: an open obligation —
  // e.g. the fresh remediation obligation an owner reversal creates after a clean
  // confirmation round — still needs a round to classify it.
  if (latestRound && latestRound.findings.length === 0 && obligations.length === 0) {
    return { allowed: false, reason: "latest review round has no actionable findings" };
  }
  if (latestRound?.findings.some((finding) => finding.disposition === "deferred-to-human")) {
    return { allowed: false, reason: "latest review round has a finding deferred to the owner" };
  }
  // Accepting a finding is a commitment to fix it. Re-running at the same HEAD would
  // let a clean round certify the branch with the accepted defect still in the tree
  // (a fresh reviewer isn't guaranteed to re-find it) — the fix must be committed
  // first. Open remediation obligations extend the same rule to decisions recorded in
  // earlier rounds (an owner reversal); documentation obligations are exempt because
  // verifying an already-committed doc needs no new commit.
  if (
    currentHeadSha &&
    latestRound?.headSha === currentHeadSha &&
    (latestRound.findings.some((finding) => finding.disposition === "accepted") ||
      obligations.some((obligation) => obligation.type === "remediation"))
  ) {
    return {
      allowed: false,
      reason: "latest round has accepted findings — implement and commit them before the next round",
    };
  }
  return { allowed: true };
}
