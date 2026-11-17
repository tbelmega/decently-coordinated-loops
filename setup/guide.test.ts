// Tests for setup/guide.ts: the operating guide every session loads, installed into each
// detected harness whether or not a data repo exists, and the retirement of the guide
// section the decently-capable-powers installer used to write.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  GENERATED_CLOSE,
  GENERATED_OPEN,
  GUIDE_SECTION_CLOSE,
  GUIDE_SECTION_OPEN,
  RETIRED_GUIDE_SECTION_CLOSE,
  RETIRED_GUIDE_SECTION_OPEN,
  SECTION_CLOSE,
  SECTION_OPEN,
} from "./marks.ts";
import { installGuide, renderGuideSection, upsertGuideSection } from "./guide.ts";

const DCL_HOME = resolve(import.meta.dirname, "..");
const flatten = (text: string): string => text.replace(/\s+/g, " ");

function freshHome(...dirs: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "loops-guide-home-"));
  for (const dir of dirs) mkdirSync(join(home, dir), { recursive: true });
  return home;
}

describe("guide section", () => {
  const section = renderGuideSection();

  test("is wrapped in its own tags with a provenance line", () => {
    const lines = section.trimEnd().split("\n");
    expect(lines[0]).toBe(GUIDE_SECTION_OPEN);
    expect(lines[1]).toContain("managed by decently-coordinated-loops");
    expect(lines.at(-1)).toBe(GUIDE_SECTION_CLOSE);
  });

  test("carries the completion receipt as four blank-line separated lines", () => {
    expect(section).toMatch(
      /<WORK TYPE>: MERGED\|READY TO MERGE\|INCOMPLETE[^\n]*\n\n {4}VERIFICATION: [^\n]*\n\n {4}REVIEW: [^\n]*\n\n {4}NEXT STEP\/OPTIONS:/,
    );
  });

  test("closes the receipt values and makes each line readable cold", () => {
    const flat = flatten(section);
    expect(flat).toContain("**Hard:** only these values.");
    expect(flat).toContain("`MERGED` once it is in the integration branch");
    expect(flat).toContain("`READY TO MERGE` when it is finished and verified but not merged yet");
    expect(flat).toContain("WORK TYPE: the most specific of IMPLEMENTATION, FIX, SPEC, PLAN, RESEARCH, DOCS; else TASK.");
    expect(flat).toContain(
      "A `BLOCKED` line states the risk of merging now: what is unreviewed, what covers it anyway, " +
        "your confidence and why, and the impact if wrong.",
    );
    expect(flat).toContain('Say "merge", never "land", to the user.');
  });

  test("carries the work-stream definition the board block defers to", () => {
    expect(flatten(section)).toContain("A work-stream changes a project's behavior");
  });

  test("names no owner, data repo or machine path", () => {
    expect(section).not.toMatch(/\/home\/|~\/workspace|casey/);
  });

  test("contains no em or en dash", () => {
    expect(section).not.toMatch(/[–—]/);
  });
});

