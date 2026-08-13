import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { detectConfigTargets, harnesses, skillsDirs } from "./harnesses.ts";
import { START_MARK } from "./marks.ts";
import { allReviewers, reviewerBin } from "../tools/review/reviewers.ts";

const DCL_HOME = resolve(import.meta.dirname, "..");

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "dcl-home-"));
}

/** Creates `<home>/<relative>` and every parent. */
function makeDir(home: string, relative: string): string {
  const path = join(home, relative);
  mkdirSync(path, { recursive: true });
  return path;
}

describe("harness registry", () => {
  test("no entry claims a config target in a home where it is not installed", () => {
    // The gate that keeps DCL from writing into files on a machine that never ran the
    // harness. Asserted over the registry rather than per entry, so a new harness that
    // forgets to gate its targets fails here.
    for (const harness of harnesses) {
      expect(harness.detect(join(tmpdir(), "dcl-absent-home"))).toBe(false);
    }
    expect(detectConfigTargets(join(tmpdir(), "dcl-absent-home"))).toEqual([]);
  });

  test("every entry has a usable id", () => {
    expect(harnesses.map((harness) => harness.id)).toEqual(["claude", "agents", "codex", "cursor"]);
  });

  test("skillsDirs is the deduplicated union, in registry order", () => {
    expect(skillsDirs()).toEqual([".claude/skills", ".agents/skills"]);
  });

  test("setup/skill-dirs.txt matches the registry", () => {
    // install.sh is bash and cannot read the registry, so it reads this mirror. If the
    // two drift, a new harness's skills silently never get linked.
    const listed = readFileSync(join(DCL_HOME, "setup", "skill-dirs.txt"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(listed).toEqual(skillsDirs());
  });
});

describe("detectConfigTargets", () => {
  test("a home with no harness directories yields nothing", () => {
    const home = tempHome();
    try {
      expect(detectConfigTargets(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a skills tree this run created is not evidence that Claude Code is installed", () => {
    const home = tempHome();
    try {
      makeDir(home, ".claude/skills");
      process.env.DCL_CREATED_SKILL_DIRS = ".claude/skills\n";
      expect(detectConfigTargets(home)).toEqual([]);
      writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
      expect(detectConfigTargets(home)).toEqual([
        { path: join(home, ".claude", "CLAUDE.md"), kind: "block" },
      ]);
    } finally {
      delete process.env.DCL_CREATED_SKILL_DIRS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a skills tree that was already there still counts as a Claude installation", () => {
    // The opposite error, and the worse one: refusing to wire a real installation leaves
    // every later session unaware of the board, while a block in a directory DCL made
    // earlier is inert.
    const home = tempHome();
    try {
      makeDir(home, ".claude/skills");
      expect(detectConfigTargets(home)).toEqual([
        { path: join(home, ".claude", "CLAUDE.md"), kind: "block" },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a fully populated home yields every target, in registry order", () => {
    const home = tempHome();
    try {
      makeDir(home, ".claude");
      writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
      makeDir(home, ".codex");
      makeDir(home, ".cursor");
      expect(detectConfigTargets(home)).toEqual([
        { path: join(home, ".claude", "CLAUDE.md"), kind: "block" },
        { path: join(home, ".codex", "AGENTS.md"), kind: "block" },
        { path: join(home, ".cursor", ".cursor", "rules", "loops.mdc"), kind: "cursor" },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an alternate Claude profile is refreshed only once it carries the marker", () => {
    const home = tempHome();
    try {
      makeDir(home, ".claude");
      makeDir(home, ".claude-work");
      makeDir(home, ".claude-untouched");
      const opted = join(home, ".claude-work", "CLAUDE.md");
      writeFileSync(opted, `# work profile\n${START_MARK}\nold block\n`);
      writeFileSync(join(home, ".claude-untouched", "CLAUDE.md"), "# no marker here\n");

      const paths = detectConfigTargets(home).map((target) => target.path);
      expect(paths).toContain(opted);
      expect(paths).not.toContain(join(home, ".claude-untouched", "CLAUDE.md"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an opted-in profile is found even when the default Claude home is absent", () => {
    const home = tempHome();
    try {
      makeDir(home, ".claude-work");
      writeFileSync(join(home, ".claude-work", "CLAUDE.md"), `${START_MARK}\n`);
      expect(detectConfigTargets(home)).toEqual([
        { path: join(home, ".claude-work", "CLAUDE.md"), kind: "block" },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("install.sh", () => {
  /** Skill links under `root`, as name -> resolved target. */
  function linksIn(root: string): Record<string, string> {
    const entries: Record<string, string> = {};
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (lstatSync(path).isSymbolicLink()) entries[name] = resolve(dirname(path), readlinkSync(path));
    }
    return entries;
  }

  const expectedSkills = () =>
    Object.fromEntries(
      readdirSync(join(DCL_HOME, "skills"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => [entry.name, join(DCL_HOME, "skills", entry.name)]),
    );

  test("links every skill into every registry destination without bun on PATH", () => {
    // Acceptance criterion 9: the plain (no --seed) path must keep working on a machine
    // that has never installed bun. A controlled PATH is the only way to prove it.
    const home = tempHome();
    const shims = mkdtempSync(join(tmpdir(), "dcl-path-"));
    try {
      // No readlink here on purpose: install.sh must canonicalize with the shell alone,
      // since stock macOS has no `readlink -f`.
      for (const tool of ["bash", "ln", "mkdir", "basename", "dirname", "sed", "cat"]) {
        const found = spawnSync("which", [tool], { encoding: "utf8" });
        if (found.status === 0) {
          spawnSync("ln", ["-s", found.stdout.trim(), join(shims, tool)]);
        }
      }
      expect(spawnSync("bun", ["--version"], { env: { PATH: shims }, encoding: "utf8" }).error).toBeDefined();

      const result = spawnSync("bash", [join(DCL_HOME, "install.sh")], {
        env: { HOME: home, PATH: shims },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      for (const relative of skillsDirs()) {
        expect(linksIn(join(home, relative))).toEqual(expectedSkills());
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(shims, { recursive: true, force: true });
    }
  });

  test("--config-dir adds destinations without dropping the registry's own", () => {
    const home = tempHome();
    try {
      const extraOne = join(home, "profile-one");
      const extraTwo = join(home, "profile-two");
      const result = spawnSync(
        "bash",
        [join(DCL_HOME, "install.sh"), "--config-dir", extraOne, "--config-dir", extraTwo],
        { env: { HOME: home, PATH: process.env.PATH ?? "" }, encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      for (const root of [...skillsDirs().map((relative) => join(home, relative)), extraOne, extraTwo]) {
        expect(linksIn(root.endsWith("skills") ? root : join(root, "skills"))).toEqual(expectedSkills());
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("recognises its own links as current on a rerun, without GNU readlink", () => {
    // The rerun path is where a non-portable canonicalization bites: both sides failing
    // to the empty string would make any existing symlink read as already ours.
    const home = tempHome();
    try {
      const env = { HOME: home, PATH: process.env.PATH ?? "" };
      expect(spawnSync("bash", [join(DCL_HOME, "install.sh")], { env, encoding: "utf8" }).status).toBe(0);
      const second = spawnSync("bash", [join(DCL_HOME, "install.sh")], { env, encoding: "utf8" });

      expect(second.status).toBe(0);
      expect(second.stdout).toContain("0 newly linked");
      expect(second.stdout).not.toContain("left untouched");
      for (const relative of skillsDirs()) {
        expect(linksIn(join(home, relative))).toEqual(expectedSkills());
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("leaves a foreign path in a skills tree untouched and reports it", () => {
    const home = tempHome();
    try {
      const claudeSkills = makeDir(home, ".claude/skills");
      const foreign = join(claudeSkills, "loops-board");
      mkdirSync(foreign);
      writeFileSync(join(foreign, "SKILL.md"), "somebody else's skill\n");

      const result = spawnSync("bash", [join(DCL_HOME, "install.sh")], {
        env: { HOME: home, PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("left untouched");
      expect(readFileSync(join(foreign, "SKILL.md"), "utf8")).toBe("somebody else's skill\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("reviewer roster", () => {
  test("the seeder's detection derives from the reviewer registry", () => {
    // Acceptance criterion 2: exactly one module knows which reviewers exist. seed.ts
    // used to carry a second {id, bin} list, so adding an adapter meant editing two
    // files and forgetting one made the new reviewer undetectable at seed time.
    const seed = readFileSync(join(DCL_HOME, "setup", "seed.ts"), "utf8");
    expect(seed).toContain("allReviewers()");
    // Code only. Comments and user-facing prose may name a reviewer — forcing them not
    // to would trade a real duplication gate for message churn, which is the same call
    // the tracker-boundary spec makes about its structural scan.
    const code = seed
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    for (const name of ["codex", "cursor-agent", "CODEX_BIN", "CURSOR_AGENT_BIN"]) {
      expect(code).not.toContain(`"${name}"`);
    }
  });

  test("every reviewer resolves a binary through its env override", () => {
    for (const reviewer of allReviewers()) {
      // The override may already be set in this environment for real use, so the default
      // is asserted with it cleared rather than assumed absent.
      const configured = process.env[reviewer.binEnv];
      try {
        delete process.env[reviewer.binEnv];
        expect(reviewerBin(reviewer)).toBe(reviewer.defaultBin);
        process.env[reviewer.binEnv] = "/somewhere/else";
        expect(reviewerBin(reviewer)).toBe("/somewhere/else");
      } finally {
        if (configured === undefined) delete process.env[reviewer.binEnv];
        else process.env[reviewer.binEnv] = configured;
      }
    }
  });
});
