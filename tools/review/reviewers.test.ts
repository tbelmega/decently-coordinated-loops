import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeArgs,
  buildCodexArgs,
  buildGrokArgs,
  buildKiroArgs,
  buildOpenCodeArgs,
  getReviewer,
  kiroWorkspaceAgentOverride,
  isReviewerId,
  openCodeReadOnlyConfig,
  openCodeReviewEnv,
  parseClaudeOutput,
  parseCodexEvents,
  parseCursorOutput,
  parseGrokOutput,
  parseKiroEvents,
  parseOpenCodeEvents,
  parseTrailingJson,
  promptWithRangeDiffs,
  rangeDiffs,
  promptWithSchema,
  reviewerIds,
  stripCodeFences,
  usageTokens,
} from "./reviewers.ts";

const reviewJson = '{"summary":"ok","findings":[]}';

describe("isReviewerId / getReviewer", () => {
  test("recognizes every adapter and rejects others", () => {
    expect([...reviewerIds]).toEqual(["codex", "claude", "cursor", "grok", "opencode", "kiro"]);
    for (const id of ["codex", "claude", "cursor", "grok", "opencode", "kiro"]) expect(isReviewerId(id)).toBe(true);
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
  test("prefers structured_output (the parsed object) and records envelope usage", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: reviewJson, structured_output: { summary: "ok", findings: [] }, usage: { input_tokens: 120, output_tokens: 30 } });
    expect(parseClaudeOutput(stdout)).toEqual({
      review: { summary: "ok", findings: [] },
      tokens: { input: 120, output: 30, total: 150 },
    });
  });

  test("falls back to parsing the result string when structured_output is absent", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: reviewJson });
    expect(parseClaudeOutput(stdout)).toEqual({ review: { summary: "ok", findings: [] } });
  });

  test("missing usage is tolerated - the field is omitted, never zero-filled", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: reviewJson, structured_output: { summary: "ok", findings: [] } });
    expect(parseClaudeOutput(stdout)).toEqual({ review: { summary: "ok", findings: [] } });
  });

  test("throws when the envelope reports an error", () => {
    const stdout = JSON.stringify({ is_error: true, result: "rate limited" });
    expect(() => parseClaudeOutput(stdout)).toThrow(/claude review reported an error/);
  });
});

describe("parseCursorOutput", () => {
  test("parses the result string, stripping fences, without usage when absent", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: "```json\n" + reviewJson + "\n```" });
    expect(parseCursorOutput(stdout)).toEqual({ review: { summary: "ok", findings: [] } });
  });

  test("records envelope usage when the CLI exposes it", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: reviewJson, usage: { input_tokens: 7, output_tokens: 2 } });
    expect(parseCursorOutput(stdout)).toEqual({
      review: { summary: "ok", findings: [] },
      tokens: { input: 7, output: 2, total: 9 },
    });
  });

  test("throws when the envelope reports an error", () => {
    const stdout = JSON.stringify({ is_error: true, result: "denied" });
    expect(() => parseCursorOutput(stdout)).toThrow(/cursor review reported an error/);
  });
});

describe("parseCodexEvents", () => {
  test("sums turn.completed usage across the JSONL stream", () => {
    const stream = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
      '{"type":"turn.completed","usage":{"input_tokens":26472,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}',
    ].join("\n");
    expect(parseCodexEvents(stream)).toEqual({ input: 26572, output: 15, total: 26587 });
  });

  test("a stream with no usage events yields undefined, and junk lines are skipped", () => {
    expect(parseCodexEvents("plain text\n{\"type\":\"turn.started\"}\nnot json {")).toBeUndefined();
    expect(parseCodexEvents("")).toBeUndefined();
  });
});

describe("usageTokens", () => {
  test("maps input/output and totals them; unrecognizable usage maps to undefined", () => {
    expect(usageTokens({ input_tokens: 3, output_tokens: 4 })).toEqual({ input: 3, output: 4, total: 7 });
    expect(usageTokens({ output_tokens: 4 })).toEqual({ output: 4, total: 4 });
    expect(usageTokens({ something: 1 })).toBeUndefined();
    expect(usageTokens(null)).toBeUndefined();
  });
});

