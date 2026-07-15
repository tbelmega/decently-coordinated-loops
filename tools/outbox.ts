import type { OrphanRow } from "./preflight.ts";

/** Append one orphan-row entry to OUTBOX.md's "## Open" section, per its entry contract:
 * type `question`, source = the orphan row, ask = "create an item file or discard".
 * Pure string transform — the caller does the file read/write.
 *
 * Idempotent by orphan path: if an orphan entry for this row is already present, the
 * text is returned unchanged. Sync writes the outbox before it regenerates the board,
 * so a crash in between (or a restored old board) re-runs preflight against the same
 * still-orphaned row — without this guard each re-run would append a duplicate ask.
 * The contract itself requires dedup before appending (loops-queues skill). Answered
 * entries are deleted on routing, so a present marker always means a live open ask. */
export function appendOrphanRowEntry(outboxText: string, orphan: OrphanRow): string {
  const marker = `BOARD.md row \`${orphan.path}\``;
  if (outboxText.includes(marker)) return outboxText;

  const existingIds = [...outboxText.matchAll(/^### (\d+) —/gm)].map((m) => parseInt(m[1], 10));
  const nextId = (existingIds.length ? Math.max(...existingIds) : 0) + 1;

  const entry = `
### ${nextId} — question: orphan BOARD.md row with no item file
- type: question
- project: ${orphan.project}
- source: BOARD.md row \`${orphan.path}\` — [${orphan.title}](${orphan.path})
- ask: This row has no matching item file under \`items/\` (preflight run before
  regenerating the board). Create an item file for it (per the loops-board skill) or
  confirm it should be discarded. It has been dropped from the regenerated board so
  its data isn't lost silently; row was: project=${orphan.project}, state=${orphan.state},
  next-actor=${orphan.nextActor}, awaiting=${orphan.awaiting}, auto=${orphan.auto},
  owner=${orphan.owner}, updated=${orphan.updated}.
> A:
`;

  // Entries live at the end of the file, appended in order under "## Open" — matches
  // the existing OUTBOX.md structure (no trailing section after Open).
  return `${outboxText.replace(/\n+$/, "")}\n${entry}`;
}
