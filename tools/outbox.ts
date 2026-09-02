// OUTBOX.md's programmatic writer. The file's format is the loops-queues entry
// contract; this module is the only place DCL writes it, and every write takes the
// shared lock and checks the file against the snapshot it transformed.
import {
  appendFileSync,
  chmodSync,
  existsSync,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { OrphanRow } from "./preflight.ts";

/** How this module reads OUTBOX.md. Production has exactly one implementation; the seam
 * exists because the conflict branch below is a race between two reads, and a test that
 * cannot stand between them cannot reach it at all. */
export type ReadFile = (path: string) => string;

const defaultRead: ReadFile = (path) => readFileSync(path, "utf8");

/** The file a path actually names, so the lock and the write agree on their subject.
 * An unresolvable path (it does not exist yet) is its own answer. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Run `body` while holding an exclusive lock on `path`, or return null if it is held.
 *
 * **The lock is an optimisation, not the correctness mechanism.** It stops cooperating
 * writers wasting work on each other, but it cannot bind a writer that does not take
 * it - a person editing the file, a phone client, or a tool in another repository.
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
  // Derived from the resolved target, not the path as given: two checkouts pointing
  // symlinks at one canonical OUTBOX.md would otherwise take two different locks and
  // race their writes against the same file, which is the failure the lock exists for.
  const lockPath = `${canonicalPath(path)}.lock`;
  let handle: number;
  try {
    handle = openSync(lockPath, "wx"); // atomic create-if-absent: no acquisition race
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  // Identity is the inode we created, not what the file says. Content cannot carry it: a
  // token write that fails, or half-lands, would leave a lock nothing recognises and
  // nothing ever removes. The pid below is written through this descriptor rather than by
  // path, so it reaches only the file we made - writing by path could overwrite a
  // successor's lock if ours was removed in between, and we would then delete theirs.
  let identity: number;
  try {
    identity = fstatSync(handle).ino;
  } catch (error) {
    // The lock exists and we cannot name its inode, so this is the one release we cannot
    // prove is ours. Removing it anyway is deliberate: leaving it strands every later
    // writer behind a lock no process holds, while the only state it can destroy is a
    // successor lock created inside the microseconds between an operator deleting ours
    // and this fstat failing. Availability beats that.
    // Each step guarded separately: a close that throws must not skip the release, or
    // the recovery path leaves exactly the stranded lock it exists to prevent.
    try {
      closeSync(handle);
    } catch {
      // nothing to do - the descriptor dies with the process
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone
    }
    throw error;
  }
  try {
    try {
      writeSync(handle, String(process.pid));
    } catch {
      // The pid is a diagnostic for whoever finds a stale lock, never the lock itself.
    }
    return body();
  } finally {
    try {
      closeSync(handle);
    } catch {
      // A failed close must not cost the release below.
    }
    try {
      // Keep our hands off a lock that is now somebody else's. If this lock was deleted
      // while we still held it - the documented manual recovery, aimed at a crashed
      // holder - a second writer may already have created its own, and unlinking that
      // would let a third in while the second is still working. Comparing inodes before
      // unlinking cannot close that window (the path can change between the two calls,
      // and a freed inode number can be reused), but it turns the common case from
      // "silently breaks the lock" into "leaves it alone".
      if (statSync(lockPath).ino === identity) unlinkSync(lockPath);
    } catch {
      // already gone, or unstattable - nothing safe left to do
    }
  }
}

/** The outbox is in a shape this writer will not touch. Separate from a routing conflict:
 * re-running cannot help, a person has to change the file's shape. */
export class UnsupportedOutboxError extends Error {}

/** Replaces `path` via a temp file in the same directory plus a rename, so a reader
 * never observes a half-written OUTBOX.md. Sync twin of tools/review/atomic-write.ts,
 * which is async and belongs to the review mechanism; inlined here for the same reason
 * setup/seed.ts inlines its own, to keep the module boundaries one-directional.
 *
 * The existing mode is carried onto the replacement. Replace-by-rename otherwise silently
 * re-creates the file at the process default (commonly 0644), so an OUTBOX.md an owner
 * restricted to 0600 would be published to every local user by a routine sync - a write
 * that widens permissions is a worse failure than the torn read this avoids. */
export interface OutboxFileIdentity {
  dev: number;
  ino: number;
}

/** Captures the filesystem object a caller is about to read and later replace. */
export function resolvedOutboxIdentity(target: string): OutboxFileIdentity {
  try {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) {
      throw new UnsupportedOutboxError(`${target} changed identity before observation; nothing was written.`);
    }
    return { dev: stats.dev, ino: stats.ino };
  } catch (error) {
    if (error instanceof UnsupportedOutboxError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UnsupportedOutboxError(`${target} disappeared before observation; nothing was written.`);
    }
    throw error;
  }
}

