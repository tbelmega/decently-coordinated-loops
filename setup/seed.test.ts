// End-to-end tests for setup/seed.ts: new mode, idempotency, join mode, config
// block, and the seeded repo passing check/sync (the spec's acceptance e2e).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { END_MARK, START_MARK, renderConfigBlock, renderCursorRule } from "./config-block.ts";

const DCL_HOME = resolve(import.meta.dirname, "..");
const SEED = join(DCL_HOME, "setup", "seed.ts");

function run(args: string[], opts: { cwd?: string; home?: string } = {}): SpawnSyncReturns<string> {
  return spawnSync("bun", args, {
    cwd: opts.cwd ?? DCL_HOME,
    encoding: "utf8",
    env: { ...process.env, HOME: opts.home ?? process.env.HOME! },
  });
}

function seedNewRepo(extra: string[] = [], home?: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "loops-e2e-")), "data");
  const result = run(
    ["run", SEED, dir, "--owner", "casey", "--branch", "main", ...extra],
    { home },
  );
  expect(result.status).toBe(0);
  return dir;
}

describe("seed: new mode", () => {
  test("scaffolds a complete data repo with placeholders filled", () => {
    const dir = seedNewRepo(["--skip-harness", "--projects", "atlas=~/src/atlas"]);

    for (const file of [
      "README.md",
      "BOARD.md",
      "INBOX.md",
      "OUTBOX.md",
      "ARCHIVE.md",
      "PROJECTS.md",
      "HOUSE-RULES.md",
      "loops.json",
      "package.json",
      ".loops-version",
      ".gitignore",
    ]) {
      expect(existsSync(join(dir, file))).toBe(true);
    }
    for (const d of ["items", "for-delivery", "archive"]) {
      expect(existsSync(join(dir, d, ".gitkeep"))).toBe(true);
    }

    const houseRules = readFileSync(join(dir, "HOUSE-RULES.md"), "utf8");
    expect(houseRules).toContain("casey");
    expect(houseRules).not.toContain("{{OWNER}}");

    const inbox = readFileSync(join(dir, "INBOX.md"), "utf8");
    expect(inbox).toContain("---- dump below this line ----");
    expect(inbox).toContain(DCL_HOME);

    const config = JSON.parse(readFileSync(join(dir, "loops.json"), "utf8"));
    expect(config.owner).toBe("casey");
    expect(config.integrationBranch).toBe("main");
    expect(config.projects.atlas.repo).toBe("~/src/atlas");

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.scripts.check).toContain("cli-check.ts");
    expect(pkg.scripts.check).toContain(DCL_HOME);

    const projects = readFileSync(join(dir, "PROJECTS.md"), "utf8");
    expect(projects).toContain("## atlas");

    // git repo with the initial commit
    const log = spawnSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" });
    expect(log.stdout).toContain("Seed loops data repo");
  });

  test("is idempotent — re-running never overwrites existing files", () => {
    const dir = seedNewRepo(["--skip-harness"]);
    const marker = "user content that must survive\n";
    writeFileSync(join(dir, "INBOX.md"), marker);

    const rerun = run(["run", SEED, dir, "--owner", "other", "--skip-harness", "--join"]);
    expect(rerun.status).toBe(0);
    expect(readFileSync(join(dir, "INBOX.md"), "utf8")).toBe(marker);
  });

  test("requires --owner when non-interactive", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "loops-e2e-")), "data");
    const result = run(["run", SEED, dir, "--skip-harness"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--owner");
  });

  test("refuses to seed into a non-empty directory (would commit unrelated files)", () => {
    const dir = mkdtempSync(join(tmpdir(), "loops-e2e-"));
    writeFileSync(join(dir, "my-notes.txt"), "pre-existing user file\n");
    const result = run(["run", SEED, dir, "--owner", "casey", "--skip-harness"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not empty");
    // the user's file is untouched and no scaffold was written
    expect(readFileSync(join(dir, "my-notes.txt"), "utf8")).toBe("pre-existing user file\n");
    expect(existsSync(join(dir, "BOARD.md"))).toBe(false);
  });

  test("seeds into an existing empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "loops-e2e-"));
    const result = run(["run", SEED, dir, "--owner", "casey", "--skip-harness"]);
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, "BOARD.md"))).toBe(true);
  });
});

