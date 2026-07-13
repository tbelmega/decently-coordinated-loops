#!/usr/bin/env bun
// `bun setup/seed.ts <target-dir>` — stand up a loops data repo.
//
// Two modes:
//   - new (default): scaffold a fresh data repo from setup/templates/ — board,
//     queues, registries, loops.json, package.json, version stamp — and install
//     the agent-config block into this machine's harness configs.
//   - join (--join, or auto-detected when the target already has a BOARD.md):
//     the target is an existing data repo (e.g. cloned onto a second machine).
//     Touches no data — only fills in package.json / .loops-version if missing
//     and refreshes this machine's config block.
//
// Idempotent: existing files are never overwritten; re-running is safe.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { detectConfigTargets, renderConfigBlock, upsertConfigBlock } from "./config-block.ts";

const DCL_HOME = resolve(import.meta.dirname, "..");
const TEMPLATES = join(DCL_HOME, "setup", "templates");

interface Options {
  targetDir: string;
  join: boolean;
  owner?: string;
  branch?: string;
  /** "name=~/path,name2=~/path2" */
  projects?: string;
  /** Skip harness config-block installation (used by tests / unusual setups). */
  skipHarness: boolean;
  home: string;
}

function usage(): never {
  console.error(
    "usage: bun setup/seed.ts <target-dir> [--join] [--owner NAME] [--branch BRANCH] " +
      "[--projects name=path[,name=path...]] [--skip-harness]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    targetDir: "",
    join: false,
    skipHarness: false,
    home: process.env.HOME ?? homedir(),
  };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--join") opts.join = true;
    else if (arg === "--skip-harness") opts.skipHarness = true;
    else if (arg === "--owner") opts.owner = args.shift() ?? usage();
    else if (arg === "--branch") opts.branch = args.shift() ?? usage();
    else if (arg === "--projects") opts.projects = args.shift() ?? usage();
    else if (arg.startsWith("-")) usage();
    else if (!opts.targetDir) opts.targetDir = arg;
    else usage();
  }
  if (!opts.targetDir) usage();
  return opts;
}

async function promptMissing(opts: Options): Promise<void> {
  if (opts.owner) return;
  if (!process.stdin.isTTY) {
    console.error("missing --owner (required when not running interactively)");
    process.exit(2);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  opts.owner = (await rl.question("Owner name (how agents should refer to you): ")).trim();
  if (!opts.branch) {
    const answer = (await rl.question("Default integration branch [master]: ")).trim();
    opts.branch = answer || "master";
  }
  if (opts.projects == null) {
    opts.projects =
      (await rl.question("Initial projects as name=path, comma-separated (or empty): ")).trim();
  }
  rl.close();
  if (!opts.owner) {
    console.error("owner name is required");
    process.exit(2);
  }
}

function parseProjects(spec: string | undefined): Array<{ name: string; repo: string }> {
  if (!spec) return [];
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf("=");
      if (eq < 1) {
        console.error(`--projects entry "${entry}" is not name=path`);
        process.exit(2);
      }
      return { name: entry.slice(0, eq).trim(), repo: entry.slice(eq + 1).trim() };
    });
}

