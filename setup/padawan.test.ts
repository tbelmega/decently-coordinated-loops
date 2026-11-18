// Tests for padawan mode (setup/padawan.ts, install.sh --padawan): an opt-in section for a
// user who owns the product but is not a developer, remembered per machine by a marker file.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  GENERATED_CLOSE,
  GENERATED_OPEN,
  GUIDE_SECTION_OPEN,
  PADAWAN_SECTION_CLOSE,
  PADAWAN_SECTION_OPEN,
  SECTION_CLOSE,
  SECTION_OPEN,
} from "./marks.ts";
import { installGuide } from "./guide.ts";
import { PADAWAN_MARKER, renderPadawanSection } from "./padawan.ts";
import { removeSection } from "./config-block.ts";

const DCL_HOME = resolve(import.meta.dirname, "..");

function freshHome(...dirs: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "loops-padawan-home-"));
  for (const dir of dirs) mkdirSync(join(home, dir), { recursive: true });
  // Claude counts as installed only once its config home holds more than a skills tree.
  if (dirs.includes(".claude")) writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
  return home;
}

function enable(home: string): void {
  mkdirSync(dirname(join(home, PADAWAN_MARKER)), { recursive: true });
  writeFileSync(join(home, PADAWAN_MARKER), "");
}

const claudeMd = (home: string) => readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;

