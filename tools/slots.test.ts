import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { slotReport, type SlotClaim } from "./slots.ts";
import { TEST_IDENTITIES } from "./test-identities.ts";

const HOST = TEST_IDENTITIES.host;

function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", message);
}

/** A repo on master with one commit. */
function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "loops-slots-"));
  git(dir, "init", "-q", "-b", "master");
  commit(dir, "a.txt", "base\n", "base");
  return dir;
}

function addSlot(repo: string, name: string): string {
  const path = join(repo, ".worktrees", name);
  git(repo, "worktree", "add", "-q", "-b", `agents/${name}`, path, "master");
  return path;
}

function report(repo: string, claims: SlotClaim[] = [], host: string = HOST) {
  return slotReport({ repo, host, tool: "claude", integrationBranch: "master", claims });
}

describe("slotReport", () => {
  test("no slots: nothing idle, next free is <host>-<tool>-1", () => {
    const r = report(fixtureRepo());
    expect(r.slots).toEqual([]);
    expect(r.firstIdle).toBeNull();
    expect(r.nextFree).toBe(`${HOST}-claude-1`);
  });

  test("a slot level with the integration branch is idle", () => {
    const repo = fixtureRepo();
    addSlot(repo, `${HOST}-claude-1`);
    const r = report(repo);
    expect(r.firstIdle?.name).toBe(`${HOST}-claude-1`);
    expect(r.nextFree).toBe(`${HOST}-claude-2`);
  });

  test("a slot behind the integration branch is still idle", () => {
    const repo = fixtureRepo();
    addSlot(repo, `${HOST}-claude-1`);
    commit(repo, "b.txt", "later\n", "later work on master");
    expect(report(repo).firstIdle?.name).toBe(`${HOST}-claude-1`);
  });

  test("a slot with unmerged commits is busy", () => {
    const repo = fixtureRepo();
    const slot = addSlot(repo, `${HOST}-claude-1`);
    commit(slot, "b.txt", "wip\n", "unmerged work");
    const r = report(repo);
    expect(r.firstIdle).toBeNull();
    expect(r.slots[0]!.reasons).toContain("content not on master");
  });

  test("a slot whose commits reached master through a squash is idle", () => {
    const repo = fixtureRepo();
    const slot = addSlot(repo, `${HOST}-claude-1`);
    commit(slot, "b.txt", "one\n", "step one");
    commit(slot, "b.txt", "two\n", "step two");
    commit(repo, "b.txt", "two\n", "squashed work");
    expect(report(repo).firstIdle?.name).toBe(`${HOST}-claude-1`);
  });

  test("a slot with uncommitted changes is busy", () => {
    const repo = fixtureRepo();
    const slot = addSlot(repo, `${HOST}-claude-1`);
    writeFileSync(join(slot, "scratch.txt"), "editing\n");
    expect(report(repo).slots[0]!.reasons).toContain("uncommitted changes");
  });

  test("an active board item recorded in the slot makes it busy; a merged one does not", () => {
    const repo = fixtureRepo();
    const slot = addSlot(repo, `${HOST}-claude-1`);
    const active = report(repo, [{ slug: "x-feature", state: "in-progress", host: HOST, worktree: slot }]);
    expect(active.firstIdle).toBeNull();
    expect(active.slots[0]!.reasons[0]).toContain("x-feature");
    const merged = report(repo, [{ slug: "x-feature", state: "merged", host: HOST, worktree: slot }]);
    expect(merged.firstIdle?.name).toBe(`${HOST}-claude-1`);
  });

  test("other hosts' slots and purpose worktrees are not candidates", () => {
    const repo = fixtureRepo();
    addSlot(repo, "other-host-codex-1");
    git(repo, "worktree", "add", "-q", "-b", "meta", join(repo, ".worktrees", "meta"), "master");
    const r = report(repo);
    expect(r.slots).toEqual([]);
    expect(r.nextFree).toBe(`${HOST}-claude-1`);
  });

  test("slots sort in natural order and the first idle one wins", () => {
    const repo = fixtureRepo();
    addSlot(repo, `${HOST}-claude-10`);
    const busy = addSlot(repo, `${HOST}-claude-2`);
    addSlot(repo, `${HOST}-codex-1`);
    commit(busy, "b.txt", "wip\n", "unmerged");
    const r = report(repo);
    expect(r.slots.map((s) => s.name)).toEqual([`${HOST}-claude-2`, `${HOST}-claude-10`, `${HOST}-codex-1`]);
    expect(r.firstIdle?.name).toBe(`${HOST}-claude-10`);
  });

  test("the next free name skips names a branch already uses", () => {
    const repo = fixtureRepo();
    addSlot(repo, `${HOST}-claude-1`);
    git(repo, "branch", `agents/${HOST}-claude-2`);
    expect(report(repo).nextFree).toBe(`${HOST}-claude-3`);
  });

  test("an origin integration ref is preferred over the local branch", () => {
    const origin = fixtureRepo();
    const clone = mkdtempSync(join(tmpdir(), "loops-slots-clone-"));
    git(clone, "clone", "-q", origin, ".");
    const slot = addSlot(clone, `${HOST}-claude-1`);
    commit(slot, "b.txt", "done\n", "work");
    // Merged on origin, but the clone's local master never moved.
    git(origin, "fetch", "-q", clone, `agents/${HOST}-claude-1:incoming`);
    git(origin, "merge", "-q", "--ff-only", "incoming");
    git(clone, "fetch", "-q", "origin");
    const r = report(clone);
    expect(r.integrationRef).toBe("origin/master");
    expect(r.firstIdle?.name).toBe(`${HOST}-claude-1`);
  });

  test("only exact <host>-<tool>-<n> slots under .worktrees count", () => {
    const repo = fixtureRepo();
    // Purpose worktree with an agents/ branch, a legacy stack branch, and a slot-named
    // branch checked out outside .worktrees.
    git(repo, "worktree", "add", "-q", "-b", `agents/${HOST}-deploy`, join(repo, ".worktrees", `${HOST}-deploy`), "master");
    git(repo, "worktree", "add", "-q", "-b", `agents/${HOST}-claude-1--some-item`, join(repo, ".worktrees", `${HOST}-claude-1--some-item`), "master");
    git(repo, "worktree", "add", "-q", "-b", `agents/${HOST}-claude-2`, join(repo, "elsewhere"), "master");
    expect(report(repo).slots).toEqual([]);
  });

  test("a host whose name prefixes another host's never sees that host's slots", () => {
    const repo = fixtureRepo();
    addSlot(repo, "workstation-one-codex-1");
    expect(report(repo, [], "workstation").slots).toEqual([]);
    expect(report(repo, [], "workstation-one").slots.map((s) => s.name)).toEqual(["workstation-one-codex-1"]);
  });

  test("the next free name skips remote-only branches and existing directories", () => {
    const origin = fixtureRepo();
    git(origin, "branch", `agents/${HOST}-claude-1`);
    const clone = mkdtempSync(join(tmpdir(), "loops-slots-clone-"));
    git(clone, "clone", "-q", origin, ".");
    mkdirSync(join(clone, ".worktrees", `${HOST}-claude-2`), { recursive: true });
    expect(report(clone).nextFree).toBe(`${HOST}-claude-3`);
  });

  test("a claim recorded through a symlinked path still occupies the slot", () => {
    const repo = fixtureRepo();
    addSlot(repo, `${HOST}-claude-1`);
    const alias = join(mkdtempSync(join(tmpdir(), "loops-slots-alias-")), "repo");
    symlinkSync(repo, alias);
    const claim = { slug: "x-feature", state: "in-progress", host: HOST, worktree: join(alias, ".worktrees", `${HOST}-claude-1`) };
    expect(report(repo, [claim]).firstIdle).toBeNull();
  });
});
