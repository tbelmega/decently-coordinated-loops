// Reviewer adapters: turn "run a headless, read-only code review that returns JSON
// matching review.schema.json" into a concrete CLI invocation. The generic core
// (cli-review.ts, the ledger, the lock) never mentions a specific tool - it asks the
// selected adapter to produce a raw review object, then validates it with parseReview.
//
// Each adapter's flag surface and output shape were verified against the installed
// CLIs (Kiro's stream-json shape is the exception, taken from the ACP spec); the seams
// that differ are: how the schema is supplied (file vs inline vs prompt-embedded), where
// the result lands (a file vs a stdout envelope vs an event stream), and how read-only is
// enforced (OS sandbox vs plan mode vs a permission config vs a restricted agent).
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const reviewerIds = ["codex", "claude", "cursor", "grok", "opencode", "kiro"] as const;
export type ReviewerId = (typeof reviewerIds)[number];

export function isReviewerId(value: unknown): value is ReviewerId {
  return typeof value === "string" && reviewerIds.some((id) => id === value);
}

export interface ReviewRequest {
  /** The review instructions (base..head, what to report, do-not-edit). */
  prompt: string;
  /** Explicit model id, or undefined to use the CLI's own default. */
  model?: string;
  /** Reasoning-effort override, or undefined to use the CLI's own default. Every
   * adapter but Cursor consumes it; Cursor has no supported effort flag. */
  effort?: string;
  /** Repository root to run the reviewer in. */
  cwd: string;
  /** Committed ranges (`base..head`) the prompt asks about. Adapters whose reviewer
   * has no shell inline these diffs; the others let the reviewer run git itself. */
  ranges?: string[];
}

/** Token usage a reviewer CLI reported for one invocation. Fields are recorded only
 * when the CLI exposes them; they measure trend, not billing. */
export interface ReviewerTokens {
  input?: number;
  output?: number;
  total?: number;
}

/** One reviewer run: the raw review object (validated by the caller) plus whatever
 * usage the CLI exposed. */
export interface ReviewerInvocation {
  review: unknown;
  tokens?: ReviewerTokens;
}

export interface Reviewer {
  id: ReviewerId;
  /** The env var that overrides the CLI binary, and its default. */
  readonly binEnv: string;
  readonly defaultBin: string;
  /** Runs the reviewer and returns the raw parsed JSON (validated by the caller).
   * Async so the persona engine (C3) can run several passes concurrently. */
  invoke(request: ReviewRequest): Promise<ReviewerInvocation>;
}

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "review.schema.json");

function schemaObject(): Record<string, unknown> {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
}

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function resolveBin(reviewer: Reviewer): string {
  return process.env[reviewer.binEnv] || reviewer.defaultBin;
}

// --- output parsing (pure, unit-tested) -------------------------------------------

/** Strips a leading ```json / ``` fence and trailing ``` a model may wrap JSON in. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

/** `usage` object of an envelope or event, mapped to ReviewerTokens. The CLIs share
 * the input_tokens/output_tokens naming; anything absent stays absent, and a usage
 * with no recognizable field maps to undefined so the caller omits the record. */
export function usageTokens(usage: unknown): ReviewerTokens | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const input = typeof record.input_tokens === "number" ? record.input_tokens : undefined;
  const output = typeof record.output_tokens === "number" ? record.output_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input !== undefined ? {input} : {}),
    ...(output !== undefined ? {output} : {}),
    total: (input ?? 0) + (output ?? 0),
  };
}

/** claude -p --output-format json envelope. Prefers the parsed `structured_output`
 * (present when --json-schema is honored); falls back to parsing the `result` text.
 * Usage is taken from the envelope's `usage` when present. */
export function parseClaudeOutput(stdout: string): ReviewerInvocation {
  const envelope = JSON.parse(stdout);
  if (envelope && typeof envelope === "object") {
    const record = envelope as Record<string, unknown>;
    if (record.is_error) throw new Error(`claude review reported an error: ${String(record.result ?? "")}`);
    const tokens = usageTokens(record.usage);
    if (record.structured_output !== undefined) {
      return {review: record.structured_output, ...(tokens ? {tokens} : {})};
    }
    if (typeof record.result === "string") {
      return {review: JSON.parse(stripCodeFences(record.result)), ...(tokens ? {tokens} : {})};
    }
  }
  throw new Error("claude review output had neither structured_output nor a result string");
}