describe("upsertGuideSection", () => {
  const guide = renderGuideSection();
  const board = `${SECTION_OPEN}\nboard\n${SECTION_CLOSE}\n`;
  const retired = `${RETIRED_GUIDE_SECTION_OPEN}\nold guide\n${RETIRED_GUIDE_SECTION_CLOSE}\n`;

  function upsertInto(initial: string | null) {
    const dir = mkdtempSync(join(tmpdir(), "loops-guide-upsert-"));
    const target = join(dir, "CLAUDE.md");
    if (initial !== null) writeFileSync(target, initial);
    const outcome = upsertGuideSection(target, guide);
    const content = existsSync(target) ? readFileSync(target, "utf8") : "";
    rmSync(dir, { recursive: true, force: true });
    return { outcome, content };
  }

  test("creates a wrapped section for an absent file", () => {
    const { outcome, content } = upsertInto(null);
    expect(outcome.action).toBe("created");
    expect(content).toBe(`${GENERATED_OPEN}\n${guide}${GENERATED_CLOSE}\n`);
  });

  test("takes the retired guide's place, before the board section", () => {
    const { outcome, content } = upsertInto(`# Mine\n${GENERATED_OPEN}\n${retired}${board}${GENERATED_CLOSE}\n`);
    expect(outcome.action).toBe("migrated");
    expect(content).toBe(`# Mine\n${GENERATED_OPEN}\n${guide}${board}${GENERATED_CLOSE}\n`);
  });

  test("goes before the board section when no guide is there yet", () => {
    const { outcome, content } = upsertInto(`${GENERATED_OPEN}\n${board}${GENERATED_CLOSE}\n`);
    expect(outcome.action).toBe("appended");
    expect(content).toBe(`${GENERATED_OPEN}\n${guide}${board}${GENERATED_CLOSE}\n`);
  });

  test("replaces itself in place and is idempotent", () => {
    const start = `${GENERATED_OPEN}\n${GUIDE_SECTION_OPEN}\nstale\n${GUIDE_SECTION_CLOSE}\n${board}${GENERATED_CLOSE}\n`;
    const first = upsertInto(start);
    expect(first.outcome.action).toBe("replaced");
    expect(first.content).toBe(`${GENERATED_OPEN}\n${guide}${board}${GENERATED_CLOSE}\n`);
    const second = upsertInto(first.content);
    expect(second.content).toBe(first.content);
  });

  test("removes a retired guide that a re-run of the old installer wrote next to it", () => {
    const start = `${GENERATED_OPEN}\n${guide}${retired}${board}${GENERATED_CLOSE}\n`;
    const { outcome, content } = upsertInto(start);
    expect(outcome.action).toBe("migrated");
    expect(content).toBe(`${GENERATED_OPEN}\n${guide}${board}${GENERATED_CLOSE}\n`);
  });

  test("appends a wrapper below custom content when the file has none", () => {
    const { outcome, content } = upsertInto("# Mine\n");
    expect(outcome.action).toBe("appended");
    expect(content).toBe(`# Mine\n\n${GENERATED_OPEN}\n${guide}${GENERATED_CLOSE}\n`);
  });

  test("an unpaired retired tag fails closed and writes nothing", () => {
    const start = `${GENERATED_OPEN}\n${RETIRED_GUIDE_SECTION_OPEN}\nold\n${board}${GENERATED_CLOSE}\n`;
    const { outcome, content } = upsertInto(start);
    expect(outcome.action).toBe("skipped");
    expect(content).toBe(start);
  });

  test("moves a retired guide that sits below the board section above it", () => {
    const { outcome, content } = upsertInto(`${GENERATED_OPEN}\n${board}${retired}${GENERATED_CLOSE}\n`);
    expect(outcome.action).toBe("migrated");
    expect(content).toBe(`${GENERATED_OPEN}\n${guide}${board}${GENERATED_CLOSE}\n`);
  });

  test("moves its own section that sits below the board section above it", () => {
    const stale = `${GUIDE_SECTION_OPEN}\nstale\n${GUIDE_SECTION_CLOSE}\n`;
    const { outcome, content } = upsertInto(`${GENERATED_OPEN}\n${board}${stale}${GENERATED_CLOSE}\n`);
    expect(outcome.action).toBe("replaced");
    expect(content).toBe(`${GENERATED_OPEN}\n${guide}${board}${GENERATED_CLOSE}\n`);
  });

  test("nested managed sections fail closed and keep content outside the wrapper", () => {
    const start =
      `${GENERATED_OPEN}\n${GUIDE_SECTION_OPEN}\n${retired}${GUIDE_SECTION_CLOSE}\n${GENERATED_CLOSE}\nmy rule one\nmy rule two\n`;
    const { outcome, content } = upsertInto(start);
    expect(outcome.action).toBe("skipped");
    expect(content).toBe(start);
  });

  test("crossing managed sections fail closed", () => {
    const start =
      `${GENERATED_OPEN}\n${GUIDE_SECTION_OPEN}\n${RETIRED_GUIDE_SECTION_OPEN}\n${GUIDE_SECTION_CLOSE}\n` +
      `${RETIRED_GUIDE_SECTION_CLOSE}\n${GENERATED_CLOSE}\n`;
    const { outcome, content } = upsertInto(start);
    expect(outcome.action).toBe("skipped");
    expect(content).toBe(start);
  });

  test("a retired section outside the wrapper fails closed", () => {
    const start = `${retired}${GENERATED_OPEN}\n${board}${GENERATED_CLOSE}\n`;
    const { outcome, content } = upsertInto(start);
    expect(outcome.action).toBe("skipped");
    expect(content).toBe(start);
  });
});

