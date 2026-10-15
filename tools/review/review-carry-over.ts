import type {ReviewLedger} from "./review-ledger.ts";

/** An implementer's attestation that HEAD moved past a passed review without changing
 * reviewed behavior (a rebase, an ignore file, metadata). The reason is the
 * implementer's judgment; deltaFiles is computed by the CLI, never claimed.
 *
 * Invariants:
 * 1. A carry-over is recorded only while the latest round's HEAD itself evaluates to passed.
 * 2. Every carry-over is measured against the latest round's HEAD: deltaFiles is the
 *    cumulative difference from the reviewed net patch, so a second move needs no link
 *    to the first and there is no chain to keep intact.
 * 3. Only the newest carry-over recorded since the latest round can cover a HEAD, and only
 *    the HEAD it names; any other HEAD is blocked until it is carried over or reviewed.
 * 4. Any review attempt that failed after the latest round voids every carry-over until
 *    a new round, whichever HEAD it failed at: an attempt means the move was not trusted
 *    as trivial, and a failure count cannot be laundered by a later one elsewhere.
 * 5. A newer round supersedes all earlier carry-overs.
 * 6. A carried status is the reviewed HEAD's passed status, never stronger, and always
 *    reports that the move was not independently reviewed.
 *
 * An earlier design linked carry-overs into a chain and voided only chains with a failure
 * at a linked HEAD; deciding which failures and links counted produced a defect per
 * review round, so the chain was removed in favor of invariants 2 and 4. */
export interface ReviewCarryOver {
  /** The latest round's HEAD, whose review had passed when this was recorded. */
  reviewedHeadSha: string;
  headSha: string;
  /** Files whose net patch differs from the reviewed net patch; empty for a pure rebase. */
  deltaFiles: string[];
  reason: string;
  recordedAt: string;
}

export function parseCarryOvers(value: unknown): ReviewCarryOver[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("carryOvers must be an array");
  return value.map((entry: unknown): ReviewCarryOver => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("carry-over must be an object");
    const input = entry as Record<string, unknown>;
    const sha = (field: string): string => {
      const result = input[field];
      if (typeof result !== "string" || !/^[a-f0-9]{40}$/.test(result)) throw new Error(`invalid carry-over ${field}`);
      return result;
    };
    if (!Array.isArray(input.deltaFiles) || !input.deltaFiles.every((path) => typeof path === "string" && path.length > 0)) {
      throw new Error("invalid carry-over deltaFiles");
    }
    if (typeof input.reason !== "string" || !input.reason.trim()) throw new Error("invalid carry-over reason");
    if (typeof input.recordedAt !== "string" || !Number.isFinite(Date.parse(input.recordedAt))) {
      throw new Error("invalid carry-over recordedAt");
    }
    return {reviewedHeadSha: sha("reviewedHeadSha"), headSha: sha("headSha"), deltaFiles: [...input.deltaFiles] as string[],
      reason: input.reason, recordedAt: input.recordedAt};
  });
}

/** The carry-over that lets a passed review at the latest round cover `headSha`, if any. */
export function activeCarryOver(ledger: ReviewLedger, headSha: string): ReviewCarryOver | undefined {
  const latestRound = ledger.rounds.at(-1);
  if (!latestRound || failedSinceLatestRound(ledger)) return undefined;
  const roundTime = Date.parse(latestRound.reviewedAt);
  const newest = (ledger.carryOvers ?? []).filter((entry) =>
    entry.reviewedHeadSha === latestRound.headSha && Date.parse(entry.recordedAt) >= roundTime).at(-1);
  return newest?.headSha === headSha ? newest : undefined;
}

/** Whether any review attempt failed after the latest round, which voids carry-overs. */
export function failedSinceLatestRound(ledger: ReviewLedger): boolean {
  const latestRound = ledger.rounds.at(-1);
  if (!latestRound) return false;
  const roundTime = Date.parse(latestRound.reviewedAt);
  return (ledger.failures ?? []).some((failure) => Date.parse(failure.attemptedAt) >= roundTime);
}

export function renderCarryOvers(entries: ReviewCarryOver[]): string[] {
  return entries.flatMap((entry) => ["", `## Carry-over - ${entry.headSha}`, "",
    `- Recorded: ${entry.recordedAt}`, `- Carried from reviewed HEAD: ${entry.reviewedHeadSha}`,
    `- Independently reviewed: false`,
    `- Delta files: ${entry.deltaFiles.length ? entry.deltaFiles.join(", ") : "none (patch-equivalent)"}`,
    `- Reason (implementer attestation): ${entry.reason}`]);
}
