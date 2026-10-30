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

/** The operating guide's own section tag, and the first receipt line of a guide whose
 * receipt the board's additions extend. */
export const GUIDE_SECTION_OPEN = "<DECENTLY-CAPABLE-POWERS>";
const GUIDE_RECEIPT_LINE = "<WORK TYPE>: MERGED|READY TO MERGE|INCOMPLETE -";

/** Whether a config file already holds an operating guide that defines the receipt the
 * board's additions extend: its section tag as an entire trimmed line, like every other
 * tag here, and that receipt's first line. An older guide with a different receipt gets
 * the full block, so the file is never left without a receipt the additions fit. */
export function guideDefinesReceipt(content: string): boolean {
  return content.split("\n").some((line) => line.trim() === GUIDE_SECTION_OPEN) &&
    content.includes(GUIDE_RECEIPT_LINE);
}

/** `full` defines work-streams and the whole receipt; `additions` assumes the operating
 * guide in the same file defines both and states only what the board adds. */
export type ReceiptForm = "full" | "additions";

/** The generic awareness body, rendered with this instance's owner and paths.
 * Owner-specific policy does NOT belong here - it lives in the data repo's
 * HOUSE-RULES.md, which the body points agents at. Each harness wraps it: a markered
 * block for CLAUDE.md/AGENTS.md (renderConfigBlock), or a standalone .mdc rule for
 * Cursor (renderCursorRule). */
function renderBody({ owner, dataRepo, dclHome }: BlockParams, receipt: ReceiptForm): string {
  const itemAdditions = `For a registered item, the first status also names the item's board state in
parentheses:

- \`MERGED (MERGED|TESTED|DELIVERED|ACCEPTED)\`
- \`READY TO MERGE (IMPLEMENTED_AND_REVIEW_PASSED|IMPLEMENTED_WITHOUT_REVIEW)\`, the
  second whenever the review has not passed (requested, waived, or not configured)
- \`INCOMPLETE (IN-PROGRESS|BLOCKED|IDEA|SPEC-FILED|DROPPED)\`

Also:

- \`REVIEW: PASSED\` needs current evidence: with the bundled reviewer, its \`status\`
  command run immediately before the receipt, printing \`REVIEW_STATUS=passed\`. When it
  reports \`carried_from\`, write \`REVIEW: PASSED (carried over from <sha>; <the delta in
  plain words>; not re-reviewed)\`.
- \`NEXT STEP/OPTIONS\` names who acts next.
- Before printing the receipt, leave the item true even if ${owner} never replies: state,
  next-actor, awaiting, next-step and \`links.base-sha\`/\`head-sha\` current, committed and
  pushed, presuming no approval you have not received.`;

  const receiptText = receipt === "additions"
    ? `End that handoff with the operating guide's completion receipt.

${itemAdditions}`
    : `End that handoff with this receipt as the last lines you print, as plain paragraphs
separated by blank lines, never in a code block (a Markdown renderer joins adjacent
lines, and a code block does not wrap):

    <WORK TYPE>: MERGED|READY TO MERGE|INCOMPLETE (<item state>) - <one sentence: what this work was and what for>

    VERIFICATION: PASSED|FAILED|NOT RUN - <one sentence: what was checked>

    REVIEW: PASSED|REQUESTED|BLOCKED|NOT CONFIGURED|WAIVED|NOT RUN - <reviewer, rounds>

    NEXT STEP/OPTIONS: <who acts next and what; when it is ${owner}'s call, every real alternative, doing nothing included>

The values are closed: write only those listed, because ${owner} and tools read them. A
step you skipped or could not run, for any reason, is \`NOT RUN\` with the reason; never
coin another value. \`MERGED\` means in the project's integration branch,
\`READY TO MERGE\` finished and verified but not merged yet, \`INCOMPLETE\` anything else.
\`<WORK TYPE>\` is IMPLEMENTATION, FIX, SPEC, PLAN, RESEARCH, DOCS, or TASK when nothing
narrower fits. Write each sentence for a reader switching in cold (plain words, no slugs
or finding IDs), then brief evidence: command, HEAD, URL, or ledger. \`WAIVED\` needs
${owner}'s explicit opt-out; \`REQUESTED\` means a person or asynchronous tool has the
review and has not finished; a \`BLOCKED\` line also states the risk of merging now:
what is unreviewed, what covers it anyway, your confidence and why, and the impact if
wrong. Say "merge", never "land", to ${owner}.

${itemAdditions}`;

  const definition = receipt === "additions"
    ? `Work-streams and errands are as the operating guide defines them; errands also skip
the board.`
    : `A **work-stream** is work that changes a project's behavior (for users, calling code, tests
and CI, or agents reading its instructions) or whose state must outlive the conversation (a
spec, a decision from ${owner}, a delivery, a later session); when unsure, it is one.
Anything else is an **errand**: it skips the board, the review and the receipt, and if it
changed files it ends with the line \`Errand: <what changed>; no behavior change.\` A commit
takes the class of what it commits, and an errand found to change behavior becomes a
work-stream.`;

  return `## Work-stream board (decently-coordinated-loops)
${definition}

Before touching the board from any repository, run:

    bun "${dclHome}/tools/cli-registered.ts" --data-repo "${dataRepo}"

Exit 0 (prints a name): this checkout is registered. Load loops-board, read
\`${dataRepo}/BOARD.md\` before starting a work-stream, and whenever its state or next step
changes, update its item file and index row and commit in the data repo. Non-zero: do not
read or write the board from here, except for obligations \`${dataRepo}/HOUSE-RULES.md\`
declares gate-exempt. When a work-stream starts in an unregistered repository, whatever its
origin (a new project, a fork you will change, a legacy project you pick up, or a proof of
concept that has become real work), offer ${owner} to register it, and say what it gains:
a board item, review and pickup. Register it (\`PROJECTS.md\` + \`loops.json\`) only on
${owner}'s yes. A repository that only hosts errands gets no offer.

Phrases from ${owner} and the skill each one loads: "process the inbox", "process the
outbox", "interview me" → loops-queues; "sync the tracker" → loops-board; "pick up the
next available piece of work", or any unattended work → loops-pickup; dispatch duty →
loops-dispatch. Questions only ${owner} can answer go to \`${dataRepo}/OUTBOX.md\` per
loops-queues. If this harness cannot load skills by name, read
\`${dclHome}/skills/<name>/SKILL.md\`.

## Completion review
At the final handoff of a registered work-stream item, attended or unattended, once final
verification passes: start the review mechanism named in \`${dataRepo}/HOUSE-RULES.md →
Review mechanism\` without waiting to be asked (if \`loops.json → review.reviewer\` is set,
that is loops-review). A failed review attempt is yours to fix and rerun. Escalate to
${owner} only a round cap, a finding deferred to them, or a suspected review-mechanism
defect, per loops-review, and never with "more rounds" as the only option offered.

${receiptText}

\`${dataRepo}/HOUSE-RULES.md\` beats the DCL skills where they differ. Where wording and
${owner}'s evident intent diverge, follow the intent and say so, except for the closed
receipt values and the registration check above, which never bend.`;
}