/** cursor-agent -p --output-format json envelope. No schema enforcement, so the
 * schema-conforming JSON is the model's `result` text (possibly fenced). Usage is
 * recorded when the envelope exposes it and omitted otherwise. */
export function parseCursorOutput(stdout: string): ReviewerInvocation {
  const envelope = JSON.parse(stdout);
  if (envelope && typeof envelope === "object") {
    const record = envelope as Record<string, unknown>;
    if (record.is_error) throw new Error(`cursor review reported an error: ${String(record.result ?? "")}`);
    if (typeof record.result === "string") {
      const tokens = usageTokens(record.usage);
      return {review: JSON.parse(stripCodeFences(record.result)), ...(tokens ? {tokens} : {})};
    }
  }
  throw new Error("cursor review output had no result string");
}

/** codex `--json` event stream (JSONL on stdout). Usage arrives on `turn.completed`
 * events as input_tokens/output_tokens; several turns sum. A stream with no usage
 * event yields undefined - the field is then omitted, never zero-filled. */
export function parseCodexEvents(stdout: string): ReviewerTokens | undefined {
  let input = 0;
  let output = 0;
  let seen = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // interleaved non-JSON output is not ours to police
    }
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (record.type !== "turn.completed") continue;
    const tokens = usageTokens(record.usage);
    if (!tokens) continue;
    seen = true;
    input += tokens.input ?? 0;
    output += tokens.output ?? 0;
  }
  return seen ? {input, output, total: input + output} : undefined;
}

/** The JSON object a schema-in-prompt reviewer's answer ends with. Bare or fenced JSON
 * parses directly; otherwise the earliest `{` from which the rest of the text parses as
 * one object wins, so prose a model emits ahead of its answer (some put their
 * reasoning, braces included, into the final text) is skipped. */
export function parseTrailingJson(text: string): unknown {
  const stripped = stripCodeFences(text);
  try {
    return JSON.parse(stripped);
  } catch (error) {
    for (let index = stripped.indexOf("{"); index >= 0; index = stripped.indexOf("{", index + 1)) {
      try {
        return JSON.parse(stripCodeFences(stripped.slice(index)));
      } catch {
        // not the start of the answer; keep looking
      }
    }
    throw error;
  }
}

/** grok `--output-format json` envelope. With `--json-schema` the parsed object is in
 * `structuredOutput`; `text` can then hold several concatenated JSON objects, so it is
 * only a fallback for an envelope without one. An error is `{"type":"error"}`. */
export function parseGrokOutput(stdout: string): ReviewerInvocation {
  const envelope = JSON.parse(stdout);
  if (envelope && typeof envelope === "object") {
    const record = envelope as Record<string, unknown>;
    if (record.type === "error") throw new Error(`grok review reported an error: ${String(record.message ?? "")}`);
    const tokens = usageTokens(record.usage);
    if (record.structuredOutput !== undefined) {
      return {review: record.structuredOutput, ...(tokens ? {tokens} : {})};
    }
    if (typeof record.text === "string") {
      return {review: JSON.parse(stripCodeFences(record.text)), ...(tokens ? {tokens} : {})};
    }
  }
  throw new Error("grok review output had neither structuredOutput nor a text string");
}

/** Parses each JSON object line of a JSONL stream, skipping anything else. */
function jsonLines(stdout: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object") records.push(value as Record<string, unknown>);
    } catch {
      // interleaved non-JSON output is not ours to police
    }
  }
  return records;
}

/** opencode `run --format json` event stream. The answer is the last `text` event's
 * `part.text`; usage arrives per `step_finish` as `part.tokens.{input,output}` and sums.
 * An `error` event fails the run. */
