import {describe, expect, test} from "bun:test";
import type {ReviewManifest} from "./review-manifest.ts";
import {combineReviewPasses, computeReviewMetrics, parseReviewPass} from "./review-audit.ts";

const manifest: ReviewManifest = {
  baseSha: "base",
  headSha: "head",
  files: [
    {path: "src/a.ts", hunks: ["-1,1 +1,2"]},
    {path: "src/b.ts", hunks: []},
  ],
  metadataFiles: [],
  metadataPaths: [],
  remediationFiles: [],
  baseDeltaFiles: [],
  instructionFiles: ["AGENTS.md"],
  contextReferences: [],
  patchIds: ["patch"],
};

function passResult(pass: "diff" | "integration" | "adversarial", title = "Race"): unknown {
  return {
    pass,
    summary: `${pass} complete`,
    coverage: {
      files: manifest.files,
      instructionFiles: ["AGENTS.md"],
      callsites: ["src/caller.ts"],
    },
    obligations: [],
    findings: [{
      priority: "P1",
      title,
      file: "src/a.ts",
      line: 2,
      evidence: "two requests can write",
      impact: "lost update",
      direction: "make the write conditional",
      confidence: "high",
      origin: "original",
    }],
  };
}

describe("parseReviewPass", () => {
  test("requires exact file and hunk coverage for the selected pass", () => {
    const parsed = parseReviewPass(passResult("diff"), "diff", manifest, []);
    expect(parsed.coverage.files).toEqual(manifest.files);
    expect(parsed.findings[0].origin).toBe("original");

    const missingFile = passResult("diff") as Record<string, unknown>;
    missingFile.coverage = {files: [manifest.files[0]], instructionFiles: [], callsites: []};
    expect(() => parseReviewPass(missingFile, "diff", manifest, [])).toThrow(/coverage.*src\/b\.ts/i);

    const missingInstructions = passResult("diff") as Record<string, unknown>;
    missingInstructions.coverage = {files: manifest.files, instructionFiles: [], callsites: []};
    expect(() => parseReviewPass(missingInstructions, "diff", manifest, [])).toThrow(/instruction files/);
  });

  test("permits coverage of a configured metadata path but names any other stray file", () => {
    // reviewPrompt lists every metadata file and instructs the reviewer to inspect it, so a
    // compliant reviewer reports coverage for it. Rejecting that discarded whole rounds,
    // findings included, on two items in 2026-08.
    const withMetadata: ReviewManifest = {
      ...manifest,
      metadataFiles: [{path: ".reviews/round.md", hunks: ["-0,0 +1,4"]}],
      metadataPaths: [".reviews/**"],
    };
    const coversMetadata = passResult("diff") as Record<string, unknown>;
    coversMetadata.coverage = {
      files: [...manifest.files, {path: ".reviews/round.md", hunks: ["-0,0 +1,4"]}],
      instructionFiles: ["AGENTS.md"],
      callsites: [],
    };
    expect(parseReviewPass(coversMetadata, "diff", withMetadata, []).coverage.files).toHaveLength(3);

    // A path that is neither in the manifest nor exempt still fails closed — that is what
    // catches a reviewer auditing the wrong range — and the message says which path.
    const stray = passResult("diff") as Record<string, unknown>;
    stray.coverage = {
      files: [...manifest.files, {path: "src/unrelated.ts", hunks: []}],
      instructionFiles: ["AGENTS.md"],
      callsites: [],
    };
    expect(() => parseReviewPass(stray, "diff", withMetadata, [])).toThrow(
      /outside the review manifest: src\/unrelated\.ts/,
    );
  });

  test("accepts fix-delta hunks unioned into coverage, in any order, on remediation rounds", () => {
    // reviewPrompt embeds remediationFiles/baseDeltaFiles in AUDIT_INPUT and instructs the
    // reviewer to audit those ranges, so a compliant reviewer unions their hunks into its
    // coverage. Demanding exact equality with manifest.files discarded three whole logical
    // rounds on 2026-08-09 while their passes classified every obligation fixed.
    const remediationRound: ReviewManifest = {
      ...manifest,
      remediationFiles: [{path: "src/a.ts", hunks: ["-9,2 +9,4"]}],
      baseDeltaFiles: [{path: "src/b.ts", hunks: ["-5,1 +5,2"]}],
    };
    const unioned = passResult("diff") as Record<string, unknown>;
    unioned.coverage = {
      files: [
        {path: "src/a.ts", hunks: ["-9,2 +9,4", "-1,1 +1,2"]},
        {path: "src/b.ts", hunks: ["-5,1 +5,2"]},
      ],
      instructionFiles: ["AGENTS.md"],
      callsites: [],
    };
    expect(parseReviewPass(unioned, "diff", remediationRound, []).coverage.files).toHaveLength(2);

    // Manifest hunks stay REQUIRED: covering only the fix delta is still incomplete.
    const missingRequired = passResult("diff") as Record<string, unknown>;
    missingRequired.coverage = {
      files: [{path: "src/a.ts", hunks: ["-9,2 +9,4"]}, {path: "src/b.ts", hunks: []}],
      instructionFiles: ["AGENTS.md"],
      callsites: [],
    };
    expect(() => parseReviewPass(missingRequired, "diff", remediationRound, [])).toThrow(
      /coverage is incomplete for src\/a\.ts/,
    );

    // A hunk in neither the manifest nor any fix delta still fails closed, by name.
    const invented = passResult("diff") as Record<string, unknown>;
    invented.coverage = {
      files: [{path: "src/a.ts", hunks: ["-1,1 +1,2", "-99,1 +99,1"]}, {path: "src/b.ts", hunks: []}],
      instructionFiles: ["AGENTS.md"],
      callsites: [],
    };
    expect(() => parseReviewPass(invented, "diff", remediationRound, [])).toThrow(
      /src\/a\.ts.*outside the review manifest.*-99,1 \+99,1/,
    );
  });

  test("rejects a partial fix-delta union and duplicate hunks", () => {
    // Only two covered sets are compliant reviewer behavior: exactly the manifest hunks
    // (fix delta ignored) or their complete union (fix delta audited). A partial union
    // would persist an audit of a range the reviewer did not finish. (R1-F1..F3)
    const multiHunkRemediation: ReviewManifest = {
      ...manifest,
      remediationFiles: [{path: "src/a.ts", hunks: ["-9,2 +9,4", "-20,1 +20,2"]}],
    };
    const partial = passResult("diff") as Record<string, unknown>;
    partial.coverage = {
      files: [{path: "src/a.ts", hunks: ["-1,1 +1,2", "-9,2 +9,4"]}, {path: "src/b.ts", hunks: []}],
      instructionFiles: ["AGENTS.md"],
      callsites: [],
    };
    expect(() => parseReviewPass(partial, "diff", multiHunkRemediation, [])).toThrow(
      /src\/a\.ts.*complete union/,
    );

    const duplicated = passResult("diff") as Record<string, unknown>;
    duplicated.coverage = {
      files: [{path: "src/a.ts", hunks: ["-1,1 +1,2", "-1,1 +1,2"]}, {path: "src/b.ts", hunks: []}],
      instructionFiles: ["AGENTS.md"],
      callsites: [],
    };
    expect(() => parseReviewPass(duplicated, "diff", multiHunkRemediation, [])).toThrow(
      /src\/a\.ts.*repeat/,
    );
  });

  test("permits coverage of a remediation-only path but keeps unknown paths stray", () => {
    // A fix that exactly reverts a file leaves it in the remediation delta but not in
    // base..head, so a reviewer auditing the remediation range legitimately covers it.
    const revertRound: ReviewManifest = {
      ...manifest,
      remediationFiles: [{path: "src/reverted.ts", hunks: ["-3,1 +3,1"]}],
    };
    const coversRevert = passResult("diff") as Record<string, unknown>;
    coversRevert.coverage = {
      files: [...manifest.files, {path: "src/reverted.ts", hunks: ["-3,1 +3,1"]}],
      instructionFiles: ["AGENTS.md"],
      callsites: [],
    };
    expect(parseReviewPass(coversRevert, "diff", revertRound, []).coverage.files).toHaveLength(3);

    const strayHunk = passResult("diff") as Record<string, unknown>;
    strayHunk.coverage = {
      files: [...manifest.files, {path: "src/reverted.ts", hunks: ["-3,1 +3,1", "-8,1 +8,1"]}],
      instructionFiles: ["AGENTS.md"],
      callsites: [],
    };
    expect(() => parseReviewPass(strayHunk, "diff", revertRound, [])).toThrow(
      /outside the review manifest: src\/reverted\.ts/,
    );

    // A reported fix-delta-only path needs its complete delta hunk set — an empty or
    // partial list must not pass through a vacuous subset check. (R1-F1..F3)
    const emptyHunks = passResult("diff") as Record<string, unknown>;
    emptyHunks.coverage = {
      files: [...manifest.files, {path: "src/reverted.ts", hunks: []}],
      instructionFiles: ["AGENTS.md"],
      callsites: [],
    };
    expect(() => parseReviewPass(emptyHunks, "diff", revertRound, [])).toThrow(
      /outside the review manifest: src\/reverted\.ts/,
    );
  });

  test("requires the diff pass to classify every open obligation", () => {
    const input = passResult("diff") as Record<string, unknown>;
    expect(() => parseReviewPass(input, "diff", manifest, [{findingId: "R1-F1", type: "remediation"}])).toThrow(
      /R1-F1/,
    );
    input.obligations = [{findingId: "R1-F1", status: "fixed", evidence: "guard added"}];
    expect(
      parseReviewPass(input, "diff", manifest, [{findingId: "R1-F1", type: "remediation"}]).obligations,
    ).toHaveLength(1);
  });

  test("accepts the documented terminal and stamps the obligation type on the result", () => {
    const input = passResult("diff") as Record<string, unknown>;
    input.obligations = [{findingId: "R1-F2", status: "documented", evidence: "doc covers the limitation"}];
    expect(
      parseReviewPass(input, "diff", manifest, [{findingId: "R1-F2", type: "documentation"}]).obligations,
    ).toEqual([
      {findingId: "R1-F2", status: "documented", evidence: "doc covers the limitation", type: "documentation"},
    ]);
  });

  test("keeps unsolicited obligation results out of the record without killing a compliant round", () => {
    // The invariant is that no result is PERSISTED for an obligation that was not open
    // when the round ran. A pass that was never asked to classify may still echo
    // classifications (the prompt shows every obligation to every pass); discarding
    // them preserves the invariant, while rejecting them killed a clean logical round
    // on 2026-08-14 — the same reviewer-did-as-told class as the coverage notes above.
    const echoed = passResult("diff") as Record<string, unknown>;
    echoed.obligations = [{findingId: "R9-F9", status: "documented", evidence: "echoed"}];
    expect(parseReviewPass(echoed, "diff", manifest, []).obligations).toEqual([]);

    // The classifying pass stays strict: an unknown id there is an audit error.
    const alongsideRequired = passResult("diff") as Record<string, unknown>;
    alongsideRequired.obligations = [
      {findingId: "R1-F1", status: "fixed", evidence: "guard added"},
      {findingId: "R9-F9", status: "fixed", evidence: "unsolicited"},
    ];
    expect(() =>
      parseReviewPass(alongsideRequired, "diff", manifest, [{findingId: "R1-F1", type: "remediation"}]),
    ).toThrow(/R9-F9/);
  });

  test("rejects duplicate obligation result ids within one pass", () => {
    // A contradictory response (documented AND incomplete for the same obligation) must
    // not let the terminal half retire the obligation.
    const contradictory = passResult("diff") as Record<string, unknown>;
    contradictory.obligations = [
      {findingId: "R1-F2", status: "documented", evidence: "covers it"},
      {findingId: "R1-F2", status: "incomplete", evidence: "misses the crash path"},
    ];
    expect(() =>
      parseReviewPass(contradictory, "diff", manifest, [{findingId: "R1-F2", type: "documentation"}]),
    ).toThrow(/duplicate/);
  });

  test("rejects a terminal status recorded against the wrong obligation type", () => {
    const documentedRemediation = passResult("diff") as Record<string, unknown>;
    documentedRemediation.obligations = [{findingId: "R1-F1", status: "documented", evidence: "wrong"}];
    expect(() =>
      parseReviewPass(documentedRemediation, "diff", manifest, [{findingId: "R1-F1", type: "remediation"}]),
    ).toThrow(/R1-F1.*remediation.*documented/);

    const fixedDocumentation = passResult("diff") as Record<string, unknown>;
    fixedDocumentation.obligations = [{findingId: "R1-F2", status: "fixed", evidence: "wrong"}];
    expect(() =>
      parseReviewPass(fixedDocumentation, "diff", manifest, [{findingId: "R1-F2", type: "documentation"}]),
    ).toThrow(/R1-F2.*documentation.*fixed/);
  });
});

