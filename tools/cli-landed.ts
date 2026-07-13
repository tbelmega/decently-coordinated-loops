#!/usr/bin/env bun
// `bun run landed` — check every board item that carries a work ref (a review URL
// or a branch) against whether its work has landed on the project's integration
// branch, so agents don't have to reason per-item about which repo/ref to look at.
//
// Two adapters, selected per project in loops.json (`landedAdapter`, project
// override wins):
//   - github: asks `gh pr view` for the PR's merge state (authoritative; correct
//     for squash- and rebase-merges). Needs a `links.pr`.
//   - git:    patch-id equivalence of the item's `links.branch` against the
//     integration branch (see git-landed.ts) — for flows that don't go through a
//     forge API. Correct for rebase landings; a squash-with-edits landing reads as
//     PENDING (record those by hand).
//
// Default (read-only): never mutates item files or the board. `--apply`
// additionally records observed landings — it flips `implemented -> merged` for
// any item whose work is reported landed, writing the auto-set fields (next-actor:
// agent, autonomy: auto, next-step) and updating the board row. Recording a
// landing is a fact, not the landing itself: merging (and deploying) stays the
// owner's step unless house rules delegate it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { formatSnapshotDate } from "./date.ts";
import { loadConfig } from "./config.ts";
import { gitLandedStatus } from "./git-landed.ts";
import { loadItemsDir } from "./parse.ts";
import { replaceActiveRow } from "./render.ts";
import {
  applyMergedFrontmatter,
  buildMergeReport,
  itemsToFlipMerged,
  parsePrUrl,
  tokenPathForOrg,
  workRef,
  type PrState,
  type PrStatus,
} from "./merge-status.ts";

const ROOT = process.cwd();

if (!existsSync(join(ROOT, "BOARD.md"))) {
  console.error(`not a loops data repo (no BOARD.md in ${ROOT}) — run from the data repo root`);
  process.exit(2);
}

const config = loadConfig(ROOT);

function effectiveAdapter(project: string): "github" | "git" {
  return config.projects[project]?.landedAdapter ?? config.landedAdapter;
}

function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

/** Reads the configured token for an org, expanding a leading "~" to the home
 *  directory. Returns null (ambient gh auth) when no token is configured or the
 *  file can't be read. */
function tokenForOrg(org: string): string | null {
  const configuredPath = tokenPathForOrg(config, org);
  if (!configuredPath) return null;
  try {
    return readFileSync(expandHome(configuredPath), "utf8").trim();
  } catch {
    return null;
  }
}

interface GhPrView {
  state: PrState;
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
}

/** IO boundary, github adapter: ask gh about one PR. Uses the org's configured
 *  token when there is one, else ambient gh auth. Any failure is captured as an
 *  error PrStatus rather than thrown, so one unreachable PR doesn't abort the
 *  whole scan. */
