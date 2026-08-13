// The harness registry: one entry per agent harness DCL knows how to wire into.
//
// Everything machine-shaped about a harness lives here — where its skills go, whether
// it is present, and which global config files carry DCL's managed block. Adding a
// harness is one entry plus its tests; nothing else in the installer or the seeder
// should learn a harness's name or paths.
//
// Two destinations, deliberately different in kind:
//
//   - `skillsDirs` are **unconditional**. Skills are symlinked there whether or not the
//     harness is installed, because a skills tree is inert until something reads it and
//     a machine that installs the harness later should find them already in place.
//   - `configTargets` are **detection-gated**. They mutate a file the user owns, so a
//     harness directory that does not exist is left alone: installing a harness is not
//     DCL's job.
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { START_MARK } from "./marks.ts";

/** `block` = a markered region inside an existing config file; `cursor` = a standalone
 * rule file DCL owns outright. */
export type ConfigTargetKind = "block" | "cursor";

export interface ConfigTarget {
  path: string;
  kind: ConfigTargetKind;
}

export interface Harness {
  /** Stable identifier, used in logs and tests. */
  id: string;
  /** Home-relative skill destinations, linked regardless of detection. */
  skillsDirs: string[];
  /** Is this harness present on the machine? Never creates anything. */
  detect(home: string): boolean;
  /** Config files to carry the managed block. Empty for skills-only entries. */
  configTargets(home: string): ConfigTarget[];
}

/** Alternate-profile scan input. A home that cannot be listed — absent, or a directory
 * this process may not read — contributes no profiles, matching the existsSync probes
 * around it: detection reports what is there, and repairing a home is not our job.
 * Without this, scanning for profiles would make an unusable home abort seeding. */
function readHomeEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Alternate Claude Code profiles (`CLAUDE_CONFIG_DIR=~/.claude-<name>`) opt in by
 * already carrying the marker in their CLAUDE.md: we refresh those, never seed them.
 * Anything else would write into a profile the user never pointed at DCL. */
function claudeProfileTargets(home: string): ConfigTarget[] {
  const targets: ConfigTarget[] = [];
  for (const entry of readHomeEntries(home)) {
    if (!entry.isDirectory() || !entry.name.startsWith(".claude-")) continue;
    const claudeMd = join(home, entry.name, "CLAUDE.md");
    try {
      if (readFileSync(claudeMd, "utf8").includes(START_MARK)) {
        targets.push({ path: claudeMd, kind: "block" });
      }
    } catch {
      // No CLAUDE.md in this profile — nothing to refresh.
    }
  }
  return targets;
}

/** Every harness DCL wires into. Order fixes the order of both the skill destinations
 * and the detected config targets, which the tests assert exactly. */
export const harnesses: Harness[] = [
  {
    id: "claude",
    skillsDirs: [".claude/skills"],
    // Not `existsSync(~/.claude)`: this installer creates `~/.claude/skills` itself, on
    // every machine, before any seeding runs. Keying on the bare directory would let our
    // own unconditional skill link stand in as evidence that Claude Code is installed,
    // and `./install.sh --seed` would then write a managed block into the CLAUDE.md of a
    // machine that has never run it. Anything in that directory other than the skills
    // tree is evidence; the skills tree alone is our own footprint.
    detect: (home) => readHomeEntries(join(home, ".claude")).some((entry) => entry.name !== "skills"),
    configTargets: (home) => [{ path: join(home, ".claude", "CLAUDE.md"), kind: "block" }],
  },
  {
    // The vendor-neutral tree read by skill-aware harnesses that have no config file of
    // their own. It has no detection and no config target: the directory is DCL's to
    // create, so there is nothing to find and nothing of the user's to edit.
    id: "agents",
    skillsDirs: [".agents/skills"],
    detect: () => false,
    configTargets: () => [],
  },
  {
    id: "codex",
    skillsDirs: [],
    detect: (home) => existsSync(join(home, ".codex")),
    configTargets: (home) => [{ path: join(home, ".codex", "AGENTS.md"), kind: "block" }],
  },
  {
    // The nested `.cursor/.cursor` is not a typo: Cursor's rules live under a `.cursor`
    // directory inside its config home.
    id: "cursor",
    skillsDirs: [],
    detect: (home) => existsSync(join(home, ".cursor")),
    configTargets: (home) => [
      { path: join(home, ".cursor", ".cursor", "rules", "loops.mdc"), kind: "cursor" },
    ],
  },
];

/** Home-relative skill destinations, in registry order, deduplicated. This is the list
 * `install.sh` consumes through its generated mirror — see setup/skill-dirs.txt. */
export function skillsDirs(): string[] {
  return [...new Set(harnesses.flatMap((harness) => harness.skillsDirs))];
}

/** The config targets this machine actually has: every detected harness's targets, plus
 * the opted-in alternate Claude profiles. `home` is injectable for tests. */
export function detectConfigTargets(home: string): ConfigTarget[] {
  return harnesses.flatMap((harness) => {
    const own = harness.detect(home) ? harness.configTargets(home) : [];
    return harness.id === "claude" ? [...own, ...claudeProfileTargets(home)] : own;
  });
}
