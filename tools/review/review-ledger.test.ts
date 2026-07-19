import { describe, expect, test } from "bun:test";
import {
  addReviewRound,
  createReviewLedger,
  parseReview,
  priorDispositionNotes,
  recordDisposition,
  renderReviewLedger,
  reviewCanContinue,
  type Review,
} from "./review-ledger.ts";

const finding = {
  priority: "P1" as const,
  title: "off-by-one",
  file: "src/x.ts",
  line: 12,
  evidence: "loop uses <=",
  impact: "reads past the end",
  direction: "use <",
  confidence: "high" as const,
};

const review: Review = { summary: "one issue", findings: [finding] };

describe("parseReview", () => {
  test("accepts a well-formed review and a null-anchored finding", () => {
    const parsed = parseReview({
      summary: "ok",
      findings: [{ ...finding, file: null, line: null }],
    });
    expect(parsed.findings[0].file).toBeUndefined();
    expect(parsed.findings[0].line).toBeUndefined();
  });

  test("rejects a bad priority and a missing required field", () => {
    expect(() => parseReview({ summary: "x", findings: [{ ...finding, priority: "P9" }] })).toThrow(/priority/);
    const { evidence, ...withoutEvidence } = finding;
    expect(() => parseReview({ summary: "x", findings: [withoutEvidence] })).toThrow(/evidence/);
  });
});

describe("addReviewRound", () => {
  test("assigns per-round finding ids R<round>-F<n>", () => {
    let ledger = createReviewLedger({ branch: "feature", baseRef: "master", baseSha: "b0" });
    ledger = addReviewRound(ledger, { headSha: "h1", model: "m", reviewedAt: "t1", review });
    ledger = addReviewRound(ledger, { headSha: "h2", model: "m", reviewedAt: "t2", review });
    expect(ledger.rounds[0].findings[0].id).toBe("R1-F1");
    expect(ledger.rounds[1].findings[0].id).toBe("R2-F1");
  });
});

describe("recordDisposition", () => {
  const seed = addReviewRound(createReviewLedger({ branch: "f", baseRef: "master", baseSha: "b" }), {
    headSha: "h",
    model: "m",
    reviewedAt: "t",
    review,
  });

  test("records a disposition, then rejects a duplicate and an unknown id", () => {
    const disposed = recordDisposition(seed, "R1-F1", "accepted", "will fix");
    expect(disposed.rounds[0].findings[0].disposition).toEqual({ kind: "accepted", reason: "will fix" });
    expect(() => recordDisposition(disposed, "R1-F1", "rejected", "no")).toThrow(/already has a disposition/);
    expect(() => recordDisposition(seed, "R9-F9", "accepted", "x")).toThrow(/not found/);
  });

  test("rejects an empty reason", () => {
    expect(() => recordDisposition(seed, "R1-F1", "accepted", "")).toThrow(/reason/);
  });

  test("allows superseding only a deferred-to-human disposition", () => {
    const deferred = recordDisposition(seed, "R1-F1", "deferred-to-human", "owner call needed");
    const resolved = recordDisposition(deferred, "R1-F1", "rejected", "owner: not reproducible");
    expect(resolved.rounds[0].findings[0].disposition).toEqual({
      kind: "rejected",
      reason: "owner: not reproducible",
    });
    expect(() => recordDisposition(resolved, "R1-F1", "accepted", "changed my mind")).toThrow(
      /already has a disposition/,
    );
  });
});

describe("priorDispositionNotes", () => {
  test("lists rejected and deferred findings but omits accepted and pending ones", () => {
    const secondFinding = { ...finding, title: "unused import" };
    const thirdFinding = { ...finding, title: "flaky retry" };
    let ledger = addReviewRound(createReviewLedger({ branch: "f", baseRef: "master", baseSha: "b" }), {
      headSha: "h",
      model: "m",
      reviewedAt: "t",
      review: { summary: "three issues", findings: [finding, secondFinding, thirdFinding] },
    });
    ledger = recordDisposition(ledger, "R1-F1", "rejected", "not reproducible");
    ledger = recordDisposition(ledger, "R1-F2", "accepted", "will fix");
    ledger = recordDisposition(ledger, "R1-F3", "deferred-to-human", "owner call");

    expect(priorDispositionNotes(ledger)).toEqual([
      'R1-F1 "off-by-one" — rejected: not reproducible',
      'R1-F3 "flaky retry" — deferred-to-human: owner call',
    ]);
  });
});

describe("reviewCanContinue", () => {
  test("blocks while any finding is undisposed", () => {
    expect(reviewCanContinue([{ findings: [{ id: "R1-F1" }] }]).allowed).toBe(false);
  });

  test("stops at the round-cap", () => {
    const rounds = [1, 2, 3].map(() => ({ findings: [{ id: "x", disposition: "accepted" as const }] }));
    expect(reviewCanContinue(rounds).reason).toMatch(/round limit/);
  });

  test("stops when the latest round found nothing", () => {
    expect(reviewCanContinue([{ findings: [] }]).reason).toMatch(/no actionable findings/);
  });

  test("allows a clean confirmation round after all findings are rejected", () => {
    const rounds = [{ findings: [{ id: "R1-F1", disposition: "rejected" as const }] }];
    expect(reviewCanContinue(rounds).allowed).toBe(true);
  });

  test("stops when a finding is deferred to the owner", () => {
    const rounds = [{ findings: [{ id: "R1-F1", disposition: "deferred-to-human" as const }] }];
    expect(reviewCanContinue(rounds).reason).toMatch(/deferred/);
  });

  test("refuses another round at an unchanged HEAD after an accepted finding", () => {
    const rounds = [{ headSha: "same", findings: [{ id: "R1-F1", disposition: "accepted" as const }] }];
    expect(reviewCanContinue(rounds, 3, "same").reason).toMatch(/implement and commit/);
    expect(reviewCanContinue(rounds, 3, "fixed").allowed).toBe(true);
  });

  test("allows another round when the latest has an accepted finding to act on", () => {
    const rounds = [{ findings: [{ id: "R1-F1", disposition: "accepted" as const }] }];
    expect(reviewCanContinue(rounds).allowed).toBe(true);
  });
});

describe("renderReviewLedger", () => {
  test("renders finding id, disposition, and an incomplete-attempt note", () => {
    let ledger = addReviewRound(createReviewLedger({ branch: "f", baseRef: "master", baseSha: "abc123" }), {
      headSha: "deadbeef",
      model: "m",
      reviewedAt: "t",
      review,
    });
    ledger = recordDisposition(ledger, "R1-F1", "accepted", "fixing");
    ledger = { ...ledger, failures: [{ headSha: "cafe", model: "m", attemptedAt: "t0", reason: "timeout" }] };
    const md = renderReviewLedger(ledger);
    expect(md).toContain("### R1-F1");
    expect(md).toContain("**accepted** — fixing");
    expect(md).toContain("Incomplete attempts");
    expect(md).toContain("timeout");
  });
});
