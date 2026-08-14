import type {ReviewAuditPass} from "../config.ts";
import type {ReviewObligation} from "./review-ledger.ts";
import type {ReviewManifest} from "./review-manifest.ts";

export interface ReviewContextDocument {
  label: string;
  path: string;
  content: string;
}

/** The persisted doc file a documentation obligation names, read at the HEAD under
 * review — the exact artifact the confirmation pass must verify. */
export interface ReviewDocArtifact {
  findingId: string;
  path: string;
  content: string;
}

export interface ReviewPromptInput {
  pass: ReviewAuditPass;
  manifest: ReviewManifest;
  contextDocuments: ReviewContextDocument[];
  priorNotes: string[];
  obligations: ReviewObligation[];
  classifyObligations: boolean;
  docArtifacts?: ReviewDocArtifact[];
  remediationBaseSha?: string;
  baseDeltaRange?: {baseSha: string; headSha: string};
}

const passInstructions: Record<ReviewAuditPass, string> = {
  diff: "Audit local correctness of every changed hunk, including boundary behavior, compatibility, and tests that should require the change.",
  integration: "Audit callers, consumers, tests, contracts, and architecture. Trace the changed behavior through relevant call paths rather than judging files in isolation.",
  adversarial: "Audit security, data loss, concurrency, failure handling, accessibility, compatibility, and documentation consistency. Look deliberately for interactions the other passes may miss.",
};

export function reviewPrompt(input: ReviewPromptInput): string {
  const auditInput = {
    pass: input.pass,
    manifest: input.manifest,
    obligations: input.obligations,
    requiredObligationIds: input.classifyObligations
      ? input.obligations.map((obligation) => obligation.findingId)
      : [],
    ...(input.remediationBaseSha
      ? {remediationRange: `${input.remediationBaseSha}..${input.manifest.headSha}`}
      : {}),
    ...(input.baseDeltaRange
      ? {baseDeltaRange: `${input.baseDeltaRange.baseSha}..${input.baseDeltaRange.headSha}`}
      : {}),
  };
  const metadataPaths = input.manifest.metadataFiles.map((file) => file.path);
  return [
    `AUDIT_PASS=${input.pass}`,
    `AUDIT_INPUT=${JSON.stringify(auditInput)}`,
    `Review exactly the committed change ${input.manifest.baseSha}..${input.manifest.headSha}.`,
    passInstructions[input.pass],
    "Return coverage for every manifest file and exact hunk list. Missing coverage invalidates the entire logical round.",
    "coverage.instructionFiles must repeat every path in the manifest's instructionFiles, including files you judged irrelevant to this change. It records that you considered the repository's instructions, so any deviation from that exact set invalidates the round.",
    "Report every actionable correctness, security, data-loss, concurrency, compatibility, accessibility, or material maintainability defect; omit style preferences.",
    "Classify each finding origin as original, remediation, base-delta, or unknown.",
    ...(!input.classifyObligations && input.obligations.length > 0
      ? [
          "Obligations are shown for context only in this pass. Do not classify them here — return an empty obligations array; a designated pass records the classifications.",
        ]
      : []),
    ...(input.classifyObligations && input.obligations.some((obligation) => obligation.type === "remediation")
      ? [
          "Accepted findings are remediation obligations. This pass must classify every remediation obligation as fixed, incomplete, or regressed with concrete evidence; each incomplete or regressed obligation must remain an actionable finding whose obligationId names it.",
        ]
      : []),
    ...(input.classifyObligations && input.obligations.some((obligation) => obligation.type === "documentation")
      ? [
          "For documentation obligations correctness is conceded — the finding is factually correct and the fix was declined against the component's documented assurance bar, so do not re-prove the defect. Verify instead that the DOCUMENTATION_ARTIFACT content honestly covers the finding's limitation, and classify each documentation obligation as documented, incomplete, or regressed; each incomplete or regressed one must remain an actionable finding whose obligationId names it. Challenge the disposition itself only if the finding's impact exceeds what the cited contract admits.",
        ]
      : []),
    ...(input.docArtifacts ?? []).map(
      (artifact) => `DOCUMENTATION_ARTIFACT ${artifact.findingId} (${artifact.path}):\n${artifact.content}`,
    ),
    ...(metadataPaths.length > 0
      ? [`These paths are landing metadata excluded from terminal code coverage: ${metadataPaths.join(", ")}. Inspect them only for contradictions that affect the reviewed behavior.`]
      : []),
    ...(input.baseDeltaRange
      ? [`The patch series is unchanged after a rebase. Audit integration against the base delta ${input.baseDeltaRange.baseSha}..${input.baseDeltaRange.headSha}; classify defects caused by that interaction as base-delta.`]
      : []),
    ...input.contextDocuments.map(
      (document) => `WORKSTREAM_CONTEXT ${document.label} (${document.path}):\n${document.content}`,
    ),
    ...(input.priorNotes.length > 0
      ? [
          "Earlier non-accepted findings are supplied to prevent blind re-raising; challenge one only with new factual evidence:",
          input.priorNotes.join("; "),
        ]
      : []),
    "Do not edit files, commit, push, fetch, or use the network. Ignore .reviews because it is review evidence.",
    "Return only the requested structured result. An empty findings array means this pass found no actionable finding.",
  ].join("\n\n");
}
