import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { boardWrite, dirtyPaths, rebaseInProgress, repairClone, type Reader } from "./dispatch-git.ts";
import { gitFixture, sh } from "./test-git-fixture.ts";

const FILES = { "items/a.md": "a: 1\n", "items/b.md": "b: 1\n", "BOARD.md": "board\n" };

function noReset(repo: string): void {
  expect(sh(repo, ["reflog", "--format=%gs"])).not.toMatch(/reset:|rebase/);
}

function originLog(fx: ReturnType<typeof gitFixture>): string[] {
  return sh(fx.base, ["--git-dir", fx.origin, "log", "--format=%s", "master"]).split("\n");
}

describe("boardWrite", () => {
  test("pushes one commit with only its own paths and fast-forwards a clean checkout", () => {
    const fx = gitFixture(FILES);
    const clone = fx.clone("program");
    const outcome = boardWrite(clone, () => ({ files: { "items/a.md": "a: 2\n" }, message: "Dispatch a" }));
    expect(outcome).toEqual({ status: "pushed", behind: false });
    expect(sh(clone, ["show", "--name-only", "--format=%s", "HEAD"]).split("\n")).toEqual(["Dispatch a", "", "items/a.md"]);
    expect(fx.read(clone, "items/a.md")).toBe("a: 2\n");
    noReset(clone);
  });

  test("never publishes a checkout's own commits or uncommitted files", () => {
    const fx = gitFixture(FILES);
    const shared = fx.clone("shared");
    fx.write(shared, "items/b.md", "b: someone's unpushed work\n");
    fx.commitAll(shared, "Someone's local commit");
    fx.write(shared, "items/a.md", "a: someone's uncommitted edit\n");
    const outcome = boardWrite(shared, () => ({ files: { "dispatch-control.json": "{}\n" }, message: "Pause central dispatch" }));
    expect(outcome).toEqual({ status: "pushed", behind: true });
    expect(originLog(fx)).toEqual(["Pause central dispatch", "Seed"]);
    expect(sh(shared, ["log", "-1", "--format=%s"])).toBe("Someone's local commit");
    expect(fx.read(shared, "items/a.md")).toBe("a: someone's uncommitted edit\n");
    noReset(shared);
  });

  test("decides again from the fresh upstream after a rejection, and drops a write no longer right", () => {
    const fx = gitFixture(FILES);
    const clone = fx.clone("program");
    const session = fx.clone("session");
    const seen: string[] = [];
    const decide = (read: Reader) => {
      const current = read("items/a.md")!;
      seen.push(current);
      return current.includes("claimed by someone") ? null : { files: { "items/a.md": "a: dispatched\n" }, message: "Dispatch a" };
    };
    const outcome = boardWrite(clone, decide, {
      beforePush: (attempt) => {
        if (attempt !== 1) return;
        fx.write(session, "items/a.md", "a: claimed by someone\n");
        fx.commitAll(session, "Session claims a");
        sh(session, ["push", "--quiet"]);
      },
    });
    expect(outcome).toEqual({ status: "dropped" });
    expect(seen).toEqual(["a: 1\n", "a: claimed by someone\n"]);
    expect(fx.read(clone, "items/a.md")).toBe("a: claimed by someone\n");
    expect(originLog(fx)).toEqual(["Session claims a", "Seed"]);
    noReset(clone);
  });

  test("an unrelated concurrent change leads to a second decision on top of it", () => {
    const fx = gitFixture(FILES);
    const clone = fx.clone("program");
    const session = fx.clone("session");
    const outcome = boardWrite(clone, (read) => ({ files: { "items/a.md": `a: dispatched over ${read("items/b.md")}` }, message: "Dispatch a" }), {
      beforePush: (attempt) => {
        if (attempt !== 1) return;
        fx.write(session, "items/b.md", "b: 2\n");
        fx.commitAll(session, "Unrelated");
        sh(session, ["push", "--quiet"]);
      },
    });
    expect(outcome).toEqual({ status: "pushed", behind: false });
    expect(originLog(fx)).toEqual(["Dispatch a", "Unrelated", "Seed"]);
    expect(fx.read(clone, "items/a.md")).toBe("a: dispatched over b: 2\n");
  });

  test("when every attempt is rejected nothing is written and nothing is left behind", () => {
    const fx = gitFixture(FILES);
    const clone = fx.clone("program");
    const session = fx.clone("session");
    let n = 0;
    const outcome = boardWrite(clone, () => ({ files: { "items/a.md": "a: dispatched\n" }, message: "Dispatch a" }), {
      attempts: 2,
      beforePush: () => {
        n++;
        fx.write(session, "BOARD.md", `board ${n}\n`);
        fx.commitAll(session, `Session ${n}`);
        sh(session, ["push", "--quiet"]);
      },
    });
    expect(outcome).toEqual({ status: "rejected" });
    expect(originLog(fx)).toEqual(["Session 2", "Session 1", "Seed"]);
    expect(dirtyPaths(clone)).toEqual([]);
    expect(sh(clone, ["rev-list", "--count", "@{upstream}..HEAD"])).toBe("0");
    noReset(clone);
  });

  test("refuses to write through a symlink or to an unsafe path", () => {
    const fx = gitFixture(FILES);
    const seed = fx.clone("seeder");
    symlinkSync("/etc/hostname", join(seed, "dispatch-control.json"));
    fx.commitAll(seed, "A symlink");
    sh(seed, ["push", "--quiet"]);
    const clone = fx.clone("program");
    expect(boardWrite(clone, () => ({ files: { "dispatch-control.json": "{}\n" }, message: "Pause" }))).toMatchObject({ status: "error" });
    expect(boardWrite(clone, () => ({ files: { "../escape.md": "x\n" }, message: "x" }))).toMatchObject({ status: "error" });
    expect(boardWrite(clone, () => ({ files: { "items/../x.md": "x\n" }, message: "x" }))).toMatchObject({ status: "error" });
    expect(originLog(fx)).toEqual(["A symlink", "Seed"]);
  });
});

describe("repairClone", () => {
  test("refuses foreign dirt and local commits, ignoring the listed files", () => {
    const fx = gitFixture(FILES);
    const clone = fx.clone("program");
    fx.write(clone, ".loops-sync.lock", "{}\n");
    expect(repairClone(clone, [".loops-sync.lock"])).toEqual({ ok: true, repaired: [] });
    fx.write(clone, "items/b.md", "someone else\n");
    expect(repairClone(clone, [".loops-sync.lock"])).toMatchObject({ ok: false, problem: expect.stringContaining("items/b.md") });
    fx.commitAll(clone, "Local");
    expect(repairClone(clone, [])).toMatchObject({ ok: false, problem: expect.stringContaining("local commit") });
  });

  test("aborts a rebase a crash left behind", () => {
    const fx = gitFixture(FILES);
    const clone = fx.clone("program");
    const session = fx.clone("session");
    fx.write(clone, "items/a.md", "mine\n");
    fx.commitAll(clone, "Mine");
    fx.write(session, "items/a.md", "theirs\n");
    fx.commitAll(session, "Theirs");
    sh(session, ["push", "--quiet"]);
    sh(clone, ["fetch", "--quiet"]);
    expect(() => sh(clone, ["rebase", "--quiet", "origin/master"])).toThrow();
    expect(rebaseInProgress(clone)).toBe(true);
    const repaired = repairClone(clone, []);
    expect(rebaseInProgress(clone)).toBe(false);
    expect(repaired).toMatchObject({ ok: false, problem: expect.stringContaining("local commit") });
  });
});
