#!/usr/bin/env bun
// `bun setup/seed.ts <target-dir>` — stand up a loops data repo.
//
// Two modes:
//   - new (default): scaffold a fresh data repo from setup/templates/ — board,
//     queues, registries, loops.json, package.json, version stamp — and install
//     the agent-config block into this machine's harness configs.
//   - join (--join, or auto-detected when the target already has a BOARD.md):
//     the target is an existing data repo (e.g. cloned onto a second machine).
//     Fills in package.json / .loops-version if missing, adds any generated script an
//     older package.json lacks, and refreshes this machine's config block. Touches
//     board data never, and loops.json only on an explicit reviewer answer — that one
//     write is repo-global, so it retargets the review gate for every clone.
//
// Join is also what the seeded repo's `bun run setup` runs against itself, which is
// the command five docs sites and cli-review's error message point at. Reviewer
// choice is repo-global (loops.json is committed); `cli-review --reviewer` is the
// per-machine override.
//
// Idempotent: existing files are never overwritten; re-running is safe.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  detectConfigTargets,
  renderConfigBlock,
  renderCursorRule,
  upsertConfigBlock,
  writeCursorRule,
} from "./config-block.ts";

const DCL_HOME = resolve(import.meta.dirname, "..");
const TEMPLATES = join(DCL_HOME, "setup", "templates");

interface Options {
  targetDir: string;
  join: boolean;
  owner?: string;
  branch?: string;
  /** "name=~/path,name2=~/path2" */
  projects?: string;
  /** Bundled review adapter to activate: "codex" | "claude" | "cursor" | "" (none). */
  reviewer?: string;
  /** Skip harness config-block installation (used by tests / unusual setups). */
  skipHarness: boolean;
  home: string;
}

const REVIEWERS: Array<{ id: string; bin: string }> = [
  { id: "codex", bin: "codex" },
  { id: "claude", bin: "claude" },
  { id: "cursor", bin: "cursor-agent" },
];

/** The review adapters whose CLI is actually installed on this machine. */
function detectReviewers(): string[] {
  return REVIEWERS.filter(({ bin }) => spawnSync(bin, ["--version"], { stdio: "ignore" }).error === undefined).map(
    ({ id }) => id,
  );
}

function usage(): never {
  console.error(
    "usage: bun setup/seed.ts <target-dir> [--join] [--owner NAME] [--branch BRANCH] " +
      "[--projects name=path[,name=path...]] [--reviewer codex|claude|cursor] [--skip-harness]",
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
    else if (arg === "--reviewer") opts.reviewer = args.shift() ?? usage();
    else if (arg.startsWith("-")) usage();
    else if (!opts.targetDir) opts.targetDir = arg;
    else usage();
  }
  if (!opts.targetDir) usage();
  // Normalise here, not at the point of use: join installs the harness config block and
  // fills package.json before it ever reaches the reviewer step, so validating later
  // meant `--reviewer bogus` rewrote this machine's config on its way to exiting 2.
  opts.reviewer = validateReviewer(opts.reviewer);
  return opts;
}

/** Normalises `--reviewer`: a bundled adapter id, or "" for none. Exits on anything
 * else so a typo is never written into loops.json as a silently dead reviewer. */
function validateReviewer(reviewer: string | undefined): string | undefined {
  if (reviewer == null) return undefined;
  const value = reviewer.trim();
  if (value === "" || value === "none") return "";
  if (!REVIEWERS.some((entry) => entry.id === value)) {
    console.error(`--reviewer must be one of ${REVIEWERS.map((entry) => entry.id).join(", ")} or none (got "${value}")`);
    process.exit(2);
  }
  return value;
}

