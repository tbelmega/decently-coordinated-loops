import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ReviewLedger } from "./review-ledger.ts";

export interface ReviewEvidencePaths {
  jsonPath: string;
  markdownPath: string;
}

export function reviewEvidencePaths(repository: string, branch: string): ReviewEvidencePaths {
  const reviewDirectory = join(repository, ".reviews");
  const slug = branch.replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
  const branchHash = createHash("sha256").update(branch).digest("hex").slice(0, 10);
  const filename = `${slug}--${branchHash}`;
  return {
    jsonPath: join(reviewDirectory, `${filename}.json`),
    markdownPath: join(reviewDirectory, `${filename}.md`),
  };
}

interface ReviewStatusBase {
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
    const noun = latestRound.findings.length === 1 ? "finding" : "findings";
    return {
      kind: "blocked",
      headSha: currentHeadSha,
      ledgerPath,
      reason: `latest review has ${latestRound.findings.length} ${noun}; run another round to obtain a clean review`,
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
      `model=${JSON.stringify(status.model)}`,
      `rounds=${status.rounds}`,
      `head=${status.headSha}`,
      `ledger=${status.ledgerPath}`,
    ].join(" ");
  }
  return [
    `REVIEW_STATUS=${status.kind}`,
    `head=${status.headSha}`,
    `ledger=${status.ledgerPath}`,
    `reason=${JSON.stringify(status.reason)}`,
  ].join(" ");
}
