// Reviewer adapters: turn "run a headless, read-only code review that returns JSON
// matching review.schema.json" into a concrete CLI invocation. The generic core
// (cli-review.ts, the ledger, the lock) never mentions a specific tool — it asks the
// selected adapter to produce a raw review object, then validates it with parseReview.
//
// Each adapter's flag surface and output shape were verified against the installed
// CLIs; the seams that differ are: how the schema is supplied (file vs inline vs
// prompt-embedded), where the result lands (a file vs a stdout envelope), and how
// read-only is enforced (OS sandbox vs plan mode).
import { spawnSync } from "node:child_process";
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
  /** Repository root to run the reviewer in. */
  cwd: string;
}

export interface Reviewer {
  id: ReviewerId;
  /** The env var that overrides the CLI binary, and its default. */
  readonly binEnv: string;
  readonly defaultBin: string;
  /** Runs the reviewer and returns the raw parsed JSON (validated by the caller). */
  invoke(request: ReviewRequest): unknown;
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

/** claude -p --output-format json envelope. Prefers the parsed `structured_output`
 * (present when --json-schema is honored); falls back to parsing the `result` text. */
export function parseClaudeOutput(stdout: string): unknown {
  const envelope = JSON.parse(stdout);
  if (envelope && typeof envelope === "object") {
    const record = envelope as Record<string, unknown>;
    if (record.is_error) throw new Error(`claude review reported an error: ${String(record.result ?? "")}`);
    if (record.structured_output !== undefined) return record.structured_output;
    if (typeof record.result === "string") return JSON.parse(stripCodeFences(record.result));
  }
  throw new Error("claude review output had neither structured_output nor a result string");
}

/** cursor-agent -p --output-format json envelope. No schema enforcement, so the
 * schema-conforming JSON is the model's `result` text (possibly fenced). */
export function parseCursorOutput(stdout: string): unknown {
  const envelope = JSON.parse(stdout);
  if (envelope && typeof envelope === "object") {
    const record = envelope as Record<string, unknown>;
    if (record.is_error) throw new Error(`cursor review reported an error: ${String(record.result ?? "")}`);
    if (typeof record.result === "string") return JSON.parse(stripCodeFences(record.result));
  }
  throw new Error("cursor review output had no result string");
}

/** Reviewers without native schema enforcement get the schema in the prompt. */
export function promptWithSchema(prompt: string): string {
  return `${prompt}\nReturn ONLY a JSON object conforming to this JSON Schema — no prose, no markdown fences:\n${JSON.stringify(schemaObject())}`;
}

// --- adapters ----------------------------------------------------------------------

function runCaptured(bin: string, args: string[], cwd: string, tool: string): string {
  const result = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error) throw new Error(`could not run ${tool} (${bin}): ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${tool} exited with code ${result.status ?? "unknown"}`);
  return result.stdout;
}

const codex: Reviewer = {
  id: "codex",
  binEnv: "CODEX_BIN",
  defaultBin: "codex",
  invoke(request) {
    // Codex enforces the schema natively and writes the last message to a file.
    const directory = mkdtempSync(join(tmpdir(), "loops-review-"));
    try {
      const schemaPath = join(directory, "schema.json");
      writeFileSync(schemaPath, `${JSON.stringify(schemaObject())}\n`);
      const outputPath = join(directory, "result.json");
      const args = [
        "exec",
        ...(request.model ? ["--model", request.model] : []),
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        request.prompt,
      ];
      const result = spawnSync(resolveBin(codex), args, { cwd: request.cwd, stdio: "inherit" });
      if (result.error) throw new Error(`could not run codex (${resolveBin(codex)}): ${result.error.message}`);
      if (result.status !== 0) throw new Error(`codex exited with code ${result.status ?? "unknown"}`);
      return JSON.parse(readFileSync(outputPath, "utf8"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
};

const claude: Reviewer = {
  id: "claude",
  binEnv: "CLAUDE_BIN",
  defaultBin: "claude",
  invoke(request) {
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
    return parseClaudeOutput(runCaptured(resolveBin(claude), args, request.cwd, "claude"));
  },
};

const cursor: Reviewer = {
  id: "cursor",
  binEnv: "CURSOR_AGENT_BIN",
  defaultBin: "cursor-agent",
  invoke(request) {
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
    return parseCursorOutput(runCaptured(resolveBin(cursor), args, request.cwd, "cursor-agent"));
  },
};

const REVIEWERS: Record<ReviewerId, Reviewer> = { codex, claude, cursor };

export function getReviewer(id: ReviewerId): Reviewer {
  return REVIEWERS[id];
}
