// What central dispatch asks a worker host, over dispatch-remote.ts: the probe (reachable,
// which project repositories are work trees, whether the job launcher and Codex CLI answer),
// whether a recorded checkout exists, the Codex
// job commands of the launcher (dispatch-job.ts), and the read-only worktree slot report.
// The control host copies no code to a worker: the worker's own DCL clone runs the launcher.
import { dclHomeWord, word, type Remote, type Route, type Word } from "./dispatch-remote.ts";
import type { JobShow, JobStatus } from "./dispatch-job.ts";
import type { SlotClaim } from "./slots.ts";

export interface WorkerProbe {
  /** Projects whose repository is a Git work tree on the worker. */
  repos: Set<string>;
  /** The launcher exists in the worker's DCL clone and bun runs. */
  launcher: boolean;
  /** `codex --version` answers. */
  codex: boolean;
}

export type ProbeResult = { reachable: true; probe: WorkerProbe } | { reachable: false; detail: string };

const PROBE_MARK = "dcl-probe";
const PROBE_TIMEOUT_MS = 30_000;
const CODEX_CHECK_TIMEOUT_MS = 20_000;
const JOB_TIMEOUT_MS = 45_000;
const SLOTS_TIMEOUT_MS = 120_000;

function launcherWord(route: Route): string {
  return `${word(dclHomeWord(route))}/tools/dispatch-job.ts`;
}

function test(condition: string, mark: string): string {
  return `if ${condition}; then echo ${mark}; fi`;
}

/** A shell condition: `path` is itself the top of a Git work tree. A bare `.git` marker, a
 * linked worktree whose metadata is gone, or a plain directory inside some other checkout
 * does not pass. */
export function gitWorkTree(path: string): string {
  const dir = word(path);
  return `[ -d ${dir} ] && [ "$(cd ${dir} && pwd -P)" = "$(top=$(git -C ${dir} rev-parse --show-toplevel 2>/dev/null) && cd "$top" && pwd -P)" ]`;
}

/** Reachability, repositories and the launcher in one bounded round trip, then Codex as a
 * separate bounded check, so a hung T3 server or a hung `codex` disables only its own
 * executor and never hides the worker or its repositories. */
export function probeWorker(remote: Remote, route: Route, repos: Record<string, string>): ProbeResult {
  const repoChecks = Object.values(repos).map((path, index) => test(gitWorkTree(path), `repo:${index}`));
  const script = [`echo ${PROBE_MARK}`, ...repoChecks, test(`command -v bun >/dev/null 2>&1 && [ -f ${launcherWord(route)} ]`, "launcher")].join("\n");
  const result = remote.run(route, [{ raw: script }], { timeoutMs: PROBE_TIMEOUT_MS });
  const lines = result.stdout.split("\n").map((l) => l.trim());
  if (!result.reached || !lines.includes(PROBE_MARK)) return { reachable: false, detail: result.detail || "no probe answer" };
  const names = Object.keys(repos);
  const present = new Set<string>();
  for (const line of lines) {
    const match = /^repo:(\d+)$/.exec(line);
    if (match) present.add(names[Number(match[1])]!);
  }
  const codex = remote.run(route, [{ raw: test(`${word(route.codexBin)} --version >/dev/null 2>&1`, "codex") }], { timeoutMs: CODEX_CHECK_TIMEOUT_MS });
  return { reachable: true, probe: { repos: present, launcher: lines.includes("launcher"), codex: codex.reached && codex.stdout.split("\n").includes("codex") } };
}

/** Whether `path` is a Git work tree on the worker: true, false, or null when the worker did
 * not answer. */
export function checkoutExists(remote: Remote, route: Route, path: string): boolean | null {
  const r = remote.run(route, [{ raw: test(gitWorkTree(path), "checkout") }], { timeoutMs: PROBE_TIMEOUT_MS });
  if (!r.reached) return null;
  return r.stdout.split("\n").includes("checkout");
}

export type JobObservation =
  | { kind: "job"; job: Extract<JobShow, { found: true }> }
  /** The launcher answered that no job has this token. From `fence`, that is final: the
   * token can no longer start. */
  | { kind: "none" }
  | { kind: "unreachable"; detail: string };

export interface JobStartRequest {
  token: string;
  /** The working directory on the worker; a leading `~/` is the worker's home. */
  cwd: string;
  model: string;
  prompt: string;
}