/** New mode only: the identity questions that shape a repo being created. */
async function promptIdentity(opts: Options): Promise<void> {
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

/** Both modes: resolve the review adapter, prompting only when there is a human to
 * ask. Returns undefined for "leave whatever is configured alone" — the answer an
 * unattended run must get, since join is what automation invokes and a dispatcher
 * that inherited a TTY would otherwise block on the question forever. */
async function promptReviewer(opts: Options, current?: string): Promise<string | undefined> {
  if (opts.reviewer != null) return opts.reviewer; // already normalised by parseArgs
  if (!process.stdin.isTTY) return undefined;

  const detected = detectReviewers();
  if (!detected.length) {
    console.log("no supported review CLI (codex/claude/cursor-agent) detected — skipping review activation");
    return current ? undefined : "";
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (
    await rl.question(
      `Activate a local code-review adapter? A reviewer runs read-only and drives\n` +
        `the loops-review loop for finished changes. Detected: ${detected.join(", ")}.\n` +
        (current
          ? `Currently: ${current}. Enter one, 'none', or empty to keep [${current}]: `
          : `Enter one or 'none' [none]: `),
    )
  ).trim();
  rl.close();
  if (!answer) return current ? undefined : "";
  return validateReviewer(answer);
}

/** Sets (or clears) `review.reviewer` in an existing loops.json.
 *
 * Deliberately a raw read-merge-write rather than `writeNew` or the typed loader in
 * tools/config.ts, unlike every neighbouring write in join mode: `writeNew` no-ops on
 * a file that already exists, which is precisely the case here, and round-tripping
 * through `LoopsConfig` would silently drop any key a hand edit or a newer version
 * added. Only the one field is touched. */
/** True only for a plain object. An array passes `typeof x === "object"`, and assigning
 * `.reviewer` to one lands a non-index property that JSON.stringify silently drops — the
 * command would report success and persist nothing. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replaces `path` via a temp file in the same directory plus a rename, so a reader
 * never observes a truncated loops.json. Sync twin of tools/review/atomic-write.ts,
 * inlined to keep setup/ from depending on tools/review/ and to match this file's
 * all-sync style. */
function writeFileAtomically(path: string, content: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, content);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function applyReviewer(root: string, reviewer: string): void {
  const path = join(root, "loops.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`cannot update ${path}: ${(error as Error).message}`);
    process.exit(1);
  }
  if (!isPlainObject(parsed)) {
    console.error(`cannot update ${path}: top-level value is not a JSON object`);
    process.exit(1);
  }
  const existing = parsed.review;
  if (existing !== undefined && !isPlainObject(existing)) {
    console.error(`cannot update ${path}: "review" is not a JSON object`);
    process.exit(1);
  }
  const review = existing ?? {};
  if (reviewer) review.reviewer = reviewer;
  else delete review.reviewer;
  parsed.review = review;
  writeFileAtomically(path, `${JSON.stringify(parsed, null, 2)}\n`);
  console.log(
    reviewer
      ? `  review adapter: ${reviewer} (loops.json → review.reviewer; drive it per the loops-review skill)`
      : "  review adapter: none",
  );
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
        ready: scriptFor("cli-ready"),
        restamp: scriptFor("cli-restamp"),
        // Join mode against this repo: refresh this machine's harness config and set
        // the review adapter. `.` is safe — bun and npm both run scripts from the
        // package.json directory, whatever the caller's cwd.
        setup: `bun "\${DCL_HOME:-${DCL_HOME}}/setup/seed.ts" --join .`,
      },
    },
    null,
    2,
  )}\n`;
}

/** Adds generated scripts that an existing package.json is missing, and nothing else.
 *
 * Every other join write is `writeNew`, which leaves an existing file alone — correct
 * for data files, wrong for this one: a repo seeded before a script existed would never
 * receive it, so a command the docs promise (`bun run setup` above all) fails on exactly
 * the repos it was added for. Only absent keys are added: a customised script, a
 * user-defined script, and every non-script field are left untouched. */
function addMissingScripts(root: string): void {
  const path = join(root, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.log(`  ! ${basename(path)} is not readable JSON (${(error as Error).message}) — left untouched`);
    return;
  }
  if (!isPlainObject(parsed)) {
    console.log(`  ! ${basename(path)} is not a JSON object — left untouched`);
    return;
  }
  const generated = JSON.parse(packageJsonText(root)).scripts as Record<string, string>;
  const scripts = isPlainObject(parsed.scripts) ? parsed.scripts : {};
  const added = Object.keys(generated).filter((name) => scripts[name] === undefined);
  if (!added.length) {
    console.log(`  = ${basename(path)} exists — every generated script present`);
    return;
  }
  for (const name of added) scripts[name] = generated[name]!;
  parsed.scripts = scripts;
  writeFileAtomically(path, `${JSON.stringify(parsed, null, 2)}\n`);
  console.log(`  + ${basename(path)}: added ${added.join(", ")}`);
}

function installConfigBlock(opts: Options, root: string): void {
  if (opts.skipHarness) return;
  const owner = opts.owner ?? "the owner";
  const params = { owner, dataRepo: root, dclHome: DCL_HOME };
  const block = renderConfigBlock(params);
  const cursorRule = renderCursorRule(params);
  const targets = detectConfigTargets(opts.home);
  if (!targets.length) {
    console.log("no harness config directories detected — config block not installed");
    return;
  }
  for (const target of targets) {
    if (target.kind === "cursor") {
      const action = writeCursorRule(target.path, cursorRule);
      console.log(`  cursor rule ${action}: ${target.path}`);
    } else {
      const action = upsertConfigBlock(target.path, block);
      console.log(`  config block ${action}: ${target.path}`);
    }
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
  if (existsSync(join(root, "package.json"))) addMissingScripts(root);
  else writeNew(join(root, "package.json"), packageJsonText(root));
  writeNew(join(root, ".loops-version"), `${dclCommit()}\n`);
  installConfigBlock(opts, root);

  // The one data field join may change, and only on an explicit answer. Before this,
  // the reviewer prompt was reachable only during the first seed, so a joining machine
  // — and anyone who once answered "none" — had no route back but a hand edit.
  let current: string | undefined;
  try {
    const config = JSON.parse(readFileSync(join(root, "loops.json"), "utf8"));
    if (typeof config.review?.reviewer === "string") current = config.review.reviewer;
  } catch {
    // no loops.json or unreadable — treated as "nothing configured"
  }
  const chosen = await promptReviewer(opts, current);
  if (chosen != null && chosen !== (current ?? "")) applyReviewer(root, chosen);

  console.log("join complete.");
  process.exit(0);
}

// New mode scaffolds into `root` and (on a fresh git init) `git add -A` — so a
// non-empty target would sweep unrelated user files into the seed commit. Refuse it:
// seed into a new or empty directory, or pass --join to wire an existing data repo.
if (existsSync(root) && readdirSync(root).length > 0) {
  console.error(
    `refusing to seed into ${root}: directory is not empty. Seed into a new or empty ` +
      `directory, or pass --join to wire an existing data repo.`,
  );
  process.exit(2);
}

await promptIdentity(opts);
const owner = opts.owner!;
const branch = opts.branch ?? "master";
const projects = parseProjects(opts.projects);
const reviewer = (await promptReviewer(opts)) ?? "";

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
      review: reviewer ? { reviewer } : {},
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

console.log(
  reviewer
    ? `  review adapter: ${reviewer} (loops.json → review.reviewer; drive it per the loops-review skill)`
    : `  review adapter: none — activate later with \`bun run setup\` (see loops-review)`,
);

console.log(`
seed complete. Next steps:
  1. Fill in the TODO sections of HOUSE-RULES.md (roster, review mechanism).
  2. Register your projects' gates in PROJECTS.md.
  3. Add a git remote and push — origin is the source of truth across machines.
  4. Try it: cd ${root} && bun run check`);