export function parseOpenCodeEvents(stdout: string): ReviewerInvocation {
  let answer: string | undefined;
  let input = 0;
  let output = 0;
  let seen = false;
  for (const event of jsonLines(stdout)) {
    const part = (event.part ?? {}) as Record<string, unknown>;
    if (event.type === "error") {
      throw new Error(`opencode review reported an error: ${JSON.stringify(event.error ?? event)}`);
    }
    if (event.type === "text" && typeof part.text === "string") answer = part.text;
    if (event.type === "step_finish" && part.tokens && typeof part.tokens === "object") {
      const tokens = part.tokens as Record<string, unknown>;
      if (typeof tokens.input === "number" || typeof tokens.output === "number") {
        seen = true;
        input += typeof tokens.input === "number" ? tokens.input : 0;
        output += typeof tokens.output === "number" ? tokens.output : 0;
      }
    }
  }
  if (answer === undefined) throw new Error("opencode review output had no text event");
  return {
    review: parseTrailingJson(answer),
    ...(seen ? {tokens: {input, output, total: input + output}} : {}),
  };
}

/** kiro-cli `--output-format stream-json`: ACP session updates as JSON Lines, with or
 * without the JSON-RPC `session/update` wrapper. The answer is the concatenated
 * `agent_message_chunk` text; a `runError` event fails the run; `tokenUsage`
 * (`inputTokens`/`outputTokens`) is recorded wherever it appears at the top of an event.
 * The shape comes from the ACP spec and the CLI's documented event names, not a
 * captured run, so the parser is deliberately tolerant about nesting. */
