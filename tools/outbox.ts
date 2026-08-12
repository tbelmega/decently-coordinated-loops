// OUTBOX.md's programmatic writer. The file's format is the loops-queues entry
// contract; this module is the only place DCL writes it, and every write takes the
// shared lock and checks the file against the snapshot it transformed.
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { OrphanRow } from "./preflight.ts";

/** How this module reads OUTBOX.md. Production has exactly one implementation; the seam
 * exists because the conflict branch below is a race between two reads, and a test that
 * cannot stand between them cannot reach it at all. */
export type ReadFile = (path: string) => string;

const defaultRead: ReadFile = (path) => readFileSync(path, "utf8");

/** Run `body` while holding an exclusive lock on `path`, or return null if it is held.
 *
 * **The lock is an optimisation, not the correctness mechanism.** It stops cooperating
 * writers wasting work on each other, but it cannot bind a writer that does not take
 * it — a person editing the file, a phone client, or a tool in another repository.
 * Against those, `replaceIfUnchanged` narrows the window rather than closing it; read
 * its contract before claiming this file is safe against any writer at all.
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
  const token = String(process.pid);
  try {
    writeFileSync(lockPath, token);
    return body();
  } finally {
    closeSync(handle);
    try {
      // Release only our own lock. If someone deleted this lock while we still held it —
      // the documented manual recovery, aimed at a crashed holder — a second writer may
      // already have created its own, and unlinking that one would let a third in while
      // the second is still working. Reading before unlinking cannot close that window
      // either (the file can change between the two calls), but it turns the common case
      // from "silently breaks the lock" into "leaves it alone".
      if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
    } catch {
      // already gone, or unreadable — nothing safe left to do
    }
  }
}

/** Replaces `path` via a temp file in the same directory plus a rename, so a reader
 * never observes a half-written OUTBOX.md. Sync twin of tools/review/atomic-write.ts,
 * which is async and belongs to the review mechanism; inlined here for the same reason
 * setup/seed.ts inlines its own, to keep the module boundaries one-directional.
 *
 * The existing mode is carried onto the replacement. Replace-by-rename otherwise silently
 * re-creates the file at the process default (commonly 0644), so an OUTBOX.md an owner
 * restricted to 0600 would be published to every local user by a routine sync — a write
 * that widens permissions is a worse failure than the torn read this avoids. */
