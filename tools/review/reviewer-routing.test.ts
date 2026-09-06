import {describe, expect, test} from "bun:test";
import {
  bindImplementerIdentity,
  matchReviewerAlternative,
  planReviewerPasses,
  type ReviewPassTemplate,
} from "./reviewer-routing.ts";

const alternatives = [
  {when: {harness: "codex", model: "gpt"}, reviewer: "claude", model: "opus", effort: "high"},
  {when: {model: "gpt"}, reviewer: "cursor", model: "cursor-model"},
] as const;

describe("matchReviewerAlternative", () => {
  test("matches literal prefixes with AND inside a rule and first-match ordering", () => {
    expect(matchReviewerAlternative(alternatives, {harness: "codex-cli", model: "gpt-5"})).toEqual({
      index: 0,
      alternative: alternatives[0],
    });
    expect(matchReviewerAlternative(alternatives, {harness: "other", model: "gpt-5"})?.index).toBe(1);
  });

  test("does not normalize case or match a condition whose identity field is absent", () => {
    expect(matchReviewerAlternative(alternatives, {harness: "Codex", model: "gpt-5"})?.index).toBe(1);
    expect(matchReviewerAlternative(alternatives, {harness: "codex-cli"})).toBeUndefined();
  });
});

describe("bindImplementerIdentity", () => {
  test("records the first supplied identity and accepts identical continuations", () => {
    const identity = {harness: "codex", model: "gpt-5.6-sol", effort: "medium"};
    expect(bindImplementerIdentity(undefined, identity, true)).toEqual(identity);
    expect(bindImplementerIdentity(identity, {harness: "codex"})).toEqual(identity);
  });

  test("rejects changed or newly added identity fields within an epoch", () => {
    const recorded = {harness: "codex"};
    expect(() => bindImplementerIdentity(recorded, {harness: "claude"})).toThrow(/harness/);
    expect(() => bindImplementerIdentity(recorded, {model: "gpt"})).toThrow(/model/);
  });

  test("a legacy epoch may initialize once when explicitly allowed", () => {
    expect(bindImplementerIdentity(undefined, {harness: "codex"}, true)).toEqual({harness: "codex"});
  });
});

describe("planReviewerPasses", () => {
  const templates: ReviewPassTemplate[] = [
    {pass: "diff", reviewer: "codex", model: "persona-model", effort: "medium"},
    {pass: "adversarial", reviewer: "cursor", model: "other-model"},
  ];

  test("a matched alternative replaces every pass tuple and preserves pass names", () => {
    expect(planReviewerPasses({
      templates,
      alternative: alternatives[0],
      explicit: {},
      alternativesEnabled: true,
    })).toEqual([
      {pass: "diff", reviewer: "claude", model: "opus", effort: "high"},
      {pass: "adversarial", reviewer: "claude", model: "opus", effort: "high"},
    ]);
  });

  test("omitted alternative model and effort use adapter defaults", () => {
    expect(planReviewerPasses({
      templates,
      alternative: {when: {harness: "codex"}, reviewer: "claude"},
      explicit: {},
      alternativesEnabled: true,
    })).toEqual([
      {pass: "diff", reviewer: "claude"},
      {pass: "adversarial", reviewer: "claude"},
    ]);
  });

  test("explicit fields overlay each final tuple field by field", () => {
    expect(planReviewerPasses({
      templates,
      alternative: alternatives[0],
      explicit: {reviewer: "codex", model: "flag-model", effort: "low"},
      alternativesEnabled: true,
    })).toEqual([
      {pass: "diff", reviewer: "codex", model: "flag-model", effort: "low"},
      {pass: "adversarial", reviewer: "codex", model: "flag-model", effort: "low"},
    ]);
  });

  test("a retry baselines from saved tuples before applying new explicit fields", () => {
    expect(planReviewerPasses({
      templates: [{pass: "diff", reviewer: "codex"}],
      saved: [{pass: "diff", reviewer: "claude", model: "saved-model", effort: "high"}],
      explicit: {model: "new-model"},
      alternativesEnabled: true,
    })).toEqual([{pass: "diff", reviewer: "claude", model: "new-model", effort: "high"}]);
  });

  test("rejects Cursor effort only when alternative routing participates", () => {
    expect(() => planReviewerPasses({
      templates: [{pass: "diff", reviewer: "codex"}],
      alternative: alternatives[1],
      explicit: {effort: "high"},
      alternativesEnabled: true,
    })).toThrow(/cursor.*effort/i);
    expect(planReviewerPasses({
      templates: [{pass: "diff", reviewer: "cursor", effort: "legacy"}],
      explicit: {},
      alternativesEnabled: false,
    })).toEqual([{pass: "diff", reviewer: "cursor", effort: "legacy"}]);
  });
});
