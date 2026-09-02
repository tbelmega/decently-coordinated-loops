// The tagged agent-config section DCL installs into a harness's global config file.
// Idempotent upsert into the shared <GENERATED> wrapper: an existing
// <DECENTLY-COORDINATED-LOOPS> section is replaced in place, a missing one is inserted
// into the wrapper (created if absent), and a legacy LOOPS:START/END block is migrated
// into the new grammar. Malformed or ambiguous tags fail closed: the file is reported
// and left untouched, never partially rewritten.
//
// Which files those are is not decided here - setup/harnesses.ts owns that, and this
// module re-exports its detection so callers keep one import. Nothing below may name a
// harness or one of its paths.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  GENERATED_OPEN,
  GENERATED_CLOSE,
  SECTION_OPEN,
  SECTION_CLOSE,
  PROVENANCE,
  LEGACY_START_MARK,
  LEGACY_END_MARK,
} from "./marks.ts";

export {
  GENERATED_OPEN,
  GENERATED_CLOSE,
  SECTION_OPEN,
  SECTION_CLOSE,
  PROVENANCE,
  LEGACY_START_MARK,
  LEGACY_END_MARK,
};
export { detectConfigTargets, type ConfigTarget, type ConfigTargetKind } from "./harnesses.ts";

export interface BlockParams {
  owner: string;
  dataRepo: string;
  dclHome: string;
}

/** The generic awareness body, rendered with this instance's owner and paths.
 * Owner-specific policy does NOT belong here - it lives in the data repo's
 * HOUSE-RULES.md, which the body points agents at. Each harness wraps it: a markered
 * block for CLAUDE.md/AGENTS.md (renderConfigBlock), or a standalone .mdc rule for
 * Cursor (renderCursorRule). */
function renderBody({ owner, dataRepo, dclHome }: BlockParams): string {
  return `## Work-stream board (decently-coordinated-loops)
Board participation is scoped to registered projects. Before engaging the board in any
repository, run:

    bun "${dclHome}/tools/cli-registered.ts" --data-repo "${dataRepo}"

If it prints a name (exit 0), this checkout is registered: follow the loops-board
skill, read \`${dataRepo}/BOARD.md\` before substantive work, and when a work-stream's state
or next step changes, update its item file and index row and commit there. If it exits
non-zero, this repo is unregistered - do not read or update the board here, unless an
obligation in \`${dataRepo}/HOUSE-RULES.md\` applies regardless of the current directory
(those are gate-exempt). When a session gives birth to a new work-stream, register it on
the board and add its repo to \`${dataRepo}/PROJECTS.md\` + \`loops.json\` so it passes
the gate. ${owner} dumps raw thoughts into \`${dataRepo}/INBOX.md\` - when
asked to "process the inbox" (or during unattended pickup), turn entries into board
items per the loops-queues skill. Questions, proposals, and approvals that only
${owner} can resolve go into \`${dataRepo}/OUTBOX.md\` per the same skill; "process
the outbox" and "interview me" are handled there too. When ${owner} says "pick up
the next available piece of work" (or similar) without naming an item, follow the
loops-pickup skill. When ${owner} asks you to set yourself up for dispatch duty (or
to inspect or stop a running dispatcher), follow the loops-dispatch skill.
Read \`${dataRepo}/HOUSE-RULES.md\` before any unattended work -
it holds this instance's local policy. If this harness can't load skills by name,
read them from \`${dclHome}/skills/*/SKILL.md\`.

## Completion review
At the final implementation handoff of a registered work-stream item - attended or
unattended, after all of its internal tasks and commits are complete and final
verification passes - resolve \`${dataRepo}/HOUSE-RULES.md → Review mechanism\` and
initiate it without waiting for an explicit request. If \`loops.json → review.reviewer\`
is set, load loops-review and drive the bundled reviewer; a clean review of the current
HEAD is its passing terminal signal.

**End** that final item handoff with this receipt - the last lines you print, below the
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
the cause and run the review again, leaving the item where it is - the attempt is
recorded separately as the pending logical round with an alphabetic suffix, such as
\`1-a\`, and costs no round. When a changed patch series supersedes the review base,
the active review epoch starts again at round 1; prior epochs remain append-only audit
history and do not consume the new epoch's configured round cap. A stale review is not
free: a fresh round consumes one, and \`start\` refuses a same-base rerun when the last round was clean.
Escalate only a round cap or an outstanding \`deferred-to-human\` finding, and then
enumerate every real exit with the board transition it requires:

- authorize rounds past the cap (\`--max-rounds\`, logged on the item) - until the
  owner rules, the item sits \`blocked\` / \`next-actor: owner\` / \`awaiting: approve\`
- disposition the outstanding finding \`deferred-to-human\` and hand over
  \`REVIEW: BLOCKED\` - \`blocked\` / \`next-actor: owner\` / \`awaiting: decide\`
- land as-is under the owner's explicit \`WAIVED\` opt-out - only the owner can give
  it; once given the item is \`implemented\` / \`next-actor: owner\` /
  \`awaiting: review-merge\`
- drop the change - \`dropped\`

Never make "approve more rounds" the only option the owner can see.

**Before printing the receipt, leave the item in a state that is still accurate if the
owner never replies** - state, next-actor, awaiting, next-step, and the recorded
\`base-sha\`/\`head-sha\` all true as of that moment, committed and pushed. Never park an
item in a state that presumes an approval you have not received. The owner must be able
to close the conversation at that point without leaving the board stale.`;
}

