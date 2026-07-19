// The `git` landed-adapter: decide whether an agent branch's work has landed on
// the integration branch using git alone — for projects whose review/landing flow
// doesn't go through a forge API. Landing is assumed to be rebase-shaped, so the
// check is patch-id equivalence (`git cherry`), not ancestry: a rebase rewrites
// hashes but keeps patch-ids. Known limit: a squash-with-edits landing changes the
// patch-id and reads as PENDING — record those by hand or use the github adapter.
import { spawnSync } from "node:child_process";

export type GitLandedState = "LANDED" | "PENDING";

export interface GitLandedResult {
  state?: GitLandedState;
  error?: string;
}

export interface GitItemRange {
  baseSha: string;
  headSha: string;
}

function git(repoDir: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

/** Resolves a branch name to a usable ref: the name itself if git can parse it,
 * else its origin/ remote-tracking sibling (covers branches deleted locally after
 * landing but still on the remote). Returns null when neither exists. */
function resolveRef(repoDir: string, name: string): string | null {
  for (const candidate of [name, `origin/${name}`]) {
    if (git(repoDir, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]).ok) {
      return candidate;
    }
  }
  return null;
}

/** The integration ref to compare against: prefer the remote-tracking ref
 * (origin/<branch>) — origin is the source of truth — falling back to the local
 * branch for repos without a remote. */
function integrationRef(repoDir: string, integrationBranch: string): string | null {
  for (const candidate of [`origin/${integrationBranch}`, integrationBranch]) {
    if (git(repoDir, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]).ok) {
      return candidate;
    }
  }
  return null;
}

/** Pure query (no fetch — the caller refreshes remote refs if it wants freshness):
 * has every commit in the immutable item range, or the legacy whole branch, landed
 * patch-equivalent on the integration branch? `git cherry` marks each selected
 * commit `-` (an equivalent patch exists upstream) or `+` (it doesn't); any `+`
 * means PENDING. An empty result means nothing in the selected range is waiting. */
export function gitLandedStatus(
  repoDir: string,
  branch: string,
  integrationBranch: string,
  itemRange?: GitItemRange,
): GitLandedResult {
  const intRef = integrationRef(repoDir, integrationBranch);
  if (!intRef) {
    return { error: `integration branch "${integrationBranch}" not found in ${repoDir}` };
  }
  let headRef: string;
  const cherryArgs = ["cherry", intRef];
  if (itemRange) {
    const base = git(repoDir, ["rev-parse", "--verify", "--quiet", `${itemRange.baseSha}^{commit}`]);
    if (!base.ok) return { error: `base SHA "${itemRange.baseSha}" not found in ${repoDir}` };
    const head = git(repoDir, ["rev-parse", "--verify", "--quiet", `${itemRange.headSha}^{commit}`]);
    if (!head.ok) return { error: `head SHA "${itemRange.headSha}" not found in ${repoDir}` };
    headRef = itemRange.headSha;
    cherryArgs.push(headRef, itemRange.baseSha);
  } else {
    const branchRef = resolveRef(repoDir, branch);
    if (!branchRef) {
      return { error: `branch "${branch}" not found in ${repoDir} (locally or on origin)` };
    }
    headRef = branchRef;
    cherryArgs.push(headRef);
  }

  const cherry = git(repoDir, cherryArgs);
  if (!cherry.ok) {
    return { error: `git cherry failed: ${cherry.stderr}` };
  }

  const pending = cherry.stdout
    .split("\n")
    .filter(Boolean)
    .some((line) => line.startsWith("+"));
  return { state: pending ? "PENDING" : "LANDED" };
}
