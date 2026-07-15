#!/usr/bin/env bun
// `bun cli-registered.ts --data-repo <dir> [--cwd <dir>]` — the project-participation
// gate. Unlike the other tools, this runs from inside an *arbitrary* project checkout
// (not the data repo): it answers "should I engage the board here?" for the harness
// config block, before any board read.
//
// Exit codes:
//   0 — registered. Prints the project name (or "(data repo)") to stdout.
//   1 — not a registered project (or the cwd isn't a git checkout). Prints nothing.
//   2 — usage error / the --data-repo path doesn't exist.
import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { expandHome, matchProject, type Canonicalize } from "./registration.ts";

interface Options {
  dataRepo: string;
  cwd: string;
  home: string;
}

function usage(): never {
  console.error("usage: bun cli-registered.ts --data-repo <dir> [--cwd <dir>]");
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { dataRepo: "", cwd: process.cwd(), home: process.env.HOME ?? homedir() };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--data-repo") opts.dataRepo = args.shift() ?? usage();
    else if (arg === "--cwd") opts.cwd = args.shift() ?? usage();
    else usage();
  }
  if (!opts.dataRepo) usage();
  return opts;
}

/** git in `cwd`, or null if the command fails (e.g. not a git repo). */
function git(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

const opts = parseArgs(process.argv.slice(2));
const dataRepo = resolve(expandHome(opts.dataRepo, opts.home));
if (!existsSync(dataRepo)) {
  console.error(`data repo not found: ${dataRepo}`);
  process.exit(2);
}

// The checkout to test, plus its main checkout root — for a linked worktree these
// differ, and either matching a registered repo counts as registered.
const worktreeRoot = git(opts.cwd, ["rev-parse", "--show-toplevel"]);
if (worktreeRoot === null) process.exit(1); // not a git checkout → not participating
const commonDir = git(opts.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
const mainCheckoutRoot = commonDir ? commonDir.replace(/\/\.git\/?$/, "") : worktreeRoot;

const canonicalize: Canonicalize = (path) => {
  const expanded = resolve(expandHome(path, opts.home));
  try {
    return realpathSync.native(expanded);
  } catch {
    return expanded; // path doesn't exist — fall back to the lexical form
  }
};

const candidateRoots = [worktreeRoot, mainCheckoutRoot];

// The data repo itself always participates (board upkeep, queues, sync) whether or not
// it is registered as a project in loops.json.
if (candidateRoots.map(canonicalize).includes(canonicalize(dataRepo))) {
  console.log("(data repo)");
  process.exit(0);
}

const config = loadConfig(dataRepo);
const project = matchProject(config.projects, candidateRoots, canonicalize);
if (project) {
  console.log(project);
  process.exit(0);
}
process.exit(1);
