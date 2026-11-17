#!/usr/bin/env bun
// Lists a project's permanent worktree slots on this host and which are idle, then names the
// first idle slot and the next free slot name. Run from the data repo root:
//
//   bun <DCL>/tools/cli-slots.ts --project <name> --host <host> --tool <tool> [--item <slug>] [--no-fetch]
//
// Fetches origin first (best effort; offline, it reports on the last-known state). Creates,
// switches and rebases nothing. `--item` leaves that item's own claim out, so a session can
// re-check the slot it just claimed for a competing claim. Prints FIRST_IDLE= and NEXT_FREE=
// lines for scripts. Exit 0 on a report, 2 on a usage or configuration error.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { loadItemsDir } from "./parse.ts";
import { expandHome } from "./registration.ts";
import { slotReport, TOOL_PATTERN } from "./slots.ts";

const USAGE = "usage: cli-slots.ts --project <name> --host <host> --tool <tool> [--item <slug>] [--no-fetch]";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const args = process.argv.slice(2);
const opts: Record<string, string> = {};
let fetch = true;
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--no-fetch") fetch = false;
  else if (arg === "--project" || arg === "--host" || arg === "--tool" || arg === "--item") {
    const value = args[++i];
    if (!value) fail(`${arg} needs a value\n${USAGE}`);
    opts[arg.slice(2)] = value;
  } else fail(`unknown argument ${arg}\n${USAGE}`);
}
for (const key of ["project", "host", "tool"]) if (!opts[key]) fail(`--${key} is required\n${USAGE}`);
if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.host!)) fail("--host must be lowercase letters, digits and hyphens");
if (!TOOL_PATTERN.test(opts.tool!)) fail("--tool must be one token of lowercase letters and digits (claude, codex, ...)");

const ROOT = process.cwd();
if (!existsSync(join(ROOT, "BOARD.md"))) fail(`not a loops data repo (no BOARD.md in ${ROOT}) - run from the data repo root`);
const config = loadConfig(ROOT);
const project = config.projects[opts.project!];
if (!project?.repo) fail(`project "${opts.project}" has no repo in loops.json`);
const repo = expandHome(project.repo, process.env.HOME ?? homedir());
if (!existsSync(repo)) fail(`repo ${repo} does not exist on this host`);
const integrationBranch = project.integrationBranch ?? config.integrationBranch;

if (fetch) spawnSync("git", ["-C", repo, "fetch", "--quiet", "origin"], { encoding: "utf8" });

const claims = loadItemsDir(join(ROOT, "items"))
  .filter((item) => item.project === opts.project && item.slug !== opts.item)
  .map((item) => ({ slug: item.slug, state: item.state, host: item.execution?.host, worktree: item.execution?.worktree }));

const report = slotReport({ repo, host: opts.host!, tool: opts.tool!, integrationBranch, claims });

console.log(`Slots of ${opts.project} on ${opts.host} (integration: ${report.integrationRef}):`);
if (!report.slots.length) console.log("  (none)");
for (const slot of report.slots) {
  const status = slot.idle ? "idle" : `busy - ${slot.reasons.join("; ")}`;
  console.log(`  ${slot.idle ? "·" : "✗"} ${slot.name}  ${slot.path}  [${slot.branch}]  ${status}`);
}
console.log(`FIRST_IDLE=${report.firstIdle ? `${report.firstIdle.name} ${report.firstIdle.path}` : "-"}`);
console.log(`NEXT_FREE=${report.nextFree} ${join(repo, ".worktrees", report.nextFree)}`);