function writeFileAtomically(path: string, content: string, expected: OutboxFileIdentity): void {
  // Replace the file the path resolves to, not the path. A rename over a symlinked
  // OUTBOX.md would swap the link itself for a standalone file, silently forking a data
  // repo that points several checkouts at one canonical outbox - and the recovery entry
  // written here would then be invisible to every writer still using the target.
  //
  // What replace-by-rename still cannot preserve is the inode's own metadata: ownership,
  // ACLs and extended attributes belong to the file it replaces. That is inherent to the
  // technique (tools/review/atomic-write.ts makes the same trade) and is the price of
  // never letting a reader see a half-written outbox.
  const target = path;
  const temporaryPath = join(dirname(target), `${basename(target)}.tmp-${process.pid}-${randomUUID()}`);
  let mode: number;
  try {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink() || stats.dev !== expected.dev || stats.ino !== expected.ino) {
      throw new UnsupportedOutboxError(`${target} changed identity before replacement; nothing was written.`);
    }
    mode = stats.mode;
    if (stats.nlink > 1) {
      // Replace-by-rename swaps in a new inode, so every other name for the old content
      // keeps it: a hard-linked outbox forks silently, and entries written here become
      // invisible through the other link. Unlike a symlink there is no canonical path to
      // resolve to - a hard link IS the file - so the only honest answers are to fork it
      // quietly or to refuse. Refusing, loudly.
      throw new UnsupportedOutboxError(
        `${target} has ${stats.nlink} hard links; replacing it would fork the file. ` +
          `Use a symlink to one canonical outbox instead.`,
      );
    }
  } catch (error) {
    if (error instanceof UnsupportedOutboxError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UnsupportedOutboxError(`${target} disappeared before replacement; nothing was written.`);
    }
    throw error;
  }
  try {
    // The mode goes on at creation, not afterwards. Writing first and chmodding second
    // publishes the content at the default mode for the width of that window, which for a
    // deliberately restricted OUTBOX.md is the exposure this is meant to prevent. The
    // explicit chmod stays because the creation mode is still masked by the umask.
    writeFileSync(temporaryPath, content, { mode });
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, target);
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
 * window. What the check does buy is real but bounded - it catches every edit made
 * before the transaction started, which is the overwhelmingly likely shape of a
 * conflict (a person editing OUTBOX.md, or a phone client committing an answer, while a
 * long-running sync computes) - and it costs nothing. Full serialization is available
 * only between writers that take `withOutboxLock`; against the ones that cannot, this
 * narrows the race to microseconds rather than eliminating it. */
export function replaceIfUnchanged(
  path: string,
  snapshot: string,
  next: string,
  read: ReadFile = defaultRead,
): boolean {
  const target = canonicalPath(path);
  return replaceResolvedIfUnchanged(target, snapshot, next, resolvedOutboxIdentity(target), read);
}

/** The resolved-path form for callers that already verified one canonical target and
 * observed its identity before reading. Carrying that identity through the transaction
 * prevents an identical-content file installed after the read from being overwritten. */
export function replaceResolvedIfUnchanged(
  target: string,
  snapshot: string,
  next: string,
  expected: OutboxFileIdentity,
  read: ReadFile = defaultRead,
): boolean {
  const current = resolvedOutboxIdentity(target);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new UnsupportedOutboxError(`${target} changed identity before comparison; nothing was written.`);
  }
  if (read(target) !== snapshot) return false;
  writeFileAtomically(target, next, expected);
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

/** One entry under `## Open`. */
export interface OutboxEntry {
  /** From `### <id> — ...`. Stable and citable, but sparse because routed entries are deleted. */
  id: number;
  /** The label as written. Unknown values remain visible and produce an anomaly. */
  type: string;
  /** `decision` is a notice; every other type is an ask. This never determines openness. */
  kind: "notice" | "ask";
  project: string;
  title: string;
  /** Markdown excluding the answer blockquote. */
  body: string;
  /** Opaque digest of the raw entry used by callers to detect a concurrent rewrite. */
  entryHash: string;
  itemSlug: string | null;
  /** The `> A:` blockquote content, or null when it is empty or absent. */
  answer: string | null;
  /** Whether the entry contains a `> A:` line that a writer can replace. */
  answerable: boolean;
}

