import { describe, expect, test } from "bun:test";
import {
  buildCodexArgs,
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

describe("buildCodexArgs", () => {
  const fixed = { schemaPath: "/tmp/s.json", outputPath: "/tmp/o.json", prompt: "review a..b" };

  test("always carries the read-only exec surface and the prompt last", () => {
    const args = buildCodexArgs(fixed);
    expect(args[0]).toBe("exec");
    expect(args).toContain("--ephemeral");
    expect(args.join(" ")).toContain("--sandbox read-only");
    expect(args).toContain("--output-schema");
    expect(args).toContain("--output-last-message");
    expect(args.at(-1)).toBe("review a..b");
  });

  test("adds --model only when a model is given", () => {
    expect(buildCodexArgs(fixed)).not.toContain("--model");
    const args = buildCodexArgs({ ...fixed, model: "gpt-5.6-terra" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-terra");
  });

  test("adds the reasoning-effort config override only when effort is given", () => {
    expect(buildCodexArgs(fixed).join(" ")).not.toContain("model_reasoning_effort");
    const args = buildCodexArgs({ ...fixed, effort: "high" });
    const flag = args.indexOf("-c");
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(args[flag + 1]).toBe('model_reasoning_effort="high"');
  });

  test("model and effort compose", () => {
    const args = buildCodexArgs({ ...fixed, model: "gpt-5.6-sol", effort: "high" }).join(" ");
    expect(args).toContain("--model gpt-5.6-sol");
    expect(args).toContain('-c model_reasoning_effort="high"');
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
