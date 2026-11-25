#!/usr/bin/env bun
// Central dispatch: assigns eligible board items and starts one agent thread per item
// through T3 Code, under the limits of the `dispatch` section of loops.json. Run from the
// data repo root (for `tick`, a clone dedicated to the program):
//
//   bun <DCL>/tools/cli-dispatch.ts plan --host <name>
//   bun <DCL>/tools/cli-dispatch.ts tick --host <name> [--init]
//   bun <DCL>/tools/cli-dispatch.ts status
//   bun <DCL>/tools/cli-dispatch.ts pause [--project <name>] [--note <text>]
//   bun <DCL>/tools/cli-dispatch.ts resume [--project <name>]
//
// Exit 0 on success (including "central dispatch is off"), 2 on a usage or precondition
// error, 1 when an operation failed (pull, push, T3 Code unreachable).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { defaultStatePath, runPause, runPlan, runStatus, runTick, type RunDeps } from "./dispatch-run.ts";

const USAGE = `usage: cli-dispatch.ts plan --host <name>
       cli-dispatch.ts tick --host <name> [--init]
       cli-dispatch.ts status
       cli-dispatch.ts pause [--project <name>] [--note <text>]
       cli-dispatch.ts resume [--project <name>]`;

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
const values: Record<string, string> = {};
const flags = new Set<string>();
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i]!;
  if (arg === "--init") flags.add(arg.slice(2));
  else if (arg === "--host" || arg === "--project" || arg === "--note") {
    const value = rest[++i];
    if (value === undefined || value.trim() === "") fail(`${arg} needs a non-empty value`);
    values[arg.slice(2)] = value;
  } else fail(`unknown argument ${arg}`);
}

const allowed: Record<string, string[]> = {
  plan: ["host"],
  tick: ["host", "init"],
  status: [],
  pause: ["project", "note"],
  resume: ["project"],
};
if (!command || !(command in allowed)) fail(command ? `unknown command ${command}` : "a command is required");
for (const key of [...Object.keys(values), ...flags]) {
  if (!allowed[command]!.includes(key)) fail(`--${key} does not apply to ${command}`);
}

const ROOT = process.cwd();
if (!existsSync(join(ROOT, "BOARD.md"))) fail(`not a loops data repo (no BOARD.md in ${ROOT}) - run from the data repo root`);
let config;
try {
  config = loadConfig(ROOT);
} catch (error) {
  fail(`loops.json: ${(error as Error).message}`);
}

const deps: RunDeps = {
  root: ROOT,
  config,
  now: () => new Date(),
  statePath: defaultStatePath(ROOT),
  out: (line) => console.log(line),
};

let code: number;
if (command === "plan") code = runPlan(deps, { host: values.host });
else if (command === "tick") code = runTick(deps, { host: values.host, init: flags.has("init") });
else if (command === "status") code = runStatus(deps);
else code = runPause(deps, { paused: command === "pause", project: values.project, note: values.note });
process.exit(code);
