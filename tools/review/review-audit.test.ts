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

  test("requires the diff pass to classify every accepted-finding obligation", () => {
    const input = passResult("diff") as Record<string, unknown>;
    expect(() => parseReviewPass(input, "diff", manifest, ["R1-F1"])).toThrow(/R1-F1/);
    input.obligations = [{findingId: "R1-F1", status: "fixed", evidence: "guard added"}];
    expect(parseReviewPass(input, "diff", manifest, ["R1-F1"]).obligations).toHaveLength(1);
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