/** The section DCL upserts inside a shared config file's <GENERATED> wrapper
 * (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md). */
export function renderConfigBlock(params: BlockParams): string {
  return `${SECTION_OPEN}\n${PROVENANCE}\n${renderBody(params)}\n${SECTION_CLOSE}\n`;
}

/** Cursor reads global rules as standalone `.mdc` files (YAML frontmatter + body) under
 * `~/.cursor/.cursor/rules/`, not as a markered block inside one shared file - so the
 * whole file is the managed unit. Same body, different wrapper. */
export function renderCursorRule(params: BlockParams): string {
  return `---
description: Work-stream board participation and pickup for decently-coordinated-loops (global). Project rules override on conflict.
alwaysApply: true
---

${renderBody(params)}
`;
}

export type UpsertOutcome =
  | { action: "created" | "replaced" | "appended" | "migrated" }
  | { action: "skipped"; reason: string };

interface TagPair {
  open: number;
  close: number;
}

/** Nearest-pair tag scan over the whole file. A tag counts only as the entire
 * trimmed line. Any orphan tag - a closing tag with no pending opening tag, an
 * opening tag while one is already pending, or one still pending at the end - is
 * malformed: an exact-line bare tag is far more likely wreckage of a damaged block
 * than prose, so the caller must fail closed rather than write around it. */
function scanPairs(
  lines: readonly string[],
  openTag: string,
  closeTag: string,
): { pairs: TagPair[]; error?: string } {
  const pairs: TagPair[] = [];
  let open: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === openTag) {
      if (open !== null) return { pairs, error: `${openTag} opened again before it was closed` };
      open = i;
    } else if (line === closeTag) {
      if (open === null) return { pairs, error: `${closeTag} without a matching ${openTag}` };
      pairs.push({ open, close: i });
      open = null;
    }
  }
  if (open !== null) return { pairs, error: `${openTag} is never closed` };
  return { pairs };
}

/** The legacy LOOPS:START/END region, matched as entire trimmed lines, the exact
 * lines old seeds wrote. Any legacy marker state other than none, or exactly one
 * START before exactly one END, is damage - a half-deleted block, duplicated
 * markers, a reversed pair - and fails closed instead of leaving stale legacy
 * material next to a freshly written section. */
function findLegacy(lines: readonly string[]): { pair: TagPair | null; error?: string } {
  const starts: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === LEGACY_START_MARK) starts.push(i);
    else if (trimmed === LEGACY_END_MARK) ends.push(i);
  });
  if (starts.length === 0 && ends.length === 0) return { pair: null };
  if (starts.length === 1 && ends.length === 1 && ends[0]! > starts[0]!) {
    return { pair: { open: starts[0]!, close: ends[0]! } };
  }
  return { pair: null, error: "unmatched, duplicated, or reversed legacy LOOPS markers" };
}

