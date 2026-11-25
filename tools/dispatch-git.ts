// How central dispatch writes to the board: one procedure for every write (claim, release,
// park, pause, resume).
//
// Invariants:
// - A write is one commit built directly on the fetched upstream commit with git plumbing
//   (a private index, `commit-tree`), containing only the write's own paths, and pushed as
//   exactly that commit. The local branch, index and working tree are never used to
//   prepare it, so a write never commits or publishes anyone else's work, never follows a
//   symlink in the checkout, and leaves nothing behind when its push is rejected.
// - A rejected push is answered by fetching and deciding again from the fresh upstream
//   state; after the last rejected attempt the write is simply not made. Nothing is reset,
//   rebased away or forced.
// - Decisions read the upstream tree through git, never the file system, and every written
//   path must be a regular file (or absent) in that tree.
// - After a pushed write the checkout is fast-forwarded when it is clean and has no local
//   commits; otherwise it is left as it is and reported as behind.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT_TIMEOUT_MS = 120_000;

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

export function git(root: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): GitResult {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    input: options.input,
    env: options.env ?? process.env,
    // A hung remote must not outlive the lock that guards the tick.
    timeout: GIT_TIMEOUT_MS,
  });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}

export function rebaseInProgress(root: string): boolean {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const path = git(root, ["rev-parse", "--path-format=absolute", "--git-path", name]);
    if (path.ok && existsSync(path.out)) return true;
  }
  return false;
}

/** Repository-relative paths with uncommitted changes, untracked files included, or null
 * when git cannot read the working tree. Both paths of a rename are listed. */
export function dirtyPaths(root: string): string[] | null {
  const status = spawnSync("git", ["-C", root, "status", "--porcelain", "-z", "--untracked-files=all"], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  if (status.status !== 0) return null;
  const fields = (status.stdout ?? "").split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    paths.push(field.slice(3));
    if (field[0] === "R" || field[0] === "C") paths.push(fields[++i]!);
  }
  return paths;
}

/** Local commits not on the upstream branch, or null without an upstream. */
export function aheadOfUpstream(root: string): number | null {
  const count = git(root, ["rev-list", "--count", "@{upstream}..HEAD"]);
  return count.ok ? Number(count.out) : null;
}

export type RepairResult = { ok: true; repaired: string[] } | { ok: false; problem: string };

/** Brings the program's clone back to a usable state: aborts a rebase a crash left behind,
 * then requires a clean tree (ignoring `ignore`) with no local commits. */
export function repairClone(root: string, ignore: string[] = []): RepairResult {
  const repaired: string[] = [];
  if (rebaseInProgress(root)) {
    const aborted = git(root, ["rebase", "--abort"]);
    if (!aborted.ok || rebaseInProgress(root)) return { ok: false, problem: `could not abort an interrupted rebase: ${aborted.err}` };
    repaired.push("aborted an interrupted rebase");
  }
  const dirty = dirtyPaths(root);
  if (dirty === null) return { ok: false, problem: "git cannot read the working tree" };
  const foreign = dirty.filter((path) => !ignore.includes(path));
  if (foreign.length) return { ok: false, problem: `the clone has changes the program did not make: ${foreign.join(", ")}` };
  const ahead = aheadOfUpstream(root);
  if (ahead === null) return { ok: false, problem: "the branch has no upstream" };
  if (ahead > 0) return { ok: false, problem: `the branch has ${ahead} local commit(s) that are not on its upstream` };
  return { ok: true, repaired };
}

interface Upstream {
  remote: string;
  /** Branch name on the remote. */
  branch: string;
  /** Remote-tracking ref, e.g. refs/remotes/origin/master. */
  trackingRef: string;
}

