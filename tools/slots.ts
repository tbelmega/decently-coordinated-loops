// Permanent worktree slots: which of a project's slots on this host are idle, and the next
// free slot name. A slot is a linked worktree on the fixed branch `agents/<host>-<tool>-<n>`
// checked out at `<repo>/.worktrees/<host>-<tool>-<n>`; anything else (a purpose worktree, a
// legacy `<slot>--<item>` stack branch, another host's lane) is not a candidate. This module
// creates, switches and rebases nothing and moves no ref; the idle test's `git merge-tree
// --write-tree` does store unreferenced objects, which `git gc` prunes. Invariants and the
// no-lock claim decision: docs/design/slot-claims.md.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export const SLOT_BRANCH_PREFIX = "agents/";

/** A harness id inside a slot name: one token, no hyphen, so `<host>-<tool>-<n>` parses
 * unambiguously even when the host name has hyphens. */
export const TOOL_PATTERN = /^[a-z0-9]+$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `name` is exactly `<host>-<tool>-<n>` for this host. */
export function isSlotName(name: string, host: string): boolean {
  return new RegExp(`^${escapeRegExp(host)}-[a-z0-9]+-[1-9][0-9]*$`).test(name);
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Item states in which a recorded `execution.worktree` still occupies its slot. Merged and
 * later states do not: their content is on the integration branch. */
export const OCCUPYING_STATES = new Set(["in-progress", "implemented", "blocked"]);

export interface Slot {
  name: string;
  path: string;
  branch: string;
  idle: boolean;
  /** Why the slot is not idle; empty when idle. */
  reasons: string[];
}

export interface SlotReport {
  integrationRef: string;
  slots: Slot[];
  /** First idle slot in natural name order, or null. */
  firstIdle: Slot | null;
  /** Lowest-numbered `<host>-<tool>-<n>` no worktree or branch uses yet. */
  nextFree: string;
}

export interface SlotClaim {
  slug: string;
  state: string;
  host?: string;
  worktree?: string;
}

/** A hung git must not hold up a caller that holds the data repo lock. */
const GIT_TIMEOUT_MS = 120_000;

function git(dir: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; out: string } {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: env ?? process.env, timeout: GIT_TIMEOUT_MS });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

/** `origin/<branch>` when the remote-tracking ref exists, else the local branch. */
export function integrationRef(repo: string, branch: string): string {
  return git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).ok
    ? `origin/${branch}`
    : branch;
}

/** True when merging `ref` into `integration` would leave the integration tree unchanged,
 * i.e. everything on `ref` is already integrated, however it got there (fast-forward,
 * rebase or squash). A conflicting merge counts as not integrated. */
export function contentIntegrated(repo: string, integration: string, ref: string, env?: NodeJS.ProcessEnv): boolean {
  const merged = git(repo, ["merge-tree", "--write-tree", integration, ref], env);
  if (!merged.ok) return false;
  const tree = git(repo, ["rev-parse", `${integration}^{tree}`], env);
  return tree.ok && merged.out.split("\n")[0] === tree.out;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

interface ListedWorktree {
  path: string;
  branch?: string;
}

function listWorktrees(repo: string): ListedWorktree[] {
  const listed = git(repo, ["worktree", "list", "--porcelain"]);
  const result: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;
  for (const line of listed.out.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      result.push(current);
    } else if (line.startsWith("branch refs/heads/") && current) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return result;
}

/** A git environment under which the slot report writes nothing to `repo`: new objects
 * (from `merge-tree --write-tree`) go to `objectDir`, the repository's own objects stay
 * readable as alternates, and `git status` takes no optional index lock. */
export function readOnlyGitEnv(repo: string, objectDir: string): NodeJS.ProcessEnv {
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_OBJECT_DIRECTORY: objectDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(common.out, "objects"),
  };
}

/** Reports the slots of `repo` that belong to `host`, and the next free name for `tool`. */
export function slotReport(opts: {
  repo: string;
  host: string;
  tool: string;
  integrationBranch: string;
  claims: SlotClaim[];
  /** Environment for every git call; a caller that must not write to the repository passes
   * one that sends new objects elsewhere (see readOnlyGitEnv). */
  env?: NodeJS.ProcessEnv;
}): SlotReport {
  const { repo, host, tool, integrationBranch, claims, env } = opts;
  if (!TOOL_PATTERN.test(tool)) throw new Error(`tool "${tool}" must be one token of lowercase letters and digits`);
  const integration = integrationRef(repo, integrationBranch);

  const slots: Slot[] = [];
  for (const worktree of listWorktrees(repo)) {
    if (!worktree.branch?.startsWith(SLOT_BRANCH_PREFIX)) continue;
    const name = worktree.branch.slice(SLOT_BRANCH_PREFIX.length);
    if (!isSlotName(name, host)) continue;
    if (canonical(worktree.path) !== canonical(join(repo, ".worktrees", name))) continue;
    const reasons: string[] = [];
    const status = git(worktree.path, ["status", "--porcelain"], env);
    if (!status.ok) reasons.push("git cannot read its working tree");
    else if (status.out) reasons.push("uncommitted changes");
    if (!contentIntegrated(repo, integration, worktree.branch, env)) reasons.push(`content not on ${integration}`);
    for (const claim of claims) {
      if (!OCCUPYING_STATES.has(claim.state) || !claim.worktree) continue;
      if (claim.host !== undefined && claim.host !== host) continue;
      if (canonical(claim.worktree) === canonical(worktree.path)) reasons.push(`board item ${claim.slug} (${claim.state}) works here`);
    }
    slots.push({ name, path: worktree.path, branch: worktree.branch, idle: reasons.length === 0, reasons });
  }
  slots.sort((a, b) => naturalCompare(a.name, b.name));

  const taken = new Set<string>(slots.map((slot) => slot.name));
  const refs = git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/agents/", "refs/remotes/origin/agents/"]);
  for (const ref of refs.out.split("\n").filter(Boolean)) {
    taken.add(ref.replace(/^refs\/(heads|remotes\/origin)\/agents\//, ""));
  }
  const existsOnDisk = (name: string) => existsSync(resolve(repo, ".worktrees", name));
  let n = 1;
  while (taken.has(`${host}-${tool}-${n}`) || existsOnDisk(`${host}-${tool}-${n}`)) n++;

  return {
    integrationRef: integration,
    slots,
    firstIdle: slots.find((slot) => slot.idle) ?? null,
    nextFree: `${host}-${tool}-${n}`,
  };
}
