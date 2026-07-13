#!/usr/bin/env bun
// `bun run landed` — check every board item that carries a `links.pr` against
// whether its work has landed on the project's integration branch, so agents
// don't have to reason per-item about which repo/PR to look at. v1 implements
// only the `github` adapter (checks PR merge state via `gh pr view`); a `git`
// adapter (checking the integration branch directly, for projects that don't use
// GitHub PRs) is a later addition — until then, git-adapter items are reported as
// SKIP so they stay visible without failing the run.
//
// Default (read-only): never mutates item files or the board. `--apply`
// additionally records observed merges — it flips `implemented -> merged` for any
// github-adapter item whose PR is MERGED, writing the auto-set fields (next-actor:
// agent, autonomy: auto, next-step) and updating the board row. Recording a merge
// is a fact, not the merge itself: merging (and deploying) stays a human step.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { formatSnapshotDate } from "./date.ts";
import { loadConfig } from "./config.ts";
import { loadItemsDir } from "./parse.ts";
import { replaceActiveRow } from "./render.ts";
import {
  applyMergedFrontmatter,
  buildMergeReport,
  itemsToFlipMerged,
  parsePrUrl,
  tokenPathForOrg,
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

/** Reads the configured token for an org, expanding a leading "~" to the home
 *  directory (config.ts stores the raw configured path; expansion is our job).
 *  Returns null (ambient gh auth) when no token is configured or the file can't
 *  be read. */
function tokenForOrg(org: string): string | null {
  const configuredPath = tokenPathForOrg(config, org);
  if (!configuredPath) return null;
  const expanded = configuredPath.startsWith("~")
    ? join(homedir(), configuredPath.slice(1))
    : configuredPath;
  try {
    return readFileSync(expanded, "utf8").trim();
  } catch {
    return null;
  }
}

interface GhPrView {
  state: PrState;
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
}

/** IO boundary: ask gh about one PR. Uses the org's configured token when there is
 *  one, else ambient gh auth. Any failure is captured as an error PrStatus rather
 *  than thrown, so one unreachable PR doesn't abort the whole scan. */
function fetchPrStatus(url: string): PrStatus {
  const ref = parsePrUrl(url);
  if (!ref) return { url, error: "not a recognizable GitHub PR URL" };

  const token = tokenForOrg(ref.org);
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;

  const result = spawnSync("gh", ["pr", "view", url, "--json", "state,mergedAt,mergeCommit"], {
    env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    return { url, error: stderr || `gh exited ${result.status}` };
  }

  try {
    const parsed = JSON.parse(result.stdout) as GhPrView;
    return {
      url,
      state: parsed.state,
      mergedAt: parsed.mergedAt ?? undefined,
      mergeCommit: parsed.mergeCommit?.oid,
    };
  } catch (cause) {
    return { url, error: `could not parse gh output: ${String(cause)}` };
  }
}

const apply = process.argv.includes("--apply");

const items = loadItemsDir(join(ROOT, "items"));
const prItems = items.filter((i) => Boolean(i.links.pr));

if (prItems.length === 0) {
  console.log("No items carry a links.pr — nothing to check.");
  process.exit(0);
}

const gitAdapterItems = prItems.filter((i) => effectiveAdapter(i.project) === "git");
const githubAdapterItems = prItems.filter((i) => effectiveAdapter(i.project) === "github");

for (const item of gitAdapterItems) {
  console.log(`  · SKIP (git adapter not yet implemented)  ${item.slug}  ${item.links.pr}`);
}

if (githubAdapterItems.length === 0) {
  process.exit(0);
}

const prUrls = [...new Set(githubAdapterItems.map((i) => i.links.pr).filter((pr): pr is string => Boolean(pr)))];

console.log(`\nChecking ${prUrls.length} PR(s) across ${githubAdapterItems.length} item(s)…\n`);

const statusByUrl = new Map<string, PrStatus>();
for (const url of prUrls) {
  statusByUrl.set(url, fetchPrStatus(url));
}

const report = buildMergeReport(githubAdapterItems, statusByUrl);

const icon = (state: PrState | "ERROR"): string =>
  state === "MERGED" ? "✓" : state === "ERROR" ? "!" : state === "CLOSED" ? "✗" : "·";

for (const row of report.rows) {
  const flags: string[] = [];
  if (row.staleReviewMerge) flags.push("STALE → advance");
  if (row.closedUnmerged) flags.push("CLOSED, not merged");
  if (row.error) flags.push(row.error);
  const suffix = flags.length ? `  [${flags.join("; ")}]` : "";
  console.log(
    `  ${icon(row.state)} ${row.state.padEnd(6)} ${row.itemState}/${row.awaiting ?? "-"}  ${row.slug}  ${row.prUrl}${suffix}`,
  );
}

const flippable = itemsToFlipMerged(githubAdapterItems, statusByUrl);

if (apply) {
  if (!flippable.length) {
    console.log("\n--apply: no implemented item has a newly MERGED PR. Nothing to record.");
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
    `\n--apply: recorded ${flippable.length} merge(s) (implemented → merged, now agent-owned for verification):`,
  );
  for (const item of flippable) console.log(`  ✓ ${item.slug}`);
  console.log("\nAdd the merge to each item's ## Log, then verify per the loops-pickup skill.");
  process.exit(0);
}

if (report.stale.length) {
  console.log(
    `\n${report.stale.length} item(s) have a MERGED PR but are still awaiting review-merge — record with \`bun run landed --apply\`:`,
  );
  for (const row of report.stale) {
    console.log(`  - ${row.slug} (merged ${row.mergedAt ?? "?"}) — ${row.prUrl}`);
  }
  process.exit(1);
}

console.log("\nNo stale review-merge items. Board is consistent with GitHub.");