/** Upserts the section into one config file's <GENERATED> wrapper, creating the file
 * (and its directory) or the wrapper if needed and migrating a legacy markered block.
 * Returns what happened, for logging; `skipped` means the file's tags are malformed
 * or ambiguous and nothing was written.
 *
 * Accepted limitation (owner ruling 2026-08-23): this read-modify-write is not
 * serialized against the decently-capable-powers installer, so two installers run
 * concurrently on the same file can drop each other's freshly written section -
 * last writer wins. The window is sub-second, both runs are hand-started by the
 * same user, the fail-closed parser keeps the surviving file well-formed, and
 * re-running the losing installer restores its section. A locking protocol was
 * tried and reverted: its own failure modes reviewed worse than the race. */
export function upsertConfigBlock(target: string, section: string): UpsertOutcome {
  mkdirSync(dirname(target), { recursive: true });
  const wrapped = `${GENERATED_OPEN}\n${section}${GENERATED_CLOSE}\n`;
  if (!existsSync(target)) {
    writeFileSync(target, wrapped);
    return { action: "created" };
  }
  const content = readFileSync(target, "utf8");
  const lines = content.split("\n");
  const sectionLines = section.replace(/\n$/, "").split("\n");
  const wrapper = scanPairs(lines, GENERATED_OPEN, GENERATED_CLOSE);
  if (wrapper.error) return { action: "skipped", reason: wrapper.error };
  if (wrapper.pairs.length > 1) {
    return { action: "skipped", reason: `more than one ${GENERATED_OPEN} block` };
  }
  const own = scanPairs(lines, SECTION_OPEN, SECTION_CLOSE);
  if (own.error) return { action: "skipped", reason: own.error };
  if (own.pairs.length > 1) {
    return { action: "skipped", reason: `more than one ${SECTION_OPEN} section` };
  }
  const legacy = findLegacy(lines);
  if (legacy.error) return { action: "skipped", reason: legacy.error };

  if (wrapper.pairs.length === 1) {
    const { open: wrapperOpen, close: wrapperClose } = wrapper.pairs[0]!;
    if (
      own.pairs.length === 1 &&
      (own.pairs[0]!.open < wrapperOpen || own.pairs[0]!.close > wrapperClose)
    ) {
      return {
        action: "skipped",
        reason: `${SECTION_OPEN} section outside the ${GENERATED_OPEN} wrapper`,
      };
    }
    const next = [...lines];
    if (own.pairs.length === 1) {
      const pair = own.pairs[0]!;
      next.splice(pair.open, pair.close - pair.open + 1, ...sectionLines);
    } else {
      next.splice(wrapperClose, 0, ...sectionLines);
    }
    // A leftover legacy block (this tool's own, from before the wrapper existed) is
    // folded away: its content now lives in the section that was just written.
    // Everything else outside the tags is reproduced byte for byte.
    const leftover = findLegacy(next);
    if (leftover.error) return { action: "skipped", reason: leftover.error };
    if (leftover.pair) {
      next.splice(leftover.pair.open, leftover.pair.close - leftover.pair.open + 1);
    }
    writeFileSync(target, next.join("\n"));
    if (leftover.pair) return { action: "migrated" };
    return { action: own.pairs.length === 1 ? "replaced" : "appended" };
  }

  if (own.pairs.length === 1) {
    return {
      action: "skipped",
      reason: `${SECTION_OPEN} section outside any ${GENERATED_OPEN} wrapper`,
    };
  }
  if (legacy.pair) {
    const next = [...lines];
    next.splice(
      legacy.pair.open,
      legacy.pair.close - legacy.pair.open + 1,
      ...wrapped.replace(/\n$/, "").split("\n"),
    );
    writeFileSync(target, next.join("\n"));
    return { action: "migrated" };
  }
  const glue = content.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(target, `${content}${glue}${wrapped}`);
  return { action: "appended" };
}

/** Writes the Cursor rule file (whole-file managed unit), creating the rules dir if
 * needed. Returns what happened, for logging. */
export function writeCursorRule(target: string, content: string): "created" | "replaced" {
  const existed = existsSync(target);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return existed ? "replaced" : "created";
}
