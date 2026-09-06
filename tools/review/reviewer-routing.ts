import type {
  ReviewAlternativeConfig,
  ReviewImplementerIdentity,
  ReviewPersonaName,
} from "../config.ts";
import {isReviewerId, type ReviewerId} from "./reviewers.ts";

export interface ReviewPassTemplate {
  pass: ReviewPersonaName;
  reviewer?: ReviewerId;
  model?: string;
  effort?: string;
}

export interface ReviewPassSelection {
  pass: ReviewPersonaName;
  reviewer: ReviewerId;
  model?: string;
  effort?: string;
}

export interface ReviewExplicitSelection {
  reviewer?: ReviewerId;
  model?: string;
  effort?: string;
}

export type ReviewRoutingSelection =
  | {kind: "default"}
  | {kind: "alternative"; index: number; when: ReviewImplementerIdentity};

export interface ReviewRoutingEvidence {
  identity: ReviewImplementerIdentity;
  selection: ReviewRoutingSelection;
  finalPasses: ReviewPassSelection[];
  shadowPasses?: ReviewPassSelection[];
  explicit?: ReviewExplicitSelection;
  retryOf?: string;
  legacyInitialization?: true;
}

export function bindImplementerIdentity(
  recorded: ReviewImplementerIdentity | undefined,
  supplied: ReviewImplementerIdentity,
  allowInitialization = false,
): ReviewImplementerIdentity {
  if (!recorded) {
    if (allowInitialization) return {...supplied};
    const field = (["harness", "model", "effort"] as const).find(
      (candidate) => supplied[candidate] !== undefined,
    );
    if (field) {
      throw new Error(`implementer ${field} conflicts with this review epoch: recorded "missing"`);
    }
    return {};
  }
  for (const field of ["harness", "model", "effort"] as const) {
    const value = supplied[field];
    if (value !== undefined && recorded[field] !== value) {
      throw new Error(
        `implementer ${field} conflicts with this review epoch: recorded ${JSON.stringify(recorded[field] ?? "missing")}, supplied ${JSON.stringify(value)}`,
      );
    }
  }
  return recorded;
}

export function matchReviewerAlternative(
  alternatives: readonly ReviewAlternativeConfig[],
  identity: ReviewImplementerIdentity,
): {index: number; alternative: ReviewAlternativeConfig} | undefined {
  for (const [index, alternative] of alternatives.entries()) {
    const matches = Object.entries(alternative.when).every(([field, prefix]) => {
      const value = identity[field as keyof ReviewImplementerIdentity];
      return typeof value === "string" && value.startsWith(prefix);
    });
    if (matches) return {index, alternative};
  }
  return undefined;
}

export function planReviewerPasses(input: {
  templates: ReviewPassTemplate[];
  alternative?: ReviewAlternativeConfig;
  saved?: ReviewPassSelection[];
  explicit: ReviewExplicitSelection;
  alternativesEnabled: boolean;
}): ReviewPassSelection[] {
  const baseline: ReviewPassTemplate[] = input.saved ?? input.templates.map((template) => {
    if (!input.alternative) return template;
    return {
      pass: template.pass,
      reviewer: input.alternative.reviewer,
      ...(input.alternative.model ? {model: input.alternative.model} : {}),
      ...(input.alternative.effort ? {effort: input.alternative.effort} : {}),
    };
  });
  return baseline.map((pass): ReviewPassSelection => {
    const reviewer = input.explicit.reviewer ?? pass.reviewer;
    if (!reviewer || !isReviewerId(reviewer)) {
      throw new Error("no reviewer configured - set review.reviewer in loops.json (run setup) or pass --reviewer <codex|claude|cursor>");
    }
    const model = input.explicit.model ?? pass.model;
    const effort = input.explicit.effort ?? pass.effort;
    if (input.alternativesEnabled && reviewer === "cursor" && effort) {
      throw new Error("cursor reviewer does not support effort; omit effort or select a reviewer that supports it");
    }
    return {
      pass: pass.pass,
      reviewer,
      ...(model ? {model} : {}),
      ...(effort ? {effort} : {}),
    };
  });
}