describe("buildCodexArgs", () => {
  const fixed = { schemaPath: "/tmp/s.json", outputPath: "/tmp/o.json" };

  test("always carries the read-only exec surface and takes the prompt on stdin", () => {
    const args = buildCodexArgs(fixed);
    expect(args[0]).toBe("exec");
    expect(args).toContain("--ephemeral");
    expect(args.join(" ")).toContain("--sandbox read-only");
    expect(args).toContain("--output-schema");
    expect(args).toContain("--output-last-message");
    // JSONL events are the only place codex exposes token usage (C0).
    expect(args).toContain("--json");
    // `-` is codex's documented "read the instructions from stdin" positional.
    expect(args.at(-1)).toBe("-");
  });

  // Regression: the prompt used to be the final argv entry, and Linux caps a SINGLE
  // argument at MAX_ARG_STRLEN (128 KiB) however much total argument space is free. On
  // 2026-08-06 an 88 KB review diff crossed it and `posix_spawn` failed with E2BIG,
  // blocking two work-streams at once. argv must not scale with the prompt at all.
  test("argv stays tiny no matter how large the prompt is", () => {
    const args = buildCodexArgs(fixed);
    const bytes = args.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0);
    expect(bytes).toBeLessThan(1024);
    // And there is no seam through which a caller could put one back on the command line.
    expect(JSON.stringify(args)).not.toContain("review");
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

describe("buildClaudeArgs", () => {
  test("forwards model and effort before the read-only structured-output arguments", () => {
    const args = buildClaudeArgs({model: "opus", effort: "high", schema: {type: "object"}, prompt: "review"});
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args).toContain("plan");
    expect(args.at(-1)).toBe("review");
  });

  test("omits optional model and effort flags when absent", () => {
    const args = buildClaudeArgs({schema: {}, prompt: "review"});
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
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

/** argv byte size, for the "prompt never rides on argv" regressions. */
function argvBytes(args: string[]): number {
  return args.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0);
}

describe("parseTrailingJson", () => {
  test("parses bare or fenced JSON", () => {
    expect(parseTrailingJson(reviewJson)).toEqual({ summary: "ok", findings: [] });
    expect(parseTrailingJson("```json\n" + reviewJson + "\n```")).toEqual({ summary: "ok", findings: [] });
  });

  // Captured from opencode 1.19.0 on a free model: the final text event carried the
  // model's reasoning, braces included, ahead of the answer.
  test("takes the JSON object that ends a text led by prose", () => {
    const text = "Schema: pass, summary, coverage{files[]}. Let me produce the required JSON.\n\n" + reviewJson;
    expect(parseTrailingJson(text)).toEqual({ summary: "ok", findings: [] });
  });

  test("throws when no JSON object ends the text", () => {
    expect(() => parseTrailingJson('{"a":1} and then more prose')).toThrow();
  });
});

describe("parseGrokOutput", () => {
  // Shape captured from `grok --output-format json --json-schema ...` (grok 1.0.52). With a
  // schema, `text` can hold more than one concatenated JSON object, so only
  // `structuredOutput` is trustworthy when present.
  const envelope = {
    text: '{"summary":"","findings":[]}{"summary":"ok","findings":[]}',
    stopReason: "end_turn",
    usage: { input_tokens: 22513, cache_read_input_tokens: 24576, output_tokens: 221, reasoning_tokens: 153, total_tokens: 47310 },
    num_turns: 2,
    structuredOutput: { summary: "ok", findings: [] },
  };

  test("prefers structuredOutput over the text and records usage", () => {
    expect(parseGrokOutput(JSON.stringify(envelope))).toEqual({
      review: { summary: "ok", findings: [] },
      tokens: { input: 22513, output: 221, total: 22734 },
    });
  });

  test("falls back to a single fenced JSON text when structuredOutput is absent", () => {
    const stdout = JSON.stringify({ text: "```json\n" + reviewJson + "\n```", stopReason: "end_turn" });
    expect(parseGrokOutput(stdout)).toEqual({ review: { summary: "ok", findings: [] } });
  });

  test("throws on an error envelope", () => {
    const stdout = JSON.stringify({ type: "error", message: "rate limited" });
    expect(() => parseGrokOutput(stdout)).toThrow(/grok review reported an error: rate limited/);
  });

  test("throws when neither structuredOutput nor text is present", () => {
    expect(() => parseGrokOutput(JSON.stringify({ stopReason: "end_turn" }))).toThrow(/grok review output/);
  });
});

describe("buildGrokArgs", () => {
  test("reads the prompt from a file and enforces the schema inside the read-only sandbox", () => {
    const args = buildGrokArgs({ promptPath: "/tmp/p.txt", schema: { type: "object" } });
    expect(args.join(" ")).toContain("--prompt-file /tmp/p.txt");
    expect(args[args.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
    expect(args.join(" ")).toContain("--output-format json");
    expect(args.join(" ")).toContain("--sandbox read-only");
    // Headless runs cannot answer a prompt; the sandbox, not approval, keeps it read-only.
    expect(args).toContain("--always-approve");
    expect(args).not.toContain("-m");
    expect(args).not.toContain("--reasoning-effort");
    expect(argvBytes(args)).toBeLessThan(1024);
  });

  test("forwards model and effort when given", () => {
    const args = buildGrokArgs({ promptPath: "/tmp/p.txt", schema: {}, model: "grok-4.7-build", effort: "high" });
    expect(args[args.indexOf("-m") + 1]).toBe("grok-4.7-build");
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("high");
  });
});

describe("parseOpenCodeEvents", () => {
  // Shape captured from `opencode run --format json` (opencode 1.19.0): NDJSON events, the
  // answer in the last `text` event, usage per `step_finish`.
  const step = (input: number, output: number) =>
    JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { total: input + output, input, output, reasoning: 5, cache: { read: 9, write: 0 } } } });
  const text = (value: string) => JSON.stringify({ type: "text", part: { type: "text", text: value } });

  test("takes the last text event and sums step usage", () => {
    const stream = [
      JSON.stringify({ type: "step_start", part: {} }),
      JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { status: "error" } } }),
      step(14305, 70),
      text("Let me look first."),
      step(751, 13),
      text("```json\n" + reviewJson + "\n```"),
    ].join("\n");
    expect(parseOpenCodeEvents(stream)).toEqual({
      review: { summary: "ok", findings: [] },
      tokens: { input: 15056, output: 83, total: 15139 },
    });
  });

  test("omits usage when no step reported it", () => {
    expect(parseOpenCodeEvents(text(reviewJson))).toEqual({ review: { summary: "ok", findings: [] } });
  });

  test("throws on an error event", () => {
    const stream = JSON.stringify({ type: "error", error: { name: "ProviderAuthError", message: "no key" } });
    expect(() => parseOpenCodeEvents(stream)).toThrow(/opencode review reported an error: .*no key/);
  });

  test("throws when the stream carries no text", () => {
    expect(() => parseOpenCodeEvents(step(1, 1))).toThrow(/opencode review output had no text/);
  });

  test("tolerates reasoning ahead of the answer in the final text", () => {
    expect(parseOpenCodeEvents(text("The diff changes add. Let me produce the JSON.\n" + reviewJson)))
      .toEqual({ review: { summary: "ok", findings: [] } });
  });
});

describe("buildOpenCodeArgs / openCodeReadOnlyConfig", () => {
  test("runs headless with JSON events and keeps the prompt off argv", () => {
    const args = buildOpenCodeArgs({});
    expect(args[0]).toBe("run");
    expect(args.join(" ")).toContain("--format json");
    expect(args).not.toContain("-m");
    expect(args).not.toContain("--variant");
    expect(argvBytes(args)).toBeLessThan(256);
  });

  test("forwards model and effort (as --variant) when given", () => {
    const args = buildOpenCodeArgs({ model: "opencode/big-pickle", effort: "high" });
    expect(args[args.indexOf("-m") + 1]).toBe("opencode/big-pickle");
    expect(args[args.indexOf("--variant") + 1]).toBe("high");
  });

  // Regression: an allowlist of `git diff*` let a review write files through
  // `git diff > probe.txt` and `git diff --output=probe.txt` (opencode 1.19.0). Command
  // patterns are not a sandbox, so the reviewer gets no shell and no edit tool at all.
  const readOnly = {
    "*": "deny",
    bash: "deny",
    edit: "deny",
    task: "deny",
    webfetch: "deny",
    websearch: "deny",
    external_directory: "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
  };

  // Regression: opencode applies an agent's own permissions AFTER the top-level ones, so
  // a top-level deny alone was overridden by any user or repository config granting the
  // default agent bash or edit. The review runs as its own agent, defined last.
  test("the review runs as a dedicated agent whose permissions deny everything but reads", () => {
    const args = buildOpenCodeArgs({});
    expect(args[args.indexOf("--agent") + 1]).toBe("dcl-reviewer");
    const config = JSON.parse(openCodeReadOnlyConfig());
    expect(config.agent["dcl-reviewer"].mode).toBe("primary");
    expect(config.agent["dcl-reviewer"].permission).toEqual(readOnly);
    expect(config.permission).toEqual(readOnly);
  });

  test("the review env ignores repository config and plugins and injects the reviewer config", () => {
    const env = openCodeReviewEnv({ PATH: "/bin", OPENCODE_DISABLE_PROJECT_CONFIG: "0" });
    expect(env.PATH).toBe("/bin");
    // A reviewed repository must not be able to redefine the reviewer agent or run code.
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(env.OPENCODE_PURE).toBe("1");
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(openCodeReadOnlyConfig());
  });
});

describe("promptWithRangeDiffs / rangeDiffs", () => {
  test("appends each range's diff after the prompt, labelled by range", () => {
    const prompt = promptWithRangeDiffs("review a..b", [
      { range: "a..b", text: "diff --git a/x b/x\n+new\n" },
      { range: "c..d", text: "" },
    ]);
    expect(prompt.startsWith("review a..b\n")).toBe(true);
    expect(prompt).toContain("no shell");
    expect(prompt).toContain("git diff a..b");
    expect(prompt).toContain("+new");
    expect(prompt).toContain("git diff c..d");
    expect(prompt).toContain("(empty)");
  });

  test("no ranges leaves the prompt untouched", () => {
    expect(promptWithRangeDiffs("review", [])).toBe("review");
  });

  test("reads each range's diff from the repository", async () => {
    const repo = mkdtempSync(join(tmpdir(), "loops-range-diffs-"));
    try {
      const run = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).stdout.trim();
      run("init", "-q", "-b", "master");
      writeFileSync(join(repo, "math.ts"), "a + b\n");
      run("add", ".");
      run("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
      const base = run("rev-parse", "HEAD");
      writeFileSync(join(repo, "math.ts"), "a - b\n");
      run("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "head");
      const head = run("rev-parse", "HEAD");
      const diffs = await rangeDiffs(repo, [`${base}..${head}`]);
      expect(diffs).toHaveLength(1);
      expect(diffs[0].range).toBe(`${base}..${head}`);
      expect(diffs[0].text).toContain("-a + b");
      expect(diffs[0].text).toContain("+a - b");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("parseKiroEvents", () => {
  // Kiro's stream-json is ACP session updates as JSON Lines. The answer arrives as
  // agent_message_chunk text; the shape is taken from the ACP spec, not a captured run.
  const chunk = (value: string) =>
    JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } } });

  test("concatenates the agent message chunks and records token usage", () => {
    const stream = [
      chunk('{"summary":"ok",'),
      JSON.stringify({ params: { update: { sessionUpdate: "tool_call", title: "fs_read" } } }),
      chunk('"findings":[]}'),
      JSON.stringify({ type: "runFinished", tokenUsage: { inputTokens: 40, outputTokens: 2 } }),
    ].join("\n");
    expect(parseKiroEvents(stream)).toEqual({
      review: { summary: "ok", findings: [] },
      tokens: { input: 40, output: 2, total: 42 },
    });
  });

  test("accepts bare update lines without the JSON-RPC wrapper", () => {
    const stream = JSON.stringify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reviewJson } });
    expect(parseKiroEvents(stream)).toEqual({ review: { summary: "ok", findings: [] } });
  });

  test("throws on a runError event", () => {
    const stream = JSON.stringify({ type: "runError", message: "agent unavailable" });
    expect(() => parseKiroEvents(stream)).toThrow(/kiro review reported an error/);
  });

  test("throws when no agent message arrived", () => {
    expect(() => parseKiroEvents("")).toThrow(/kiro review output had no agent message/);
  });
});

