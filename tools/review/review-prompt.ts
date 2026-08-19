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

/** Reviewer steering for one change class whose paths this range touches. Cost
 * reduction only: the disposition-side waiver threshold is the enforcement, so a
 * reviewer that ignores the guidance still converges. */
export interface ReviewClassGuidance {
  name: string;
  files: string[];
  guidance: string;
}

export interface ReviewPromptInput {
  pass: ReviewAuditPass;
  manifest: ReviewManifest;
  contextDocuments: ReviewContextDocument[];
  priorNotes: string[];
  obligations: ReviewObligation[];
  classifyObligations: boolean;
  docArtifacts?: ReviewDocArtifact[];
  classGuidance?: ReviewClassGuidance[];
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
  // Both groups: parseReviewDiff routes every configured metadataPath into
  // metadataFiles, so an instruction file mistakenly configured as landing metadata
  // would otherwise escape the rule below. The governance validation already unions
  // the two the same way.
  const changedInstructionFiles = [...input.manifest.files, ...input.manifest.metadataFiles]
    .map((file) => file.path)
    .filter((path) => input.manifest.instructionFiles.includes(path));
  const hasSpecContext = input.contextDocuments.some((document) => document.label === "spec");
  return [
    `AUDIT_PASS=${input.pass}`,
    `AUDIT_INPUT=${JSON.stringify(auditInput)}`,
    `Review exactly the committed change ${input.manifest.baseSha}..${input.manifest.headSha}.`,
    passInstructions[input.pass],
    "Return coverage for every manifest file and exact hunk list. Missing coverage invalidates the entire logical round.",
    "coverage.instructionFiles must repeat every path in the manifest's instructionFiles, including files you judged irrelevant to this change. It records that you considered the repository's instructions, so any deviation from that exact set invalidates the round.",
    ...(input.manifest.instructionFilesUnderRevision?.length
      ? [
          `This change is authorized to rewrite these instruction files: ${input.manifest.instructionFilesUnderRevision.join(", ")}. For them the diff's new text is the proposed rule under review: audit it as subject (internal coherence, contradictions with rules not under revision, correctness of embedded commands), and do not report its deviation from these files' prior text, or a conflict with a rule inside these same files, as a defect. Rules in instruction files not listed here remain authority.`,
        ]
      : []),
    "Report every actionable correctness, security, data-loss, concurrency, compatibility, accessibility, or material maintainability defect; omit style preferences.",
    "Classify each finding origin as original, remediation, base-delta, or unknown.",
    ...(!input.classifyObligations && input.obligations.length > 0
      ? [
          "Obligations are shown for context only in this pass. Do not classify them here — return an empty obligations array; a designated pass records the classifications.",
        ]
      : []),
    ...(input.classifyObligations && input.obligations.some((obligation) => obligation.type === "remediation")
      ? [
          "Accepted findings are remediation obligations. This pass must classify every remediation obligation as fixed, incomplete, or regressed with concrete evidence; each incomplete or regressed obligation must remain an actionable finding whose obligationId names it. When one defect produced several obligations, one finding may answer them all by listing every id in obligationIds - do not leave a sibling unnamed, and do not invent a separate finding per id.",
        ]
      : []),
    ...(input.classifyObligations && input.obligations.some((obligation) => obligation.type === "documentation")
      ? [
          "For documentation obligations correctness is conceded — the finding is factually correct and the fix was declined against the component's documented assurance bar, so do not re-prove the defect. Verify instead that the DOCUMENTATION_ARTIFACT content honestly covers the finding's limitation, and classify each documentation obligation as documented, incomplete, or regressed; each incomplete or regressed one must remain an actionable finding whose obligationId names it, or whose obligationIds list it among the siblings it answers. Challenge the disposition itself only if the finding's impact exceeds what the cited contract admits.",
        ]
      : []),
    ...(input.docArtifacts ?? []).map(
      (artifact) => `DOCUMENTATION_ARTIFACT ${artifact.findingId} (${artifact.path}):\n${artifact.content}`,
    ),
    ...(metadataPaths.length > 0
      ? [`These paths are landing metadata excluded from terminal code coverage: ${metadataPaths.join(", ")}. Inspect them only for contradictions that affect the reviewed behavior.`]
      : []),
    // Enforcement of the no-spec-reference rule, emitted only when the range can
    // violate it: specs are dated change records the owner may archive or supersede,
    // so an instruction file citing one carries a dangling authority by construction.
    ...(changedInstructionFiles.length > 0
      ? [
          `This change edits instruction files (${changedInstructionFiles.join(", ")}). Instruction files must state the current rule or delegate to another instruction file, never to a spec document; specs are historical change records with no standing authority. Report as a defect any reference this diff adds from an instruction file to a spec (for example under docs/specs/), including precedence claims such as "the spec wins".`,
        ]
      : []),
    ...(input.classGuidance ?? []).map(
      (entry) =>
        `Change class "${entry.name}" covers these changed files: ${entry.files.join(", ")}. ${entry.guidance}`,
    ),
    ...(input.baseDeltaRange
      ? [`The patch series is unchanged after a rebase. Audit integration against the base delta ${input.baseDeltaRange.baseSha}..${input.baseDeltaRange.headSha}; classify defects caused by that interaction as base-delta.`]
      : []),
    ...input.contextDocuments.map(
      (document) => `WORKSTREAM_CONTEXT ${document.label} (${document.path}):\n${document.content}`,
    ),
    // Scope the spec's authority to this landing: during the round it is the oracle
    // ("did the change implement it"), but it must not become a standing rulebook
    // that turns every later intentional edit into a defect.
    ...(hasSpecContext
      ? [
          "The WORKSTREAM_CONTEXT spec is the acceptance oracle for this reviewed range only: verify the change implements it. It grants the diff no authority over unchanged text, and once this item lands the repository's living documents outrank it: do not treat the spec as a standing rulebook beyond this range.",
        ]
      : []),
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
