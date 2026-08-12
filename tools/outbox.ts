// OUTBOX.md's programmatic writer. The file's format is the loops-queues entry
// contract; this module is the only place DCL writes it, and every write goes through
// the lock and the compare-and-swap below.
import { closeSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { OrphanRow } from "./preflight.ts";

/** Run `body` while holding an exclusive lock on `path`, or return null if it is held.
 *
 * **The lock is an optimisation, not the correctness mechanism.** It stops cooperating
 * writers wasting work on each other, but it cannot bind a writer that does not take
 * it — a person editing the file, a phone client, or a tool in another repository.
 * Correctness comes from the compare-and-swap every caller performs before its rename.
 * The lock filename (`<path>.lock`) is part of the contract: a second writer that picks
 * a different name serializes nothing.
 *
 * **There is deliberately no automatic reclamation.** Age alone sweeps a paused-but-live
 * writer, liveness alone lets a reused pid hold forever, and unlink-then-create lets two
 * reclaimers delete each other's fresh lock. A lock left behind by a crash is a visible
 * file a person deletes in one command; the pid is recorded so they can tell what left
 * it. */
export function withOutboxLock<T>(path: string, body: () => T): T | null {
  const lockPath = `${path}.lock`;
  let handle: number;
  try {
    handle = openSync(lockPath, "wx"); // atomic create-if-absent: no acquisition race
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  try {
    writeFileSync(lockPath, String(process.pid));
    return body();
  } finally {
    closeSync(handle);
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone
    }
  }
}

/** Replaces `path` via a temp file in the same directory plus a rename, so a reader
 * never observes a half-written OUTBOX.md. Sync twin of tools/review/atomic-write.ts,
 * which is async and belongs to the review mechanism; inlined here for the same reason
 * setup/seed.ts inlines its own, to keep the module boundaries one-directional. */
function writeFileAtomically(path: string, content: string): void {
  const temporaryPath = join(dirname(path), `${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temporaryPath, content);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/** Writes `next` only while `path` still holds exactly `snapshot`, and reports whether
 * it did. This is the guarantee the lock cannot give: OUTBOX.md is hand-edited and
 * written from other tools, so a writer that renamed unconditionally would silently
 * drop whatever arrived between its read and its write. Losing the write is recoverable
 * — every caller here is idempotent and a re-run reproduces it — while losing the
 * owner's answer is not. */
export function replaceIfUnchanged(path: string, snapshot: string, next: string): boolean {
  if (readFileSync(path, "utf8") !== snapshot) return false;
  writeFileAtomically(path, next);
  return true;
}

/** `## Open` is not guaranteed to be the last section. An entry appended after a later
 * `## Answered` heading is outside the section every reader scans, so the recovery ask
 * would be filed where nothing reads it. */
function openSection(text: string): { head: string; open: string; tail: string } | null {
  const at = text.search(/^## Open\s*$/m);
  if (at === -1) return null;
  const rest = text.slice(at);
  const afterHeading = rest.indexOf("\n");
  const next = afterHeading === -1 ? -1 : rest.slice(afterHeading).search(/^## /m);
  if (next === -1) return { head: text.slice(0, at), open: rest, tail: "" };
  const cut = afterHeading + next;
  return { head: text.slice(0, at), open: rest.slice(0, cut), tail: rest.slice(cut) };
}

/** Append one orphan-row entry to OUTBOX.md's `## Open` section, in the shape the
 * loops-queues entry contract defines: `### <id> — <type> · <project> · <title>` and a
 * prose body. No `- item:` line — an orphan row is by definition a row whose item file
 * is missing. Pure string transform; the caller does the file read/write.
 *
 * Idempotent by orphan path: if an entry for this row is already present, the text is
 * returned unchanged. Sync writes the outbox before it regenerates the board, so a
 * crash in between (or a restored old board) re-runs preflight against the same still
 * orphaned row — without this guard each re-run would append a duplicate ask. The
 * marker is built once and embedded in the body, so the guard cannot drift away from
 * what the entry actually says. Answered entries are deleted on routing, so a present
 * marker always means a live open ask. */
export function appendOrphanRowEntry(outboxText: string, orphan: OrphanRow): string {
  const marker = `BOARD.md row \`${orphan.path}\``;
  if (outboxText.includes(marker)) return outboxText;

  // Numbered against the WHOLE file, not just `## Open`: an id must not collide with an
  // entry that has since moved to a later section, or the two become indistinguishable
  // in every citation. Placement below is section-bounded; numbering is not.
  const existingIds = [...outboxText.matchAll(/^### (\d+) —/gm)].map((match) => parseInt(match[1], 10));
  const nextId = (existingIds.length ? Math.max(...existingIds) : 0) + 1;

  const entry = `
### ${nextId} — question · ${orphan.project} · orphan BOARD.md row with no item file

Source: ${marker} - [${orphan.title}](${orphan.path}). The preflight run before regenerating
the board found no matching item file under \`items/\`.

The row was dropped from the regenerated board, so its data is recorded here rather than lost
silently: state=${orphan.state}, next-actor=${orphan.nextActor}, awaiting=${orphan.awaiting},
auto=${orphan.auto}, assignee=${orphan.assignee}, updated=${orphan.updated}.

**The ask:** create an item file for it (per the loops-board skill), or confirm it should be
discarded.

> A:
`;

  const section = openSection(outboxText);
  if (!section) throw new Error("OUTBOX.md has no `## Open` section to append to");
  return `${section.head}${section.open.replace(/\n+$/, "")}\n${entry}${section.tail}`;
}

export type OrphanRoutingResult =
  | { status: "routed"; count: number }
  | { status: "unchanged" }
  | { status: "conflict" }
  | { status: "locked" };

/** Route every orphan row into OUTBOX.md as one locked, compare-and-swapped
 * transaction, and report what happened. Nothing is reported as done that did not
 * happen: a held lock and a concurrent edit each return their own status for the caller
 * to surface. Both are safe to leave — the rows stay orphaned, so the next sync files
 * them again. */
export function routeOrphanRows(outboxPath: string, orphans: OrphanRow[]): OrphanRoutingResult {
  const result = withOutboxLock(outboxPath, (): OrphanRoutingResult => {
    // ONE read. Everything below transforms this exact snapshot, and the rename replaces
    // the file it came from.
    const snapshot = readFileSync(outboxPath, "utf8");
    let outboxText = snapshot;
    for (const orphan of orphans) outboxText = appendOrphanRowEntry(outboxText, orphan);
    if (outboxText === snapshot) return { status: "unchanged" };
    return replaceIfUnchanged(outboxPath, snapshot, outboxText)
      ? { status: "routed", count: orphans.length }
      : { status: "conflict" };
  });
  return result ?? { status: "locked" };
}
