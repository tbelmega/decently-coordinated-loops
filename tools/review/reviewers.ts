// Reviewer adapters: turn "run a headless, read-only code review that returns JSON
// matching review.schema.json" into a concrete CLI invocation. The generic core
// (cli-review.ts, the ledger, the lock) never mentions a specific tool - it asks the
// selected adapter to produce a raw review object, then validates it with parseReview.
//
// Each adapter's flag surface and output shape were verified against the installed
// CLIs; the seams that differ are: how the schema is supplied (file vs inline vs
// prompt-embedded), where the result lands (a file vs a stdout envelope), and how
// read-only is enforced (OS sandbox vs plan mode).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const reviewerIds = ["codex", "claude", "cursor"] as const;
export type ReviewerId = (typeof reviewerIds)[number];

export function isReviewerId(value: unknown): value is ReviewerId {
  return typeof value === "string" && reviewerIds.some((id) => id === value);
}

export interface ReviewRequest {
  /** The review instructions (base..head, what to report, do-not-edit). */
  prompt: string;
  /** Explicit model id, or undefined to use the CLI's own default. */
  model?: string;
  /** Reasoning-effort override, or undefined to use the CLI's own default. Only the
   * codex adapter consumes this (via -c model_reasoning_effort); others ignore it. */
  effort?: string;
  /** Repository root to run the reviewer in. */
  cwd: string;
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
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, {cwd, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"]});
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

const claude: Reviewer = {
  id: "claude",
  binEnv: "CLAUDE_BIN",
  defaultBin: "claude",
  async invoke(request) {
    // claude enforces the schema, but its validator can't resolve the $schema draft
    // ref, so strip it; the returned parsed object is in `structured_output`.
    const schema = { ...schemaObject() };
    delete schema.$schema;
    const args = [
      "-p",
      ...(request.model ? ["--model", request.model] : []),
      "--permission-mode",
      "plan",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(schema),
      request.prompt,
    ];
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

const REVIEWERS: Record<ReviewerId, Reviewer> = { codex, claude, cursor };

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
