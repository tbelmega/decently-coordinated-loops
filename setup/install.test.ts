// install.sh's skill linking against links an earlier decently-capable-powers (DCP)
// install left behind: a link into a DCP checkout's skills/ is taken over when DCL has
// that skill, and kept when it does not, so no skill stops loading mid-migration.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DCL_HOME = resolve(import.meta.dirname, "..");

function fakeDcp(root: string, skills: string[]): string {
  const dcp = join(root, "decently-capable-powers");
  for (const skill of skills) mkdirSync(join(dcp, "skills", skill), { recursive: true });
  writeFileSync(join(dcp, "install.sh"), "#!/usr/bin/env bash\n# install.sh - deploy decently-capable-powers into user-level agent config.\n");
  return dcp;
}

function runInstall(home: string): string {
  const result = spawnSync("bash", [join(DCL_HOME, "install.sh")], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("install.sh takes over skill links from a decently-capable-powers install", () => {
  test("a DCP link to a skill DCL has is repointed to DCL", () => {
    const root = mkdtempSync(join(tmpdir(), "loops-takeover-"));
    const home = join(root, "home");
    const dcp = fakeDcp(root, ["loops-board"]);
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(join(dcp, "skills", "loops-board"), join(home, ".claude", "skills", "loops-board"));

    const out = runInstall(home);

    expect(readlinkSync(join(home, ".claude", "skills", "loops-board"))).toBe(join(DCL_HOME, "skills", "loops-board"));
    expect(out).toContain("taken over from decently-capable-powers");
  });

  test("a DCP link whose DCP checkout is gone is still taken over", () => {
    const root = mkdtempSync(join(tmpdir(), "loops-takeover-"));
    const home = join(root, "home");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(
      join(root, "moved-away", "decently-capable-powers", "skills", "loops-board"),
      join(home, ".claude", "skills", "loops-board"),
    );

    runInstall(home);

    expect(readlinkSync(join(home, ".claude", "skills", "loops-board"))).toBe(join(DCL_HOME, "skills", "loops-board"));
  });

  test("a DCP link to a skill DCL lacks is kept", () => {
    const root = mkdtempSync(join(tmpdir(), "loops-takeover-"));
    const home = join(root, "home");
    const dcp = fakeDcp(root, ["agent-handover"]);
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(join(dcp, "skills", "agent-handover"), join(home, ".claude", "skills", "agent-handover"));

    runInstall(home);

    expect(readlinkSync(join(home, ".claude", "skills", "agent-handover"))).toBe(join(dcp, "skills", "agent-handover"));
  });

  test("a link into some other repo, or a real directory, is left untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "loops-takeover-"));
    const home = join(root, "home");
    const other = join(root, "other-tool", "skills", "loops-board");
    mkdirSync(other, { recursive: true });
    mkdirSync(join(home, ".claude", "skills", "loops-queues"), { recursive: true });
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    symlinkSync(other, join(home, ".agents", "skills", "loops-board"));

    const out = runInstall(home);

    expect(readlinkSync(join(home, ".agents", "skills", "loops-board"))).toBe(other);
    expect(lstatSync(join(home, ".claude", "skills", "loops-queues")).isDirectory()).toBe(true);
    expect(out).toContain("is not a link to this repo - left untouched");
    expect(existsSync(join(home, ".claude", "skills", "loops-board"))).toBe(true);
  });
});
