import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock } from "./lock.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "loops-lock-"));
}

/** A pid guaranteed to no longer be alive: spawnSync blocks until the child exits,
 * so by the time it returns, its pid belongs to a dead process. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""]);
  return result.pid!;
}

describe("acquireLock / releaseLock", () => {
  test("acquires a fresh lock", () => {
    const root = tempRoot();
    try {
      const result = acquireLock(root);
      expect(result).toEqual({ acquired: true, brokeStale: false });
      expect(existsSync(join(root, ".loops-sync.lock"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("acquiring a second time while the first is held fails", () => {
    const root = tempRoot();
    try {
      expect(acquireLock(root).acquired).toBe(true);
      const second = acquireLock(root);
      expect(second).toEqual({ acquired: false, brokeStale: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("breaks a stale lock (dead pid, old timestamp) and acquires it", () => {
    const root = tempRoot();
    try {
      const staleInfo = {
        pid: deadPid(),
        startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      };
      writeFileSync(join(root, ".loops-sync.lock"), JSON.stringify(staleInfo));

      const result = acquireLock(root);
      expect(result).toEqual({ acquired: true, brokeStale: true });

      const written = JSON.parse(readFileSync(join(root, ".loops-sync.lock"), "utf8"));
      expect(written.pid).toBe(process.pid);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("breaks a lock whose pid is dead even if the timestamp is recent", () => {
    const root = tempRoot();
    try {
      const staleInfo = { pid: deadPid(), startedAt: new Date().toISOString() };
      writeFileSync(join(root, ".loops-sync.lock"), JSON.stringify(staleInfo));

      const result = acquireLock(root);
      expect(result).toEqual({ acquired: true, brokeStale: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not break a lock with a live pid and a recent timestamp", () => {
    const root = tempRoot();
    try {
      const liveInfo = { pid: process.pid, startedAt: new Date().toISOString() };
      writeFileSync(join(root, ".loops-sync.lock"), JSON.stringify(liveInfo));

      const result = acquireLock(root);
      expect(result).toEqual({ acquired: false, brokeStale: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("releaseLock removes the lock file", () => {
    const root = tempRoot();
    try {
      acquireLock(root);
      expect(existsSync(join(root, ".loops-sync.lock"))).toBe(true);
      releaseLock(root);
      expect(existsSync(join(root, ".loops-sync.lock"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("releaseLock is a no-op when no lock exists", () => {
    const root = tempRoot();
    try {
      expect(() => releaseLock(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
