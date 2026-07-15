import { describe, expect, test } from "bun:test";
import {
  getReviewer,
  isReviewerId,
  parseClaudeOutput,
  parseCursorOutput,
  promptWithSchema,
  reviewerIds,
  stripCodeFences,
} from "./reviewers.ts";

const reviewJson = '{"summary":"ok","findings":[]}';

describe("isReviewerId / getReviewer", () => {
  test("recognizes the three adapters and rejects others", () => {
    expect(isReviewerId("codex")).toBe(true);
    expect(isReviewerId("gpt")).toBe(false);
    expect(isReviewerId(undefined)).toBe(false);
    for (const id of reviewerIds) expect(getReviewer(id).id).toBe(id);
  });
});

describe("stripCodeFences", () => {
  test("removes a ```json fence and leaves bare JSON untouched", () => {
    expect(stripCodeFences("```json\n" + reviewJson + "\n```")).toBe(reviewJson);
    expect(stripCodeFences("```\n" + reviewJson + "\n```")).toBe(reviewJson);
    expect(stripCodeFences("  " + reviewJson + "  ")).toBe(reviewJson);
  });
});

describe("parseClaudeOutput", () => {
  test("prefers structured_output (the parsed object)", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: reviewJson, structured_output: { summary: "ok", findings: [] } });
    expect(parseClaudeOutput(stdout)).toEqual({ summary: "ok", findings: [] });
  });

  test("falls back to parsing the result string when structured_output is absent", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: reviewJson });
    expect(parseClaudeOutput(stdout)).toEqual({ summary: "ok", findings: [] });
  });

  test("throws when the envelope reports an error", () => {
    const stdout = JSON.stringify({ is_error: true, result: "rate limited" });
    expect(() => parseClaudeOutput(stdout)).toThrow(/claude review reported an error/);
  });
});

describe("parseCursorOutput", () => {
  test("parses the result string, stripping fences", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: "```json\n" + reviewJson + "\n```" });
    expect(parseCursorOutput(stdout)).toEqual({ summary: "ok", findings: [] });
  });

  test("throws when the envelope reports an error", () => {
    const stdout = JSON.stringify({ is_error: true, result: "denied" });
    expect(() => parseCursorOutput(stdout)).toThrow(/cursor review reported an error/);
  });
});

describe("promptWithSchema", () => {
  test("appends the review schema so a schema-less reviewer still conforms", () => {
    const augmented = promptWithSchema("review base..head");
    expect(augmented).toContain("review base..head");
    expect(augmented).toContain("JSON Schema");
    expect(augmented).toContain('"findings"');
  });
});
