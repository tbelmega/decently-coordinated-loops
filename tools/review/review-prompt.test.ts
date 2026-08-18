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
      type: "remediation",
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

  test("hands a documentation obligation its artifact and concedes the finding's correctness", () => {
    const value = reviewPrompt({
      pass: "diff",
      manifest,
      contextDocuments: [],
      priorNotes: [],
      obligations: [{
        findingId: "R2-F1",
        type: "documentation",
        title: "Lock loss on crash",
        evidence: "lock file survives",
        direction: "document or fix",
        dispositionReason: "below the component's assurance bar",
        doc: "docs/limits.md",
      }],
      classifyObligations: true,
      docArtifacts: [{findingId: "R2-F1", path: "docs/limits.md", content: "The lock is an optimisation only."}],
    });
    expect(value).toContain("DOCUMENTATION_ARTIFACT R2-F1 (docs/limits.md)");
    expect(value).toContain("The lock is an optimisation only.");
    expect(value).toContain("correctness is conceded");
    expect(value).toContain("documented, incomplete, or regressed");
    expect(value).toContain("do not re-prove the defect");
  });

  test("marks declared-change-surface instruction files as subject, not authority", () => {
    const value = reviewPrompt({
      pass: "diff",
      manifest: {...manifest, instructionFilesUnderRevision: ["AGENTS.md"]},
      contextDocuments: [],
      priorNotes: [],
      obligations: [],
      classifyObligations: false,
    });
    expect(value).toContain("This change is authorized to rewrite these instruction files: AGENTS.md.");
    expect(value).toContain("do not report its deviation from these files' prior text");
    expect(value).toContain("Rules in instruction files not listed here remain authority.");
    // The mandatory-coverage rule is unchanged: under-revision files are still read.
    expect(value).toContain("coverage.instructionFiles must repeat every path");
  });

  test("scopes spec authority to the reviewed range when a spec is in context", () => {
    const withSpec = reviewPrompt({
      pass: "diff",
      manifest,
      contextDocuments: [{label: "spec", path: "/data/docs/specs/x.md", content: "# Spec"}],
      priorNotes: [],
      obligations: [],
      classifyObligations: false,
    });
    expect(withSpec).toContain("acceptance oracle for this reviewed range only");
    expect(withSpec).toContain("do not treat the spec as a standing rulebook");
    const withoutSpec = reviewPrompt({
      pass: "diff",
      manifest,
      contextDocuments: [{label: "item", path: "/data/items/work.md", content: "context"}],
      priorNotes: [],
      obligations: [],
      classifyObligations: false,
    });
    expect(withoutSpec).not.toContain("acceptance oracle");
  });

  test("flags added spec references as defects only when instruction files are in the diff", () => {
    const editingRules = reviewPrompt({
      pass: "diff",
      manifest: {
        ...manifest,
        files: [{path: "AGENTS.md", hunks: ["-1,1 +1,2"]}],
        instructionFiles: ["AGENTS.md"],
      },
      contextDocuments: [],
      priorNotes: [],
      obligations: [],
      classifyObligations: false,
    });
    expect(editingRules).toContain("This change edits instruction files (AGENTS.md).");
    expect(editingRules).toContain("never to a spec document");
    expect(editingRules).toContain("Report as a defect any reference this diff adds from an instruction file to a spec");
    // A range not touching instruction files carries no such line.
    expect(prompt("diff")).not.toContain("never to a spec document");
  });

  test("renders one guidance line per change class with its matched files", () => {
    const value = reviewPrompt({
      pass: "diff",
      manifest,
      contextDocuments: [],
      priorNotes: [],
      obligations: [],
      classifyObligations: false,
      classGuidance: [
        {name: "coordination-prose", files: ["OUTBOX.md"], guidance: "Report only factual errors."},
      ],
    });
    expect(value).toContain(
      'Change class "coordination-prose" covers these changed files: OUTBOX.md. Report only factual errors.',
    );
  });
});