function installSh(home: string, ...args: string[]) {
  return spawnSync("bash", [join(DCL_HOME, "install.sh"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

describe("padawan section", () => {
  const section = renderPadawanSection();

  test("is wrapped in its own tags with a provenance line", () => {
    const lines = section.trimEnd().split("\n");
    expect(lines[0]).toBe(PADAWAN_SECTION_OPEN);
    expect(lines[1]).toContain("managed by decently-coordinated-loops");
    expect(lines.at(-1)).toBe(PADAWAN_SECTION_CLOSE);
  });

  test("contains no em or en dash", () => {
    expect(section).not.toMatch(/[–—]/);
  });

  test("carries the round-cap guidance and never refuses a topic", () => {
    const flat = section.replace(/\s+/g, " ");
    expect(flat).toContain("At a review round cap");
    expect(flat).toContain("waiving the rest");
    expect(flat).toContain("Name the risk, never refuse.");
  });
});

describe("installGuide with padawan mode", () => {
  test("is off by default", () => {
    const home = freshHome(".claude");
    installGuide(home, () => {});
    expect(claudeMd(home)).not.toContain(PADAWAN_SECTION_OPEN);
  });

  test("with the marker, writes the section below the guide and above the board section", () => {
    const home = freshHome(".claude");
    writeFileSync(
      join(home, ".claude", "CLAUDE.md"),
      `# Mine\n${GENERATED_OPEN}\n${SECTION_OPEN}\nboard\n${SECTION_CLOSE}\n${GENERATED_CLOSE}\n`,
    );
    enable(home);
    installGuide(home, () => {});
    const text = claudeMd(home);
    const guide = text.indexOf(GUIDE_SECTION_OPEN);
    const padawan = text.indexOf(PADAWAN_SECTION_OPEN);
    const board = text.indexOf(SECTION_OPEN);
    expect(guide).toBeGreaterThan(-1);
    expect(padawan).toBeGreaterThan(guide);
    expect(board).toBeGreaterThan(padawan);
    expect(text.startsWith("# Mine\n")).toBe(true);
  });

  test("with the marker and no board section, sits below the guide", () => {
    const home = freshHome(".claude");
    enable(home);
    installGuide(home, () => {});
    const text = claudeMd(home);
    expect(text.indexOf(PADAWAN_SECTION_OPEN)).toBeGreaterThan(text.indexOf(GUIDE_SECTION_OPEN));
    expect(text.indexOf(PADAWAN_SECTION_OPEN)).toBeLessThan(text.indexOf(GENERATED_CLOSE));
  });

  test("re-running is idempotent", () => {
    const home = freshHome(".claude");
    enable(home);
    installGuide(home, () => {});
    const first = claudeMd(home);
    installGuide(home, () => {});
    expect(claudeMd(home)).toBe(first);
    expect(count(first, PADAWAN_SECTION_OPEN)).toBe(1);
  });

  test("without the marker, an installed section is removed and everything else kept", () => {
    const home = freshHome(".claude");
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# Mine\n");
    enable(home);
    installGuide(home, () => {});
    const withPadawan = claudeMd(home);
    spawnSync("rm", [join(home, PADAWAN_MARKER)]);
    installGuide(home, () => {});
    const text = claudeMd(home);
    expect(text).not.toContain(PADAWAN_SECTION_OPEN);
    expect(text).toContain(GUIDE_SECTION_OPEN);
    expect(text.startsWith("# Mine\n")).toBe(true);
    expect(withPadawan.length).toBeGreaterThan(text.length);
  });

  test("writes and removes its own Cursor rule and Kiro steering file", () => {
    const home = freshHome(".cursor/rules", ".kiro/steering");
    enable(home);
    installGuide(home, () => {});
    const rule = join(home, ".cursor", "rules", "padawan-mode.mdc");
    const steering = join(home, ".kiro", "steering", "padawan-mode.md");
    expect(readFileSync(rule, "utf8")).toContain("alwaysApply: true");
    expect(readFileSync(steering, "utf8").startsWith("---\ninclusion: always\n---\n")).toBe(true);
    spawnSync("rm", [join(home, PADAWAN_MARKER)]);
    installGuide(home, () => {});
    expect(existsSync(rule)).toBe(false);
    expect(existsSync(steering)).toBe(false);
  });
});

describe("whole-file copies someone else owns", () => {
  test("a plain install never deletes a padawan-mode file DCL did not write", () => {
    const home = freshHome(".cursor/rules", ".kiro/steering");
    const rule = join(home, ".cursor", "rules", "padawan-mode.mdc");
    const steering = join(home, ".kiro", "steering", "padawan-mode.md");
    writeFileSync(rule, "my own rule\n");
    writeFileSync(steering, "my own steering\n");
    installGuide(home, () => {});
    expect(readFileSync(rule, "utf8")).toBe("my own rule\n");
    expect(readFileSync(steering, "utf8")).toBe("my own steering\n");
  });

  test("turning padawan mode on keeps a foreign file and reports it", () => {
    const home = freshHome(".cursor/rules");
    const rule = join(home, ".cursor", "rules", "padawan-mode.mdc");
    writeFileSync(rule, "my own rule\n");
    enable(home);
    const lines: string[] = [];
    installGuide(home, (line) => lines.push(line));
    expect(readFileSync(rule, "utf8")).toBe("my own rule\n");
    expect(lines.join("\n")).toContain("is not managed by DCL - left untouched");
  });
});

describe("removeSection", () => {
  const target = (content: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "loops-remove-")), "CLAUDE.md");
    writeFileSync(path, content);
    return path;
  };

  test("a malformed section fails closed and writes nothing", () => {
    const content = `${GENERATED_OPEN}\n${PADAWAN_SECTION_OPEN}\ntext\n${GENERATED_CLOSE}\n`;
    const path = target(content);
    expect(removeSection(path, PADAWAN_SECTION_OPEN, PADAWAN_SECTION_CLOSE).action).toBe("skipped");
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  test("a section outside the wrapper fails closed", () => {
    const content = `${PADAWAN_SECTION_OPEN}\ntext\n${PADAWAN_SECTION_CLOSE}\n${GENERATED_OPEN}\n${GENERATED_CLOSE}\n`;
    const path = target(content);
    expect(removeSection(path, PADAWAN_SECTION_OPEN, PADAWAN_SECTION_CLOSE).action).toBe("skipped");
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  test("an absent section or file is reported as absent", () => {
    expect(removeSection(target(`${GENERATED_OPEN}\n${GENERATED_CLOSE}\n`), PADAWAN_SECTION_OPEN, PADAWAN_SECTION_CLOSE).action).toBe("absent");
    expect(removeSection(join(tmpdir(), "loops-no-such-file.md"), PADAWAN_SECTION_OPEN, PADAWAN_SECTION_CLOSE).action).toBe("absent");
  });
});

describe("install.sh --padawan", () => {
  test("turns it on, a plain re-run keeps it, --no-padawan removes it", () => {
    const home = freshHome(".claude");

    expect(installSh(home, "--padawan").status).toBe(0);
    expect(claudeMd(home)).toContain(PADAWAN_SECTION_OPEN);

    expect(installSh(home).status).toBe(0);
    expect(count(claudeMd(home), PADAWAN_SECTION_OPEN)).toBe(1);

    expect(installSh(home, "--no-padawan").status).toBe(0);
    expect(claudeMd(home)).not.toContain(PADAWAN_SECTION_OPEN);
    expect(existsSync(join(home, PADAWAN_MARKER))).toBe(false);
  });

  test("with --seed, the board section lands below the padawan section", () => {
    const home = freshHome(".claude");
    const result = installSh(home, "--padawan", "--seed", join(home, "data"), "--owner", "Ada");
    expect(result.status).toBe(0);
    const text = claudeMd(home);
    const guide = text.indexOf(GUIDE_SECTION_OPEN);
    const padawan = text.indexOf(PADAWAN_SECTION_OPEN);
    const board = text.indexOf(SECTION_OPEN);
    expect(guide).toBeGreaterThan(-1);
    expect(padawan).toBeGreaterThan(guide);
    expect(board).toBeGreaterThan(padawan);
  });

  test("rejects --padawan together with --no-padawan", () => {
    const result = installSh(freshHome(".claude"), "--padawan", "--no-padawan");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot be combined");
  });
});
