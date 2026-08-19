// The review ledger: the validated, append-only record of review rounds and the
// agent's per-finding dispositions. The JSON ledger is machine state; the Markdown
// render is the human surface. Model-agnostic — a reviewer adapter (reviewers.ts)
// produces a Review; everything here is pure.

import type {ReviewAuditPass, ReviewClassConfig} from "../config.ts";
import type {
  FindingOrigin,
  ReviewCoverage,
  ReviewMetrics,
  ReviewObligationResult,
} from "./review-audit.ts";
import {waiverRefusalReason} from "./review-classes.ts";
import type {ReviewManifest} from "./review-manifest.ts";

export const priorities = ["P0", "P1", "P2", "P3"] as const;
export const confidenceLevels = ["high", "medium", "low"] as const;
export const dispositionKinds = [
  "accepted",
  "rejected",
  "already-addressed",
  "deferred-to-human",
  "accepted-as-limitation",
  "waived-by-policy",
  "tracked-elsewhere",
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
  /** Every obligation this finding answers, primary first. Several accepted findings can
   * describe one defect, and a single follow-up keeps all of them actionable; the audit
   * record has to say which, so this is persisted rather than derived. */
  obligationIds?: string[];
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
  /** The change class authorizing this waiver (waived-by-policy only). Authorization is
   * re-validated against the RESOLVED config at every consuming gate, so a narrowed
   * class blocks a previously recorded waiver rather than the record certifying it. */
  class?: string;
  /** Where the fix lands (tracked-elsewhere only): a board item slug, or a
   * `repo#branch`/path pointer. The finding is conceded correct; its fix cannot land
   * inside this repository's reviewed range because the counterpart lands separately.
   * No pointer, no disposition. */
  tracks?: string;
  /** The prior finding id whose terminal decision this one repeats. Set only by the
   * automatic carry for an exact identity repeat of a terminally dispositioned
   * finding; a carried decision creates no new obligation (the original decision's
   * obligation still governs) and may be superseded by any fresh disposition. */
  carriedFrom?: string;
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
  /** "remediation-range": the round ran under scoped confirmation
   * (`review.confirmation: "scoped"`), so the reviewer saw the remediation range alone
   * and only the obligation-classifying pass. Absent means the round covered the whole
   * `manifest.baseSha..headSha` range with every configured pass. Recorded because the
   * narrower round is exactly the one whose clean result proves less. */
  scope?: "remediation-range";
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
  /** The policy authority this review's class waivers are bound to, recorded when the
   * ledger is created and never rewritten afterwards. Absent on a ledger opened without
   * a data repo, and a waiver on such a ledger blocks - it is never backfilled, because
   * a binding a later run can supply is not a binding. */
  authority?: ReviewAuthority;
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

/** Which configuration may authorize a `waived-by-policy` disposition on this review.
 * Both halves are needed: the root alone still lets a later `projects.*.repo` edit select
 * a different project's classes - or drop the entry and fall through to a broader global
 * block - for a review that started under a narrower policy. */
export interface ReviewAuthority {
  /** Canonical root of the data repository whose loops.json governs this review. */
  dataRepo: string;
  /** The registered project whose review block was resolved at the first round. Absent
   * when the reviewed checkout matched no project, which means the global block governs
   * and must keep governing. */
  project?: string;
  /** Canonical root that project's `repo` pointed at when the review started. A
   * registered name is not an identity - `projects.<name>.repo` can be repointed at
   * another checkout while keeping the name - so the name alone would let a review be
   * governed by a policy that has since become somebody else's. */
  projectRepo?: string;
}

export interface CreateLedgerInput {
  item?: string;
  authority?: ReviewAuthority;
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

/** The three documented shapes a `tracked-elsewhere` pointer may take: a board item
 * slug, `repo#branch`, or a repository-relative path. Returns the normalized pointer or
 * throws.
 *
 * Shape-checked rather than merely non-blank because `tracked-elsewhere` is terminal and
 * creates no obligation: the pointer is the ONLY thing standing between a conceded,
 * actionable finding and no record of where its fix lands. A shape check cannot prove
 * the target exists - it is another repository's business, which is the whole point of
 * the kind - but it does reject prose, which is the failure this guards. */
/** The branch half of a `repo#branch` pointer, checked against a conservative WHITELIST
 * rather than against git's rejection rules.
 *
 * The property that has to hold is "anything we accept, git accepts" - not "we reject
 * everything git rejects". Three review rounds spent themselves on the second reading,
 * each finding one more thing the blacklist missed (`***`, then the ASCII control range
 * and DEL, then `.lock` on a non-final component), because a blacklist of another
 * program's grammar has an unbounded tail. Every component matching
 * `[A-Za-z0-9_][A-Za-z0-9._-]*` with no component ending in `.lock` is strictly narrower
 * than `git check-ref-format --branch`, so the first property holds by construction.
 *
 * It refuses some branch names git would take. That is the right trade for a pointer
 * field: a destination this cannot spell can be given as a path or a board-item slug.
 * See docs/design/review-policy-authority.md. */
function isRefNameShaped(branch: string): boolean {
  // Separators only BETWEEN alphanumeric runs. That shape forbids a leading dot, a
  // trailing dot and consecutive dots by construction rather than by three more
  // blacklist entries - which is the mistake the first attempt at this whitelist made,
  // by writing a character class permissive enough to accept `foo.` and `foo..bar`.
  const component = /^[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*$/;
  return (
    branch.length > 0 &&
    branch.split("/").every((part) => component.test(part) && !part.endsWith(".lock"))
  );
}

export function validateTracksPointer(pointer: string): string {
  const trimmed = pointer.trim();
  const slug = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
  const invalid = (): never => {
    throw new Error(
      `tracks must be a board item slug, "repo#branch", or a repository-relative path: ${JSON.stringify(pointer)}`,
    );
  };
  if (trimmed.length === 0 || /\s/.test(trimmed)) invalid();
  if (trimmed.includes("#")) {
    const [repository, ...rest] = trimmed.split("#");
    const branch = rest.join("#");
    if (rest.length !== 1 || !slug.test(repository) || !isRefNameShaped(branch)) invalid();
    return trimmed;
  }
  if (trimmed.includes("/")) return validateEvidencePath(trimmed);
  if (!slug.test(trimmed)) invalid();
  return trimmed;
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
  const waivedClass = optionalString(input, "class", path);
  const tracks = optionalString(input, "tracks", path);
  const carriedFrom = optionalString(input, "carriedFrom", path);
  return {
    kind,
    reason: requiredString(input, "reason", path),
    ...(doc ? {doc} : {}),
    ...(waivedClass ? {class: waivedClass} : {}),
    ...(tracks ? {tracks} : {}),
    ...(carriedFrom ? {carriedFrom} : {}),
    ...(input.owner === true ? {owner: true} : {}),
    ...(typeof decidedAfterRound === "number" ? {decidedAfterRound} : {}),
  };
}

/** The kinds an exact identity repeat may automatically carry forward: terminal and
 * non-remediation. `accepted` never carries (a re-raised accepted defect is a
 * regression signal) and `deferred-to-human` never carries (only the owner closes it). */
export const carryableDispositionKinds: readonly DispositionKind[] = [
  "rejected",
  "accepted-as-limitation",
  "waived-by-policy",
  "tracked-elsewhere",
];

/** Invariant 5: a persisted decision honors the recording rules even when the ledger
 * arrived from disk — a malformed ledger must fail closed, not certify silently. */
function assertDecisionInvariants(
  decision: ReviewDisposition,
  finding: Pick<Finding, "priority" | "file">,
  path: string,
): void {
  const priority = finding.priority;
  if (decision.kind === "accepted-as-limitation") {
    if (!decision.doc) {
      throw new Error(`${path} is accepted-as-limitation and must carry a doc path`);
    }
    // No legacy writer existed for this kind, so a missing round stamp is
    // malformation — the legacy fallback must never apply to it.
    if (decision.decidedAfterRound === undefined) {
      throw new Error(`${path} is accepted-as-limitation and must carry decidedAfterRound`);
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
  if (decision.kind === "waived-by-policy") {
    // Structural half of the waiver contract; authorization against the resolved
    // classes binds at each consuming gate, not at parse (a config edit must block a
    // stale waiver, not make the ledger unreadable).
    if (!decision.class) {
      throw new Error(`${path} is waived-by-policy and must name its authorizing class`);
    }
    if (!finding.file) {
      throw new Error(`${path} is waived-by-policy but its finding has no file anchor`);
    }
    // No legacy writer existed for this kind either.
    if (decision.decidedAfterRound === undefined) {
      throw new Error(`${path} is waived-by-policy and must carry decidedAfterRound`);
    }
  } else if (decision.class) {
    throw new Error(`${path}.class is only valid on a waived-by-policy disposition`);
  }
  if (decision.kind === "tracked-elsewhere") {
    if (!decision.tracks) {
      throw new Error(`${path} is tracked-elsewhere and must carry a tracks pointer naming where the fix lands`);
    }
    if (decision.tracks !== validateTracksPointer(decision.tracks)) {
      throw new Error(`${path}.tracks must be a normalized pointer`);
    }
    // No legacy writer existed for this kind.
    if (decision.decidedAfterRound === undefined) {
      throw new Error(`${path} is tracked-elsewhere and must carry decidedAfterRound`);
    }
  } else if (decision.tracks) {
    throw new Error(`${path}.tracks is only valid on a tracked-elsewhere disposition`);
  }
  if (decision.carriedFrom !== undefined && !carryableDispositionKinds.includes(decision.kind)) {
    throw new Error(
      `${path}.carriedFrom is only valid on a carried terminal disposition (${carryableDispositionKinds.join(", ")})`,
    );
  }
}

function parseStepBack(input: unknown, path: string, roundNumber: number): ReviewStepBack | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new Error(`${path} must be an object`);
  const notePath = requiredString(input, "path", path);
  if (notePath !== validateEvidencePath(notePath)) {
    throw new Error(`${path}.path must be a normalized repository-relative path`);
  }
  const triggerRounds = input.triggerRounds;
  if (
    !Array.isArray(triggerRounds) ||
    triggerRounds.length !== 2 ||
    triggerRounds.some((value) => typeof value !== "number" || !Number.isInteger(value) || value < 1)
  ) {
    throw new Error(`${path}.triggerRounds must be two positive round numbers`);
  }
  // The tripwire only ever arms from the two rounds immediately preceding the round
  // the note opens, so any other persisted pair cannot be the recorded evidence.
  if (roundNumber < 3 || triggerRounds[0] !== roundNumber - 2 || triggerRounds[1] !== roundNumber - 1) {
    throw new Error(
      `${path}.triggerRounds must be the two rounds immediately preceding round ${roundNumber}`,
    );
  }
  return {
    path: notePath,
    triggerRounds: [triggerRounds[0], triggerRounds[1]],
  };
}

function parseAuthority(input: unknown): ReviewAuthority | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new Error("review ledger authority must be an object");
  const dataRepo = requiredString(input, "dataRepo", "review ledger authority");
  const project = optionalString(input, "project", "review ledger authority");
  const projectRepo = optionalString(input, "projectRepo", "review ledger authority");
  if (projectRepo && !project) {
    throw new Error("review ledger authority records a projectRepo without a project");
  }
  return {dataRepo, ...(project ? {project} : {}), ...(projectRepo ? {projectRepo} : {})};
}

export function parseReviewLedger(input: unknown): ReviewLedger {
  if (!isRecord(input)) throw new Error("review ledger must be an object");
  if (input.version !== 1) throw new Error("review ledger version must be 1");
  const authority = parseAuthority(input.authority);
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
        assertDecisionInvariants(disposition, finding, `${findingPath}.disposition`);
      }
      if (findingInput.history !== undefined && !Array.isArray(findingInput.history)) {
        throw new Error(`${findingPath}.history must be an array when present`);
      }
      const history = Array.isArray(findingInput.history)
        ? findingInput.history.map((entry, historyIndex) => {
            const historyPath = `${findingPath}.history[${historyIndex}]`;
            const parsed = parseDisposition(entry, historyPath);
            if (!parsed) throw new Error(`${historyPath} must be an object`);
            assertDecisionInvariants(parsed, finding, historyPath);
            return parsed;
          })
        : undefined;
      if (history?.length && !disposition) {
        throw new Error(`${findingPath}.history requires a live disposition to have superseded it`);
      }
      // The recorder permits exactly two supersessions; a persisted chain claiming any
      // other transition is malformed, not merely unusual.
      const decisions = [...(history ?? []), ...(disposition ? [disposition] : [])];
      // Supersession chains post-date the legacy era too: every member was recorded by
      // a stamping recorder, so an omitted stamp anywhere in a chain is malformation
      // that would otherwise re-open the legacy ordering fallback.
      if (decisions.length > 1) {
        for (const [decisionIndex, decision] of decisions.entries()) {
          if (decision.decidedAfterRound === undefined) {
            throw new Error(
              `${findingPath} decision ${decisionIndex} belongs to a supersession chain and must carry decidedAfterRound`,
            );
          }
        }
      }
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
          // An automatically carried decision is an override target by design: the
          // fresh hand-written disposition supersedes it, both sides staying in the
          // audit record.
          predecessor.carriedFrom !== undefined ||
          (predecessor.kind === "accepted-as-limitation" &&
            successor.kind === "accepted" &&
            successor.owner === true);
        if (!permitted) {
          throw new Error(
            `${findingPath} has an unsupported disposition supersession: ${predecessor.kind} may only be superseded by ${predecessor.kind === "accepted-as-limitation" ? "an owner-attributed accepted disposition" : "nothing"}`,
          );
        }
      }
      // Provenance fields fail closed when present but invalid — a silently dropped
      // origin would disarm the remediation-churn tripwire. Only omission is legacy.
      if (findingInput.origin !== undefined && !isFindingOrigin(findingInput.origin)) {
        throw new Error(`${findingPath}.origin is invalid`);
      }
      if (findingInput.passes !== undefined && !isReviewAuditPassArray(findingInput.passes)) {
        throw new Error(`${findingPath}.passes is invalid`);
      }
      if (
        findingInput.firstSeenRound !== undefined &&
        (typeof findingInput.firstSeenRound !== "number" ||
          !Number.isInteger(findingInput.firstSeenRound) ||
          findingInput.firstSeenRound < 1)
      ) {
        throw new Error(`${findingPath}.firstSeenRound must be a positive integer when present`);
      }
      if (findingInput.repeatedFrom !== undefined && !isStringArray(findingInput.repeatedFrom)) {
        throw new Error(`${findingPath}.repeatedFrom must be an array of strings when present`);
      }
      if (findingInput.obligationIds !== undefined && !isStringArray(findingInput.obligationIds)) {
        throw new Error(`${findingPath}.obligationIds must be an array of strings when present`);
      }
      return {
        ...finding,
        id: requiredString(findingInput, "id", findingPath),
        ...(isFindingOrigin(findingInput.origin) ? {origin: findingInput.origin} : {}),
        ...(isReviewAuditPassArray(findingInput.passes) ? {passes: findingInput.passes} : {}),
        ...(optionalString(findingInput, "identity", findingPath)
          ? {identity: String(findingInput.identity)}
          : {}),
        ...(typeof findingInput.firstSeenRound === "number" ? {firstSeenRound: findingInput.firstSeenRound} : {}),
        ...(optionalString(findingInput, "obligationId", findingPath)
          ? {obligationId: String(findingInput.obligationId)}
          : {}),
        ...(isStringArray(findingInput.obligationIds) ? {obligationIds: findingInput.obligationIds} : {}),
        ...(isStringArray(findingInput.repeatedFrom) ? {repeatedFrom: findingInput.repeatedFrom} : {}),
        ...(disposition ? { disposition } : {}),
        ...(history?.length ? {history} : {}),
      };
    });
    const number = roundInput.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number !== roundIndex + 1) {
      throw new Error(`${path}.number must be ${roundIndex + 1}`);
    }
    const stepBack = parseStepBack(roundInput.stepBack, `${path}.stepBack`, roundIndex + 1);
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
  // A step-back record claims its trigger pair armed the tripwire; the referenced
  // rounds' own findings are in this ledger, so an untriggered claim is detectable
  // malformation, not trusted history.
  for (const round of rounds) {
    if (!round.stepBack) continue;
    const [older, newer] = round.stepBack.triggerRounds.map((number) => rounds[number - 1]);
    if (!isRemediationDominated(older) || !isRemediationDominated(newer)) {
      throw new Error(
        `rounds[${round.number - 1}].stepBack references trigger rounds that are not both remediation-dominated`,
      );
    }
  }
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
    ...(authority ? { authority } : {}),
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
//      count, monotonic along the chain, and MANDATORY for decisions no legacy writer
//      could have produced - a limitation, or any member of a supersession chain)
//      hold for live decisions and history alike. A persisted step-back record must
//      reference the immediately preceding round pair and that pair must actually
//      satisfy the tripwire predicate.
//   6. Base supersession resets round mechanics only; decisions, obligations, and
//      tripwire state carry forward by construction.
//   7. Each persisted result carries its obligation type; a result whose status
//      contradicts its stamped type is malformation, and a documented result must
//      always carry its type (no legacy writer existed for that status).
//
// Trust boundary (accepted-as-limitation, 2026-08-14; also the step-back analysis for
// the tripwire the containment spec's own review rounds 2 and 3 armed):
// The persisted ledger is trusted machine state. The operating contract forbids
// hand-editing it, and every write goes through this module's recorder functions. The
// parser therefore fails closed on MALFORMATION - shape violations, contradictory
// status/type stamps, out-of-window or non-monotonic decision stamps, unsupported
// supersession chains, invalid evidence paths, impossible step-back trigger pairs -
// but it does NOT authenticate history against a well-formed forgery. An editor able
// to produce semantically consistent JSON can equally delete findings, rewrite
// reasons, or drop whole rounds, and no self-contained mutable file can prove its own
// past. Catching an in-window re-stamp of decidedAfterRound (spec-review findings
// R3-F1/F2/F3/F5) would require an append-only, externally anchored decision journal,
// a redesign whose cost exceeds this component's assurance bar. Decision: remove that
// invariant family from the parser's obligations by this documented boundary rather
// than continue patching guards; this covers the in-window residue of remediation
// obligations R2-F3 and R2-F4, whose window and monotonicity validation is
// implemented above.
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
      // A carried decision creates no new obligation: the original decision on the
      // finding it repeats still owns the obligation (and its terminal result).
      if (decision.carriedFrom) return [];
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
function isRemediationDominated(round: Pick<ReviewRound, "findings">): boolean {
  const remediationCount = round.findings.filter((finding) => finding.origin === "remediation").length;
  return round.findings.length > 0 && remediationCount * 2 > round.findings.length;
}

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
  /** The class name authorizing a waived-by-policy disposition. */
  waivedClass?: string;
  /** The pointer to where the fix lands (tracked-elsewhere only). */
  tracks?: string;
  /** The RESOLVED review classes (loops.json, after per-project merge). Required for
   * waived-by-policy: recording a waiver without the config context fails closed. */
  classes?: ReviewClassConfig[];
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
  if (options.waivedClass !== undefined && kind !== "waived-by-policy") {
    throw new Error("a class is only valid on a waived-by-policy disposition");
  }
  let doc: string | undefined;
  if (kind === "accepted-as-limitation") {
    if (!options.doc) {
      throw new Error("accepted-as-limitation requires a doc path naming where the limitation is documented");
    }
    doc = validateEvidencePath(options.doc);
  }
  if (kind === "waived-by-policy" && !options.waivedClass) {
    throw new Error("waived-by-policy requires the authorizing class name");
  }
  if (options.tracks !== undefined && kind !== "tracked-elsewhere") {
    throw new Error("a tracks pointer is only valid on a tracked-elsewhere disposition");
  }
  let tracks: string | undefined;
  if (kind === "tracked-elsewhere") {
    if (!options.tracks?.trim()) {
      throw new Error("tracked-elsewhere requires a tracks pointer naming where the fix lands");
    }
    tracks = validateTracksPointer(options.tracks);
  }
  const next: ReviewDisposition = {
    kind,
    reason,
    ...(doc ? {doc} : {}),
    ...(kind === "waived-by-policy" && options.waivedClass ? {class: options.waivedClass} : {}),
    ...(tracks ? {tracks} : {}),
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
      if (kind === "waived-by-policy" && options.waivedClass) {
        const refusal = waiverRefusalReason(
          {...(finding.file ? {file: finding.file} : {}), priority: finding.priority},
          options.waivedClass,
          options.classes,
        );
        if (refusal) throw new Error(`${findingId} cannot be waived: ${refusal}`);
      }
      if (!finding.disposition) return { ...finding, disposition: next };
      // Two dispositions may be superseded, and both sides always stay in the ledger
      // (hand-editing is forbidden): deferred-to-human parks a finding on the owner,
      // whose eventual decision needs a sanctioned way back in; accepted-as-limitation
      // may be reversed, but only by the owner converting it into a fix commitment,
      // which creates a fresh obligation the retired decision's results cannot satisfy.
      const supersedable =
        finding.disposition.kind === "deferred-to-human" ||
        finding.disposition.carriedFrom !== undefined ||
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

/** Applies disposition auto-carry to the LATEST round: a finding that exactly repeats
 * (same audit identity, via repeatedFrom) a prior finding whose live decision is
 * terminal and non-remediation gets that decision applied automatically, marked
 * `carriedFrom`. The carried copy creates no new obligation, counts in the terminal
 * predicate as its kind, and may be overridden by any fresh disposition. Carrying only
 * happens when the MOST RECENT prior occurrence's decision is carryable — a repeat of
 * an accepted or deferred finding stays undispositioned and blocks as today. */
export function carryForwardDispositions(ledger: ReviewLedger): ReviewLedger {
  const latest = ledger.rounds.at(-1);
  if (!latest) return ledger;
  const priorFindingsById = new Map<string, LedgerFinding>();
  for (const round of ledger.rounds.slice(0, -1)) {
    for (const finding of round.findings) priorFindingsById.set(finding.id, finding);
  }
  let carriedAny = false;
  const findings = latest.findings.map((finding) => {
    if (finding.disposition || !finding.repeatedFrom?.length) return finding;
    const mostRecentPriorId = finding.repeatedFrom.at(-1) as string;
    const prior = priorFindingsById.get(mostRecentPriorId);
    const decision = prior?.disposition;
    if (!prior || !decision || !carryableDispositionKinds.includes(decision.kind)) return finding;
    carriedAny = true;
    return {
      ...finding,
      disposition: {
        ...decision,
        carriedFrom: prior.id,
        decidedAfterRound: ledger.rounds.length,
      },
    };
  });
  if (!carriedAny) return ledger;
  return {
    ...ledger,
    rounds: [...ledger.rounds.slice(0, -1), {...latest, findings}],
  };
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
  const waivedClass = disposition.class ? ` (class: ${disposition.class})` : "";
  const tracks = disposition.tracks ? ` (tracked at: ${disposition.tracks})` : "";
  return `**${disposition.kind}**${attribution}${waivedClass}${tracks} — ${disposition.reason}${doc}`;
}

export function renderReviewLedger(ledger: ReviewLedger): string {
  const lines = [
    "# Local review",
    "",
    ...(ledger.item ? [`- Item: \`${ledger.item}\``] : []),
    `- Branch: \`${ledger.branch}\``,
    `- Base ref: \`${ledger.baseRef}\``,
    `- Base SHA: \`${ledger.baseSha}\``,
    // The authority any policy waiver in this ledger is bound to, on the human surface
    // so the owner can see which policy authorized it without reading the JSON.
    ...(ledger.authority
      ? [
          `- Policy authority: \`${ledger.authority.dataRepo}\`` +
            (ledger.authority.project
              ? ` (project \`${ledger.authority.project}\`` +
                (ledger.authority.projectRepo ? ` at \`${ledger.authority.projectRepo}\`)` : ")")
              : " (global block)"),
        ]
      : []),
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
        ...(finding.obligationId
          ? [`- Remediation obligation: ${(finding.obligationIds ?? [finding.obligationId]).join(", ")}`]
          : []),
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
        ...(round.audit.scope === "remediation-range"
          ? ["- Scope: remediation range only (scoped confirmation); the range outside the fix was not re-reviewed this round"]
          : []),
        `- Passes: ${round.audit.passes.map((pass) => pass.pass).join(", ")}`,
        `- Coverage: complete for ${round.audit.manifest.files.length} reviewable files, ${round.audit.manifest.files.reduce((count, file) => count + file.hunks.length, 0)} hunks, and ${round.audit.manifest.instructionFiles.length} instruction files`,
        ...(round.audit.manifest.instructionFilesUnderRevision?.length
          ? [`- Instruction files under revision (declared change surface): ${round.audit.manifest.instructionFilesUnderRevision.join(", ")}`]
          : []),
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

/** The persisted governance authorization: it is rendered to the owner as the authority
 * that was suspended for a range, so a list naming a non-instruction file or repeating
 * one is a false record. Each round validates its own fresh declaration; this keeps a
 * hand-edited or truncated ledger from reading as one that was validated. */
function isUnderRevisionSubset(underRevision: unknown, instructionFiles: readonly string[]): boolean {
  if (underRevision === undefined) return true;
  if (!isStringArray(underRevision)) return false;
  return (
    new Set(underRevision).size === underRevision.length &&
    underRevision.every((path) => instructionFiles.includes(path))
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
    isUnderRevisionSubset(input.instructionFilesUnderRevision, input.instructionFiles) &&
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
    // is malformation, not data. `documented` post-dates the legacy era entirely, so
    // it must always carry its type.
    !(input.status === "fixed" && input.type === "documentation") &&
    !(input.status === "documented" && input.type !== "documentation")
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
    (input.scope === undefined || input.scope === "remediation-range") &&
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
