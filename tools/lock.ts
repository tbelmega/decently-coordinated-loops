// The data repo lock: one file that every writer of the data repo checkout takes (sync,
// `landed --apply`, the tracker, central dispatch's tick and pause).
//
// Protocol:
// - A lock file only ever appears complete: its owner record is written to a private file
//   and hard-linked into place, which fails when a lock already exists.
// - A lock is held for as long as its holder process lives, however long it runs. It is
//   stale only once that process is gone, or once its pid belongs to a different process
//   (told apart by the process start time).
// - A stale lock is taken over only by the one contender that creates the takeover marker
//   named after that exact stale record, and only after reading the record again unchanged.
//   A stale record cannot change underneath it: its owner is gone, and every other
//   contender loses the marker. The new record replaces the stale one in one rename.
//   A takeover interrupted between the marker and the rename leaves the marker behind;
//   the lock then stays refused until someone removes that `.takeover-` file, which fails
//   closed instead of admitting two holders.
// - Because a live holder's lock is never taken over, a holder that still finds its own
//   record can renew or release it without racing a replacement.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, linkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_NAME = ".loops-sync.lock";

interface LockInfo {
  pid: number;
  startedAt: string;
  /** The holder's process start time, or null where it cannot be read. */
  pidStart?: string | null;
}

function lockPath(root: string): string {
  return join(root, LOCK_NAME);
}

/** False only when the system says no process has this pid. A process this user may not
 * signal (EPERM) is alive, and any other probe failure counts as alive too, so a lock is
 * never taken over on an uncertain answer. */
function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 does no actual signalling; it only probes the pid.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** When process `pid` started, as the system reports it, or null where it cannot be read.
 * Two processes that share a pid over time never share this value. */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 (starttime); the command name in field 2 may contain spaces and parentheses.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    // No /proc (macOS): ask ps.
  }
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 });
  const started = (ps.stdout ?? "").trim();
  return ps.status === 0 && started ? started : null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parse(text: string): LockInfo | null {
  try {
    const info = JSON.parse(text) as LockInfo;
    return typeof info?.pid === "number" ? info : null;
  } catch {
    return null;
  }
}

/** True once the holder of `info` is gone: its pid is dead, or now belongs to a process
 * that started at a different time. An unreadable record counts as stale; since locks
 * are created complete, only damage or an older tool leaves one. */
function isStale(info: LockInfo | null): boolean {
  if (!info) return true;
  if (!isPidAlive(info.pid)) return true;
  if (!info.pidStart) return false;
  const current = processStartTime(info.pid);
  return current !== null && current !== info.pidStart;
}

function ownRecord(): string {
  const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString(), pidStart: processStartTime(process.pid) };
  return JSON.stringify(info);
}

/** Creates `path` only if it does not exist, and only ever complete. False when it exists. */
function createComplete(path: string, content: string): boolean {
  const temp = `${path}.${process.pid}.new`;
  writeFileSync(temp, content);
  try {
    linkSync(temp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    unlinkSync(temp);
  }
}

export interface AcquireResult {
  acquired: boolean;
  /** Set when a stale lock was found and replaced. */
  brokeStale: boolean;
}

/** Takes the lock, or reports it held. Succeeds outright when no lock exists, and takes a
 * stale one over (see the protocol above). `acquired: false` means a live process holds
 * it, or another contender is taking the same stale lock over; the caller retries later. */
export function acquireLock(root: string): AcquireResult {
  const path = lockPath(root);
  const content = ownRecord();
  if (createComplete(path, content)) return { acquired: true, brokeStale: false };

  const seen = readText(path);
  // Released between the two calls: one more plain attempt.
  if (seen === null) return { acquired: createComplete(path, content), brokeStale: false };
  if (!isStale(parse(seen))) return { acquired: false, brokeStale: false };

  const marker = `${path}.takeover-${createHash("sha256").update(seen).digest("hex").slice(0, 16)}`;
  if (!createComplete(marker, content)) return { acquired: false, brokeStale: false };
  try {
    if (readText(path) !== seen) return { acquired: false, brokeStale: false };
    const temp = `${path}.${process.pid}.new`;
    writeFileSync(temp, content);
    renameSync(temp, path);
    return { acquired: true, brokeStale: true };
  } finally {
    unlinkSync(marker);
  }
}

/** Renews the record of a lock this process holds and says whether it still holds it.
 * The new record replaces the old one in one rename, so a contender never reads a partial
 * lock. Returns false, changing nothing, when the lock is missing, unreadable or another
 * process's. */
export function refreshLock(root: string): boolean {
  const path = lockPath(root);
  const info = parse(readText(path) ?? "");
  if (!info || info.pid !== process.pid) return false;
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, ownRecord());
  renameSync(temp, path);
  return true;
}

/** Releases the lock only while this process holds it, so a run never removes another
 * process's lock. */
export function releaseOwnLock(root: string): void {
  const path = lockPath(root);
  const info = parse(readText(path) ?? "");
  if (!info || info.pid !== process.pid) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Releases this process's lock. Kept for callers that hold the lock themselves; it never
 * removes another process's lock. */
export function releaseLock(root: string): void {
  releaseOwnLock(root);
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

/** Runs `fn` while holding the sync lock, releasing it in a `finally`. Retries
 * acquisition a few times with a short delay (a stale lock is taken over automatically by
 * `acquireLock`). If the lock is genuinely held after every attempt, prints a message
 * naming `label` and exits(1) - a concurrent holder owns the data repo. Shared by the
 * sync and `landed --apply` CLIs so their overlapping BOARD.md/item-file writes can't
 * interleave. */
export async function withLock<T>(root: string, fn: () => T, label = "sync run"): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = acquireLock(root);
    if (result.acquired) {
      if (result.brokeStale) console.log("breaking stale lock");
      try {
        return fn();
      } finally {
        releaseOwnLock(root);
      }
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  console.error(
    `could not acquire ${LOCK_NAME} after ${MAX_ATTEMPTS} attempts - another ${label} appears to be in progress`,
  );
  process.exit(1);
}