function dclCommit(): string {
  const result = spawnSync("git", ["-C", DCL_HOME, "rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

/** Writes `content` to `path` unless the file already exists. */
function writeNew(path: string, content: string): boolean {
  if (existsSync(path)) {
    console.log(`  = ${basename(path)} exists — left untouched`);
    return false;
  }
  writeFileSync(path, content);
  console.log(`  + ${basename(path)}`);
  return true;
}

function fillTemplate(name: string, replacements: Record<string, string>): string {
  let text = readFileSync(join(TEMPLATES, name), "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  return text;
}

function packageJsonText(root: string): string {
  const scriptFor = (cli: string) => `bun "\${DCL_HOME:-${DCL_HOME}}/tools/${cli}.ts"`;
  return `${JSON.stringify(
    {
      name: basename(root),
      private: true,
      scripts: {
        check: scriptFor("cli-check"),
        sync: scriptFor("cli-sync"),
        landed: scriptFor("cli-landed"),
      },
    },
    null,
    2,
  )}\n`;
}

function installConfigBlock(opts: Options, root: string): void {
  if (opts.skipHarness) return;
  const owner = opts.owner ?? "the owner";
  const block = renderConfigBlock({ owner, dataRepo: root, dclHome: DCL_HOME });
  const targets = detectConfigTargets(opts.home);
  if (!targets.length) {
    console.log("no harness config directories detected — config block not installed");
    return;
  }
  for (const target of targets) {
    const action = upsertConfigBlock(target, block);
    console.log(`  config block ${action}: ${target}`);
  }
}

const opts = parseArgs(process.argv.slice(2));
const root = resolve(opts.targetDir);
const joinMode = opts.join || existsSync(join(root, "BOARD.md"));

if (joinMode) {
  console.log(`joining existing data repo at ${root}`);
  if (!existsSync(join(root, "BOARD.md"))) {
    console.error(`--join: ${root} has no BOARD.md — not a loops data repo`);
    process.exit(2);
  }
  // Owner for the config block: prefer the repo's own loops.json over prompting.
  if (!opts.owner) {
    try {
      const config = JSON.parse(readFileSync(join(root, "loops.json"), "utf8"));
      if (typeof config.owner === "string" && config.owner) opts.owner = config.owner;
    } catch {
      // no loops.json or unreadable — block falls back to "the owner"
    }
  }
  writeNew(join(root, "package.json"), packageJsonText(root));
  writeNew(join(root, ".loops-version"), `${dclCommit()}\n`);
  installConfigBlock(opts, root);
  console.log("join complete.");
  process.exit(0);
}

await promptMissing(opts);
const owner = opts.owner!;
const branch = opts.branch ?? "master";
const projects = parseProjects(opts.projects);

console.log(`seeding new data repo at ${root}`);
mkdirSync(root, { recursive: true });

let inited = false;
if (!existsSync(join(root, ".git"))) {
  const init = spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  if (init.status !== 0) {
    console.error(`git init failed: ${init.stderr}`);
    process.exit(1);
  }
  inited = true;
  console.log("  + git init");
}

const replacements = {
  OWNER: owner,
  DCL_HOME,
  INTEGRATION_BRANCH: branch,
  REPO_NAME: basename(root),
};

for (const template of ["README.md", "BOARD.md", "INBOX.md", "OUTBOX.md", "ARCHIVE.md", "HOUSE-RULES.md"]) {
  writeNew(join(root, template), fillTemplate(template, replacements));
}

// PROJECTS.md: template plus one seeded entry per prompted project.
const projectEntries = projects
  .map(
    (p) => `
## ${p.name}

- repo: \`${p.repo}\`
- integration branch: \`${branch}\`
- quality gate: TODO
- verify gate: TODO
- specs / follow-ups: TODO
- notes: TODO
`,
  )
  .join("");
writeNew(join(root, "PROJECTS.md"), fillTemplate("PROJECTS.md", replacements) + projectEntries);

writeNew(join(root, ".gitignore"), readFileSync(join(TEMPLATES, "gitignore"), "utf8"));
writeNew(
  join(root, "loops.json"),
  `${JSON.stringify(
    {
      owner,
      priorityProjects: [],
      integrationBranch: branch,
      landedAdapter: "git",
      githubTokens: {},
      projects: Object.fromEntries(projects.map((p) => [p.name, { repo: p.repo }])),
    },
    null,
    2,
  )}\n`,
);
writeNew(join(root, "package.json"), packageJsonText(root));
writeNew(join(root, ".loops-version"), `${dclCommit()}\n`);

for (const dir of ["items", "for-delivery", "archive"]) {
  mkdirSync(join(root, dir), { recursive: true });
  writeNew(join(root, dir, ".gitkeep"), "");
}

installConfigBlock(opts, root);

if (inited) {
  const add = spawnSync("git", ["-C", root, "add", "-A"], { encoding: "utf8" });
  const commit = spawnSync(
    "git",
    ["-C", root, "commit", "-q", "-m", "Seed loops data repo"],
    { encoding: "utf8" },
  );
  if (add.status !== 0 || commit.status !== 0) {
    console.log("  ! initial commit failed — commit manually");
  } else {
    console.log("  + initial commit");
  }
}

console.log(`
seed complete. Next steps:
  1. Fill in the TODO sections of HOUSE-RULES.md (roster, review mechanism).
  2. Register your projects' gates in PROJECTS.md.
  3. Add a git remote and push — origin is the source of truth across machines.
  4. Try it: cd ${root} && bun run check`);