export type OutboxAnomalyKind =
  | "unparseable-heading"
  | "unknown-type"
  | "duplicate-id"
  | "retired-type";

export interface OutboxAnomaly {
  kind: OutboxAnomalyKind;
  detail: string;
}

export interface OutboxPayload {
  /** ISO 8601 timestamp for this parse. */
  readAt: string;
  entries: OutboxEntry[];
  anomalies: OutboxAnomaly[];
}

/** Anything that can answer whether an item slug exists. */
export type KnownSlugs = { has(slug: string): boolean };

const KNOWN_TYPES: ReadonlySet<string> = new Set(["question", "proposal", "approval", "decision"]);
const RETIRED_TYPES: ReadonlySet<string> = new Set(["decide"]);
const ENTRY_HEADING = /^(\d+)\s+—\s+(\S+)\s+·\s+(\S+)\s+·\s+(.+)$/;
const ANSWER_START = /^>\s*A:\s?(.*)$/;

/** An entry is open exactly when it has no non-blank answer. */
export function isOpen(entry: OutboxEntry): boolean {
  return !entry.answer?.trim();
}

function hashEntry(raw: string): string {
  return createHash("sha256").update(raw.trim()).digest("hex");
}

function splitAnswer(rest: string): { body: string; answer: string | null; answerable: boolean } {
  const lines = rest.split("\n");
  const start = lines.findIndex((line) => ANSWER_START.test(line));
  if (start === -1) return { body: rest.trim(), answer: null, answerable: false };

  const answerLines = [ANSWER_START.exec(lines[start])![1]];
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith(">")) {
    answerLines.push(lines[end].replace(/^>\s?/, ""));
    end += 1;
  }

  const before = lines.slice(0, start).join("\n").trim();
  const after = lines.slice(end).join("\n").trim();
  const answer = answerLines.join("\n").trim();
  return {
    body: [before, after].filter(Boolean).join("\n\n"),
    answer: answer === "" ? null : answer,
    answerable: true,
  };
}

function resolveItemSlug(body: string, knownSlugs: KnownSlugs): string | null {
  const explicit = /^-\s*item:\s*([a-z0-9-]+)\s*$/m.exec(body);
  if (explicit) return explicit[1];

  const link = /items\/([a-z0-9-]+)\.md/.exec(body);
  if (link) return link[1];

  for (const line of body.split("\n")) {
    if (!/^\s*(?:\*\*)?(?:Source|Item)(?:\*\*)?:/.test(line)) continue;
    for (const [, candidate] of line.matchAll(/`([a-z0-9-]+)`/g)) {
      if (knownSlugs.has(candidate)) return candidate;
    }
  }
  return null;
}