describe("combineReviewPasses", () => {
  test("unions unique findings and retains every pass that raised a duplicate", () => {
    const diff = parseReviewPass(passResult("diff"), "diff", manifest, []);
    const integration = parseReviewPass(passResult("integration"), "integration", manifest, []);
    const adversarial = parseReviewPass(passResult("adversarial", "Missing rollback"), "adversarial", manifest, []);

    const combined = combineReviewPasses([diff, integration, adversarial], []);

    expect(combined.findings).toHaveLength(2);
    expect(combined.findings[0].passes).toEqual(["diff", "integration"]);
    expect(combined.findings[0].firstSeenRound).toBe(1);
    expect(combined.findings[1].passes).toEqual(["adversarial"]);
  });
});

describe("computeReviewMetrics", () => {
  test("reports pass counts, origins, late high severity, decline, repeats, and unchanged-head drift", () => {
    const diff = parseReviewPass(passResult("diff"), "diff", manifest, []);
    const integration = parseReviewPass(passResult("integration"), "integration", manifest, []);
    const combined = combineReviewPasses([diff, integration], [
      {id: "R1-F2", identity: "different", firstSeenRound: 1},
    ]);

    expect(computeReviewMetrics({
      roundNumber: 2,
      headSha: "same-head",
      previousRound: {headSha: "same-head", findingCount: 4, identities: ["different"]},
      passResults: [diff, integration],
      findings: combined.findings,
    })).toEqual({
      findingsByPass: {diff: 1, integration: 1, adversarial: 0},
      findingsByPriority: {P0: 0, P1: 1, P2: 0, P3: 0},
      findingsByOrigin: {original: 1, remediation: 0, "base-delta": 0, unknown: 0},
      repeatedFindings: 0,
      lateHighPriorityFindings: 1,
      unchangedHeadDrift: true,
      declineRatio: 0.75,
    });
  });
});