describe("kiroWorkspaceAgentOverride", () => {
  // Kiro lets a workspace agent shadow a global one of the same name, so a reviewed
  // repository could swap in a reviewer with write tools. The adapter refuses instead.
  test("finds a repository agent claiming the reviewer's name, by file name or name field", () => {
    const repo = mkdtempSync(join(tmpdir(), "loops-kiro-agents-"));
    try {
      expect(kiroWorkspaceAgentOverride(repo)).toBeUndefined();
      const agents = join(repo, ".kiro", "agents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "helper.json"), JSON.stringify({ name: "helper" }));
      writeFileSync(join(agents, "notes.md"), "not an agent");
      expect(kiroWorkspaceAgentOverride(repo)).toBeUndefined();
      writeFileSync(join(agents, "innocent.json"), JSON.stringify({ name: "dcl-reviewer", tools: ["*"] }));
      expect(kiroWorkspaceAgentOverride(repo)).toBe(join(agents, "innocent.json"));
      rmSync(join(agents, "innocent.json"));
      writeFileSync(join(agents, "dcl-reviewer.json"), "not even json");
      expect(kiroWorkspaceAgentOverride(repo)).toBe(join(agents, "dcl-reviewer.json"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("buildKiroArgs", () => {
  test("runs the DCL reviewer agent headless, never trusting all tools, prompt off argv", () => {
    const args = buildKiroArgs({});
    expect(args.slice(0, 2)).toEqual(["chat", "--no-interactive"]);
    expect(args[args.indexOf("--agent") + 1]).toBe("dcl-reviewer");
    expect(args.join(" ")).toContain("--output-format stream-json");
    expect(args).not.toContain("--trust-all-tools");
    expect(args).not.toContain("-a");
    expect(argvBytes(args)).toBeLessThan(256);
  });

  test("forwards model and effort when given", () => {
    const args = buildKiroArgs({ model: "claude-sonnet-4.6", effort: "high" });
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4.6");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });
});