function fetchPrStatus(ref: string): PrStatus {
  const prRef = parsePrUrl(ref);
  if (!prRef) return { ref, error: "not a recognizable GitHub PR URL" };

  const token = tokenForOrg(prRef.org);
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;

  const result = spawnSync("gh", ["pr", "view", ref, "--json", "state,mergedAt,mergeCommit"], {
    env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    return { ref, error: stderr || `gh exited ${result.status}` };
  }

  try {
    const parsed = JSON.parse(result.stdout) as GhPrView;
    return {
      ref,
      state: parsed.state,
      mergedAt: parsed.mergedAt ?? undefined,
      mergeCommit: parsed.mergeCommit?.oid,
    };
  } catch (cause) {
    return { ref, error: `could not parse gh output: ${String(cause)}` };
  }
}

const fetchedRepos = new Set<string>();

/** IO boundary, git adapter: refresh the integration branch's remote-tracking ref
 *  (best effort — offline is fine, the check then runs on the last-known state),
 *  then compare the item's branch by patch-id. */
function fetchGitStatus(item: { project: string; slug: string }, branch: string): PrStatus {
  const projectConfig = config.projects[item.project];
  if (!projectConfig?.repo) {
    return {
      ref: branch,
      error: `project "${item.project}" has no repo configured in loops.json`,
    };
  }
  const repoDir = expandHome(projectConfig.repo);
  const integrationBranch = projectConfig.integrationBranch ?? config.integrationBranch;

  if (!fetchedRepos.has(repoDir)) {
    fetchedRepos.add(repoDir);
    spawnSync("git", ["-C", repoDir, "fetch", "--quiet", "origin", integrationBranch], {
      encoding: "utf8",
    });
  }

  const result = gitLandedStatus(repoDir, branch, integrationBranch);
  if (result.error) return { ref: branch, error: result.error };
  return { ref: branch, state: result.state === "LANDED" ? "MERGED" : "OPEN" };
}

const apply = process.argv.includes("--apply");

const items = loadItemsDir(join(ROOT, "items"));
const checkable = items.filter((i) => workRef(i) !== null);

if (checkable.length === 0) {
  console.log("No items carry a links.pr or links.branch — nothing to check.");
  process.exit(0);
}

console.log(`Checking ${checkable.length} item(s)…\n`);

const statusByRef = new Map<string, PrStatus>();
for (const item of checkable) {
  const ref = workRef(item)!;
  if (statusByRef.has(ref)) continue;
  const adapter = effectiveAdapter(item.project);
  if (adapter === "github" && item.links.pr) {
    statusByRef.set(ref, fetchPrStatus(ref));
  } else if (item.links.branch) {
    statusByRef.set(item.links.branch, fetchGitStatus(item, item.links.branch));
  } else {
    // github adapter but only a branch link: the PR URL is the missing piece.
    statusByRef.set(ref, { ref, error: "github adapter needs a links.pr (or switch the project to the git adapter)" });
  }
}

const report = buildMergeReport(checkable, statusByRef);

const icon = (state: PrState | "ERROR"): string =>
  state === "MERGED" ? "✓" : state === "ERROR" ? "!" : state === "CLOSED" ? "✗" : "·";

const label = (state: PrState | "ERROR"): string =>
  state === "MERGED" ? "LANDED" : state === "OPEN" ? "PENDING" : state;

for (const row of report.rows) {
  const flags: string[] = [];
  if (row.staleReviewMerge) flags.push("STALE → advance");
  if (row.closedUnmerged) flags.push("CLOSED, not landed");
  if (row.error) flags.push(row.error);
  const suffix = flags.length ? `  [${flags.join("; ")}]` : "";
  console.log(
    `  ${icon(row.state)} ${label(row.state).padEnd(7)} ${row.itemState}/${row.awaiting ?? "-"}  ${row.slug}  ${row.ref}${suffix}`,
  );
}

const flippable = itemsToFlipMerged(checkable, statusByRef);

if (apply) {
  if (!flippable.length) {
    console.log("\n--apply: no implemented item has newly landed work. Nothing to record.");
    process.exit(0);
  }
  const today = formatSnapshotDate(new Date());
  const BOARD_PATH = join(ROOT, "BOARD.md");
  let boardText = readFileSync(BOARD_PATH, "utf8");

  for (const item of flippable) {
    const itemPath = join(ROOT, item.path);
    writeFileSync(itemPath, applyMergedFrontmatter(readFileSync(itemPath, "utf8"), today));
    boardText = replaceActiveRow(boardText, {
      ...item,
      state: "merged",
      nextActor: "agent",
      awaiting: undefined,
      autonomy: "auto",
      nextStep: "Verify per the project verify gate, then flip to tested",
      updated: today,
    });
  }
  writeFileSync(BOARD_PATH, boardText);

  console.log(
    `\n--apply: recorded ${flippable.length} landing(s) (implemented → merged, now agent-owned for verification):`,
  );
  for (const item of flippable) console.log(`  ✓ ${item.slug}`);
  console.log("\nAdd the landing to each item's ## Log, then verify per the loops-pickup skill.");
  process.exit(0);
}

if (report.stale.length) {
  console.log(
    `\n${report.stale.length} item(s) have landed work but are still awaiting review-merge — record with \`bun run landed --apply\`:`,
  );
  for (const row of report.stale) {
    console.log(`  - ${row.slug} (landed ${row.mergedAt ?? "?"}) — ${row.ref}`);
  }
  process.exit(1);
}

console.log("\nNo stale review-merge items. Board is consistent with the integration branches.");