function writeFileAtomically(path: string, content: string): void {
  const temporaryPath = join(dirname(path), `${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temporaryPath, content);
    try {
      chmodSync(temporaryPath, statSync(path).mode);
    } catch {
      // No existing file (or no permission to read its mode): keep the default.
    }
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/** Writes `next` only if `path` still held exactly `snapshot` when last observed, and
 * reports whether it wrote.
 *
 * **This is not an atomic compare-and-swap, and must not be described as one.** The
 * check and the rename are two syscalls: an edit that lands in between is overwritten
 * and lost, undetectably, because no lock-free protocol over a plain file can close that
 * window. What the check does buy is real but bounded — it catches every edit made
 * before the transaction started, which is the overwhelmingly likely shape of a
 * conflict (a person editing OUTBOX.md, or a phone client committing an answer, while a
 * long-running sync computes) — and it costs nothing. Full serialization is available
 * only between writers that take `withOutboxLock`; against the ones that cannot, this
 * narrows the race to microseconds rather than eliminating it. */
export function replaceIfUnchanged(
  path: string,
  snapshot: string,
  next: string,
  read: ReadFile = defaultRead,
): boolean {
  if (read(path) !== snapshot) return false;
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
### ${nextId} — question · ${headingToken(orphan.project)} · orphan BOARD.md row with no item file

Source: ${marker} - [${orphan.title}](${orphan.path}). The preflight run before regenerating
the board found no matching item file under \`items/\`.

The row was dropped from the regenerated board, so its data is recorded here rather than lost
silently: project=${orphan.project}, state=${orphan.state}, next-actor=${orphan.nextActor},
awaiting=${orphan.awaiting}, auto=${orphan.auto}, assignee=${orphan.assignee},
updated=${orphan.updated}.

**The ask:** create an item file for it (per the loops-board skill), or confirm it should be
discarded.

> A:
`;

  const section = openSection(outboxText);
  if (!section) throw new Error("OUTBOX.md has no `## Open` section to append to");
  return `${section.head}${section.open.replace(/\n+$/, "")}\n${entry}${section.tail}`;
}

/** The project a routed entry claims, which readers compare directly against their own
 * project labels. The heading's project field is one whitespace-free token to them, while
 * the item schema asks only that `project` be non-blank — and an orphan row has no item
 * file, so nothing validated its label in the first place.
 *
 * A label that cannot be a token becomes `UNPARSEABLE`, never an invented identity.
 * Substituting the whitespace (`family app` → `family-app`) would silently merge two
 * distinct projects, and escaping it (`family%20app`) invents a project name that matches
 * nothing on the board and no consumer decodes. `UNPARSEABLE` is the honest third answer:
 * it cannot collide with a real project, it does not misattribute the entry to one, and
 * the exact label is recorded in the body immediately below, which is where a reader who
 * sees the marker will look. */
export const UNPARSEABLE_PROJECT = "UNPARSEABLE";

function headingToken(project: string): string {
  const label = project.trim();
  return label === "" || /\s/.test(label) ? UNPARSEABLE_PROJECT : label;
}

export type OrphanRoutingResult =
  | { status: "routed"; count: number }
  | { status: "unchanged" }
  | { status: "conflict" }
  | { status: "locked" };

/** Route every orphan row into OUTBOX.md under the shared lock, against a single
 * snapshot, and report what happened. Nothing is reported as done that did not
 * happen: a held lock and a concurrent edit each return their own status for the caller
 * to surface. Both are safe to leave — the rows stay orphaned, so the next sync files
 * them again. */
export function routeOrphanRows(
  outboxPath: string,
  orphans: OrphanRow[],
  read: ReadFile = defaultRead,
): OrphanRoutingResult {
  const result = withOutboxLock(outboxPath, (): OrphanRoutingResult => {
    // ONE read. Everything below transforms this exact snapshot, and the rename replaces
    // the file it came from.
    const snapshot = read(outboxPath);
    let outboxText = snapshot;
    // Counted, not assumed: a batch mixing already-recorded rows with new ones would
    // otherwise report every row as newly routed, and that log line is the audit trail
    // for whether an owner-facing recovery entry was actually created in this run.
    let appended = 0;
    for (const orphan of orphans) {
      const next = appendOrphanRowEntry(outboxText, orphan);
      if (next !== outboxText) appended += 1;
      outboxText = next;
    }
    if (outboxText === snapshot) return { status: "unchanged" };
    return replaceIfUnchanged(outboxPath, snapshot, outboxText, read)
      ? { status: "routed", count: appended }
      : { status: "conflict" };
  });
  return result ?? { status: "locked" };
}

/** What sync should do about a routing result, and what to tell the reader.
 *
 * `locked` and `conflict` abort the run. An orphan row has no item file, so BOARD.md is
 * the only remaining copy of it: regenerating the board after a failed routing would
 * drop the row from the one place the next sync could still find it, and the retry this
 * module promises would be impossible. Aborting leaves both files exactly as they were. */
export function orphanRoutingOutcome(
  routing: OrphanRoutingResult,
  rowCount: number,
): { abort: boolean; message: string } {
  const rows = `${rowCount} orphan row(s)`;
  switch (routing.status) {
    case "routed": {
      const already = rowCount - routing.count;
      return {
        abort: false,
        message:
          `Routed ${routing.count} orphan row(s) to OUTBOX.md.` +
          (already > 0 ? ` (${already} already recorded.)` : ""),
      };
    }
    case "unchanged":
      return { abort: false, message: `${rows} already recorded in OUTBOX.md.` };
    case "locked":
      return {
        abort: true,
        message: `${rows} NOT routed: OUTBOX.md.lock is held by another writer. Nothing was changed — re-run sync.`,
      };
    case "conflict":
      return {
        abort: true,
        message: `${rows} NOT routed: OUTBOX.md changed while sync held the lock. Nothing was changed — re-run sync.`,
      };
  }
}
