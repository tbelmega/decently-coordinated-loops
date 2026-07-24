import {describe, expect, test} from "bun:test";
import {buildReviewManifest, matchesMetadataPath, parseReviewDiff} from "./review-manifest.ts";

const diff = [
  "diff --git a/src/alpha.ts b/src/alpha.ts",
  "--- a/src/alpha.ts",
  "+++ b/src/alpha.ts",
  "@@ -2,2 +2,3 @@",
  "diff --git a/docs/release-state.md b/docs/release-state.md",
  "--- a/docs/release-state.md",
  "+++ b/docs/release-state.md",
  "@@ -1 +1 @@",
  "diff --git a/assets/logo.png b/assets/logo.png",
  "Binary files a/assets/logo.png and b/assets/logo.png differ",
].join("\n");

describe("parseReviewDiff", () => {
  test("enumerates every changed file and zero-context hunk while separating metadata", () => {
    expect(parseReviewDiff(diff, ["docs/release-state.md"])).toEqual({
      files: [
        {path: "src/alpha.ts", hunks: ["-2,2 +2,3"]},
        {path: "assets/logo.png", hunks: []},
      ],
      metadataFiles: [{path: "docs/release-state.md", hunks: ["-1,1 +1,1"]}],
    });
  });

  test("merges duplicate files and hunks from combined review ranges", () => {
    expect(parseReviewDiff(`${diff}\n${diff}`, ["docs/release-state.md"])).toEqual({
      files: [
        {path: "src/alpha.ts", hunks: ["-2,2 +2,3"]},
        {path: "assets/logo.png", hunks: []},
      ],
      metadataFiles: [{path: "docs/release-state.md", hunks: ["-1,1 +1,1"]}],
    });
  });
});

describe("matchesMetadataPath", () => {
  test("supports exact paths and recursive directory patterns", () => {
    expect(matchesMetadataPath("docs/release-state.md", ["docs/release-state.md"])).toBe(true);
    expect(matchesMetadataPath("generated/nested/state.json", ["generated/**"])).toBe(true);
    expect(matchesMetadataPath("src/generated.ts", ["generated/**"])).toBe(false);
  });
});

describe("buildReviewManifest", () => {
  test("records deterministic coverage, instructions, context references, and patch identity", () => {
    expect(buildReviewManifest({
      baseSha: "base",
      headSha: "head",
      diffText: diff,
      remediationDiffText: diff.split("diff --git a/docs/release-state.md")[0],
      baseDeltaDiffText: "diff --git a/src/base.ts b/src/base.ts\n@@ -1 +1,2 @@",
      metadataPaths: ["docs/release-state.md"],
      instructionFiles: ["AGENTS.md", "src/AGENTS.md"],
      contextReferences: [{label: "item", path: "/data/items/work.md", digest: "abc"}],
      patchIds: ["patch-two", "patch-one"],
    })).toEqual({
      baseSha: "base",
      headSha: "head",
      files: [
        {path: "src/alpha.ts", hunks: ["-2,2 +2,3"]},
        {path: "assets/logo.png", hunks: []},
      ],
      metadataFiles: [{path: "docs/release-state.md", hunks: ["-1,1 +1,1"]}],
      metadataPaths: ["docs/release-state.md"],
      remediationFiles: [{path: "src/alpha.ts", hunks: ["-2,2 +2,3"]}],
      baseDeltaFiles: [{path: "src/base.ts", hunks: ["-1,1 +1,2"]}],
      instructionFiles: ["AGENTS.md", "src/AGENTS.md"],
      contextReferences: [{label: "item", path: "/data/items/work.md", digest: "abc"}],
      patchIds: ["patch-one", "patch-two"],
    });
  });
});
