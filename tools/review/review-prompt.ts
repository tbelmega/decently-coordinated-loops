import type {ReviewPersonaName} from "../config.ts";
import type {ReviewObligation} from "./review-ledger.ts";
import type {ReviewManifest} from "./review-manifest.ts";

export interface ReviewContextDocument {
  label: string;
  path: string;
  content: string;
}

/** The persisted doc file a documentation obligation names, read at the HEAD under
 * review - the exact artifact the confirmation pass must verify. */
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
  pass: ReviewPersonaName;
  manifest: ReviewManifest;
  contextDocuments: ReviewContextDocument[];
  priorNotes: string[];
  obligations: ReviewObligation[];
  classifyObligations: boolean;
  docArtifacts?: ReviewDocArtifact[];
  classGuidance?: ReviewClassGuidance[];
  remediationBaseSha?: string;
  baseDeltaRange?: {baseSha: string; headSha: string};
  /** Emit the P0-P3 definitions: on whenever any resolved key depends on the
   * taxonomy (config.ts taxonomyEnabled), so a dependent feature never runs
   * against undefined priorities. */
  taxonomy?: boolean;
  /** The C1 severity floor is active for THIS round: only new P0/P1 are findings;
   * P2/P3 observations go to the non-blocking notes array. */
  severityFloorActive?: boolean;
  /** C4: the previous round rejected a P0/P1 finding; this confirmation round must
   * treat each such rejection (reason among the prior notes) as a claim to refute
   * or affirm with factual evidence. */
  refuteRejections?: boolean;
  /** C2: the persona engine's sharpened briefs (interactions-only integration,
   * security-sharpened adversarial). Off for legacy auditPasses runs. */
  personaBriefs?: boolean;
}

/** The four priority definitions, load-bearing for the severity floor, terminal
 * rejection, and cap exits. One source; the spec's wording verbatim. */
export const priorityDefinitions = [
  "Priority definitions - apply them exactly:",
  "P0: data loss, security exposure, or a broken load-bearing invariant on a path the change makes reachable.",
  "P1: wrong behavior on a realistic path, or an acceptance criterion of the linked item or spec left unmet.",
  "P2: robustness on an unrealistic or adversarial path, a missing test for an implemented behavior, or a maintainability defect that does not change what a person or machine does next.",
  "P3: prose, comment, or consistency defects, and anything the reviewer would call a preference.",
].join("\n");

const passInstructions: Record<ReviewPersonaName, string> = {
  diff: "Audit local correctness of every changed hunk, including boundary behavior, compatibility, and tests that should require the change.",
  integration: "Audit callers, consumers, tests, contracts, and architecture. Trace the changed behavior through relevant call paths rather than judging files in isolation.",
  adversarial: "Audit security, data loss, concurrency, failure handling, accessibility, compatibility, and documentation consistency. Look deliberately for interactions the other passes may miss.",
  confirmation: "You are the unified confirmation reviewer for this round. Classify every open obligation against the artifact it names, and scan the fix delta for new defects, with the full reviewed range as context.",
};

/** The C2 persona-engine briefs: diff unchanged; adversarial keeps documentation
 * consistency and gains a security sharpening; integration is rebriefed to
 * interactions only (93% of its unique findings previously anchored inside the diff
 * manifest - the perspective was not materializing). Selected by `personaBriefs`,
 * so a legacy auditPasses configuration keeps today's briefs untouched. */