function upstreamOf(root: string): Upstream | null {
  const local = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!local.ok) return null;
  const full = git(root, ["rev-parse", "--symbolic-full-name", "@{upstream}"]);
  const remote = git(root, ["config", `branch.${local.out}.remote`]);
  const merge = git(root, ["config", `branch.${local.out}.merge`]);
  if (!full.ok || !remote.ok || !merge.ok) return null;
  return { remote: remote.out, branch: merge.out.replace(/^refs\/heads\//, ""), trackingRef: full.out };
}

export type SyncResult = { ok: true; behind: boolean } | { ok: false; detail: string };

/** Fetches the upstream and fast-forwards the checkout when it is clean and has no local
 * commits (`ignore` lists untracked files that do not count, such as the lock file). */
export function syncCheckout(root: string, ignore: string[] = []): SyncResult {
  const upstream = upstreamOf(root);
  if (!upstream) return { ok: false, detail: "the branch has no upstream" };
  const fetched = git(root, ["fetch", "--quiet", upstream.remote]);
  if (!fetched.ok) return { ok: false, detail: `git fetch failed: ${fetched.err}` };
  const dirty = dirtyPaths(root);
  if (dirty === null || dirty.some((path) => !ignore.includes(path)) || aheadOfUpstream(root) !== 0) return { ok: true, behind: true };
  const merged = git(root, ["merge", "--ff-only", "--quiet", upstream.trackingRef]);
  return merged.ok ? { ok: true, behind: false } : { ok: true, behind: true };
}

/** One intended write: full new contents for each path (null deletes it). */
export interface PlannedWrite {
  files: Record<string, string | null>;
  message: string;
}

/** Reads a repository-relative path from the upstream tree, or null when it is absent. */
export type Reader = (path: string) => string | null;

export type WriteOutcome =
  /** The write is pushed. `behind` when the checkout could not be fast-forwarded to it. */
  | { status: "pushed"; behind: boolean }
  /** The first decision found nothing to write. */
  | { status: "nothing" }
  /** After a rejection, the fresh state no longer calls for the write. */
  | { status: "dropped" }
  /** Every attempt was rejected; nothing was written. */
  | { status: "rejected" }
  | { status: "error"; detail: string };

export interface WriteOptions {
  /** Untracked files that do not stop the fast-forward (the lock file). */
  ignore?: string[];
  /** Attempts before giving up on rejected pushes. */
  attempts?: number;
  /** Test seam: runs before each push. */
  beforePush?(attempt: number): void;
  /** Runs before each fetch and each push, e.g. to renew a lock. */
  heartbeat?(): void;
}

const SAFE_PATH = /^(?!\/)(?!(?:.*\/)?\.\.?(?:\/|$))[A-Za-z0-9._/-]+$/;

function treeReader(root: string, commit: string): { read: Reader; mode(path: string): string | null } {
  return {
    read(path) {
      const shown = spawnSync("git", ["-C", root, "cat-file", "blob", `${commit}:${path}`], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
      return shown.status === 0 ? shown.stdout : null;
    },
    mode(path) {
      const listed = git(root, ["ls-tree", commit, "--", path]);
      if (!listed.ok || !listed.out) return null;
      return listed.out.split(/\s/)[0]!;
    },
  };
}

function commitOnto(root: string, base: string, write: PlannedWrite): GitResult {
  const dir = mkdtempSync(join(tmpdir(), "dcl-dispatch-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
    const read = git(root, ["read-tree", base], { env });
    if (!read.ok) return read;
    for (const [path, text] of Object.entries(write.files)) {
      if (text === null) {
        const removed = git(root, ["update-index", "--force-remove", "--", path], { env });
        if (!removed.ok) return removed;
        continue;
      }
      const blob = git(root, ["hash-object", "-w", "--stdin"], { input: text });
      if (!blob.ok) return blob;
      const added = git(root, ["update-index", "--add", "--cacheinfo", `100644,${blob.out},${path}`], { env });
      if (!added.ok) return added;
    }
    const tree = git(root, ["write-tree"], { env });
    if (!tree.ok) return tree;
    return git(root, ["commit-tree", tree.out, "-p", base, "-F", "-"], { input: write.message });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The write procedure. Before each attempt the upstream is fetched (and the checkout
 * fast-forwarded when possible); `decide` reads the fresh upstream tree and returns the
 * write, or null when none is right. */
export function boardWrite(root: string, decide: (read: Reader) => PlannedWrite | null, options: WriteOptions = {}): WriteOutcome {
  const upstream = upstreamOf(root);
  if (!upstream) return { status: "error", detail: "the branch has no upstream" };
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    options.heartbeat?.();
    const synced = syncCheckout(root, options.ignore);
    if (!synced.ok) return { status: "error", detail: synced.detail };
    const base = git(root, ["rev-parse", upstream.trackingRef]);
    if (!base.ok) return { status: "error", detail: base.err };
    const tree = treeReader(root, base.out);
    const write = decide(tree.read);
    if (!write) return { status: attempt === 1 ? "nothing" : "dropped" };
    for (const path of Object.keys(write.files)) {
      if (!SAFE_PATH.test(path)) return { status: "error", detail: `refusing to write the unsafe path ${path}` };
      const mode = tree.mode(path);
      if (mode !== null && mode !== "100644") return { status: "error", detail: `refusing to write ${path}: not a regular file upstream` };
    }
    const commit = commitOnto(root, base.out, write);
    if (!commit.ok) return { status: "error", detail: commit.err || commit.out };
    options.heartbeat?.();
    options.beforePush?.(attempt);
    const pushed = git(root, ["push", "--quiet", upstream.remote, `${commit.out}:refs/heads/${upstream.branch}`]);
    if (pushed.ok) {
      const after = syncCheckout(root, options.ignore);
      return { status: "pushed", behind: !after.ok || after.behind };
    }
    if (!/rejected|fetch first|non-fast-forward|stale info/i.test(pushed.err)) {
      return { status: "error", detail: pushed.err || "git push failed" };
    }
  }
  return { status: "rejected" };
}
