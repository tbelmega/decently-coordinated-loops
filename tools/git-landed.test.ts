import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gitLandedStatus } from "./git-landed.ts";

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

/** A repo with one commit on master and a feature branch carrying one more commit. */
function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "loops-git-"));
  git(dir, "init", "-q", "-b", "master");
  writeFileSync(join(dir, "a.txt"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "feature/search");
  writeFileSync(join(dir, "b.txt"), "feature work\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "add search");
  git(dir, "checkout", "-q", "master");
  return dir;
}

describe("gitLandedStatus", () => {
  test("a branch whose commits were rebase-landed onto the integration branch is LANDED", () => {
    const dir = fixtureRepo();
    // Simulate the owner landing the branch via rebase: same patch, new commit hash.
    git(dir, "cherry-pick", "feature/search");
    expect(gitLandedStatus(dir, "feature/search", "master")).toEqual({ state: "LANDED" });
  });

  test("a branch with commits not on the integration branch is PENDING", () => {
    const dir = fixtureRepo();
    expect(gitLandedStatus(dir, "feature/search", "master")).toEqual({ state: "PENDING" });
  });

  test("a fully-behind branch (no unique commits) counts as LANDED", () => {
    const dir = fixtureRepo();
    git(dir, "cherry-pick", "feature/search");
    git(dir, "branch", "-q", "-f", "feature/search", "master");
    expect(gitLandedStatus(dir, "feature/search", "master")).toEqual({ state: "LANDED" });
  });

  test("a missing branch is an error, not a crash", () => {
    const dir = fixtureRepo();
    const result = gitLandedStatus(dir, "no-such-branch", "master");
    expect(result.error).toContain("no-such-branch");
  });

  test("a missing integration branch is an error", () => {
    const dir = fixtureRepo();
    const result = gitLandedStatus(dir, "feature/search", "no-such-integration");
    expect(result.error).toContain("no-such-integration");
  });

  test("prefers the remote-tracking integration ref when one exists", () => {
    // Clone the fixture so origin/master exists, then land the branch only on the
    // clone's local master — origin/master (stale) must be what's checked.
    const upstream = fixtureRepo();
    const clone = join(mkdtempSync(join(tmpdir(), "loops-git-")), "clone");
    git(upstream, "worktree", "prune"); // no-op, keeps upstream tidy
    spawnSync("git", ["clone", "-q", upstream, clone], { encoding: "utf8" });
    git(clone, "cherry-pick", "origin/feature/search");
    // Local master has the patch, origin/master does not -> still PENDING.
    expect(gitLandedStatus(clone, "origin/feature/search", "master")).toEqual({
      state: "PENDING",
    });
  });
});