describe("installGuide", () => {
  test("writes the guide into every detected Claude profile and Codex", () => {
    const home = freshHome(".claude", ".claude-work", ".codex");
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    installGuide(home, () => {});
    for (const path of [
      join(home, ".claude", "CLAUDE.md"),
      join(home, ".claude-work", "CLAUDE.md"),
      join(home, ".codex", "AGENTS.md"),
    ]) {
      const text = readFileSync(path, "utf8");
      expect(text.split(GUIDE_SECTION_OPEN).length).toBe(2);
      expect(text).toContain(GENERATED_OPEN);
    }
  });

  test("replaces the retired Cursor rule and Kiro steering file with its own", () => {
    const home = freshHome(".cursor/rules", ".kiro/steering");
    writeFileSync(join(home, ".cursor", "rules", "decently-capable-powers.mdc"), "old\n");
    writeFileSync(join(home, ".kiro", "steering", "decently-capable-powers.md"), "old\n");
    installGuide(home, () => {});

    const rule = readFileSync(join(home, ".cursor", "rules", "operating-guide.mdc"), "utf8");
    expect(rule).toContain("alwaysApply: true");
    expect(rule).toContain("NEXT STEP/OPTIONS:");
    expect(rule).not.toContain(GENERATED_OPEN);
    const steering = readFileSync(join(home, ".kiro", "steering", "operating-guide.md"), "utf8");
    expect(steering.startsWith("---\ninclusion: always\n---\n")).toBe(true);
    expect(steering).toContain("NEXT STEP/OPTIONS:");
    expect(existsSync(join(home, ".cursor", "rules", "decently-capable-powers.mdc"))).toBe(false);
    expect(existsSync(join(home, ".kiro", "steering", "decently-capable-powers.md"))).toBe(false);
    // The board's own Kiro reviewer agent is not the guide's to write.
    expect(existsSync(join(home, ".kiro", "agents", "dcl-reviewer.json"))).toBe(false);
  });

  test("touches nothing on a machine with no harness", () => {
    const home = freshHome();
    installGuide(home, () => {});
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });
});

describe("install.sh", () => {
  test("installs the guide without a data repo", () => {
    const home = freshHome(".claude");
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    const result = spawnSync("bash", [join(DCL_HOME, "install.sh")], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    expect(result.status).toBe(0);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain(GUIDE_SECTION_OPEN);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).not.toContain(SECTION_OPEN);
  });

  test("without bun it still links the skills and says the guide was skipped", () => {
    const home = freshHome(".claude");
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    // A PATH holding only the tools install.sh uses, linked one by one, so no bun is on it.
    const bin = mkdtempSync(join(tmpdir(), "loops-nobun-bin-"));
    for (const tool of ["bash", "basename", "dirname", "ln", "mkdir", "rm", "grep", "readlink", "cat"]) {
      const found = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (found) symlinkSync(found, join(bin, tool));
    }
    const result = spawnSync(join(bin, "bash"), [join(DCL_HOME, "install.sh")], {
      encoding: "utf8",
      env: { HOME: home, PATH: bin },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("bun not found");
    expect(existsSync(join(home, ".claude", "skills", "loops-board"))).toBe(true);
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
  });
});