/** The section DCL upserts inside a shared config file's <GENERATED> wrapper
 * (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md). Pass `additions` when that file already holds
 * the operating guide, so the receipt is defined once per file. */
export function renderConfigBlock(params: BlockParams, receipt: ReceiptForm = "full"): string {
  return `${SECTION_OPEN}\n${PROVENANCE}\n${renderBody(params, receipt)}\n${SECTION_CLOSE}\n`;
}

/** Cursor reads global rules as standalone `.mdc` files (YAML frontmatter + body) under
 * `~/.cursor/rules/`, not as a markered block inside one shared file - so the
 * whole file is the managed unit. Same body, different wrapper. */
export function renderCursorRule(params: BlockParams): string {
  return `---
description: Work-stream board participation and pickup for decently-coordinated-loops (global). Project rules override on conflict.
alwaysApply: true
---

${renderBody(params, "full")}
`;
}

/** Kiro loads every markdown file under `~/.kiro/steering/` as global steering; the
 * `inclusion: always` frontmatter (also Kiro's default) puts it in every session. Like
 * the Cursor rule, the whole file is the managed unit. */
export function renderKiroSteering(params: BlockParams): string {
  return `---
inclusion: always
---

${renderBody(params, "full")}
`;
}

/** The Kiro agent a DCL review runs as (`kiro-cli chat --agent dcl-reviewer`). Kiro has
 * no sandbox flag in headless mode, so read-only is the tool list: file reads only, no
 * write tool and no shell - a command allowlist is not a sandbox (`git diff
 * --output=<file>` writes), so the adapter inlines the diffs instead. Custom agents load
 * no steering on their own, so the repo's rule files are named as resources. Carries no
 * owner data, so every machine's copy is identical.
 *
 * The shape is Kiro's universal format, exactly what `kiro-cli agent upgrade` emits, so the
 * V2 and V3 engines both load it: V2 reads `allowedTools`, V3 reads the `read` tag and the
 * `permissions` block, and V3 skips a profile carrying `allowedTools` without
 * `permissions`. The `skill` rule is part of that format; dropping it makes the upgrader
 * treat the file as not yet universal. */
export function renderKiroReviewerAgent(): string {
  const agent = {
    name: "dcl-reviewer",
    description: "Read-only code reviewer driven by decently-coordinated-loops. Managed file; re-running setup overwrites it.",
    tools: ["glob", "grep", "read"],
    allowedTools: ["fs_read", "grep", "glob"],
    resources: ["file://AGENTS.md", "file://.kiro/steering/**/*.md"],
    permissions: {
      rules: [
        { capability: "fs_read", effect: "allow" },
        { capability: "skill", effect: "allow" },
      ],
    },
  };
  return `${JSON.stringify(agent, null, 2)}\n`;
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

/** Writes a whole-file managed unit (the Cursor rule, the Kiro steering and agent files), creating
 * its directory if needed. Returns what happened, for logging. */
export function writeOwnedFile(target: string, content: string): "created" | "replaced" {
  const existed = existsSync(target);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return existed ? "replaced" : "created";
}