const personaPassInstructions: Record<ReviewPersonaName, string> = {
  diff: passInstructions.diff,
  integration:
    "Audit integration only: report a finding only when its defect arises from the interaction between the reviewed delta and code outside it (a caller, consumer, contract, or test). A defect provable within the changed hunks alone belongs to another pass and must not be reported here.",
  adversarial:
    "Audit security, data loss, concurrency, failure handling, accessibility, compatibility, and documentation consistency. For security: name the trust boundaries this delta touches, then check the changed entry points for authn/authz gaps, injection and path traversal on new inputs, secret handling and logging, unsafe exec or deserialization, and TOCTOU or symlink races on new file operations. A security finding must state a concrete attack path, not a category.",
  confirmation: passInstructions.confirmation,
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
    (input.personaBriefs ? personaPassInstructions : passInstructions)[input.pass],
    "Return coverage for every manifest file and exact hunk list. Missing coverage invalidates the entire logical round.",
    "coverage.instructionFiles must repeat every path in the manifest's instructionFiles, including files you judged irrelevant to this change. It records that you considered the repository's instructions, so any deviation from that exact set invalidates the round.",
    ...(input.manifest.instructionFilesUnderRevision?.length
      ? [
          `This change is authorized to rewrite these instruction files: ${input.manifest.instructionFilesUnderRevision.join(", ")}. For them the diff's new text is the proposed rule under review: audit it as subject (internal coherence, contradictions with rules not under revision, correctness of embedded commands), and do not report its deviation from these files' prior text, or a conflict with a rule inside these same files, as a defect. Rules in instruction files not listed here remain authority.`,
        ]
      : []),
    ...(input.taxonomy ? [priorityDefinitions] : []),
    ...(input.severityFloorActive
      ? [
          "The severity floor is active for this round: report as findings ONLY new P0/P1 defects (plus the obligation classifications requested of this pass). Every P2/P3 observation belongs in the notes array instead - a note is non-blocking, creates no obligation, and needs no disposition. Do not grade a P2/P3 up to keep it blocking; the priority definitions above are the contract.",
        ]
      : ["Return an empty notes array; the notes channel is not in use for this round."]),
    "Report every actionable correctness, security, data-loss, concurrency, compatibility, accessibility, or material maintainability defect; omit style preferences.",
    "Classify each finding origin as original, remediation, base-delta, or unknown.",
    "Classify each finding causality as introduced, worsened, unmet-obligation, pre-existing, or unknown. Inspect the base, diff, and relevant surrounding code already needed for this review. Pre-existing findings are contextual observations, not directions to expand the current workstream. A remediation-created regression is introduced or worsened even when related production debt already exists. Do not begin a separate reproduction effort, root-cause project, or base checkout merely to prove that an unrelated observation is pre-existing.",
    ...(!input.classifyObligations && input.obligations.length > 0
      ? [
          "Obligations are shown for context only in this pass. Do not classify them here - return an empty obligations array; a designated pass records the classifications.",
        ]
      : []),
    ...(input.classifyObligations && input.obligations.some((obligation) => obligation.type === "remediation")
      ? [
          "Accepted findings are remediation obligations. This pass must classify every remediation obligation as fixed, incomplete, or regressed with concrete evidence; each incomplete or regressed obligation must remain an actionable finding whose obligationId names it. When one defect produced several obligations, one finding may answer them all by listing every id in obligationIds - do not leave a sibling unnamed, and do not invent a separate finding per id.",
        ]
      : []),
    ...(input.classifyObligations && input.obligations.some((obligation) => obligation.type === "documentation")
      ? [
          "For documentation obligations correctness is conceded - the finding is factually correct and the fix was declined against the component's documented assurance bar, so do not re-prove the defect. Verify instead that the DOCUMENTATION_ARTIFACT content honestly covers the finding's limitation, and classify each documentation obligation as documented, incomplete, or regressed; each incomplete or regressed one must remain an actionable finding whose obligationId names it, or whose obligationIds list it among the siblings it answers. Challenge the disposition itself only if the finding's impact exceeds what the cited contract admits.",
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
    ...(input.refuteRejections
      ? [
          "The previous round rejected one or more P0/P1 findings; their reasons are among the prior notes above. Treat each such rejection as a claim under test: refute it with factual evidence if it is wrong, or let it stand silently if it holds. Do not re-raise the finding unchanged without engaging the rejection reason.",
        ]
      : []),
    "Do not edit files, commit, push, fetch, or use the network. Ignore .reviews because it is review evidence.",
    "Return only the requested structured result. An empty findings array means this pass found no actionable finding.",
  ].join("\n\n");
}
