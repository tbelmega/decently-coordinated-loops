// The markered agent-config block DCL installs into each harness's global config
// file (e.g. ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md). Idempotent upsert: an
// existing block between the markers is replaced; otherwise the block is appended.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const START_MARK =
  "<!-- LOOPS:START — managed by decently-coordinated-loops; re-run install.sh or setup/seed.ts to refresh -->";
export const END_MARK = "<!-- LOOPS:END -->";

export interface BlockParams {
  owner: string;
  dataRepo: string;
  dclHome: string;
}

/** The generic awareness body, rendered with this instance's owner and paths.
 * Owner-specific policy does NOT belong here — it lives in the data repo's
 * HOUSE-RULES.md, which the body points agents at. Each harness wraps it: a markered
 * block for CLAUDE.md/AGENTS.md (renderConfigBlock), or a standalone .mdc rule for
 * Cursor (renderCursorRule). */
function renderBody({ owner, dataRepo, dclHome }: BlockParams): string {
  return `## Work-stream board (decently-coordinated-loops)
Board participation is scoped to registered projects. Before engaging the board in any
repository, run:

    bun "${dclHome}/tools/cli-registered.ts" --data-repo "${dataRepo}"

If it prints a name (exit 0), this checkout is registered: follow the loops-board skill
— read \`${dataRepo}/BOARD.md\` before substantive work, and when a work-stream's state
or next step changes, update its item file and index row and commit there. If it exits
non-zero, this repo is unregistered — do not read or update the board here, unless an
obligation in \`${dataRepo}/HOUSE-RULES.md\` applies regardless of the current directory
(those are gate-exempt). When a session gives birth to a new work-stream, register it on
the board and add its repo to \`${dataRepo}/PROJECTS.md\` + \`loops.json\` so it passes
the gate. ${owner} dumps raw thoughts into \`${dataRepo}/INBOX.md\` — when
asked to "process the inbox" (or during unattended pickup), turn entries into board
items per the loops-queues skill. Questions, proposals, and approvals that only
${owner} can resolve go into \`${dataRepo}/OUTBOX.md\` per the same skill; "process
the outbox" and "interview me" are handled there too. When ${owner} says "pick up
the next available piece of work" (or similar) without naming an item, follow the
loops-pickup skill. Read \`${dataRepo}/HOUSE-RULES.md\` before any unattended work —
it holds this instance's local policy. If this harness can't load skills by name,
read them from \`${dclHome}/skills/*/SKILL.md\`.

## Completion review
At the final implementation handoff of a registered work-stream item — attended or
unattended, after all of its internal tasks and commits are complete and final
verification passes — resolve \`${dataRepo}/HOUSE-RULES.md → Review mechanism\` and
initiate it without waiting for an explicit request. If \`loops.json → review.reviewer\`
is set, load loops-review and drive the bundled reviewer; a clean review of the current
HEAD is its passing terminal signal.

Begin that final item handoff with this receipt, using only these states and including
concise command, HEAD, URL, or ledger evidence after the dash:

    IMPLEMENTATION: COMPLETE|INCOMPLETE
    VERIFICATION: PASSED|FAILED|NOT RUN
    REVIEW: PASSED|REQUESTED|BLOCKED|NOT CONFIGURED|WAIVED|NOT RUN

\`REQUESTED\` means an asynchronous tool or human has the review but has not completed
it; \`WAIVED\` requires the owner's explicit opt-out. Do not claim the overall item
complete when its required review has not passed. If the bundled reviewer is active,
run its \`status\` command immediately before the receipt; only its
\`REVIEW_STATUS=passed\` result supports \`REVIEW: PASSED\`.`;
}

/** The block DCL upserts between markers inside a shared config file
 * (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md). */
export function renderConfigBlock(params: BlockParams): string {
  return `${START_MARK}\n${renderBody(params)}\n${END_MARK}\n`;
}

/** Cursor reads global rules as standalone `.mdc` files (YAML frontmatter + body) under
 * `~/.cursor/.cursor/rules/`, not as a markered block inside one shared file — so the
 * whole file is the managed unit. Same body, different wrapper. */
export function renderCursorRule(params: BlockParams): string {
  return `---
description: Work-stream board participation and pickup for decently-coordinated-loops (global). Project rules override on conflict.
alwaysApply: true
---

${renderBody(params)}
`;
}

/** Upserts the block into one config file, creating the file (and its directory)
 * if needed. Returns what happened, for logging. */
export function upsertConfigBlock(target: string, block: string): "created" | "replaced" | "appended" {
  mkdirSync(dirname(target), { recursive: true });
  if (!existsSync(target)) {
    writeFileSync(target, block);
    return "created";
  }
  const content = readFileSync(target, "utf8");
  if (content.includes(START_MARK) && content.includes(END_MARK)) {
    const before = content.split(START_MARK, 1)[0];
    const after = content.split(END_MARK).slice(1).join(END_MARK).replace(/^\n/, "");
    writeFileSync(target, `${before}${block}${after}`);
    return "replaced";
  }
  const glue = content.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(target, `${content}${glue}${block}`);
  return "appended";
}

/** How a target's content is written: a markered upsert into a shared file, or a
 * standalone Cursor rule file. */
export type ConfigTargetKind = "block" | "cursor";

export interface ConfigTarget {
  path: string;
  kind: ConfigTargetKind;
}

/** Writes the Cursor rule file (whole-file managed unit), creating the rules dir if
 * needed. Returns what happened, for logging. */
export function writeCursorRule(target: string, content: string): "created" | "replaced" {
  const existed = existsSync(target);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return existed ? "replaced" : "created";
}

/** The harness global configs this machine appears to use: a target is included when
 * its harness directory already exists (we never create harness directories —
 * installing a harness is not our job). CLAUDE.md/AGENTS.md take a markered block;
 * Cursor takes a standalone rule under its (nested) rules dir. Alternate Claude Code
 * profiles (CLAUDE_CONFIG_DIR=~/.claude-<name>) opt in by already carrying the
 * marker in their CLAUDE.md — we refresh those but never seed them. `home` is
 * injectable for tests. */
export function detectConfigTargets(home: string): ConfigTarget[] {
  const targets: ConfigTarget[] = [];
  if (existsSync(join(home, ".claude"))) {
    targets.push({ path: join(home, ".claude", "CLAUDE.md"), kind: "block" });
  }
  for (const entry of readdirSync(home, { withFileTypes: true })) {
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
  if (existsSync(join(home, ".codex"))) {
    targets.push({ path: join(home, ".codex", "AGENTS.md"), kind: "block" });
  }
  if (existsSync(join(home, ".cursor"))) {
    targets.push({ path: join(home, ".cursor", ".cursor", "rules", "loops.mdc"), kind: "cursor" });
  }
  return targets;
}