/** Parse the entries in OUTBOX.md's `## Open` section without reading the file itself. */
export function parseOutbox(
  text: string,
  knownSlugs: KnownSlugs,
  now: Date = new Date(),
): OutboxPayload {
  const anomalies: OutboxAnomaly[] = [];
  const entries: OutboxEntry[] = [];
  const readAt = now.toISOString();
  const section = openSection(text);
  if (!section) {
    anomalies.push({
      kind: "unparseable-heading",
      detail: "no `## Open` section - the file was left alone rather than guessed at",
    });
    return { readAt, entries, anomalies };
  }

  const titleById = new Map<number, string>();
  for (const chunk of section.open.split(/^### /m).slice(1)) {
    const raw = `### ${chunk}`;
    const newline = chunk.indexOf("\n");
    const headingLine = (newline === -1 ? chunk : chunk.slice(0, newline)).trim();
    const rest = newline === -1 ? "" : chunk.slice(newline + 1);
    const match = ENTRY_HEADING.exec(headingLine);
    if (!match) {
      anomalies.push({
        kind: "unparseable-heading",
        detail: `not "<id> — <type> · <project> · <title>": ${headingLine}`,
      });
      continue;
    }

    const [, idText, type, project, titleText] = match;
    const id = parseInt(idText, 10);
    const title = titleText.trim();
    if (titleById.has(id)) {
      anomalies.push({
        kind: "duplicate-id",
        detail: `id ${id} appears twice - "${titleById.get(id)}" and "${title}"`,
      });
    } else {
      titleById.set(id, title);
    }

    if (RETIRED_TYPES.has(type)) {
      anomalies.push({
        kind: "retired-type",
        detail: `entry ${id} uses the retired type "${type}" - re-type it as \`question\` when routing`,
      });
    } else if (!KNOWN_TYPES.has(type)) {
      anomalies.push({
        kind: "unknown-type",
        detail: `entry ${id} has type "${type}", which the entry contract does not define`,
      });
    }

    const { body, answer, answerable } = splitAnswer(rest);
    entries.push({
      id,
      type,
      kind: type === "decision" ? "notice" : "ask",
      project,
      title,
      body,
      entryHash: hashEntry(raw),
      itemSlug: resolveItemSlug(body, knownSlugs),
      answer,
      answerable,
    });
  }

  return { readAt, entries, anomalies };
}

/** Append one orphan-row entry to OUTBOX.md's `## Open` section, in the shape the
 * loops-queues entry contract defines: `### <id> — <type> · <project> · <title>` and a
 * prose body. No `- item:` line: the row is on the board precisely because no active
 * item file answers for it. Pure string transform; the caller does the file read/write.
 *
 * Two asks, chosen by whether the row is stranded (`OrphanRow.stranded`): write the
 * missing item file, or move the one already sitting in `archive/`.
 *
 * Idempotent by orphan path: if an entry for this row is already present, the text is
 * returned unchanged. Sync writes the outbox before it regenerates the board, so a
 * crash in between (or a restored old board) re-runs preflight against the same still
 * orphaned row - without this guard each re-run would append a duplicate ask. The
 * marker is built once and embedded in the body, so the guard cannot drift away from
 * what the entry actually says. Answered entries are deleted on routing, so a present
 * marker always means a live open ask. */
/** The project a routed entry claims, which readers compare directly against their own
 * project labels. The heading's project field is one whitespace-free token to them, while
 * the item schema asks only that `project` be non-blank - and an orphan row has no item
 * file, so nothing validated its label in the first place.
 *
 * A label that cannot be that token gets this marker, never an invented identity.
 * Substituting the whitespace (`household app` → `household-app`) would silently merge two
 * distinct projects, and escaping it (`household%20app`) invents a project name that matches
 * nothing on the board and that no consumer decodes. The marker is the honest third
 * answer: it does not misattribute the entry to any project, and the exact label is
 * recorded in the body immediately below it.
 *
 * The pipes make it **unforgeable rather than merely unlikely**: a board row is a
 * pipe-delimited table row, split on `|` before its project cell is ever read, so no
 * project label arriving here can contain one. A plain word like `UNPARSEABLE` would be a
 * legal project name that a real board could carry. */
export const UNPARSEABLE_PROJECT = "|UNPARSEABLE|";

function headingToken(project: string): string {
  // The raw value, not the trimmed one: ` atlas ` is not the project `atlas`, and quietly
  // trimming a malformed label into a real project is the misattribution this function
  // exists to prevent. (The board parser trims its cells, so that case is unreachable
  // from sync today - it is the contract for every future caller.)
  //
  // The middle dot is rejected for the same reason as whitespace: it is the heading's own
  // field separator, so a label carrying one hands the reader an extra field and an entry
  // that reads as some other project.
  const unrepresentable = project.trim() === "" || /\s/.test(project) || project.includes("·");
  return unrepresentable ? UNPARSEABLE_PROJECT : project;
}

/** The dedup key for an orphan row's entry: machine-readable, and impossible to write by
 * accident. The predecessor keyed on the entry's own prose (``BOARD.md row `path` ``), so
 * any text repeating that phrase - a retained note, a quoted earlier entry, the owner
 * describing the problem - read as "already recorded". Sync then dropped the row from
 * BOARD.md, which is its only remaining copy, and reported success. */
function orphanMarker(orphan: OrphanRow): string {
  const identity = createHash("sha256").update(orphan.raw).digest("hex");
  return `<!-- loops:orphan ${identity} -->`;
}

export function appendOrphanRowEntry(outboxText: string, orphan: OrphanRow): string {
  const section = openSection(outboxText);
  if (!section) throw new Error("OUTBOX.md has no `## Open` section to append to");
  // Scoped to the open section: an entry that has been answered and moved on is not a
  // live ask, and re-filing the row is the right thing once it is out of `## Open`.
  if (section.open.includes(orphanMarker(orphan))) return outboxText;

  const entry = orphanEntryText(outboxText, orphan);
  return `${section.head}${section.open.replace(/\n+$/, "")}\n${entry}${section.tail}`;
}

/** One entry, ready to append. Kept to the entry contract's six body lines: the marker,
 * three lines of source and dropped-row data, and the ask. */
function orphanEntryText(outboxText: string, orphan: OrphanRow): string {
  // Numbered against the WHOLE file, not just `## Open`: an id must not collide with an
  // entry that has since moved to a later section, or the two become indistinguishable
  // in every citation.
  const existingIds = [...outboxText.matchAll(/^### (\d+) —/gm)].map((match) => parseInt(match[1], 10));
  const nextId = (existingIds.length ? Math.max(...existingIds) : 0) + 1;

  const rowFields = `Its row said: project=${orphan.project}, state=${orphan.state}, next-actor=${orphan.nextActor},
awaiting=${orphan.awaiting}, auto=${orphan.auto}, assignee=${orphan.assignee}, updated=${orphan.updated}.`;

  // Two different situations, and telling them apart is the whole point of the ask. A
  // stranded item's file exists, so "create an item file for it" would be wrong twice
  // over: it describes the wrong repair, and acting on it puts a second file under the
  // same slug, which the duplicate-slug guard then refuses to sync past.
  if (orphan.stranded) {
    return `
### ${nextId} — question · ${headingToken(orphan.project)} · BOARD.md row whose item is stranded in archive/
${orphanMarker(orphan)}

Source: [${orphan.title}](${orphan.path}). Its item file exists at \`${orphan.stranded.itemPath}\`, but state
\`${orphan.state}\` belongs in \`${orphan.stranded.belongsIn}/\` and sync never moves files out of \`archive/\`.
${rowFields}

**The ask:** move \`${orphan.stranded.itemPath}\` to \`${orphan.stranded.belongsIn}/\`, or give it a state that belongs in \`archive/\`. Do not create a second item file; the slug is taken and sync refuses to run while two files share one.

> A:
`;
  }

  return `
### ${nextId} — question · ${headingToken(orphan.project)} · orphan BOARD.md row with no item file
${orphanMarker(orphan)}

Source: [${orphan.title}](${orphan.path}), dropped from BOARD.md because no item file matched it.
${rowFields}

**The ask:** create an item file for it (per the loops-board skill), or confirm it can be discarded.

> A:
`;
}

/** Rewrite one entry's `> A:` block in place and leave every other byte untouched. */
export function applyAnswer(outboxText: string, id: number, text: string): string {
  const answer = text.trim();
  if (answer === "") throw new Error("an answer cannot be blank - empty means never answered");

  const section = openSection(outboxText);
  if (!section) throw new Error("OUTBOX.md has no `## Open` section");

  const chunks = section.open.split(/^### /m);
  let found = false;
  const rewritten = chunks.map((chunk, index) => {
    if (index === 0) return chunk;
    const newline = chunk.indexOf("\n");
    const heading = chunk.slice(0, newline === -1 ? undefined : newline).trim();
    const match = ENTRY_HEADING.exec(heading);
    if (!match || parseInt(match[1], 10) !== id || found) return chunk;
    found = true;

    const lines = chunk.split("\n");
    const start = lines.findIndex((line) => ANSWER_START.test(line));
    if (start === -1) throw new Error(`entry ${id} has no \`> A:\` line to write to`);

    let end = start + 1;
    while (end < lines.length && lines[end].startsWith(">")) end += 1;

    const answerLines = answer.split("\n");
    const block = [`> A: ${answerLines[0]}`, ...answerLines.slice(1).map((line) => `> ${line}`)];
    return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
  });

  if (!found) throw new Error(`no entry ${id} under \`## Open\``);
  return section.head + rewritten.join("### ") + section.tail;
}

/** Reports `routed` only after reading the live file back and finding every entry inside
 * `## Open`, where a reader will actually look.
 *
 * Writing is not routing. Both write paths can succeed and still leave the entry
 * unreachable: a concurrent writer can add a trailing section between the snapshot and
 * the append, putting the entry below `## Open`; an editor saving by atomic rename can
 * replace the inode a successful append just wrote to. The caller drops the orphan's
 * board row on the strength of this answer, and that row is the row's only remaining
 * copy, so the answer has to be an observation rather than an assumption.
 *
 * What this still cannot cover is a whole-file save that lands *after* the read below.
 * At that point the owner has replaced the file with their own content, which is
 * indistinguishable from deleting the entry on purpose, and no protocol over a plain
 * file can tell those apart. */
function verified(
  outboxPath: string,
  orphans: OrphanRow[],
  confirmed: string[],
  appended: number,
  read: ReadFile,
): OrphanRoutingResult {
  const section = openSection(read(outboxPath));
  const missing = orphans.filter((orphan) => !section?.open.includes(orphanMarker(orphan)));
  return missing.length ? { status: "conflict" } : { status: "routed", count: appended, confirmed };
}

export type OrphanRoutingResult =
  /** `confirmed` names the orphan paths whose entry was already in `## Open` before this
   * run wrote anything. Only those may leave the board: an entry this run just wrote has
   * not survived anything yet. */
  | { status: "routed"; count: number; confirmed: string[] }
  | { status: "conflict" }
  | { status: "locked" }
  | { status: "unsupported"; detail: string };

/** Route every orphan row into OUTBOX.md under the shared lock, against a single
 * snapshot, and report what happened. Nothing is reported as done that did not
 * happen: a held lock and a concurrent edit each return their own status for the caller
 * to surface. Both are safe to leave - the rows stay orphaned, so the next sync files
 * them again. */
export function routeOrphanRows(
  outboxPath: string,
  orphans: OrphanRow[],
  read: ReadFile = defaultRead,
): OrphanRoutingResult {
  const result = withOutboxLock(outboxPath, (): OrphanRoutingResult => {
    // OUTBOX.md is a file the owner edits, so "missing" and "no `## Open` section" are
    // states to report, not exceptions to escape through. Both leave the board intact and
    // tell the reader which file to repair; a stack trace would do neither.
    if (!existsSync(outboxPath)) {
      return { status: "unsupported", detail: `${outboxPath} does not exist.` };
    }
    // ONE read. Everything below transforms this exact snapshot, and the rename replaces
    // the file it came from.
    const snapshot = read(outboxPath);
    if (!openSection(snapshot)) {
      return {
        status: "unsupported",
        detail: `${outboxPath} has no \`## Open\` section to file entries under.`,
      };
    }
    // Recorded before this run touched anything. A row may only leave the board once its
    // entry has survived at least one write it did not make itself - see the two-phase
    // note on the return type.
    const openBefore = openSection(snapshot)?.open ?? "";
    const confirmed = orphans
      .filter((orphan) => openBefore.includes(orphanMarker(orphan)))
      .map((orphan) => orphan.path);
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
    if (outboxText === snapshot) return { status: "routed", count: 0, confirmed };

    // When `## Open` is the last section - the seeded shape, and the shape of every
    // outbox that has not grown an archive section - the new entries belong at the end of
    // the file, so they can be appended instead of rewriting it. That is the whole
    // difference between "we probably did not clobber the owner's edit" and "we cannot
    // have": O_APPEND places the write after whatever else has landed, and it keeps the
    // inode, so the mode, the symlink and any hard links survive untouched too.
    const section = openSection(snapshot);
    if (section && section.tail === "") {
      appendFileSync(outboxPath, outboxText.slice(snapshot.replace(/\n+$/, "").length));
      return verified(outboxPath, orphans, confirmed, appended, read);
    }

    try {
      if (!replaceIfUnchanged(outboxPath, snapshot, outboxText, read)) return { status: "conflict" };
      return verified(outboxPath, orphans, confirmed, appended, read);
    } catch (error) {
      if (error instanceof UnsupportedOutboxError) return { status: "unsupported", detail: error.message };
      throw error;
    }
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
      const held = rowCount - routing.confirmed.length;
      return {
        abort: false,
        message:
          `${routing.count} orphan row(s) newly filed in OUTBOX.md; ` +
          `${routing.confirmed.length} confirmed and dropped from the board, ` +
          `${held} kept until a later sync sees their entry.`,
      };
    }
    case "locked":
      return {
        abort: true,
        message: `${rows} NOT routed: OUTBOX.md.lock is held by another writer. Nothing was changed - re-run sync.`,
      };
    case "conflict":
      return {
        abort: true,
        message:
          `${rows} NOT routed: OUTBOX.md changed under sync, so the entries could not be placed ` +
          `where a reader would find them. The board is untouched - re-run sync.`,
      };
    case "unsupported":
      return { abort: true, message: `${rows} NOT routed: ${routing.detail} Nothing was changed.` };
  }
}
