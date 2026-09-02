// End-to-end tests for setup/seed.ts: new mode, idempotency, join mode, config
// block, and the seeded repo passing check/sync (the spec's acceptance e2e).
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  GENERATED_OPEN,
  GENERATED_CLOSE,
  SECTION_OPEN,
  SECTION_CLOSE,
  LEGACY_END_MARK,
  LEGACY_START_MARK,
  detectConfigTargets,
  renderConfigBlock,
  renderCursorRule,
  upsertConfigBlock,
} from "./config-block.ts";

const DCL_HOME = resolve(import.meta.dirname, "..");
const SEED = join(DCL_HOME, "setup", "seed.ts");

function run(args: string[], opts: { cwd?: string; home?: string } = {}): SpawnSyncReturns<string> {
  return spawnSync("bun", args, {
    cwd: opts.cwd ?? DCL_HOME,
    encoding: "utf8",
    env: { ...process.env, HOME: opts.home ?? process.env.HOME! },
  });
}

/** Whether mode bits actually stop this process from listing a directory. False
 * under root, which ignores them - so a permission-based test proves nothing there. */
const PERMISSIONS_ARE_ENFORCED = (() => {
  const probe = mkdtempSync(join(tmpdir(), "loops-perm-probe-"));
  chmodSync(probe, 0o000);
  try {
    readdirSync(probe);
    return false;
  } catch {
    return true;
  } finally {
    chmodSync(probe, 0o700);
  }
})();

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

    const board = readFileSync(join(dir, "BOARD.md"), "utf8");
    expect(board).toContain("| Auto | Assignee | Updated |");
    expect(board).not.toContain("| Auto | Owner | Updated |");

    // git repo with the initial commit
    const log = spawnSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" });
    expect(log.stdout).toContain("Seed loops data repo");
  });

  test("is idempotent - re-running never overwrites existing files", () => {
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

  test("check rejects an archived item with conflicting assignment keys", () => {
    const dir = seedNewRepo(["--skip-harness"]);
    mkdirSync(join(dir, "archive"), { recursive: true });
    writeFileSync(
      join(dir, "archive", "atlas-conflicting-assignment.md"),
      `---
title: Conflicting archived assignment
project: atlas
state: accepted
assignee: codex/default
owner: claude-code/primary
autonomy: auto
next-actor: owner
next-step: none
updated: 2026-08-09
---
`,
    );

    const check = run(["run", join(DCL_HOME, "tools", "cli-check.ts")], { cwd: dir });
    expect(check.status).toBe(1);
    expect(check.stdout).toContain("assignee and legacy owner cannot both be present");
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

// `bun run setup` is join mode aimed at the repo it lives in. Five docs sites plus
// cli-review's error message promise this command; before it existed, the reviewer
// prompt was reachable only during the very first seed, so a second machine - and
// anyone who answered "none" - had no way to it but hand-editing loops.json.
describe("seed: bun run setup (reviewer activation after the first seed)", () => {
  const readConfig = (dir: string) => JSON.parse(readFileSync(join(dir, "loops.json"), "utf8"));

  test("the seeded package.json exposes setup as join against its own directory", () => {
    const dir = seedNewRepo(["--skip-harness"]);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.scripts.setup).toContain("seed.ts");
    expect(pkg.scripts.setup).toContain("--join");
    // `.` is safe: both bun and npm run scripts from the package.json directory.
    expect(pkg.scripts.setup.trimEnd().endsWith(".")).toBe(true);
  });

  test("running the generated setup script activates a reviewer", () => {
    const dir = seedNewRepo(["--skip-harness"]);
    const result = run(["run", "setup", "--", "--reviewer", "codex", "--skip-harness"], { cwd: dir });
    expect(result.status).toBe(0);
    expect(readConfig(dir).review.reviewer).toBe("codex");
  });

  test("join sets review.reviewer on an already-seeded repo", () => {
    const dir = seedNewRepo(["--skip-harness"]);
    expect(readConfig(dir).review.reviewer).toBeUndefined();

    const result = run(["run", SEED, dir, "--join", "--skip-harness", "--reviewer", "claude"]);
    expect(result.status).toBe(0);
    expect(readConfig(dir).review.reviewer).toBe("claude");
  });

  test("join changes an already-set reviewer", () => {
    const dir = seedNewRepo(["--skip-harness", "--reviewer", "codex"]);
    expect(readConfig(dir).review.reviewer).toBe("codex");

    const result = run(["run", SEED, dir, "--join", "--skip-harness", "--reviewer", "cursor"]);
    expect(result.status).toBe(0);
    expect(readConfig(dir).review.reviewer).toBe("cursor");
  });

  test("--reviewer none deactivates review but keeps the rest of the review block", () => {
    const dir = seedNewRepo(["--skip-harness", "--reviewer", "codex"]);
    const config = readConfig(dir);
    config.review.maxRounds = 5;
    writeFileSync(join(dir, "loops.json"), `${JSON.stringify(config, null, 2)}\n`);

    const result = run(["run", SEED, dir, "--join", "--skip-harness", "--reviewer", "none"]);
    expect(result.status).toBe(0);
    const after = readConfig(dir);
    expect(after.review.reviewer).toBeUndefined();
    expect(after.review.maxRounds).toBe(5);
  });

  // writeNew (join's primitive for every other file) no-ops on an existing file, and
  // round-tripping through config.ts's typed loader would drop anything it doesn't know.
  // The reviewer write is a raw read-merge-write for exactly these two reasons.
  test("the write preserves unknown keys and every unrelated setting", () => {
    const dir = seedNewRepo(["--skip-harness", "--projects", "atlas=~/src/atlas"]);
    const config = readConfig(dir);
    config.futureKnob = { kept: true };
    config.review.auditPasses = ["diff"];
    writeFileSync(join(dir, "loops.json"), `${JSON.stringify(config, null, 2)}\n`);

    const result = run(["run", SEED, dir, "--join", "--skip-harness", "--reviewer", "codex"]);
    expect(result.status).toBe(0);
    const after = readConfig(dir);
    expect(after.futureKnob).toEqual({ kept: true });
    expect(after.review.auditPasses).toEqual(["diff"]);
    expect(after.review.reviewer).toBe("codex");
    expect(after.projects.atlas.repo).toBe("~/src/atlas");
    expect(after.owner).toBe("casey");
  });

  // Join is what automation runs. Without an explicit --reviewer it must not prompt and
  // must not write: a dispatcher inheriting a TTY would otherwise block forever, and an
  // unattended run must never silently change the repo-global reviewer.
  test("non-interactive join without --reviewer leaves loops.json byte-identical", () => {
    const dir = seedNewRepo(["--skip-harness", "--reviewer", "codex"]);
    const before = readFileSync(join(dir, "loops.json"), "utf8");

    const result = run(["run", SEED, dir, "--join", "--skip-harness"]);
    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, "loops.json"), "utf8")).toBe(before);
  });

  test("join rejects an unknown reviewer id instead of writing it", () => {
    const dir = seedNewRepo(["--skip-harness"]);
    const before = readFileSync(join(dir, "loops.json"), "utf8");

    const result = run(["run", SEED, dir, "--join", "--skip-harness", "--reviewer", "bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("bogus");
    expect(readFileSync(join(dir, "loops.json"), "utf8")).toBe(before);
  });

  // R1-F1/R1-F6: the audience for `bun run setup` is repos that already exist. Join's
  // writeNew never touches an existing package.json, so without this the command reaches
  // only repos seeded after it was added - the exact inverse of who needs it.
  test("join adds missing generated scripts to an existing package.json", () => {
    const dir = seedNewRepo(["--skip-harness"]);
    const legacy = {
      name: "data",
      private: true,
      scripts: {
        check: 'bun "/somewhere/tools/cli-check.ts"',
        board: "bun run tools/board/cli-board.ts",
      },
      customField: "kept",
    };
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(legacy, null, 2)}\n`);

    const result = run(["run", SEED, dir, "--join", "--skip-harness"]);
    expect(result.status).toBe(0);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.scripts.setup).toContain("--join");
    // user-defined script and field survive; an existing generated script is not rewritten
    expect(pkg.scripts.board).toBe("bun run tools/board/cli-board.ts");
    expect(pkg.customField).toBe("kept");
    expect(pkg.scripts.check).toBe('bun "/somewhere/tools/cli-check.ts"');
  });

  test("join leaves an already-complete package.json byte-identical", () => {
    const dir = seedNewRepo(["--skip-harness"]);
    const before = readFileSync(join(dir, "package.json"), "utf8");
    const result = run(["run", SEED, dir, "--join", "--skip-harness"]);
    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
  });

  // R1-F2: an argument rejected as invalid must not have already rewritten this
  // machine's harness config on the way to rejecting it.
  test("an invalid --reviewer is rejected before join performs any write", () => {
    const original = seedNewRepo(["--skip-harness"]);
    const clone = join(mkdtempSync(join(tmpdir(), "loops-e2e-")), "clone");
    spawnSync("git", ["clone", "-q", original, clone], { encoding: "utf8" });
    spawnSync("rm", [join(clone, "package.json"), join(clone, ".loops-version")], { encoding: "utf8" });

    const result = run(["run", SEED, clone, "--join", "--skip-harness", "--reviewer", "bogus"]);
    expect(result.status).toBe(2);
    expect(existsSync(join(clone, "package.json"))).toBe(false);
    expect(existsSync(join(clone, ".loops-version"))).toBe(false);
  });

  // R1-F5: assigning `.reviewer` onto an array lands a non-index property that
  // JSON.stringify drops - the command would print success and persist nothing.
  test.each([
    ["an array review block", "[]"],
    ["a string review block", '"codex"'],
    ["a non-object config", "[]"],
  ])("refuses to activate a reviewer against %s", (_label, value) => {
    const dir = seedNewRepo(["--skip-harness"]);
    const text = value === "[]" && _label === "a non-object config"
      ? "[]\n"
      : `${JSON.stringify({ owner: "casey", review: JSON.parse(value) }, null, 2)}\n`;
    writeFileSync(join(dir, "loops.json"), text);

    const result = run(["run", SEED, dir, "--join", "--skip-harness", "--reviewer", "codex"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("review adapter: codex");
    expect(readFileSync(join(dir, "loops.json"), "utf8")).toBe(text);
  });

  // R1-F3/R1-F7: loops.json holds the registry and review settings for every clone,
  // so the replacement must never be observable half-written.
  test("the reviewer write leaves no temp file behind", () => {
    const dir = seedNewRepo(["--skip-harness"]);
    const result = run(["run", SEED, dir, "--join", "--skip-harness", "--reviewer", "codex"]);
    expect(result.status).toBe(0);
    expect(readdirSync(dir).filter((entry) => entry.includes("loops.json.tmp"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "loops.json"), "utf8")).review.reviewer).toBe("codex");
  });

  test("seed's closing note points at bun run setup, not a hand edit", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "loops-e2e-")), "data");
    const result = run(["run", SEED, dir, "--owner", "casey", "--skip-harness"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("bun run setup");
  });
});

describe("generated receipt contract", () => {
  // Both wrappers emit the same body, so assert the policy once per wrapper. Without
  // this, deleting the fourth receipt line or the owner-no-reply rule from the
  // template would leave the suite green while every seeded or refreshed harness
  // config silently lost it.
  const params = { owner: "casey", dataRepo: "/tmp/board", dclHome: "/tmp/dcl" };

  // Assert against whitespace-collapsed text: the clauses are wrapped for prose width,
  // and rewrapping a paragraph must not fail a test that is about its content.
  const flatten = (rendered: string): string => rendered.replace(/\s+/g, " ");

  const wrappers: ReadonlyArray<readonly [string, string]> = [
    ["markered block", renderConfigBlock(params)],
    ["cursor rule", renderCursorRule(params)],
  ];

  test.each(wrappers)("%s states the four receipt lines in order", (_name, rendered) => {
    const positions = [
      rendered.indexOf("IMPLEMENTATION: COMPLETE|INCOMPLETE"),
      rendered.indexOf("VERIFICATION: PASSED|FAILED|NOT RUN"),
      rendered.indexOf("REVIEW: PASSED|REQUESTED|BLOCKED|NOT CONFIGURED|WAIVED|NOT RUN"),
      rendered.indexOf("NEXT STEP/OPTIONS:"),
    ];

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test.each(wrappers)("%s puts the receipt at the end of the handoff", (_name, rendered) => {
    expect(flatten(rendered)).toContain(
      "**End** that final item handoff with this receipt - the last lines you print, " +
        "below the prose summary, so the status is visible without scrolling.",
    );
  });

  test.each(wrappers)(
    "%s gives every capped-review exit its board transition",
    (_name, rendered) => {
      const flat = flatten(rendered);

      expect(flat).toContain(
        "authorize rounds past the cap (`--max-rounds`, logged on the item) - until the " +
          "owner rules, the item sits `blocked` / `next-actor: owner` / `awaiting: approve`",
      );
      expect(flat).toContain(
        "disposition the outstanding finding `deferred-to-human` and hand over " +
          "`REVIEW: BLOCKED` - `blocked` / `next-actor: owner` / `awaiting: decide`",
      );
      expect(flat).toContain(
        "land as-is under the owner's explicit `WAIVED` opt-out - only the owner can give " +
          "it; once given the item is `implemented` / `next-actor: owner` / `awaiting: review-merge`",
      );
      expect(flat).toContain("drop the change - `dropped`");
      expect(flat).toContain(
        'Never make "approve more rounds" the only option the owner can see.',
      );
    },
  );

  test.each(wrappers)(
    "%s keeps reviewer failure and staleness out of the owner's hands",
    (_name, rendered) => {
      const flat = flatten(rendered);

      expect(flat).toContain(
        "A failed or incomplete review attempt is yours to recover from, not the owner's: " +
          "fix the cause and run the review again, leaving the item where it is - the attempt " +
          "is recorded separately as the pending logical round with an alphabetic suffix, such " +
          "as `1-a`, and costs no round.",
      );
      expect(flat).toContain(
        "When a changed patch series supersedes the review base, the active review epoch starts " +
          "again at round 1; prior epochs remain append-only audit history and do not consume the " +
          "new epoch's configured round cap.",
      );
    },
  );

  test.each(wrappers)("%s keeps the owner-no-reply rule intact", (_name, rendered) => {
    expect(flatten(rendered)).toContain(
      "**Before printing the receipt, leave the item in a state that is still accurate if " +
        "the owner never replies** - state, next-actor, awaiting, next-step, and the recorded " +
        "`base-sha`/`head-sha` all true as of that moment, committed and pushed. Never park an " +
        "item in a state that presumes an approval you have not received. The owner must be " +
        "able to close the conversation at that point without leaving the board stale.",
    );
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
    expect(claudeMd).toContain(`${GENERATED_OPEN}\n${SECTION_OPEN}\n`);
    expect(claudeMd).toContain(`${SECTION_CLOSE}\n${GENERATED_CLOSE}\n`);
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
    expect(after.split(SECTION_OPEN).length).toBe(2);
    expect(after.split(GENERATED_OPEN).length).toBe(2);
    // No .codex dir in this fake home - must not have been created.
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  test("seeds every alternate Claude profile, migrating legacy blocks", () => {
    const home = mkdtempSync(join(tmpdir(), "loops-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    // Still carries the legacy markered block - migrated on refresh.
    mkdirSync(join(home, ".claude-work"), { recursive: true });
    writeFileSync(
      join(home, ".claude-work", "CLAUDE.md"),
      `# Work rules\n${LEGACY_START_MARK}\nold block\n${LEGACY_END_MARK}\n`,
    );
    // No marker: targeted all the same, custom content preserved above the wrapper.
    mkdirSync(join(home, ".claude-scratch"), { recursive: true });
    writeFileSync(join(home, ".claude-scratch", "CLAUDE.md"), "# Scratch rules\n");

    const dir = seedNewRepo([], home);

    const optedIn = readFileSync(join(home, ".claude-work", "CLAUDE.md"), "utf8");
    expect(optedIn).toContain("# Work rules");
    expect(optedIn).toContain(dir);
    expect(optedIn).not.toContain("old block");
    // The refresh migrated the legacy markers into the tag grammar.
    expect(optedIn).not.toContain("LOOPS:START");
    expect(optedIn).toContain(GENERATED_OPEN);
    const scratch = readFileSync(join(home, ".claude-scratch", "CLAUDE.md"), "utf8");
    expect(scratch.startsWith("# Scratch rules\n")).toBe(true);
    expect(scratch).toContain(GENERATED_OPEN);
    expect(scratch).toContain(dir);
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
    // Cursor rules use YAML frontmatter, not the tag grammar.
    expect(rule).not.toContain("LOOPS:START");
    expect(rule).not.toContain(GENERATED_OPEN);

    // Re-running refreshes the whole file - one frontmatter, no duplication.
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

  // A home that cannot be listed is not an error: every other probe in
  // detectConfigTargets is an existsSync, so an unusable home has always meant
  // "no harness config here" and seed.ts prints that and carries on. Scanning
  // for alternate .claude-* profiles must not turn it into an abort.
  test("an absent home detects no targets instead of throwing", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "loops-home-")), "never-created");
    expect(detectConfigTargets(missing)).toEqual([]);
  });

  // A home whose path is not a directory at all fails the listing for every
  // caller, root included, so this case pins the catch path with no dependence
  // on privileges.
  test("a home that is not a directory detects no targets instead of throwing", () => {
    const notADir = join(mkdtempSync(join(tmpdir(), "loops-home-")), "home-is-a-file");
    writeFileSync(notADir, "");
    expect(detectConfigTargets(notADir)).toEqual([]);
  });

  // Permission bits do not stop a privileged runner, and a test that quietly
  // returns there would report a pass it never earned. Skip visibly instead -
  // the non-directory case above still covers the failed listing.
  test.skipIf(PERMISSIONS_ARE_ENFORCED === false)(
    "an unreadable home detects no targets instead of throwing",
    () => {
      const home = mkdtempSync(join(tmpdir(), "loops-home-"));
      chmodSync(home, 0o000);
      try {
        expect(detectConfigTargets(home)).toEqual([]);
      } finally {
        chmodSync(home, 0o700);
      }
    },
  );

  test("seeding under an absent home skips harness wiring instead of aborting", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "loops-home-")), "never-created");
    const dir = seedNewRepo([], missing);
    expect(existsSync(join(dir, "BOARD.md"))).toBe(true);
  });
});

