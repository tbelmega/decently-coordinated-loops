// The markered agent-config block DCL installs into each harness's global config
// file (e.g. ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md). Idempotent upsert: an
// existing block between the markers is replaced; otherwise the block is appended.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const START_MARK =
  "<!-- LOOPS:START — managed by decently-coordinated-loops; re-run install.sh or setup/seed.ts to refresh -->";
export const END_MARK = "<!-- LOOPS:END -->";

export interface BlockParams {
  owner: string;
  dataRepo: string;
  dclHome: string;
}

/** The generic awareness block, rendered with this instance's owner and paths.
 * Owner-specific policy does NOT belong here — it lives in the data repo's
 * HOUSE-RULES.md, which the block points agents at. */
export function renderConfigBlock({ owner, dataRepo, dclHome }: BlockParams): string {
  const body = `## Work-stream board (decently-coordinated-loops)
\`${dataRepo}/BOARD.md\` tracks all parallel dev work-streams across projects and
agent harnesses. Read it before starting substantive work; when a work-stream's
state or next step changes, update its item file and index row per the loops-board
skill and commit there. When a session gives birth to a new work-stream, register
it on the board. ${owner} dumps raw thoughts into \`${dataRepo}/INBOX.md\` — when
asked to "process the inbox" (or during unattended pickup), turn entries into board
items per the loops-queues skill. Questions, proposals, and approvals that only
${owner} can resolve go into \`${dataRepo}/OUTBOX.md\` per the same skill; "process
the outbox" and "interview me" are handled there too. When ${owner} says "pick up
the next available piece of work" (or similar) without naming an item, follow the
loops-pickup skill. Read \`${dataRepo}/HOUSE-RULES.md\` before any unattended work —
it holds this instance's local policy. If this harness can't load skills by name,
read them from \`${dclHome}/skills/*/SKILL.md\`.`;
  return `${START_MARK}\n${body}\n${END_MARK}\n`;
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

/** The harness global-config files this machine appears to use: a target is
 * included when its harness directory already exists (we never create harness
 * directories — installing a harness is not our job). `home` is injectable for
 * tests. */
export function detectConfigTargets(home: string): string[] {
  const candidates = [
    join(home, ".claude", "CLAUDE.md"),
    join(home, ".codex", "AGENTS.md"),
  ];
  return candidates.filter((path) => existsSync(dirname(path)));
}