describe("seeded repo passes the board tools", () => {
  test("check green on skeleton; sync moves an accepted item to archive", () => {
    const dir = seedNewRepo(["--skip-harness"]);

    const check = run(["run", join(DCL_HOME, "tools", "cli-check.ts")], { cwd: dir });
    expect(check.status).toBe(0);

    // File a dummy item in a terminal state; sync must move it and record it.
    writeFileSync(
      join(dir, "items", "atlas-search-index.md"),
      `---
title: Search index rebuild
project: atlas
state: accepted
owner: "-"
autonomy: "-"
next-actor: owner
next-step: none
updated: 2026-01-01
links: {}
---

Test item.

## Log
- 2026-01-01: filed.
`,
    );

    const sync = run(["run", join(DCL_HOME, "tools", "cli-sync.ts")], { cwd: dir });
    expect(sync.status).toBe(0);
    expect(existsSync(join(dir, "items", "atlas-search-index.md"))).toBe(false);
    expect(existsSync(join(dir, "archive", "atlas-search-index.md"))).toBe(true);
    expect(readFileSync(join(dir, "ARCHIVE.md"), "utf8")).toContain("Search index rebuild");
    expect(readFileSync(join(dir, "BOARD.md"), "utf8")).not.toContain("atlas-search-index");

    // sync is repeat-safe
    const again = run(["run", join(DCL_HOME, "tools", "cli-sync.ts")], { cwd: dir });
    expect(again.status).toBe(0);
  });
});

