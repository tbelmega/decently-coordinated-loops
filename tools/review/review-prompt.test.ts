import {describe, expect, test} from "bun:test";
import type {ReviewManifest} from "./review-manifest.ts";
import {reviewPrompt} from "./review-prompt.ts";

const manifest: ReviewManifest = {
  baseSha: "aaaaaaaaaaaa",
  headSha: "bbbbbbbbbbbb",
  files: [{path: "src/a.ts", hunks: ["-1,1 +1,2"]}],
  metadataFiles: [{path: "docs/release-state.md", hunks: ["-1,1 +1,1"]}],
  metadataPaths: ["docs/release-state.md"],
  remediationFiles: [{path: "src/a.ts", hunks: ["-1,1 +1,2"]}],
  baseDeltaFiles: [],
  instructionFiles: ["AGENTS.md"],
  contextReferences: [{label: "item", path: "/data/items/work.md", digest: "abc"}],
  patchIds: ["patch"],
};

function prompt(pass: "diff" | "integration" | "adversarial"): string {
  return reviewPrompt({
    pass,
    manifest,
    contextDocuments: [{label: "item", path: "/data/items/work.md", content: "Tests were waived by the owner."}],
    priorNotes: ["R1-F2 rejected: pre-existing"],
    obligations: [{
      findingId: "R1-F1",
      title: "Race",
      evidence: "two writers",
      direction: "serialize",
      dispositionReason: "accepted for remediation",
    }],
    classifyObligations: true,
    remediationBaseSha: "previous-head",
  });
}

describe("reviewPrompt", () => {
  test("embeds a machine-readable manifest and requires explicit coverage", () => {
    const value = prompt("diff");
    expect(value).toContain("AUDIT_PASS=diff");
    expect(value).toContain('"path":"src/a.ts"');
    expect(value).toContain('"hunks":["-1,1 +1,2"]');
    expect(value).toContain("Return coverage for every manifest file and exact hunk list");
  });

  test("carries owner context, accepted-finding intent, and the remediation delta", () => {
    const value = prompt("diff");
    expect(value).toContain("Tests were waived by the owner.");
    expect(value).toContain("R1-F1");
    expect(value).toContain("accepted for remediation");
    expect(value).toContain("previous-head..bbbbbbbbbbbb");
  });

  test("gives each pass a distinct audit responsibility", () => {
    expect(prompt("diff")).toContain("local correctness of every changed hunk");
    expect(prompt("integration")).toContain("callers, consumers, tests, contracts, and architecture");
    expect(prompt("adversarial")).toContain("security, data loss, concurrency, failure handling, accessibility");
  });

  test("marks landing metadata as excluded from terminal code coverage", () => {
    expect(prompt("integration")).toContain("docs/release-state.md");
    expect(prompt("integration")).toContain("landing metadata");
  });
});
