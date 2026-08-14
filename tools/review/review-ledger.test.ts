import { describe, expect, test } from "bun:test";
import {
  addReviewRound,
  createReviewLedger,
  liveRounds,
  openObligations,
  parseReview,
  parseReviewLedger,
  priorDispositionNotes,
  recordDisposition,
  remediationChurnTripwire,
  renderReviewLedger,
  reviewCanContinue,
  supersedeLedgerBase,
  validateEvidencePath,
  type Review,
} from "./review-ledger.ts";
import type {Finding, ReviewLedger, ReviewRoundAudit} from "./review-ledger.ts";
import type {ReviewObligationResult} from "./review-audit.ts";

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

  test("persists structured audit evidence while legacy rounds remain readable", () => {
    const audit: ReviewRoundAudit = {
      kind: "full",
      manifest: {
        baseSha: "b0",
        headSha: "h1",
        files: [{path: "src/x.ts", hunks: ["-1,1 +1,2"]}],
        metadataFiles: [],
        metadataPaths: [],
        remediationFiles: [],
        baseDeltaFiles: [],
        instructionFiles: ["AGENTS.md"],
        contextReferences: [],
        patchIds: ["patch"],
      },
      passes: [{
        pass: "diff",
        summary: "covered",
        coverage: {
          files: [{path: "src/x.ts", hunks: ["-1,1 +1,2"]}],
          instructionFiles: ["AGENTS.md"],
          callsites: [],
        },
      }],
      obligations: [],
      metrics: {
        findingsByPass: {diff: 1, integration: 0, adversarial: 0},
        findingsByPriority: {P0: 0, P1: 1, P2: 0, P3: 0},
        findingsByOrigin: {original: 1, remediation: 0, "base-delta": 0, unknown: 0},
        repeatedFindings: 0,
        lateHighPriorityFindings: 0,
        unchangedHeadDrift: false,
      },
    };
    const ledger = addReviewRound(
      createReviewLedger({branch: "feature", baseRef: "master", baseSha: "b0", patchIds: ["patch"]}),
      {headSha: "h1", model: "m", reviewedAt: "t1", review, audit},
    );
    const parsed = parseReviewLedger(JSON.parse(JSON.stringify(ledger)));
    expect(parsed.patchIds).toEqual(["patch"]);
    expect(parsed.rounds[0].audit).toEqual(audit);

    const legacy = parseReviewLedger({
      version: 1,
      branch: "legacy",
      baseRef: "master",
      baseSha: "base",
      rounds: [],
    });
    expect(legacy.patchIds).toBeUndefined();

    const earlyAudit = JSON.parse(JSON.stringify(ledger));
    delete earlyAudit.rounds[0].audit.manifest.metadataPaths;
    delete earlyAudit.rounds[0].audit.manifest.remediationFiles;
    delete earlyAudit.rounds[0].audit.manifest.baseDeltaFiles;
    expect(parseReviewLedger(earlyAudit).rounds[0].audit).toBeDefined();
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
    expect(disposed.rounds[0].findings[0].disposition).toEqual({ kind: "accepted", reason: "will fix", decidedAfterRound: 1 });
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
      decidedAfterRound: 1,
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

describe("openObligations — accepted findings", () => {
  test("retains accepted finding intent until a later audit verifies it fixed", () => {
    let ledger = addReviewRound(createReviewLedger({branch: "f", baseRef: "master", baseSha: "b"}), {
      headSha: "h1",
      model: "m",
      reviewedAt: "t1",
      review,
    });
    ledger = recordDisposition(ledger, "R1-F1", "accepted", "replace the boundary check");
    expect(openObligations(ledger)).toEqual([{
      findingId: "R1-F1",
      type: "remediation",
      title: "off-by-one",
      evidence: "loop uses <=",
      direction: "use <",
      dispositionReason: "replace the boundary check",
    }]);

    ledger = addReviewRound(ledger, {
      headSha: "h2",
      model: "m",
      reviewedAt: "t2",
      review: {summary: "fixed", findings: []},
      audit: {
        kind: "remediation",
        manifest: {
          baseSha: "b",
          headSha: "h2",
          files: [{path: "src/x.ts", hunks: []}],
          metadataFiles: [],
          metadataPaths: [],
          remediationFiles: [],
          baseDeltaFiles: [],
          instructionFiles: [],
          contextReferences: [],
          patchIds: [],
        },
        passes: [],
        obligations: [{findingId: "R1-F1", status: "fixed", evidence: "strict comparison"}],
        metrics: {
          findingsByPass: {diff: 0, integration: 0, adversarial: 0},
          findingsByPriority: {P0: 0, P1: 0, P2: 0, P3: 0},
          findingsByOrigin: {original: 0, remediation: 0, "base-delta": 0, unknown: 0},
          repeatedFindings: 0,
          lateHighPriorityFindings: 0,
          unchangedHeadDrift: false,
        },
      },
    });
    expect(openObligations(ledger)).toEqual([]);
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

  function obligationOf(type: "remediation" | "documentation") {
    return {
      findingId: "R1-F1#2",
      type,
      title: "off-by-one",
      evidence: "loop uses <=",
      direction: "use <",
      dispositionReason: "owner ruled: fix it",
    };
  }

  test("allows continuation after a clean round while an obligation is still open", () => {
    // The owner reversal of a limitation reopens work after a clean confirmation round:
    // without the obligation the clean round would dead-end the ledger.
    const rounds = [
      { headSha: "h1", findings: [{ id: "R1-F1", disposition: "accepted-as-limitation" as const }] },
      { headSha: "h2", findings: [] },
    ];
    expect(reviewCanContinue(rounds, 5, "h3", [obligationOf("remediation")]).allowed).toBe(true);
    expect(reviewCanContinue(rounds, 5, "h3").reason).toMatch(/no actionable findings/);
  });

  test("refuses an unchanged HEAD while a remediation obligation is open, but not a documentation one", () => {
    const rounds = [
      { headSha: "h1", findings: [{ id: "R1-F1", disposition: "accepted-as-limitation" as const }] },
      { headSha: "h2", findings: [] },
    ];
    expect(reviewCanContinue(rounds, 5, "h2", [obligationOf("remediation")]).reason).toMatch(
      /implement and commit/,
    );
    expect(reviewCanContinue(rounds, 5, "h2", [obligationOf("documentation")]).allowed).toBe(true);
  });
});

const p2Finding = { ...finding, priority: "P2" as const };

/** Minimal audit block carrying only what obligation-closure semantics read. */
function auditWith(obligations: ReviewObligationResult[]): ReviewRoundAudit {
  return {
    kind: "remediation",
    manifest: {
      baseSha: "b",
      headSha: "h",
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
    obligations,
    metrics: {
      findingsByPass: {diff: 0, integration: 0, adversarial: 0},
      findingsByPriority: {P0: 0, P1: 0, P2: 0, P3: 0},
      findingsByOrigin: {original: 0, remediation: 0, "base-delta": 0, unknown: 0},
      repeatedFindings: 0,
      lateHighPriorityFindings: 0,
      unchangedHeadDrift: false,
    },
  };
}

function seededLedger(seedFinding: Finding): ReviewLedger {
  return addReviewRound(createReviewLedger({ branch: "f", baseRef: "master", baseSha: "b" }), {
    headSha: "h1",
    model: "m",
    reviewedAt: "t1",
    review: { summary: "one issue", findings: [seedFinding] },
  });
}

describe("validateEvidencePath", () => {
  test("normalizes a repo-relative path and strips a leading ./", () => {
    expect(validateEvidencePath("docs/limits.md")).toBe("docs/limits.md");
    expect(validateEvidencePath("./docs/limits.md")).toBe("docs/limits.md");
  });

  test("rejects absolute, traversal, and empty forms", () => {
    expect(() => validateEvidencePath("/etc/passwd")).toThrow(/repository-relative/);
    expect(() => validateEvidencePath("../outside.md")).toThrow(/repository-relative/);
    expect(() => validateEvidencePath("docs/../../outside.md")).toThrow(/repository-relative/);
    expect(() => validateEvidencePath("")).toThrow(/repository-relative/);
  });
});

describe("recordDisposition — accepted-as-limitation", () => {
  test("requires a documentation path", () => {
    expect(() =>
      recordDisposition(seededLedger(p2Finding), "R1-F1", "accepted-as-limitation", "cost exceeds bar"),
    ).toThrow(/doc/);
  });

  test("records the doc path and rejects a doc path on any other kind", () => {
    const disposed = recordDisposition(
      seededLedger(p2Finding),
      "R1-F1",
      "accepted-as-limitation",
      "cost exceeds the documented bar",
      {doc: "./docs/limits.md"},
    );
    expect(disposed.rounds[0].findings[0].disposition).toEqual({
      kind: "accepted-as-limitation",
      reason: "cost exceeds the documented bar",
      doc: "docs/limits.md",
      decidedAfterRound: 1,
    });
    expect(() =>
      recordDisposition(seededLedger(p2Finding), "R1-F1", "accepted", "will fix", {doc: "docs/limits.md"}),
    ).toThrow(/doc/);
  });

  test("refuses a P0/P1 finding without owner attribution and accepts with it", () => {
    expect(() =>
      recordDisposition(seededLedger(finding), "R1-F1", "accepted-as-limitation", "too costly", {
        doc: "docs/limits.md",
      }),
    ).toThrow(/owner/);
    const disposed = recordDisposition(
      seededLedger(finding),
      "R1-F1",
      "accepted-as-limitation",
      "owner ruled 2026-08-14: below the assurance bar",
      {doc: "docs/limits.md", owner: true},
    );
    expect(disposed.rounds[0].findings[0].disposition?.owner).toBe(true);
  });

  test("is superseded only by an owner-attributed accepted decision, preserving both", () => {
    const limited = recordDisposition(
      seededLedger(p2Finding),
      "R1-F1",
      "accepted-as-limitation",
      "cost exceeds bar",
      {doc: "docs/limits.md"},
    );
    expect(() => recordDisposition(limited, "R1-F1", "accepted", "changed my mind")).toThrow(/owner/);
    expect(() => recordDisposition(limited, "R1-F1", "rejected", "owner: not real", {owner: true})).toThrow(
      /accepted/,
    );
    const reversed = recordDisposition(limited, "R1-F1", "accepted", "owner ruled: fix it", {owner: true});
    expect(reversed.rounds[0].findings[0].disposition).toEqual({
      kind: "accepted",
      reason: "owner ruled: fix it",
      owner: true,
      decidedAfterRound: 1,
    });
    expect(reversed.rounds[0].findings[0].history).toEqual([
      {kind: "accepted-as-limitation", reason: "cost exceeds bar", doc: "docs/limits.md", decidedAfterRound: 1},
    ]);
  });

  test("still supersedes deferred-to-human while preserving the parked decision", () => {
    const deferred = recordDisposition(seededLedger(p2Finding), "R1-F1", "deferred-to-human", "owner call");
    const resolved = recordDisposition(deferred, "R1-F1", "rejected", "owner: not reproducible");
    expect(resolved.rounds[0].findings[0].history).toEqual([
      {kind: "deferred-to-human", reason: "owner call", decidedAfterRound: 1},
    ]);
  });
});

describe("openObligations", () => {
  test("types remediation and documentation obligations and carries the doc path", () => {
    let ledger = seededLedger(p2Finding);
    ledger = {
      ...ledger,
      rounds: [
        ...ledger.rounds.map((round) => ({...round})),
      ],
    };
    ledger = addReviewRound(ledger, {
      headSha: "h2",
      model: "m",
      reviewedAt: "t2",
      review: {summary: "second", findings: [{...p2Finding, title: "missing doc"}]},
    });
    ledger = recordDisposition(ledger, "R1-F1", "accepted", "fix the boundary");
    ledger = recordDisposition(ledger, "R2-F1", "accepted-as-limitation", "below the bar", {
      doc: "docs/limits.md",
    });
    expect(openObligations(ledger)).toEqual([
      {
        findingId: "R1-F1",
        type: "remediation",
        title: "off-by-one",
        evidence: "loop uses <=",
        direction: "use <",
        dispositionReason: "fix the boundary",
      },
      {
        findingId: "R2-F1",
        type: "documentation",
        title: "missing doc",
        evidence: "loop uses <=",
        direction: "use <",
        dispositionReason: "below the bar",
        doc: "docs/limits.md",
      },
    ]);
  });

  test("closes a remediation obligation on fixed and a documentation obligation on documented", () => {
    let ledger = seededLedger(p2Finding);
    ledger = recordDisposition(ledger, "R1-F1", "accepted-as-limitation", "below the bar", {
      doc: "docs/limits.md",
    });
    ledger = addReviewRound(ledger, {
      headSha: "h2",
      model: "m",
      reviewedAt: "t2",
      review: {summary: "clean", findings: []},
      audit: auditWith([{findingId: "R1-F1", status: "documented", evidence: "limitation documented"}]),
    });
    expect(openObligations(ledger)).toEqual([]);
  });

  test("does not let a fixed result close a documentation obligation", () => {
    let ledger = seededLedger(p2Finding);
    ledger = recordDisposition(ledger, "R1-F1", "accepted-as-limitation", "below the bar", {
      doc: "docs/limits.md",
    });
    ledger = addReviewRound(ledger, {
      headSha: "h2",
      model: "m",
      reviewedAt: "t2",
      review: {summary: "clean", findings: []},
      audit: auditWith([{findingId: "R1-F1", status: "fixed", evidence: "wrong terminal"}]),
    });
    expect(openObligations(ledger)).toHaveLength(1);
  });

  test("the owner reversal creates a fresh qualified obligation no retired result can satisfy", () => {
    let ledger = seededLedger(p2Finding);
    ledger = recordDisposition(ledger, "R1-F1", "accepted-as-limitation", "below the bar", {
      doc: "docs/limits.md",
    });
    ledger = addReviewRound(ledger, {
      headSha: "h2",
      model: "m",
      reviewedAt: "t2",
      review: {summary: "clean", findings: []},
      audit: auditWith([
        {findingId: "R1-F1", status: "documented", evidence: "limitation documented"},
        {findingId: "R1-F1", status: "fixed", evidence: "stale result under the retired decision"},
      ]),
    });
    ledger = recordDisposition(ledger, "R1-F1", "accepted", "owner ruled: fix it", {owner: true});
    expect(openObligations(ledger)).toEqual([
      {
        findingId: "R1-F1#2",
        type: "remediation",
        title: "off-by-one",
        evidence: "loop uses <=",
        direction: "use <",
        dispositionReason: "owner ruled: fix it",
      },
    ]);
    const confirmed = addReviewRound(ledger, {
      headSha: "h3",
      model: "m",
      reviewedAt: "t3",
      review: {summary: "clean", findings: []},
      audit: auditWith([{findingId: "R1-F1#2", status: "fixed", evidence: "boundary rewritten"}]),
    });
    expect(openObligations(confirmed)).toEqual([]);
  });
});

describe("openObligations — result ordering", () => {
  test("a terminal result recorded before its decision cannot close the obligation", () => {
    // Legacy shape: the old validator accepted unsolicited results, so a round can
    // carry a terminal result for a finding whose obligation a LATER decision creates.
    let ledger = seededLedger(p2Finding);
    ledger = {
      ...ledger,
      rounds: [{...ledger.rounds[0], audit: auditWith([{findingId: "R1-F1", status: "fixed", evidence: "unsolicited"}])}],
    };
    ledger = recordDisposition(ledger, "R1-F1", "accepted", "will fix");
    expect(openObligations(ledger)).toHaveLength(1);
  });

  test("stamps the deciding round on a new disposition so only later results close it", () => {
    let ledger = seededLedger(p2Finding);
    ledger = recordDisposition(ledger, "R1-F1", "accepted", "will fix");
    expect(ledger.rounds[0].findings[0].disposition?.decidedAfterRound).toBe(1);
    ledger = addReviewRound(ledger, {
      headSha: "h2",
      model: "m",
      reviewedAt: "t2",
      review: {summary: "clean", findings: []},
      audit: auditWith([{findingId: "R1-F1", status: "fixed", evidence: "verified"}]),
    });
    expect(openObligations(ledger)).toEqual([]);
  });
});

describe("parseReviewLedger — decision ordering and result types", () => {
  test("rejects a decision stamped before its finding's round or beyond the round count", () => {
    const precedesFinding = JSON.parse(
      JSON.stringify(recordDisposition(seededLedger(p2Finding), "R1-F1", "accepted", "will fix")),
    );
    precedesFinding.rounds[0].findings[0].disposition.decidedAfterRound = 0;
    expect(() => parseReviewLedger(precedesFinding)).toThrow(/decidedAfterRound/);

    const beyondRounds = JSON.parse(
      JSON.stringify(recordDisposition(seededLedger(p2Finding), "R1-F1", "accepted", "will fix")),
    );
    beyondRounds.rounds[0].findings[0].disposition.decidedAfterRound = 5;
    expect(() => parseReviewLedger(beyondRounds)).toThrow(/decidedAfterRound/);
  });

  test("rejects a supersession chain whose round stamps run backwards", () => {
    let ledger = seededLedger(p2Finding);
    ledger = recordDisposition(ledger, "R1-F1", "accepted-as-limitation", "below the bar", {
      doc: "docs/limits.md",
    });
    ledger = addReviewRound(ledger, {
      headSha: "h2",
      model: "m",
      reviewedAt: "t2",
      review: {summary: "clean", findings: []},
    });
    ledger = recordDisposition(ledger, "R1-F1", "accepted", "owner ruled: fix it", {owner: true});
    const forged = JSON.parse(JSON.stringify(ledger));
    forged.rounds[0].findings[0].history[0].decidedAfterRound = 2;
    forged.rounds[0].findings[0].disposition.decidedAfterRound = 1;
    expect(() => parseReviewLedger(forged)).toThrow(/decidedAfterRound/);
  });

  test("fails closed on a result whose status contradicts its stamped type", () => {
    let ledger = seededLedger(p2Finding);
    ledger = recordDisposition(ledger, "R1-F1", "accepted-as-limitation", "below the bar", {
      doc: "docs/limits.md",
    });
    ledger = addReviewRound(ledger, {
      headSha: "h2",
      model: "m",
      reviewedAt: "t2",
      review: {summary: "clean", findings: []},
      audit: auditWith([
        {findingId: "R1-F1", status: "documented", evidence: "forged", type: "remediation"},
      ]),
    });
    // In memory the malformed result must not close the documentation obligation; a
    // persisted ledger carrying it must fail closed at parse rather than silently
    // dropping the round's audit evidence on the next rewrite.
    expect(openObligations(ledger)).toHaveLength(1);
    expect(() => parseReviewLedger(JSON.parse(JSON.stringify(ledger)))).toThrow(/audit/);
  });

  test("throws on a present-but-invalid audit instead of dropping it", () => {
    const ledger = JSON.parse(JSON.stringify(seededLedger(p2Finding)));
    ledger.rounds[0].audit = {kind: "full"};
    expect(() => parseReviewLedger(ledger)).toThrow(/audit/);
  });

  function threeRoundsWithStepBack(
    stepBack: {path: string; triggerRounds: [number, number]},
    dominated = true,
  ): unknown {
    const churn = {...p2Finding, origin: "remediation" as const};
    let ledger = createReviewLedger({branch: "f", baseRef: "master", baseSha: "b"});
    for (const roundNumber of [1, 2]) {
      ledger = addReviewRound(ledger, {
        headSha: `h${roundNumber}`,
        model: "m",
        reviewedAt: `t${roundNumber}`,
        review: {summary: `r${roundNumber}`, findings: [dominated ? churn : p2Finding]},
      });
      ledger = recordDisposition(ledger, `R${roundNumber}-F1`, "rejected", "not reproducible");
    }
    ledger = addReviewRound(ledger, {headSha: "h3", model: "m", reviewedAt: "t3", review: {summary: "r3", findings: []}, stepBack});
    return JSON.parse(JSON.stringify(ledger));
  }

  test("rejects persisted step-back evidence with a bad path or a wrong trigger pair", () => {
    expect(() =>
      parseReviewLedger(threeRoundsWithStepBack({path: "../outside.md", triggerRounds: [1, 2]})),
    ).toThrow(/repository-relative/);
    expect(() =>
      parseReviewLedger(threeRoundsWithStepBack({path: "docs/step-back.md", triggerRounds: [1, 3]})),
    ).toThrow(/trigger/);
    const valid = parseReviewLedger(threeRoundsWithStepBack({path: "docs/step-back.md", triggerRounds: [1, 2]}));
    expect(valid.rounds[2].stepBack).toEqual({path: "docs/step-back.md", triggerRounds: [1, 2]});
  });

  test("rejects a persisted step-back whose trigger pair is not remediation-dominated", () => {
    expect(() =>
      parseReviewLedger(threeRoundsWithStepBack({path: "docs/step-back.md", triggerRounds: [1, 2]}, false)),
    ).toThrow(/dominated/);
  });

  test("requires the round stamp on decisions that cannot be legacy data", () => {
    const limitationWithoutStamp = JSON.parse(
      JSON.stringify(
        recordDisposition(seededLedger(p2Finding), "R1-F1", "accepted-as-limitation", "below the bar", {
          doc: "docs/limits.md",
        }),
      ),
    );
    delete limitationWithoutStamp.rounds[0].findings[0].disposition.decidedAfterRound;
    expect(() => parseReviewLedger(limitationWithoutStamp)).toThrow(/decidedAfterRound/);

    const reversalWithoutStamp = JSON.parse(
      JSON.stringify(
        recordDisposition(
          recordDisposition(seededLedger(p2Finding), "R1-F1", "accepted-as-limitation", "below the bar", {
            doc: "docs/limits.md",
          }),
          "R1-F1",
          "accepted",
          "owner ruled: fix it",
          {owner: true},
        ),
      ),
    );
    delete reversalWithoutStamp.rounds[0].findings[0].disposition.decidedAfterRound;
    expect(() => parseReviewLedger(reversalWithoutStamp)).toThrow(/decidedAfterRound/);
  });

  test("rejects present-but-invalid finding provenance instead of dropping it", () => {
    // A corrupted origin would silently disarm the tripwire; the same silent-drop
    // pattern covered passes, firstSeenRound, and repeatedFrom.
    function withField(field: string, value: unknown): unknown {
      const ledger = JSON.parse(JSON.stringify(seededLedger(p2Finding)));
      ledger.rounds[0].findings[0][field] = value;
      return ledger;
    }
    expect(() => parseReviewLedger(withField("origin", "corrupt"))).toThrow(/origin/);
    expect(() => parseReviewLedger(withField("passes", ["nonsense"]))).toThrow(/passes/);
    expect(() => parseReviewLedger(withField("firstSeenRound", "one"))).toThrow(/firstSeenRound/);
    expect(() => parseReviewLedger(withField("repeatedFrom", [42]))).toThrow(/repeatedFrom/);
  });

  test("rejects a documented result that omits its obligation type", () => {
    let ledger = seededLedger(p2Finding);
    ledger = recordDisposition(ledger, "R1-F1", "accepted-as-limitation", "below the bar", {
      doc: "docs/limits.md",
    });
    ledger = addReviewRound(ledger, {
      headSha: "h2",
      model: "m",
      reviewedAt: "t2",
      review: {summary: "clean", findings: []},
      audit: auditWith([{findingId: "R1-F1", status: "documented", evidence: "covered"}]),
    });
    expect(() => parseReviewLedger(JSON.parse(JSON.stringify(ledger)))).toThrow(/audit/);
  });
});

describe("parseReviewLedger — supersession sequence", () => {
  test("rejects a persisted reversal that lacks owner attribution", () => {
    const reversed = JSON.parse(
      JSON.stringify(
        recordDisposition(
          recordDisposition(seededLedger(p2Finding), "R1-F1", "accepted-as-limitation", "below the bar", {
            doc: "docs/limits.md",
          }),
          "R1-F1",
          "accepted",
          "owner ruled: fix it",
          {owner: true},
        ),
      ),
    );
    delete reversed.rounds[0].findings[0].disposition.owner;
    expect(() => parseReviewLedger(reversed)).toThrow(/owner/);
  });

  test("rejects an unsupported history transition and history without a live decision", () => {
    const rejectedThenAccepted = JSON.parse(
      JSON.stringify(recordDisposition(seededLedger(p2Finding), "R1-F1", "accepted", "will fix")),
    );
    rejectedThenAccepted.rounds[0].findings[0].history = [{kind: "rejected", reason: "not real"}];
    expect(() => parseReviewLedger(rejectedThenAccepted)).toThrow(/supersession|superseded/);

    const orphanHistory = JSON.parse(JSON.stringify(seededLedger(p2Finding)));
    orphanHistory.rounds[0].findings[0].history = [{kind: "deferred-to-human", reason: "owner call"}];
    expect(() => parseReviewLedger(orphanHistory)).toThrow(/history/);
  });
});

describe("remediationChurnTripwire", () => {
  function roundOf(origins: ("original" | "remediation")[], number: number): Review {
    return {
      summary: `round ${number}`,
      findings: origins.map((origin, index) => ({
        ...p2Finding,
        title: `finding ${number}-${index}`,
        origin,
      })),
    };
  }

  function ledgerOf(...rounds: Review[]): ReviewLedger {
    let ledger = createReviewLedger({branch: "f", baseRef: "master", baseSha: "b"});
    for (const [index, review] of rounds.entries()) {
      ledger = addReviewRound(ledger, {headSha: `h${index + 1}`, model: "m", reviewedAt: `t${index + 1}`, review});
    }
    return ledger;
  }

  test("arms when the last two completed rounds are both strictly majority remediation", () => {
    const state = remediationChurnTripwire(
      ledgerOf(
        roundOf(["original"], 1),
        roundOf(["remediation", "remediation", "original"], 2),
        roundOf(["remediation"], 3),
      ),
    );
    expect(state.armed).toBe(true);
    if (state.armed) {
      expect(state.rounds.map((round) => round.number)).toEqual([2, 3]);
      expect(state.rounds.map((round) => round.remediationCount)).toEqual([2, 1]);
      expect(state.rounds.map((round) => round.findingCount)).toEqual([3, 1]);
    }
  });

  test("stays disarmed when only one of the last two rounds is dominated", () => {
    expect(
      remediationChurnTripwire(
        ledgerOf(roundOf(["remediation"], 1), roundOf(["original", "remediation"], 2)),
      ).armed,
    ).toBe(false);
  });

  test("stays disarmed when the dominated rounds are not the two most recent", () => {
    expect(
      remediationChurnTripwire(
        ledgerOf(roundOf(["remediation"], 1), roundOf(["remediation"], 2), roundOf(["original"], 3)),
      ).armed,
    ).toBe(false);
  });

  test("treats exactly half remediation as not dominated and needs two completed rounds", () => {
    expect(
      remediationChurnTripwire(
        ledgerOf(roundOf(["remediation", "original"], 1), roundOf(["remediation"], 2)),
      ).armed,
    ).toBe(false);
    expect(remediationChurnTripwire(ledgerOf(roundOf(["remediation"], 1))).armed).toBe(false);
  });

  test("an empty round and origin-less findings never dominate", () => {
    let ledger = ledgerOf(roundOf(["remediation"], 1));
    ledger = addReviewRound(ledger, {
      headSha: "h2",
      model: "m",
      reviewedAt: "t2",
      review: {summary: "no origin", findings: [p2Finding]},
    });
    expect(remediationChurnTripwire(ledger).armed).toBe(false);
  });
});

describe("parseReviewLedger — persisted decision invariants", () => {
  function persistedLimitation(withOwner = false): any {
    const seed = withOwner ? seededLedger(finding) : seededLedger(p2Finding);
    return JSON.parse(
      JSON.stringify(
        recordDisposition(seed, "R1-F1", "accepted-as-limitation", "below the bar", {
          doc: "docs/limits.md",
          ...(withOwner ? {owner: true} : {}),
        }),
      ),
    );
  }

  test("rejects a limitation without a doc path", () => {
    const ledger = persistedLimitation();
    delete ledger.rounds[0].findings[0].disposition.doc;
    expect(() => parseReviewLedger(ledger)).toThrow(/doc/);
  });

  test("rejects a doc path on a non-limitation disposition", () => {
    const ledger = JSON.parse(
      JSON.stringify(recordDisposition(seededLedger(p2Finding), "R1-F1", "accepted", "will fix")),
    );
    ledger.rounds[0].findings[0].disposition.doc = "docs/limits.md";
    expect(() => parseReviewLedger(ledger)).toThrow(/doc/);
  });

  test("rejects a traversal or non-normalized doc path", () => {
    const traversal = persistedLimitation();
    traversal.rounds[0].findings[0].disposition.doc = "../outside.md";
    expect(() => parseReviewLedger(traversal)).toThrow(/repository-relative/);
    const unnormalized = persistedLimitation();
    unnormalized.rounds[0].findings[0].disposition.doc = "./docs/limits.md";
    expect(() => parseReviewLedger(unnormalized)).toThrow(/normalized/);
  });

  test("rejects a P0/P1 limitation without owner attribution, live or in history", () => {
    const live = persistedLimitation(true);
    delete live.rounds[0].findings[0].disposition.owner;
    expect(() => parseReviewLedger(live)).toThrow(/owner/);

    const reversed = JSON.parse(
      JSON.stringify(
        recordDisposition(
          recordDisposition(seededLedger(finding), "R1-F1", "accepted-as-limitation", "owner ruled", {
            doc: "docs/limits.md",
            owner: true,
          }),
          "R1-F1",
          "accepted",
          "owner ruled: fix it",
          {owner: true},
        ),
      ),
    );
    delete reversed.rounds[0].findings[0].history[0].owner;
    expect(() => parseReviewLedger(reversed)).toThrow(/owner/);
  });
});

describe("supersedeLedgerBase and liveRounds", () => {
  test("keeps every round and decision while resetting the live window", () => {
    let ledger = seededLedger(p2Finding);
    ledger = recordDisposition(ledger, "R1-F1", "accepted", "will fix");
    const superseded = supersedeLedgerBase(ledger, {
      baseRef: "master",
      baseSha: "b2",
      patchIds: ["p2"],
      archivedAt: "t-archive",
    });
    expect(superseded.rounds).toHaveLength(1);
    expect(superseded.baseSha).toBe("b2");
    expect(superseded.patchIds).toEqual(["p2"]);
    expect(superseded.supersessions).toEqual([
      {afterRound: 1, baseRef: "master", baseSha: "b", archivedAt: "t-archive"},
    ]);
    expect(liveRounds(superseded)).toEqual([]);
    expect(openObligations(superseded)).toHaveLength(1);

    const resumed = addReviewRound(superseded, {
      headSha: "h2",
      model: "m",
      reviewedAt: "t2",
      review: {summary: "post-supersession", findings: []},
    });
    expect(resumed.rounds).toHaveLength(2);
    expect(resumed.rounds[1].number).toBe(2);
    expect(liveRounds(resumed)).toHaveLength(1);
  });

  test("round-trips supersessions, decision history, step-back, doc, and owner through parse", () => {
    let ledger = seededLedger({...p2Finding, origin: "remediation"});
    ledger = recordDisposition(ledger, "R1-F1", "accepted-as-limitation", "below the bar", {
      doc: "docs/limits.md",
    });
    ledger = recordDisposition(ledger, "R1-F1", "accepted", "owner ruled: fix it", {owner: true});
    ledger = addReviewRound(ledger, {
      headSha: "h2",
      model: "m",
      reviewedAt: "t2",
      review: {summary: "second churn", findings: [{...p2Finding, title: "second churn", origin: "remediation"}]},
    });
    ledger = supersedeLedgerBase(ledger, {
      baseRef: "master",
      baseSha: "b2",
      patchIds: ["p2"],
      archivedAt: "t-archive",
    });
    ledger = addReviewRound(ledger, {
      headSha: "h3",
      model: "m",
      reviewedAt: "t3",
      review: {summary: "with step-back", findings: []},
      stepBack: {path: "docs/step-back.md", triggerRounds: [1, 2]},
    });
    const parsed = parseReviewLedger(JSON.parse(JSON.stringify(ledger)));
    expect(parsed).toEqual(ledger);
    expect(parsed.rounds[2].stepBack).toEqual({path: "docs/step-back.md", triggerRounds: [1, 2]});
    expect(parsed.rounds[0].findings[0].history).toHaveLength(1);
  });

  test("labels a nonterminal documentation result from its persisted type", () => {
    let ledger = seededLedger(p2Finding);
    ledger = recordDisposition(ledger, "R1-F1", "accepted-as-limitation", "below the bar", {
      doc: "docs/limits.md",
    });
    ledger = addReviewRound(ledger, {
      headSha: "h2",
      model: "m",
      reviewedAt: "t2",
      review: {summary: "doc gap", findings: []},
      audit: auditWith([
        {findingId: "R1-F1", status: "incomplete", evidence: "doc misses the crash path", type: "documentation"},
      ]),
    });
    expect(renderReviewLedger(ledger)).toContain("Documentation obligation R1-F1: incomplete");
  });

  test("renders limitation, owner attribution, step-back, and supersession context", () => {
    let ledger = seededLedger(p2Finding);
    ledger = recordDisposition(ledger, "R1-F1", "accepted-as-limitation", "below the bar", {
      doc: "docs/limits.md",
    });
    ledger = addReviewRound(ledger, {
      headSha: "h2",
      model: "m",
      reviewedAt: "t2",
      review: {summary: "second", findings: []},
    });
    ledger = supersedeLedgerBase(ledger, {
      baseRef: "master",
      baseSha: "b2",
      archivedAt: "t-archive",
    });
    ledger = addReviewRound(ledger, {
      headSha: "h3",
      model: "m",
      reviewedAt: "t3",
      review: {summary: "post", findings: []},
      stepBack: {path: "docs/step-back.md", triggerRounds: [1, 2]},
    });
    const md = renderReviewLedger(ledger);
    expect(md).toContain("**accepted-as-limitation**");
    expect(md).toContain("documented at: docs/limits.md");
    expect(md).toContain("Step-back note: docs/step-back.md");
    expect(md).toContain("Base superseded after round 2");
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
