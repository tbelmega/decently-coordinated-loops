import { describe, expect, test } from "bun:test";
import {
  addReviewRound,
  createReviewLedger,
  recordDisposition,
  recordReviewFailure,
  type Review,
} from "./review-ledger.ts";
import { evaluateReviewStatus, renderReviewStatus } from "./review-status.ts";

const finding = {
  priority: "P1" as const,
  title: "off-by-one",
  evidence: "loop uses <=",
  impact: "reads past the end",
  direction: "use <",
  confidence: "high" as const,
};

const reviewWithFinding: Review = { summary: "one issue", findings: [finding] };
const cleanReview: Review = { summary: "clean", findings: [] };

describe("evaluateReviewStatus", () => {
  test("passes only when a clean review covers the current HEAD", () => {
    const ledger = addReviewRound(
      createReviewLedger({ branch: "feature", baseRef: "master", baseSha: "base" }),
      { headSha: "current", model: "codex-default", reviewedAt: "2026-07-19T12:00:00Z", review: cleanReview },
    );

    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md")).toEqual({
      kind: "passed",
      headSha: "current",
      ledgerPath: ".reviews/feature.md",
      model: "codex-default",
      rounds: 1,
    });
  });

  test("blocks when the clean review is stale", () => {
    const ledger = addReviewRound(
      createReviewLedger({ branch: "feature", baseRef: "master", baseSha: "base" }),
      { headSha: "reviewed", model: "codex-default", reviewedAt: "2026-07-19T12:00:00Z", review: cleanReview },
    );

    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md")).toEqual({
      kind: "blocked",
      headSha: "current",
      ledgerPath: ".reviews/feature.md",
      reason: "latest review covers reviewed, not current HEAD current",
    });
  });

  test("blocks when the current-HEAD round still has findings", () => {
    let ledger = addReviewRound(
      createReviewLedger({ branch: "feature", baseRef: "master", baseSha: "base" }),
      {
        headSha: "current",
        model: "codex-default",
        reviewedAt: "2026-07-19T12:00:00Z",
        review: reviewWithFinding,
      },
    );
    ledger = recordDisposition(ledger, "R1-F1", "rejected", "not reproducible");

    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md")).toEqual({
      kind: "blocked",
      headSha: "current",
      ledgerPath: ".reviews/feature.md",
      reason: "latest review has 1 finding; run another round to obtain a clean review",
    });
  });

  test("blocks for owner action when a finding is deferred", () => {
    let ledger = addReviewRound(
      createReviewLedger({ branch: "feature", baseRef: "master", baseSha: "base" }),
      {
        headSha: "current",
        model: "codex-default",
        reviewedAt: "2026-07-19T12:00:00Z",
        review: reviewWithFinding,
      },
    );
    ledger = recordDisposition(ledger, "R1-F1", "deferred-to-human", "owner decision required");

    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md")).toEqual({
      kind: "blocked",
      headSha: "current",
      ledgerPath: ".reviews/feature.md",
      reason: "latest review has a finding deferred to the owner",
    });
  });

  test("reports not-run when no review round exists", () => {
    const ledger = createReviewLedger({ branch: "feature", baseRef: "master", baseSha: "base" });

    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md")).toEqual({
      kind: "not_run",
      headSha: "current",
      ledgerPath: ".reviews/feature.md",
      reason: "review ledger has no completed rounds",
    });
  });

  test("blocks when the latest current-HEAD review attempt failed", () => {
    const ledger = recordReviewFailure(
      createReviewLedger({ branch: "feature", baseRef: "master", baseSha: "base" }),
      {
        headSha: "current",
        model: "codex-default",
        attemptedAt: "2026-07-19T12:00:00Z",
        reason: "reviewer timed out",
      },
    );

    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md")).toEqual({
      kind: "blocked",
      headSha: "current",
      ledgerPath: ".reviews/feature.md",
      reason: "latest review attempt failed: reviewer timed out",
    });
  });

  test("passes when a clean round supersedes an earlier failure", () => {
    let ledger = recordReviewFailure(
      createReviewLedger({ branch: "feature", baseRef: "master", baseSha: "base" }),
      {
        headSha: "current",
        model: "codex-default",
        attemptedAt: "2026-07-19T12:00:00Z",
        reason: "reviewer timed out",
      },
    );
    ledger = addReviewRound(ledger, {
      headSha: "current",
      model: "codex-default",
      reviewedAt: "2026-07-19T12:05:00Z",
      review: cleanReview,
    });

    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md").kind).toBe("passed");
  });
});

describe("renderReviewStatus", () => {
  test("renders a copyable passed receipt", () => {
    expect(
      renderReviewStatus({
        kind: "passed",
        headSha: "abcdef123456",
        ledgerPath: ".reviews/feature.md",
        model: "codex (default)",
        rounds: 2,
      }),
    ).toBe(
      'REVIEW_STATUS=passed model="codex (default)" rounds=2 head=abcdef123456 ledger=.reviews/feature.md',
    );
  });

  test("renders a quoted failure reason", () => {
    expect(
      renderReviewStatus({
        kind: "blocked",
        headSha: "abcdef123456",
        ledgerPath: ".reviews/feature.md",
        reason: "latest review has findings",
      }),
    ).toBe(
      'REVIEW_STATUS=blocked head=abcdef123456 ledger=.reviews/feature.md reason="latest review has findings"',
    );
  });
});
