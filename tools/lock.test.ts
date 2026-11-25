import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, withLock } from "./lock.ts";

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

describe("withLock", () => {
  test("holds the lock while fn runs and releases it afterward", async () => {
    const root = tempRoot();
    try {
      let heldDuringFn = false;
      const result = await withLock(root, () => {
        heldDuringFn = existsSync(join(root, ".loops-sync.lock"));
        return 42;
      });
      expect(heldDuringFn).toBe(true);
      expect(result).toBe(42);
      expect(existsSync(join(root, ".loops-sync.lock"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("releases the lock even if fn throws", async () => {
    const root = tempRoot();
    try {
      await expect(
        withLock(root, () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(existsSync(join(root, ".loops-sync.lock"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("refreshLock and releaseOwnLock", () => {
  test("renew and release only a lock this process holds", async () => {
    const { acquireLock, refreshLock, releaseOwnLock } = await import("./lock.ts");
    const { mkdtempSync, readFileSync, writeFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "dcl-lock-own-"));
    const path = join(root, ".loops-sync.lock");
    expect(acquireLock(root).acquired).toBe(true);
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" }));
    refreshLock(root);
    expect(Date.parse(JSON.parse(readFileSync(path, "utf8")).startedAt)).toBeGreaterThan(Date.parse("2020-01-01"));
    const other = JSON.stringify({ pid: process.pid + 100000, startedAt: "2000-01-01T00:00:00.000Z" });
    writeFileSync(path, other);
    refreshLock(root);
    releaseOwnLock(root);
    expect(readFileSync(path, "utf8")).toBe(other);
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    releaseOwnLock(root);
    expect(existsSync(path)).toBe(false);
  });
});

describe("a lock held while its process lives", () => {
  test("is not broken by age while its holder lives, and is taken over once the pid is reused", async () => {
    const { acquireLock, processStartTime } = await import("./lock.ts");
    const root = tempRoot();
    const path = join(root, ".loops-sync.lock");
    try {
      const old = "2000-01-01T00:00:00.000Z";
      writeFileSync(path, JSON.stringify({ pid: process.ppid, startedAt: old, pidStart: processStartTime(process.ppid) }));
      expect(acquireLock(root)).toEqual({ acquired: false, brokeStale: false });
      writeFileSync(path, JSON.stringify({ pid: process.ppid, startedAt: old }));
      expect(acquireLock(root)).toEqual({ acquired: false, brokeStale: false });
      writeFileSync(path, JSON.stringify({ pid: process.ppid, startedAt: old, pidStart: "1" }));
      expect(acquireLock(root)).toEqual({ acquired: true, brokeStale: true });
      expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a live holder this user may not signal still holds the lock", async () => {
    const { acquireLock, processStartTime } = await import("./lock.ts");
    // pid 1 runs as root: probing it from an unprivileged test fails with EPERM.
    if (process.getuid?.() === 0) return;
    const root = tempRoot();
    const path = join(root, ".loops-sync.lock");
    try {
      const record = JSON.stringify({ pid: 1, startedAt: "2000-01-01T00:00:00.000Z", pidStart: processStartTime(1) });
      writeFileSync(path, record);
      expect(acquireLock(root)).toEqual({ acquired: false, brokeStale: false });
      expect(readFileSync(path, "utf8")).toBe(record);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refreshLock says whether this process still holds the lock", async () => {
    const { acquireLock, refreshLock } = await import("./lock.ts");
    const root = tempRoot();
    const path = join(root, ".loops-sync.lock");
    try {
      expect(acquireLock(root).acquired).toBe(true);
      expect(refreshLock(root)).toBe(true);
      writeFileSync(path, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
      expect(refreshLock(root)).toBe(false);
      rmSync(path);
      expect(refreshLock(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a takeover marker left behind keeps the lock refused instead of admitting two", async () => {
    const { acquireLock } = await import("./lock.ts");
    const { createHash } = await import("node:crypto");
    const root = tempRoot();
    const path = join(root, ".loops-sync.lock");
    try {
      const stale = JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() });
      writeFileSync(path, stale);
      writeFileSync(`${path}.takeover-${createHash("sha256").update(stale).digest("hex").slice(0, 16)}`, "{}");
      expect(acquireLock(root)).toEqual({ acquired: false, brokeStale: false });
      expect(readFileSync(path, "utf8")).toBe(stale);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("concurrent acquisition across processes", () => {
  const LOCK_TS = join(import.meta.dir, "lock.ts");

  /** Starts `count` processes that each try the lock once at the same moment and report
   * whether they got it; returns how many did. */
  async function contend(root: string, count: number): Promise<number> {
    const go = Date.now() + 400;
    const script = `const { acquireLock } = await import(${JSON.stringify(LOCK_TS)});
while (Date.now() < ${go}) {}
console.log(acquireLock(${JSON.stringify(root)}).acquired ? "acquired" : "busy");
await new Promise((r) => setTimeout(r, 300));`;
    const children = Array.from({ length: count }, () => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe" }));
    const outs = await Promise.all(children.map((child) => new Response(child.stdout).text()));
    return outs.filter((out) => out.trim() === "acquired").length;
  }

  test("exactly one process gets a free lock or takes over a stale one", async () => {
    const root = tempRoot();
    const path = join(root, ".loops-sync.lock");
    try {
      for (let round = 0; round < 6; round++) {
        rmSync(path, { force: true });
        if (round % 2 === 1) writeFileSync(path, JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }));
        expect(await contend(root, 8)).toBe(1);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
