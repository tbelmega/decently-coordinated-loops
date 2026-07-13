import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_NAME = ".loops-sync.lock";
const STALE_MS = 10 * 60 * 1000;

interface LockInfo {
  pid: number;
  startedAt: string;
}

function lockPath(root: string): string {
  return join(root, LOCK_NAME);
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 does no actual signalling — it just probes whether the pid exists
    // and is ours to signal, throwing (ESRCH/EPERM) if not.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isStale(info: LockInfo): boolean {
  if (!isPidAlive(info.pid)) return true;
  const age = Date.now() - Date.parse(info.startedAt);
  return Number.isNaN(age) || age > STALE_MS;
}

export interface AcquireResult {
  acquired: boolean;
  /** Set when a previously-held lock was found stale and replaced. */
  brokeStale: boolean;
}

/** Attempts to exclusively create the lock file. Succeeds outright when no lock
 * exists. When one does, reads it: if its owning pid is no longer alive, or it was
 * started more than 10 minutes ago, the lock is considered abandoned — it's broken
 * (removed and recreated for this process) and `brokeStale` is set. Otherwise the
 * lock is genuinely held and `acquired: false` is returned so the caller can retry
 * later. */
export function acquireLock(root: string): AcquireResult {
  const path = lockPath(root);
  const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

  try {
    writeFileSync(path, content, { flag: "wx" });
    return { acquired: true, brokeStale: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  let existing: LockInfo | null = null;
  try {
    existing = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
  } catch {
    existing = null; // unreadable/corrupt lock file: treat as stale below
  }

  if (existing && !isStale(existing)) {
    return { acquired: false, brokeStale: false };
  }

  try {
    unlinkSync(path);
  } catch {
    // already gone — fine, another process may have just released it
  }
  try {
    writeFileSync(path, content, { flag: "wx" });
    return { acquired: true, brokeStale: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Lost a race to recreate the lock after breaking it.
      return { acquired: false, brokeStale: true };
    }
    throw err;
  }
}

/** Releases the lock, if held. Safe to call even when no lock file exists. */
export function releaseLock(root: string): void {
  const path = lockPath(root);
  if (existsSync(path)) unlinkSync(path);
}
