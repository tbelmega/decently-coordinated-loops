// The markered agent-config block DCL installs into a harness's global config file.
// Idempotent upsert: an existing block between the markers is replaced; otherwise the
// block is appended.
//
// Which files those are is not decided here — setup/harnesses.ts owns that, and this
// module re-exports its detection so callers keep one import. Nothing below may name a
// harness or one of its paths.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { START_MARK, END_MARK } from "./marks.ts";

export { START_MARK, END_MARK };
export { detectConfigTargets, type ConfigTarget, type ConfigTargetKind } from "./harnesses.ts";

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
loops-pickup skill. When ${owner} asks you to set yourself up for dispatch duty (or
to inspect or stop a running dispatcher), follow the loops-dispatch skill.
Read \`${dataRepo}/HOUSE-RULES.md\` before any unattended work —
it holds this instance's local policy. If this harness can't load skills by name,
read them from \`${dclHome}/skills/*/SKILL.md\`.

## Completion review
At the final implementation handoff of a registered work-stream item — attended or
unattended, after all of its internal tasks and commits are complete and final
verification passes — resolve \`${dataRepo}/HOUSE-RULES.md → Review mechanism\` and
initiate it without waiting for an explicit request. If \`loops.json → review.reviewer\`
is set, load loops-review and drive the bundled reviewer; a clean review of the current
HEAD is its passing terminal signal.

**End** that final item handoff with this receipt — the last lines you print, below the
prose summary, so the status is visible without scrolling. Use only these states, and
include concise command, HEAD, URL, or ledger evidence after the dash:

    IMPLEMENTATION: COMPLETE|INCOMPLETE
    VERIFICATION: PASSED|FAILED|NOT RUN
    REVIEW: PASSED|REQUESTED|BLOCKED|NOT CONFIGURED|WAIVED|NOT RUN
    NEXT STEP/OPTIONS: <the next action, or the alternatives when it is the owner's call>

\`REQUESTED\` means an asynchronous tool or human has the review but has not completed
it; \`WAIVED\` requires the owner's explicit opt-out. Do not claim the overall item
complete when its required review has not passed. If the bundled reviewer is active,
run its \`status\` command immediately before the receipt; only its
\`REVIEW_STATUS=passed\` result supports \`REVIEW: PASSED\`.

\`NEXT STEP/OPTIONS\` is mandatory and names who acts next. When the item is cleanly
handed over, one line is enough (e.g. the owner lands the recorded range).

A failed or incomplete review attempt is yours to recover from, not the owner's: fix
the cause and run the review again, leaving the item where it is — the attempt is
recorded separately and costs no round. A stale review is not free: a fresh round
consumes one, and \`start\` refuses a same-base rerun when the last round was clean.
Escalate only a round cap or an outstanding \`deferred-to-human\` finding, and then
enumerate every real exit with the board transition it requires:

- authorize rounds past the cap (\`--max-rounds\`, logged on the item) — until the
  owner rules, the item sits \`blocked\` / \`next-actor: owner\` / \`awaiting: approve\`
- disposition the outstanding finding \`deferred-to-human\` and hand over
  \`REVIEW: BLOCKED\` — \`blocked\` / \`next-actor: owner\` / \`awaiting: decide\`
- land as-is under the owner's explicit \`WAIVED\` opt-out — only the owner can give
  it; once given the item is \`implemented\` / \`next-actor: owner\` /
  \`awaiting: review-merge\`
- drop the change — \`dropped\`

Never make "approve more rounds" the only option the owner can see.

**Before printing the receipt, leave the item in a state that is still accurate if the
owner never replies** — state, next-actor, awaiting, next-step, and the recorded
\`base-sha\`/\`head-sha\` all true as of that moment, committed and pushed. Never park an
item in a state that presumes an approval you have not received. The owner must be able
to close the conversation at that point without leaving the board stale.`;
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

/** Writes the Cursor rule file (whole-file managed unit), creating the rules dir if
 * needed. Returns what happened, for logging. */
export function writeCursorRule(target: string, content: string): "created" | "replaced" {
  const existed = existsSync(target);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return existed ? "replaced" : "created";
}