export type JobCommandResult = { ok: true; job: JobShow } | { ok: false; reached: boolean; detail: string };

function launcher(route: Route): Word[] {
  return ["bun", { raw: launcherWord(route) }];
}

/** The launcher's answer about `token`, or null for anything else (another protocol, another
 * token, a malformed record), which reads as no answer rather than as a fact. */
function parseShow(stdout: string, token: string): JobShow | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || "error" in value || value.token !== token) return null;
  if (value.found === false) return { found: false, token, ...(value.fenced === true ? { fenced: true } : {}) };
  const phases = ["launching", "running", "exited"];
  if (value.version !== 1 || typeof value.phase !== "string" || !phases.includes(value.phase) || typeof value.resumes !== "number" || typeof value.log !== "string") return null;
  if (value.sessionId !== undefined && typeof value.sessionId !== "string") return null;
  const alive = typeof value.alive === "boolean" ? value.alive : value.phase !== "exited";
  return { ...(value as unknown as JobStatus), found: true, alive, logTail: typeof value.logTail === "string" ? value.logTail : "" };
}

function errorOf(stdout: string, fallback: string): string {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const value = JSON.parse(line) as { error?: unknown };
    if (typeof value.error === "string") return value.error;
  } catch {
    // Not the launcher's answer.
  }
  return fallback;
}

export interface CodexJobs {
  start(request: JobStartRequest): JobCommandResult;
  show(token: string): JobObservation;
  /** Like show, but "no such job" also fences the token, so the answer stays true. */
  fence(token: string): JobObservation;
  resume(token: string): JobCommandResult;
}

export function codexJobs(remote: Remote, route: Route): CodexJobs {
  const observe = (command: "show" | "fence", token: string): JobObservation => {
    const r = remote.run(route, [...launcher(route), command, "--token", token], { timeoutMs: JOB_TIMEOUT_MS });
    const job = r.reached && r.status === 0 ? parseShow(r.stdout, token) : null;
    if (!job) return { kind: "unreachable", detail: r.reached ? "unreadable launcher answer" : r.detail };
    return job.found ? { kind: "job", job } : { kind: "none" };
  };
  return {
    start(request) {
      const r = remote.run(
        route,
        [...launcher(route), "start", "--token", request.token, "--cwd", request.cwd, "--model", request.model, "--codex", route.codexBin],
        { input: request.prompt, timeoutMs: JOB_TIMEOUT_MS },
      );
      const job = r.status === 0 ? parseShow(r.stdout, request.token) : null;
      if (r.reached && job) return { ok: true, job };
      return { ok: false, reached: r.reached, detail: r.reached ? errorOf(r.stdout, r.detail) : r.detail };
    },
    show: (token) => observe("show", token),
    fence: (token) => observe("fence", token),
    resume(token) {
      const r = remote.run(route, [...launcher(route), "resume", "--token", token], { timeoutMs: JOB_TIMEOUT_MS });
      const job = r.status === 0 ? parseShow(r.stdout, token) : null;
      if (r.reached && job) return { ok: true, job };
      return { ok: false, reached: r.reached, detail: r.reached ? errorOf(r.stdout, r.detail) : r.detail };
    },
  };
}

export type RemoteSlotRoom = { ok: true; applies: boolean; idle: number } | { ok: false; detail: string };

/** The worker's slot report for one project and tool, read-only on the worker: no fetch, no
 * ref change, new objects in a temporary directory. Claims come from the controller's board. */
export function remoteSlotRoom(
  remote: Remote,
  route: Route,
  opts: { repo: string; tool: string; integrationBranch: string; claims: SlotClaim[] },
): RemoteSlotRoom {
  const r = remote.run(
    route,
    [...launcher(route), "slots", "--repo", opts.repo, "--host", route.host, "--tool", opts.tool, "--branch", opts.integrationBranch],
    { input: JSON.stringify(opts.claims), timeoutMs: SLOTS_TIMEOUT_MS },
  );
  if (!r.reached || r.status !== 0) return { ok: false, detail: r.detail };
  try {
    const value = JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as { applies?: unknown; idle?: unknown };
    if (typeof value.applies !== "boolean" || typeof value.idle !== "number") return { ok: false, detail: "unreadable slot report" };
    return { ok: true, applies: value.applies, idle: value.idle };
  } catch {
    return { ok: false, detail: "unreadable slot report" };
  }
}