describe("seed: join mode", () => {
  test("wires a cloned repo without touching data", () => {
    const original = seedNewRepo(["--skip-harness"]);
    const clone = join(mkdtempSync(join(tmpdir(), "loops-e2e-")), "clone");
    spawnSync("git", ["clone", "-q", original, clone], { encoding: "utf8" });
    // A fresh clone has data files but (say) lost nothing; simulate a machine
    // where package.json was never committed by removing it from the worktree.
    spawnSync("rm", [join(clone, "package.json")], { encoding: "utf8" });
    const boardBefore = readFileSync(join(clone, "BOARD.md"), "utf8");

    const result = run(["run", SEED, clone, "--join", "--skip-harness"]);
    expect(result.status).toBe(0);
    expect(existsSync(join(clone, "package.json"))).toBe(true);
    expect(readFileSync(join(clone, "BOARD.md"), "utf8")).toBe(boardBefore);
  });

  test("join refuses a directory that is not a data repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "loops-e2e-"));
    const result = run(["run", SEED, dir, "--join", "--skip-harness"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no BOARD.md");
  });
});

describe("generated receipt contract", () => {
  // Both wrappers emit the same body, so assert the policy once per wrapper. Without
  // this, deleting the fourth receipt line or the owner-no-reply rule from the
  // template would leave the suite green while every seeded or refreshed harness
  // config silently lost it.
  const params = { owner: "casey", dataRepo: "/tmp/board", dclHome: "/tmp/dcl" };

  test.each([
    ["markered block", renderConfigBlock(params)],
    ["cursor rule", renderCursorRule(params)],
  ])("%s carries the four-line receipt, ending the handoff", (_name, rendered) => {
    expect(rendered).toContain("IMPLEMENTATION: COMPLETE|INCOMPLETE");
    expect(rendered).toContain("VERIFICATION: PASSED|FAILED|NOT RUN");
    expect(rendered).toContain("REVIEW: PASSED|REQUESTED|BLOCKED|NOT CONFIGURED|WAIVED|NOT RUN");
    expect(rendered).toContain("NEXT STEP/OPTIONS:");

    // Placement: the receipt closes the handoff rather than opening it.
    expect(rendered).toContain("**End** that final item handoff with this receipt");

    // The line is only useful if it offers a way out that is not "keep reviewing".
    expect(rendered).toContain("`--max-rounds`");
    expect(rendered).toContain("deferred-to-human");
    expect(rendered).toContain("WAIVED");
    expect(rendered).toContain("drop the change");

    // The corollary that actually keeps the board honest.
    expect(rendered).toContain(
      "leave the item in a state that is still accurate if the\nowner never replies",
    );
  });

  test("orders the four receipt lines as implementation, verification, review, next step", () => {
    const rendered = renderConfigBlock(params);
    const positions = [
      rendered.indexOf("IMPLEMENTATION: COMPLETE|INCOMPLETE"),
      rendered.indexOf("VERIFICATION: PASSED|FAILED|NOT RUN"),
      rendered.indexOf("REVIEW: PASSED|REQUESTED"),
      rendered.indexOf("NEXT STEP/OPTIONS:"),
    ];

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("config block", () => {
  test("installed into detected harness configs, idempotently", () => {
    const home = mkdtempSync(join(tmpdir(), "loops-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# My rules\n");

    const dir = seedNewRepo([], home);
    const claudeMd = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("# My rules");
    expect(claudeMd).toContain("LOOPS:START");
    expect(claudeMd).toContain(dir);
    expect(claudeMd).toContain("casey");
    expect(claudeMd).toContain("IMPLEMENTATION: COMPLETE|INCOMPLETE");
    expect(claudeMd).toContain("REVIEW: PASSED|REQUESTED|BLOCKED|NOT CONFIGURED|WAIVED|NOT RUN");
    expect(claudeMd).toContain(
      "after all of its internal tasks and commits are complete and final\nverification passes",
    );
    // Re-running replaces the block instead of duplicating it.
    const rerun = run(["run", SEED, dir, "--join", "--owner", "casey"], { home });
    expect(rerun.status).toBe(0);
    const after = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(after.split("LOOPS:START").length).toBe(2);
    // No .codex dir in this fake home — must not have been created.
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  test("refreshes marker-bearing alternate Claude profiles but never seeds them", () => {
    const home = mkdtempSync(join(tmpdir(), "loops-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    // Opted in: already carries the markered block.
    mkdirSync(join(home, ".claude-work"), { recursive: true });
    writeFileSync(
      join(home, ".claude-work", "CLAUDE.md"),
      `# Work rules\n${START_MARK}\nold block\n${END_MARK}\n`,
    );
    // Not opted in: no marker — must be left untouched.
    mkdirSync(join(home, ".claude-scratch"), { recursive: true });
    writeFileSync(join(home, ".claude-scratch", "CLAUDE.md"), "# Scratch rules\n");

    const dir = seedNewRepo([], home);

    const optedIn = readFileSync(join(home, ".claude-work", "CLAUDE.md"), "utf8");
    expect(optedIn).toContain("# Work rules");
    expect(optedIn).toContain(dir);
    expect(optedIn).not.toContain("old block");
    expect(readFileSync(join(home, ".claude-scratch", "CLAUDE.md"), "utf8")).toBe("# Scratch rules\n");
  });

  test("writes a Cursor .mdc rule when ~/.cursor exists, and refreshes idempotently", () => {
    const home = mkdtempSync(join(tmpdir(), "loops-home-"));
    mkdirSync(join(home, ".cursor"), { recursive: true });

    const dir = seedNewRepo([], home);
    const rulePath = join(home, ".cursor", ".cursor", "rules", "loops.mdc");
    expect(existsSync(rulePath)).toBe(true);
    const rule = readFileSync(rulePath, "utf8");
    expect(rule).toContain("alwaysApply: true");
    expect(rule).toContain("## Work-stream board (decently-coordinated-loops)");
    expect(rule).toContain(dir);
    expect(rule).toContain("casey");
    // Cursor rules use YAML frontmatter, not the HTML markers.
    expect(rule).not.toContain("LOOPS:START");

    // Re-running refreshes the whole file — one frontmatter, no duplication.
    const rerun = run(["run", SEED, dir, "--join", "--owner", "casey"], { home });
    expect(rerun.status).toBe(0);
    expect(readFileSync(rulePath, "utf8").split("alwaysApply: true").length).toBe(2);
  });

  test("no Cursor rule when ~/.cursor is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "loops-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    seedNewRepo([], home);
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  });
});
