#!/usr/bin/env bun
// Test double for the Codex CLI, used by the launcher and dispatch tests. It reads its
// behavior from `$HOME/fake-codex.json` and appends each invocation (arguments, working
// directory, stdin) to `$HOME/fake-codex-calls.jsonl`. Knobs: `sessionId` (printed as the
// `thread.started` event `codex exec --json` prints; absent prints none), `exitCode`,
// `stderr` (a line written before exiting), and `hold` (while `$HOME/fake-codex-hold`
// exists, the job keeps running).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface FakeCodex {
  sessionId?: string;
  exitCode?: number;
  stderr?: string;
  hold?: boolean;
}

const home = process.env.HOME!;
const configPath = join(home, "fake-codex.json");
const config: FakeCodex = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf8")) as FakeCodex) : {};
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli 0.0.0-fake");
  process.exit(0);
}
const stdin = args.at(-1) === "-" ? readFileSync(0, "utf8") : "";
appendFileSync(join(home, "fake-codex-calls.jsonl"), `${JSON.stringify({ args, cwd: process.cwd(), stdin })}\n`);
if (config.sessionId) console.log(JSON.stringify({ type: "thread.started", thread_id: config.sessionId }));
console.log(JSON.stringify({ type: "turn.started" }));
const holdPath = join(home, "fake-codex-hold");
while (config.hold && existsSync(holdPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
if (config.stderr) console.error(config.stderr);
process.exit(config.exitCode ?? 0);