export function parseKiroEvents(stdout: string): ReviewerInvocation {
  const chunks: string[] = [];
  let input = 0;
  let output = 0;
  let seen = false;
  for (const event of jsonLines(stdout)) {
    if (event.type === "runError" || event.method === "runError" || "runError" in event) {
      throw new Error(`kiro review reported an error: ${JSON.stringify(event)}`);
    }
    const params = (event.params ?? {}) as Record<string, unknown>;
    const update = (params.update ?? event.update ?? event) as Record<string, unknown>;
    const content = (update.content ?? {}) as Record<string, unknown>;
    if (update.sessionUpdate === "agent_message_chunk" && typeof content.text === "string") {
      chunks.push(content.text);
    }
    const usage = (event.tokenUsage ?? params.tokenUsage) as Record<string, unknown> | undefined;
    if (usage && typeof usage === "object" && (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number")) {
      seen = true;
      input += typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
      output += typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
    }
  }
  if (!chunks.length) throw new Error("kiro review output had no agent message");
  return {
    review: parseTrailingJson(chunks.join("")),
    ...(seen ? {tokens: {input, output, total: input + output}} : {}),
  };
}

/** One range's diff, as inlined for a reviewer without a shell. */
export interface RangeDiff {
  range: string;
  text: string;
}

/** Appends each range's diff to the prompt. A reviewer that cannot run git still needs
 * the change itself; it reads surrounding code with its file tools. */
export function promptWithRangeDiffs(prompt: string, diffs: RangeDiff[]): string {
  if (!diffs.length) return prompt;
  const sections = diffs.map(
    ({range, text}) => `=== git diff ${range}\n${text.trim() ? text.trimEnd() : "(empty)"}`,
  );
  return `${prompt}\nYou have no shell, so the diffs of the ranges above are inlined here; read any other file you need with your file tools.\n${sections.join("\n")}`;
}

/** Each range's diff from the repository, in order. */
export async function rangeDiffs(cwd: string, ranges: string[]): Promise<RangeDiff[]> {
  const diffs: RangeDiff[] = [];
  for (const range of ranges) {
    const text = await runCaptured("git", ["diff", "--no-color", "--no-ext-diff", range, "--"], cwd, "git diff");
    diffs.push({range, text});
  }
  return diffs;
}

/** Reviewers without native schema enforcement get the schema in the prompt. */
export function promptWithSchema(prompt: string): string {
  return `${prompt}\nReturn ONLY a JSON object conforming to this JSON Schema - no prose, no markdown fences:\n${JSON.stringify(schemaObject())}`;
}

// --- adapters ----------------------------------------------------------------------

/** Runs a CLI, captures stdout, and resolves when it exits. stderr stays inherited
 * and live. Async (never spawnSync) so concurrent persona passes do not serialize. */
function runCaptured(
  bin: string,
  args: string[],
  cwd: string,
  tool: string,
  input?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
      ...(env ? {env} : {}),
    });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        rejectPromise(new Error(`${tool} produced more than ${MAX_OUTPUT_BYTES} bytes of output`));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error) => {
      rejectPromise(new Error(`could not run ${tool} (${bin}): ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`${tool} exited with code ${code ?? "unknown"}`));
        return;
      }
      resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });
}

/** Assembles the `codex exec` argv. Extracted (pure) so the model/effort seams are
 * unit-tested: --model and -c model_reasoning_effort are added only when supplied, and
 * the effort override is TOML-quoted to match codex's `-c key=value` parsing.
 *
 * The prompt is deliberately NOT here. It goes on stdin, and the trailing `-` is codex's
 * documented way to ask for that ("if not provided as an argument, or if `-` is used,
 * instructions are read from stdin"). The prompt carries the whole base..HEAD diff, and
 * as a command-line argument it hit MAX_ARG_STRLEN - Linux caps one argument at 128 KiB
 * no matter how much total argument space is free, so an 88 KB diff was enough to make
 * posix_spawn fail with E2BIG and block two items at once (2026-08-06). Keeping argv
 * independent of prompt size removes the ceiling rather than raising it. */
export function buildCodexArgs(opts: {
  model?: string;
  effort?: string;
  schemaPath: string;
  outputPath: string;
}): string[] {
  return [
    "exec",
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.effort ? ["-c", `model_reasoning_effort="${opts.effort}"`] : []),
    "--ephemeral",
    "--sandbox",
    "read-only",
    // JSONL events on stdout: the turn.completed event is the only place codex
    // exposes token usage. The result still lands via --output-last-message.
    "--json",
    "--output-schema",
    opts.schemaPath,
    "--output-last-message",
    opts.outputPath,
    "-",
  ];
}

const codex: Reviewer = {
  id: "codex",
  binEnv: "CODEX_BIN",
  defaultBin: "codex",
  async invoke(request) {
    // Codex enforces the schema natively and writes the last message to a file.
    const directory = mkdtempSync(join(tmpdir(), "loops-review-"));
    try {
      const schemaPath = join(directory, "schema.json");
      writeFileSync(schemaPath, `${JSON.stringify(schemaObject())}\n`);
      const outputPath = join(directory, "result.json");
      const args = buildCodexArgs({
        model: request.model,
        effort: request.effort,
        schemaPath,
        outputPath,
      });
      // stdin is a pipe carrying the prompt. stdout is captured for the usage events
      // and forwarded afterwards, so a detached run's log keeps the event trail;
      // stderr stays inherited and live.
      const stdout = await runCaptured(resolveBin(codex), args, request.cwd, "codex", request.prompt);
      if (stdout) process.stdout.write(stdout);
      const tokens = parseCodexEvents(stdout);
      return {
        review: JSON.parse(readFileSync(outputPath, "utf8")),
        ...(tokens ? {tokens} : {}),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
};

export function buildClaudeArgs(options: {
  model?: string;
  effort?: string;
  schema: Record<string, unknown>;
  prompt: string;
}): string[] {
  return [
    "-p",
    ...(options.model ? ["--model", options.model] : []),
    ...(options.effort ? ["--effort", options.effort] : []),
    "--permission-mode",
    "plan",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(options.schema),
    options.prompt,
  ];
}

const claude: Reviewer = {
  id: "claude",
  binEnv: "CLAUDE_BIN",
  defaultBin: "claude",
  async invoke(request) {
    // claude enforces the schema, but its validator can't resolve the $schema draft
    // ref, so strip it; the returned parsed object is in `structured_output`.
    const schema = { ...schemaObject() };
    delete schema.$schema;
    const args = buildClaudeArgs({
      model: request.model,
      effort: request.effort,
      schema,
      prompt: request.prompt,
    });
    return parseClaudeOutput(await runCaptured(resolveBin(claude), args, request.cwd, "claude"));
  },
};

const cursor: Reviewer = {
  id: "cursor",
  binEnv: "CURSOR_AGENT_BIN",
  defaultBin: "cursor-agent",
  async invoke(request) {
    // cursor-agent has no schema flag: embed the schema in the prompt and validate the
    // result text. --trust runs headless; --mode plan keeps it read-only (not --yolo).
    const args = [
      "-p",
      "--trust",
      "--mode",
      "plan",
      ...(request.model ? ["--model", request.model] : []),
      "--output-format",
      "json",
      promptWithSchema(request.prompt),
    ];
    return parseCursorOutput(await runCaptured(resolveBin(cursor), args, request.cwd, "cursor-agent"));
  },
};

/** Assembles the headless `grok` argv. The prompt is read from a file, never argv (see
 * buildCodexArgs for the MAX_ARG_STRLEN ceiling); grok ignores piped stdin in headless
 * mode. `--sandbox read-only` is kernel-enforced and blocks writes everywhere except
 * grok's own state directory and /tmp, so `--always-approve` only spares a headless run
 * the approval prompts it could not answer. */
export function buildGrokArgs(options: {
  promptPath: string;
  schema: Record<string, unknown>;
  model?: string;
  effort?: string;
}): string[] {
  return [
    "--prompt-file",
    options.promptPath,
    ...(options.model ? ["-m", options.model] : []),
    ...(options.effort ? ["--reasoning-effort", options.effort] : []),
    "--sandbox",
    "read-only",
    "--always-approve",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(options.schema),
  ];
}

const grok: Reviewer = {
  id: "grok",
  binEnv: "GROK_BIN",
  defaultBin: "grok",
  async invoke(request) {
    const directory = mkdtempSync(join(tmpdir(), "loops-review-"));
    try {
      const promptPath = join(directory, "prompt.md");
      writeFileSync(promptPath, request.prompt);
      const args = buildGrokArgs({
        promptPath,
        schema: schemaObject(),
        model: request.model,
        effort: request.effort,
      });
      return parseGrokOutput(await runCaptured(resolveBin(grok), args, request.cwd, "grok"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
};

/** The OpenCode agent a review runs as, defined by openCodeReadOnlyConfig. */
export const OPENCODE_REVIEWER_AGENT = "dcl-reviewer";

/** Assembles the `opencode run` argv. The prompt goes on stdin; effort maps to opencode's
 * provider-specific `--variant`. */
export function buildOpenCodeArgs(options: {model?: string; effort?: string}): string[] {
  return [
    "run",
    "--agent",
    OPENCODE_REVIEWER_AGENT,
    ...(options.model ? ["-m", options.model] : []),
    ...(options.effort ? ["--variant", options.effort] : []),
    "--format",
    "json",
  ];
}

/** The config injected through OPENCODE_CONFIG_CONTENT for one review run. opencode has
 * no OS sandbox: read-only is its permission system. Everything is denied except the
 * file-reading tools - no shell, because a command allowlist is not a sandbox (`git diff
 * --output=<file>` and `git diff > <file>` both match `git diff*`); the adapter inlines
 * the diffs instead. opencode applies an agent's own permissions after the top-level
 * ones, so the review runs as its own agent carrying the same rules. The dangerous tools
 * are named explicitly as well as covered by `*`: the inline config is merged last, so
 * an explicit key replaces any value an earlier config gave it. */
export function openCodeReadOnlyConfig(): string {
  const permission = {
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
  return JSON.stringify({
    permission,
    agent: {
      [OPENCODE_REVIEWER_AGENT]: {
        mode: "primary",
        description: "Read-only code reviewer driven by decently-coordinated-loops",
        permission,
      },
    },
  });
}

/** The environment for one review run. The reviewed repository is untrusted input: its
 * `opencode.json` could redefine the reviewer agent and its plugins could run code, so
 * project config and external plugins are both switched off. User-level config (models,
 * providers) still loads; the inline config is merged after it. */
export function openCodeReviewEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_CONFIG_CONTENT: openCodeReadOnlyConfig(),
  };
}

const opencode: Reviewer = {
  id: "opencode",
  binEnv: "OPENCODE_BIN",
  defaultBin: "opencode",
  async invoke(request) {
    // No schema flag: embed the schema in the prompt and validate the answer text. The
    // permission config is passed per invocation, never written to the user's config.
    const args = buildOpenCodeArgs({model: request.model, effort: request.effort});
    const env = openCodeReviewEnv(process.env);
    const prompt = promptWithSchema(promptWithRangeDiffs(request.prompt, await rangeDiffs(request.cwd, request.ranges ?? [])));
    return parseOpenCodeEvents(await runCaptured(resolveBin(opencode), args, request.cwd, "opencode", prompt, env));
  },
};

/** The Kiro agent a review runs as. Seeding writes its definition to
 * `~/.kiro/agents/<name>.json` (see setup/config-block.ts → renderKiroReviewerAgent). */
export const KIRO_REVIEWER_AGENT = "dcl-reviewer";

/** A file under the reviewed repository's `.kiro/agents/` that defines the reviewer
 * agent, by file name or `name` field, or undefined. Kiro lets a workspace agent shadow a
 * global one of the same name, which would let the reviewed repository hand the review
 * write tools; an unreadable candidate counts, so the check fails closed. */
export function kiroWorkspaceAgentOverride(cwd: string): string | undefined {
  const directory = join(cwd, ".kiro", "agents");
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return undefined;
  }
  for (const name of names) {
    const path = join(directory, name);
    if (name === `${KIRO_REVIEWER_AGENT}.json`) return path;
    try {
      const agent = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (agent?.name === KIRO_REVIEWER_AGENT) return path;
    } catch {
      // not an agent definition Kiro could load under our name
    }
  }
  return undefined;
}

/** Assembles the headless `kiro-cli chat` argv. The prompt goes on stdin. Read-only
 * comes from the reviewer agent's tool list (file reads only, no shell), so no trust
 * flag is ever passed. */
export function buildKiroArgs(options: {model?: string; effort?: string}): string[] {
  return [
    "chat",
    "--no-interactive",
    "--agent",
    KIRO_REVIEWER_AGENT,
    ...(options.model ? ["--model", options.model] : []),
    ...(options.effort ? ["--effort", options.effort] : []),
    "--output-format",
    "stream-json",
  ];
}

const kiro: Reviewer = {
  id: "kiro",
  binEnv: "KIRO_CLI_BIN",
  defaultBin: "kiro-cli",
  async invoke(request) {
    // No schema flag: embed the schema in the prompt and validate the answer text.
    const override = kiroWorkspaceAgentOverride(request.cwd);
    if (override) {
      throw new Error(`refusing a kiro review: ${override} would replace the read-only ${KIRO_REVIEWER_AGENT} agent`);
    }
    const args = buildKiroArgs({model: request.model, effort: request.effort});
    let stdout: string;
    try {
      const prompt = promptWithSchema(promptWithRangeDiffs(request.prompt, await rangeDiffs(request.cwd, request.ranges ?? [])));
      stdout = await runCaptured(resolveBin(kiro), args, request.cwd, "kiro-cli", prompt);
    } catch (error) {
      // Exit 4 is kiro-cli's "agent unavailable": the reviewer agent was never seeded.
      if (/exited with code 4$/.test((error as Error).message)) {
        throw new Error(`${(error as Error).message} - the ${KIRO_REVIEWER_AGENT} agent is missing; re-run DCL setup to write ~/.kiro/agents/${KIRO_REVIEWER_AGENT}.json`);
      }
      throw error;
    }
    return parseKiroEvents(stdout);
  },
};

const REVIEWERS: Record<ReviewerId, Reviewer> = { codex, claude, cursor, grok, opencode, kiro };

export function getReviewer(id: ReviewerId): Reviewer {
  return REVIEWERS[id];
}

/** The roster, in declaration order. The single source for "which reviewers exist and
 * what binary does each one look for" - `setup/seed.ts` derives its detection from this
 * rather than keeping a second list that drifts. */
export function allReviewers(): Reviewer[] {
  return reviewerIds.map((id) => REVIEWERS[id]);
}

/** The binary this reviewer would run, honouring its env override. Exposed so the
 * seeder can probe for installed CLIs without knowing any binary's name. */
export function reviewerBin(reviewer: Reviewer): string {
  return resolveBin(reviewer);
}
