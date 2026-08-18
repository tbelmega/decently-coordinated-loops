import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ReviewClassConfig } from "../config.ts";
import { waiverRefusalReason } from "./review-classes.ts";
import { liveRounds, openObligations, type ReviewLedger } from "./review-ledger.ts";

export interface ReviewEvidencePaths {
  jsonPath: string;
  markdownPath: string;
}

export function reviewEvidencePaths(repository: string, branch: string, item?: string): ReviewEvidencePaths {
  const reviewDirectory = join(repository, ".reviews");
  const slug = branch.replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
  const branchHash = createHash("sha256").update(branch).digest("hex").slice(0, 10);
  const itemSuffix = item
    ? `--item-${item.replaceAll(/[^a-zA-Z0-9._-]+/g, "-")}--${createHash("sha256").update(item).digest("hex").slice(0, 10)}`
    : "";
  const filename = `${slug}--${branchHash}${itemSuffix}`;
  return {
    jsonPath: join(reviewDirectory, `${filename}.json`),
    markdownPath: join(reviewDirectory, `${filename}.md`),
  };
}

interface ReviewStatusBase {
  item?: string;
  headSha: string;
  ledgerPath: string;
}

export interface PassedReviewStatus extends ReviewStatusBase {
  kind: "passed";
  model: string;
  rounds: number;
}

export interface IncompleteReviewStatus extends ReviewStatusBase {
  kind: "blocked" | "not_run";
  reason: string;
}

export type ReviewStatus = PassedReviewStatus | IncompleteReviewStatus;

export function evaluateReviewStatus(
  ledger: ReviewLedger,
  currentHeadSha: string,
  ledgerPath: string,
  classes?: ReviewClassConfig[],
): ReviewStatus {
  const latestRound = ledger.rounds.at(-1);
  const latestFailure = ledger.failures?.at(-1);
  if (
    latestFailure?.headSha === currentHeadSha &&
    (!latestRound || latestFailure.attemptedAt >= latestRound.reviewedAt)
  ) {
    return {
      kind: "blocked",
      headSha: currentHeadSha,
      ledgerPath,
      reason: `latest review attempt failed: ${latestFailure.reason}`,
    };
  }
  if (!latestRound) {
    return {
      kind: "not_run",
      headSha: currentHeadSha,
      ledgerPath,
      reason: "review ledger has no completed rounds",
    };
  }
  if (latestRound.headSha !== currentHeadSha) {
    return {
      kind: "blocked",
      headSha: currentHeadSha,
      ledgerPath,
      reason: `latest review covers ${latestRound.headSha}, not current HEAD ${currentHeadSha}`,
    };
  }
  if (latestRound.findings.length > 0) {
    if (latestRound.findings.some((finding) => finding.disposition?.kind === "deferred-to-human")) {
      return {
        kind: "blocked",
        headSha: currentHeadSha,
        ledgerPath,
        reason: "latest review has a finding deferred to the owner",
      };
    }
    const nonBlocking = latestRound.findings.filter(
      (finding) =>
        finding.disposition?.kind === "waived-by-policy" || finding.disposition?.kind === "tracked-elsewhere",
    );
    if (nonBlocking.length < latestRound.findings.length) {
      const noun = latestRound.findings.length === 1 ? "finding" : "findings";
      return {
        kind: "blocked",
        headSha: currentHeadSha,
        ledgerPath,
        reason: `latest review has ${latestRound.findings.length} ${noun}; run another round to obtain a clean review`,
      };
    }
  }
  // A policy waiver is pre-authorized by the owner's classes config and owes no
  // confirming round, so it never comes back for re-examination on its own. Its
  // authorization therefore binds against the RESOLVED classes at THIS gate, not against
  // the record - and across every live round, not just the last one. A waiver recorded in
  // round 1 is still holding a defect open when round 2 certifies the branch, so
  // narrowing or removing its class has to block that certification too.
  for (const round of liveRounds(ledger)) {
    for (const finding of round.findings) {
      if (finding.disposition?.kind !== "waived-by-policy") continue;
      const refusal = waiverRefusalReason(
        {...(finding.file ? {file: finding.file} : {}), priority: finding.priority},
        finding.disposition.class ?? "",
        classes,
      );
      if (refusal) {
        return {
          kind: "blocked",
          headSha: currentHeadSha,
          ledgerPath,
          reason: `waiver on ${finding.id} is not authorized: ${refusal}`,
        };
      }
    }
  }
  // A clean round certifies nothing while an obligation is still open: an owner
  // reversal of a documented limitation reopens a defect without adding a round, so
  // the pre-reversal clean round must not keep reporting passed.
  const open = openObligations(ledger);
  if (open.length > 0) {
    return {
      kind: "blocked",
      headSha: currentHeadSha,
      ledgerPath,
      reason: `review has ${open.length} open ${open.length === 1 ? "obligation" : "obligations"}; run another round to classify ${open.length === 1 ? "it" : "them"}`,
    };
  }
  return {
    kind: "passed",
    headSha: currentHeadSha,
    ledgerPath,
    model: latestRound.model,
    rounds: ledger.rounds.length,
  };
}

export function renderReviewStatus(status: ReviewStatus): string {
  if (status.kind === "passed") {
    return [
      "REVIEW_STATUS=passed",
      ...(status.item ? [`item=${JSON.stringify(status.item)}`] : []),
      `model=${JSON.stringify(status.model)}`,
      `rounds=${status.rounds}`,
      `head=${status.headSha}`,
      `ledger=${status.ledgerPath}`,
    ].join(" ");
  }
  return [
    `REVIEW_STATUS=${status.kind}`,
    ...(status.item ? [`item=${JSON.stringify(status.item)}`] : []),
    `head=${status.headSha}`,
    `ledger=${status.ledgerPath}`,
    `reason=${JSON.stringify(status.reason)}`,
  ].join(" ");
}
