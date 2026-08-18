import { describe, expect, test } from "bun:test";
import {
  addReviewRound,
  createReviewLedger,
  recordDisposition,
  recordReviewFailure,
  type Review,
  type ReviewRoundAudit,
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

  test("passes an all-waived round under the authorizing classes, fails closed without them", () => {
    const classes = [
      { name: "coordination-prose", match: ["OUTBOX.md"], waivablePriorities: ["P2", "P3"] as ("P2" | "P3")[] },
    ];
    let ledger = addReviewRound(
      createReviewLedger({ branch: "feature", baseRef: "master", baseSha: "base" }),
      {
        headSha: "current",
        model: "codex-default",
        reviewedAt: "2026-07-19T12:00:00Z",
        review: {
          summary: "wording nit",
          findings: [{ ...finding, priority: "P3", file: "OUTBOX.md" }],
        },
      },
    );
    ledger = recordDisposition(ledger, "R1-F1", "waived-by-policy", "Prose nit on a coordination queue", {
      waivedClass: "coordination-prose",
      classes,
    });

    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md", classes)).toMatchObject({
      kind: "passed",
      rounds: 1,
    });
    // Fail closed: the same ledger without the resolved classes blocks rather than passes.
    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md")).toMatchObject({
      kind: "blocked",
      reason: expect.stringContaining("R1-F1"),
    });
  });

  test("blocks a revoked waiver recorded in an earlier round, not just the latest one", () => {
    // Round 1 waives one finding and accepts another; round 2 confirms the fix and is
    // clean. The waiver is still the only thing holding R1-F1 closed, so revoking its
    // class has to block the certification even though the latest round has no findings.
    const classes = [
      { name: "coordination-prose", match: ["OUTBOX.md"], waivablePriorities: ["P3"] as "P3"[] },
    ];
    let ledger = addReviewRound(
      createReviewLedger({ branch: "feature", baseRef: "master", baseSha: "base" }),
      {
        headSha: "first",
        model: "codex-default",
        reviewedAt: "2026-08-18T12:00:00Z",
        review: {
          summary: "one nit, one defect",
          findings: [
            { ...finding, priority: "P3", file: "OUTBOX.md" },
            { ...finding, title: "Real defect", priority: "P1", file: "src/a.ts" },
          ],
        },
      },
    );
    ledger = recordDisposition(ledger, "R1-F1", "waived-by-policy", "Prose nit", {
      waivedClass: "coordination-prose",
      classes,
    });
    ledger = recordDisposition(ledger, "R1-F2", "accepted", "will fix");
    ledger = addReviewRound(ledger, {
      headSha: "current",
      model: "codex-default",
      reviewedAt: "2026-08-18T13:00:00Z",
      review: { summary: "fix confirmed", findings: [] },
      audit: {
        kind: "remediation",
        scope: "remediation-range",
        manifest: {
          baseSha: "first",
          headSha: "current",
          files: [{ path: "src/a.ts", hunks: ["-1,1 +1,2"] }],
          metadataFiles: [],
          instructionFiles: [],
          contextReferences: [],
          patchIds: [],
        },
        passes: [],
        obligations: [{ findingId: "R1-F2", status: "fixed", evidence: "verified", type: "remediation" }],
        metrics: {
          findingsByPass: { diff: 0, integration: 0, adversarial: 0 },
          findingsByPriority: { P0: 0, P1: 0, P2: 0, P3: 0 },
          findingsByOrigin: { original: 0, remediation: 0, "base-delta": 0, unknown: 0 },
          repeatedFindings: 0,
          lateHighPriorityFindings: 0,
          unchangedHeadDrift: false,
        },
      },
    });

    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md", classes)).toMatchObject({
      kind: "passed",
    });
    const narrowed = [
      { name: "coordination-prose", match: ["INBOX.md"], waivablePriorities: ["P3"] as "P3"[] },
    ];
    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md", narrowed)).toMatchObject({
      kind: "blocked",
      reason: expect.stringContaining("waiver on R1-F1 is not authorized"),
    });
  });

  test("blocks a waiver the resolved classes no longer authorize", () => {
    const recordingClasses = [
      { name: "coordination-prose", match: ["OUTBOX.md"], waivablePriorities: ["P3"] as "P3"[] },
    ];
    let ledger = addReviewRound(
      createReviewLedger({ branch: "feature", baseRef: "master", baseSha: "base" }),
      {
        headSha: "current",
        model: "codex-default",
        reviewedAt: "2026-07-19T12:00:00Z",
        review: { summary: "wording nit", findings: [{ ...finding, priority: "P3", file: "OUTBOX.md" }] },
      },
    );
    ledger = recordDisposition(ledger, "R1-F1", "waived-by-policy", "Prose nit", {
      waivedClass: "coordination-prose",
      classes: recordingClasses,
    });
    const narrowed = [{ name: "coordination-prose", match: ["INBOX.md"], waivablePriorities: ["P3"] as "P3"[] }];

    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md", narrowed)).toMatchObject({
      kind: "blocked",
      reason: expect.stringContaining("does not match OUTBOX.md"),
    });
  });

  test("passes a round mixing a valid waiver with a tracked-elsewhere concession", () => {
    const classes = [{ name: "coordination-prose", match: ["OUTBOX.md"], waivablePriorities: ["P3"] as "P3"[] }];
    let ledger = addReviewRound(
      createReviewLedger({ branch: "feature", baseRef: "master", baseSha: "base" }),
      {
        headSha: "current",
        model: "codex-default",
        reviewedAt: "2026-07-19T12:00:00Z",
        review: {
          summary: "one nit, one cross-repo gap",
          findings: [{ ...finding, priority: "P3", file: "OUTBOX.md" }, finding],
        },
      },
    );
    ledger = recordDisposition(ledger, "R1-F1", "waived-by-policy", "Prose nit", {
      waivedClass: "coordination-prose",
      classes,
    });
    ledger = recordDisposition(ledger, "R1-F2", "tracked-elsewhere", "Fix lands with the data-repo half", {
      tracks: "companion-item-slug",
    });

    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md", classes)).toMatchObject({
      kind: "passed",
      rounds: 1,
    });
    // tracked-elsewhere needs no classes config; only the waiver does.
    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md")).toMatchObject({ kind: "blocked" });
  });

  test("keeps blocking a mixed round whose other finding is not waived", () => {
    const classes = [{ name: "coordination-prose", match: ["OUTBOX.md"], waivablePriorities: ["P3"] as "P3"[] }];
    let ledger = addReviewRound(
      createReviewLedger({ branch: "feature", baseRef: "master", baseSha: "base" }),
      {
        headSha: "current",
        model: "codex-default",
        reviewedAt: "2026-07-19T12:00:00Z",
        review: {
          summary: "one nit, one bug",
          findings: [{ ...finding, priority: "P3", file: "OUTBOX.md" }, finding],
        },
      },
    );
    ledger = recordDisposition(ledger, "R1-F1", "waived-by-policy", "Prose nit", {
      waivedClass: "coordination-prose",
      classes,
    });
    ledger = recordDisposition(ledger, "R1-F2", "accepted", "Real defect");

    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md", classes)).toMatchObject({
      kind: "blocked",
      reason: expect.stringContaining("findings"),
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

  test("blocks a clean current-HEAD round once an owner reversal reopens an obligation", () => {
    const documentedAudit: ReviewRoundAudit = {
      kind: "remediation",
      manifest: {
        baseSha: "base",
        headSha: "current",
        files: [],
        metadataFiles: [],
        metadataPaths: [],
        remediationFiles: [],
        baseDeltaFiles: [],
        instructionFiles: [],
        contextReferences: [],
        patchIds: [],
      },
      passes: [],
      obligations: [{findingId: "R1-F1", status: "documented", evidence: "limitation documented"}],
      metrics: {
        findingsByPass: {diff: 0, integration: 0, adversarial: 0},
        findingsByPriority: {P0: 0, P1: 0, P2: 0, P3: 0},
        findingsByOrigin: {original: 0, remediation: 0, "base-delta": 0, unknown: 0},
        repeatedFindings: 0,
        lateHighPriorityFindings: 0,
        unchangedHeadDrift: false,
      },
    };
    let ledger = addReviewRound(
      createReviewLedger({ branch: "feature", baseRef: "master", baseSha: "base" }),
      {
        headSha: "current",
        model: "codex-default",
        reviewedAt: "2026-08-14T12:00:00Z",
        review: { summary: "one issue", findings: [{ ...finding, priority: "P2" as const }] },
      },
    );
    ledger = recordDisposition(ledger, "R1-F1", "accepted-as-limitation", "below the bar", {
      doc: "docs/limits.md",
    });
    ledger = addReviewRound(ledger, {
      headSha: "current",
      model: "codex-default",
      reviewedAt: "2026-08-14T12:05:00Z",
      review: cleanReview,
      audit: documentedAudit,
    });
    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md").kind).toBe("passed");

    ledger = recordDisposition(ledger, "R1-F1", "accepted", "owner ruled: fix it", {owner: true});
    expect(evaluateReviewStatus(ledger, "current", ".reviews/feature.md")).toEqual({
      kind: "blocked",
      headSha: "current",
      ledgerPath: ".reviews/feature.md",
      reason: "review has 1 open obligation; run another round to classify it",
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