describe("upsertConfigBlock tag pairing", () => {
  const params = { owner: "casey", dataRepo: "/tmp/board", dclHome: "/tmp/dcl" };
  const section = renderConfigBlock(params);

  function upsertInto(initial: string | null): { outcome: ReturnType<typeof upsertConfigBlock>; content: string } {
    const dir = mkdtempSync(join(tmpdir(), "loops-upsert-"));
    const target = join(dir, "CLAUDE.md");
    if (initial !== null) writeFileSync(target, initial);
    const outcome = upsertConfigBlock(target, section);
    const content = existsSync(target) ? readFileSync(target, "utf8") : "";
    rmSync(dir, { recursive: true, force: true });
    return { outcome, content };
  }

  test("creates a wrapped section for an absent file", () => {
    const { outcome, content } = upsertInto(null);
    expect(outcome).toEqual({ action: "created" });
    expect(content).toBe(`${GENERATED_OPEN}\n${section}${GENERATED_CLOSE}\n`);
  });

  test("appends below custom content, preserving it byte for byte", () => {
    const custom = "# My rules\n\nkeep this exactly.\n";
    const { outcome, content } = upsertInto(custom);
    expect(outcome).toEqual({ action: "appended" });
    expect(content.startsWith(custom)).toBe(true);
    expect(content).toContain(`${GENERATED_OPEN}\n${SECTION_OPEN}\n`);
  });

  test("replaces its own section in place, preserving a sibling section and outside content", () => {
    const sibling = "<DECENTLY-CAPABLE-POWERS>\nsibling content\n</DECENTLY-CAPABLE-POWERS>";
    const initial = `# head\n${GENERATED_OPEN}\n${sibling}\n${SECTION_OPEN}\nOLD-SECTION-BODY\n${SECTION_CLOSE}\n${GENERATED_CLOSE}\n# tail\n`;
    const { outcome, content } = upsertInto(initial);
    expect(outcome).toEqual({ action: "replaced" });
    expect(content).toContain("sibling content");
    expect(content).not.toContain("OLD-SECTION-BODY");
    expect(content.startsWith("# head\n")).toBe(true);
    expect(content.endsWith("# tail\n")).toBe(true);
    expect(content.split(GENERATED_OPEN).length).toBe(2);
    expect(content).toContain("casey");
  });

  test("inserts its section into a wrapper another tool created", () => {
    const sibling = "<DECENTLY-CAPABLE-POWERS>\nsibling content\n</DECENTLY-CAPABLE-POWERS>";
    const initial = `${GENERATED_OPEN}\n${sibling}\n${GENERATED_CLOSE}\n`;
    const { outcome, content } = upsertInto(initial);
    expect(outcome).toEqual({ action: "appended" });
    expect(content).toContain("sibling content");
    expect(content.indexOf(SECTION_OPEN)).toBeGreaterThan(content.indexOf("</DECENTLY-CAPABLE-POWERS>"));
    expect(content.indexOf(SECTION_CLOSE)).toBeLessThan(content.indexOf(GENERATED_CLOSE));
    expect(content.split(GENERATED_OPEN).length).toBe(2);
  });

  test("migrates a legacy markered block in place, idempotently", () => {
    const initial = `# head\n${LEGACY_START_MARK}\nold body\n${LEGACY_END_MARK}\n# tail\n`;
    const first = upsertInto(initial);
    expect(first.outcome).toEqual({ action: "migrated" });
    expect(first.content).not.toContain("LOOPS:START");
    expect(first.content).not.toContain("old body");
    expect(first.content.startsWith("# head\n")).toBe(true);
    expect(first.content.endsWith("# tail\n")).toBe(true);
    // Second run replaces the now-current section and is byte-identical.
    const second = upsertInto(first.content);
    expect(second.outcome).toEqual({ action: "replaced" });
    expect(second.content).toBe(first.content);
  });

  test("migrates a leftover legacy block when the wrapper already exists", () => {
    const sibling = "<DECENTLY-CAPABLE-POWERS>\nsibling content\n</DECENTLY-CAPABLE-POWERS>";
    const initial = `${GENERATED_OPEN}\n${sibling}\n${GENERATED_CLOSE}\n\n${LEGACY_START_MARK}\nold body\n${LEGACY_END_MARK}\n`;
    const { outcome, content } = upsertInto(initial);
    expect(outcome).toEqual({ action: "migrated" });
    expect(content).not.toContain("LOOPS:START");
    expect(content).not.toContain("old body");
    expect(content).toContain("sibling content");
    expect(content.split(SECTION_OPEN).length).toBe(2);
    expect(content.indexOf(SECTION_CLOSE)).toBeLessThan(content.indexOf(GENERATED_CLOSE));
  });

  test("a prose mention of a tag is not a tag", () => {
    const custom = `# notes\nthe ${GENERATED_OPEN} wrapper and the ${SECTION_OPEN} tag are discussed here\n`;
    const { outcome, content } = upsertInto(custom);
    expect(outcome).toEqual({ action: "appended" });
    expect(content.startsWith(custom)).toBe(true);
  });

  test("an unpaired wrapper tag fails closed", () => {
    const initial = `# head\n${GENERATED_OPEN}\nnever closed\n`;
    const { outcome, content } = upsertInto(initial);
    expect(outcome).toEqual({ action: "skipped", reason: `${GENERATED_OPEN} is never closed` });
    expect(content).toBe(initial);
  });

  test("more than one wrapper fails closed", () => {
    const initial = `${GENERATED_OPEN}\na\n${GENERATED_CLOSE}\n${GENERATED_OPEN}\nb\n${GENERATED_CLOSE}\n`;
    const { outcome, content } = upsertInto(initial);
    expect(outcome).toEqual({ action: "skipped", reason: `more than one ${GENERATED_OPEN} block` });
    expect(content).toBe(initial);
  });

  test("an unpaired section tag inside the wrapper fails closed", () => {
    const initial = `${GENERATED_OPEN}\n${SECTION_OPEN}\nnever closed\n${GENERATED_CLOSE}\n`;
    const { outcome, content } = upsertInto(initial);
    expect(outcome).toEqual({ action: "skipped", reason: `${SECTION_OPEN} is never closed` });
    expect(content).toBe(initial);
  });

  test("an orphan closing tag fails closed at either level", () => {
    const wrapperOrphan = `# notes\n${GENERATED_CLOSE}\n`;
    const first = upsertInto(wrapperOrphan);
    expect(first.outcome).toEqual({
      action: "skipped",
      reason: `${GENERATED_CLOSE} without a matching ${GENERATED_OPEN}`,
    });
    expect(first.content).toBe(wrapperOrphan);
    const sectionOrphan = `${GENERATED_OPEN}\n${SECTION_CLOSE}\n${GENERATED_CLOSE}\n`;
    const second = upsertInto(sectionOrphan);
    expect(second.outcome).toEqual({
      action: "skipped",
      reason: `${SECTION_CLOSE} without a matching ${SECTION_OPEN}`,
    });
    expect(second.content).toBe(sectionOrphan);
  });

  test("a section outside the wrapper fails closed", () => {
    const besideWrapper = `${SECTION_OPEN}\nloose\n${SECTION_CLOSE}\n${GENERATED_OPEN}\n${GENERATED_CLOSE}\n`;
    const first = upsertInto(besideWrapper);
    expect(first.outcome).toEqual({
      action: "skipped",
      reason: `${SECTION_OPEN} section outside the ${GENERATED_OPEN} wrapper`,
    });
    expect(first.content).toBe(besideWrapper);
    const noWrapper = `${SECTION_OPEN}\nloose\n${SECTION_CLOSE}\n`;
    const second = upsertInto(noWrapper);
    expect(second.outcome).toEqual({
      action: "skipped",
      reason: `${SECTION_OPEN} section outside any ${GENERATED_OPEN} wrapper`,
    });
    expect(second.content).toBe(noWrapper);
  });

  test("duplicated legacy markers are ambiguous and fail closed", () => {
    const initial = `${LEGACY_START_MARK}\na\n${LEGACY_END_MARK}\n${LEGACY_START_MARK}\nb\n${LEGACY_END_MARK}\n`;
    const { outcome, content } = upsertInto(initial);
    expect(outcome).toEqual({
      action: "skipped",
      reason: "unmatched, duplicated, or reversed legacy LOOPS markers",
    });
    expect(content).toBe(initial);
  });

  test("CRLF content and a missing final newline outside the tags survive byte for byte", () => {
    const head = "# head\r\nwindows line\r\n";
    const tail = "# tail without final newline";
    const initial = `${head}${GENERATED_OPEN}\n${SECTION_OPEN}\nOLD-SECTION-BODY\n${SECTION_CLOSE}\n${GENERATED_CLOSE}\n${tail}`;
    const { outcome, content } = upsertInto(initial);
    expect(outcome).toEqual({ action: "replaced" });
    expect(content.startsWith(head)).toBe(true);
    expect(content.endsWith(`${GENERATED_CLOSE}\n${tail}`)).toBe(true);
    expect(content).not.toContain("OLD-SECTION-BODY");
  });

  test("a singleton or reversed legacy marker fails closed", () => {
    for (const initial of [
      `# head\n${LEGACY_START_MARK}\nnever ended\n`,
      `# head\n${LEGACY_END_MARK}\n`,
      `${LEGACY_END_MARK}\nreversed\n${LEGACY_START_MARK}\n`,
    ]) {
      const { outcome, content } = upsertInto(initial);
      expect(outcome).toEqual({
        action: "skipped",
        reason: "unmatched, duplicated, or reversed legacy LOOPS markers",
      });
      expect(content).toBe(initial);
    }
  });
});
