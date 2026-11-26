#!/usr/bin/env bun
// The job launcher of central dispatch, run on a worker by bun from the worker's own DCL
// clone. It starts a Codex CLI job and stays alive as its supervisor, recording what
// dispatch needs to observe the job in a status file:
//
//   dispatch-job.ts start --token <t> --cwd <dir> --model <m> [--codex <bin>]   (prompt on stdin)
//   dispatch-job.ts show --token <t>
//   dispatch-job.ts fence --token <t>
//   dispatch-job.ts resume --token <t>
//   dispatch-job.ts slots --repo <dir> --host <h> --tool <t> --branch <b>        (claims on stdin)
//
// The status file (`<state>/dcl/jobs/<token>.json`, the log beside it, all owner-only) is
// written before anything is spawned, and the supervisor that records the exit is the
// process that spawns Codex; both pids are recorded, so a job counts as alive while either
// lives. `fence` makes "no such job" final: it records the token as never to start, so a
// start request still in flight refuses when it arrives. `slots` is the read-only worktree
// slot report dispatch plans with. Every command prints one JSON object. Exit 0 on success,
// 2 on a usage error, 3 when the command refuses (a token that already exists or was
// fenced, a resume without a session, of a live job, or after the one allowed resume), 4
// when the supervisor did not report in time.
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { processStartTime } from "./lock.ts";
import { readOnlyGitEnv, slotReport, type SlotClaim } from "./slots.ts";

/** fenced: the token was recorded as never to start; no job ran under it. */
export type JobPhase = "launching" | "running" | "exited" | "fenced";

export interface JobStatus {
  version: 1;
  token: string;
  cwd: string;
  model: string;
  codex: string;
  phase: JobPhase;
  /** What the supervisor runs next or ran last. */
  mode: "start" | "resume";
  /** The process that owns the job now: the launcher while launching, then the supervisor. */
  pid: number;
  /** That process's start time, so a reused pid after a reboot does not look alive. */
  pidStart: string | null;
  /** True once `pid` is the supervisor, which leads the process group Codex runs in. */
  group?: boolean;
  /** The Codex process the supervisor spawned, recorded so a lost supervisor does not hide it. */
  childPid?: number;
  childStart?: string | null;
  sessionId?: string;
  exitCode?: number;
  startedAt: string;
  finishedAt?: string;
  resumes: number;
  log: string;
}

/** What `show` prints. */
export type JobShow = { found: false; token: string; fenced?: boolean } | (JobStatus & { found: true; alive: boolean; logTail: string });

const TOKEN_PATTERN = /^d-[0-9a-f]{8}$/;
const REPORT_WAIT_MS = 20_000;
const LOG_TAIL_BYTES = 64 * 1024;
const PRIVATE_FILE = 0o600;

export function jobsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state"), "dcl", "jobs");
}

function paths(token: string, env: NodeJS.ProcessEnv = process.env) {
  const dir = jobsDir(env);
  return { dir, status: join(dir, `${token}.json`), log: join(dir, `${token}.log`), prompt: join(dir, `${token}.prompt`) };
}

export function readStatus(path: string): JobStatus | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as JobStatus;
}

function writeStatus(path: string, status: JobStatus): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`, { mode: PRIVATE_FILE });
  renameSync(temp, path);
}

/** The jobs directory, created owner-only; refused when it is a symlink or another user's,
 * since prompts and transcripts in it can carry private repository content. */
function privateDir(dir: string): string | null {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return `${dir} is not a plain directory`;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return `${dir} belongs to another user`;
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return null;
}

/** Writes the first status file, failing when one exists: a token starts at most once. */
function createStatus(path: string, status: JobStatus): boolean {
  const temp = `${path}.${process.pid}.new`;
  writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`, { mode: PRIVATE_FILE });
  try {
    linkSync(temp, path);
    return true;
  } catch {
    return false;
  } finally {
    unlinkSync(temp);
  }
}

function pidAlive(pid: number, pidStart: string | null): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return pidStart !== null && processStartTime(pid) === pidStart;
}

/** The time this host booted, so a process group id recorded before a reboot is not taken
 * for the same group after it. */
function bootTime(): number {
  return Date.now() - uptime() * 1000;
}

/** True while any process of the group still exists. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True while the job can still be working. The supervisor runs as the leader of its own
 * process group, and Codex is spawned into that group, so the group outlives a supervisor
 * killed outright, even one killed before it could record the child: a job is alive while
 * its group has any process, since this boot. */
export function jobAlive(status: JobStatus): boolean {
  if (status.childPid !== undefined && pidAlive(status.childPid, status.childStart ?? null)) return true;
  if (status.phase === "launching") return pidAlive(status.pid, status.pidStart);
  if (status.phase !== "running" || status.group !== true) return false;
  if (Date.parse(status.startedAt) < bootTime() - 5_000) return false;
  return groupAlive(status.pid);
}

/** The last line of the log that is not a Codex JSON event: an error Codex or the launcher
 * printed in plain text, which says more than the last event. */
function lastLogLine(path: string): string {
  if (!existsSync(path)) return "";
  const fd = openSync(path, "r");
  let text: string;
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    text = buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const plain = lines.filter((l) => !l.startsWith("{"));
  const line = plain.pop() ?? lines.pop() ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Starts the detached supervisor and waits until it has recorded itself. */
function launchSupervisor(token: string, cwd: string): number {
  const p = paths(token);
  const log = openSync(p.log, "a", PRIVATE_FILE);
  const child = spawn(process.execPath, [import.meta.path, "supervise", "--token", token], {
    cwd,
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  closeSync(log);
  const deadline = Date.now() + REPORT_WAIT_MS;
  while (Date.now() < deadline) {
    const status = readStatus(p.status);
    if (status && status.phase !== "launching") {
      print(status);
      return 0;
    }
    sleep(100);
  }
  print({ error: "the supervisor did not report in time", token });
  return 4;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function start(args: Record<string, string>): number {
  const { token, cwd, model } = args;
  const codex = args.codex ?? "codex";
  if (!token || !cwd || !model) return usage("start needs --token, --cwd and --model");
  const p = paths(token);
  const unsafe = privateDir(p.dir);
  if (unsafe) {
    print({ error: unsafe, token });
    return 3;
  }
  if (existsSync(p.status)) {
    print({ error: "a job with this token exists or was fenced", token });
    return 3;
  }
  const prompt = readStdin();
  const status: JobStatus = {
    version: 1,
    token,
    cwd,
    model,
    codex,
    phase: "launching",
    mode: "start",
    pid: process.pid,
    pidStart: processStartTime(process.pid),
    startedAt: new Date().toISOString(),
    resumes: 0,
    log: p.log,
  };
  if (!createStatus(p.status, status)) {
    print({ error: "a job with this token exists or was fenced", token });
    return 3;
  }
  writeFileSync(p.prompt, prompt, { mode: PRIVATE_FILE });
  if (!existsSync(cwd)) {
    rmSync(p.prompt, { force: true });
    writeStatus(p.status, { ...status, phase: "exited", exitCode: 127, finishedAt: new Date().toISOString() });
    writeFileSync(p.log, `dispatch-job: working directory ${cwd} does not exist\n`, { flag: "a", mode: PRIVATE_FILE });
    print(readStatus(p.status));
    return 0;
  }
  return launchSupervisor(token, cwd);
}

function show(args: Record<string, string>): number {
  const { token } = args;
  if (!token) return usage("show needs --token");
  const p = paths(token);
  const status = readStatus(p.status);
  if (!status || status.phase === "fenced") {
    print({ found: false, token, ...(status ? { fenced: true } : {}) } satisfies JobShow);
    return 0;
  }
  const alive = jobAlive(status);
  print({ ...status, found: true, alive, logTail: alive ? "" : lastLogLine(p.log) } satisfies JobShow);
  return 0;
}

/** "No such job", made final: records the token as never to start, so a start request
 * that is still on its way refuses when it arrives. An existing job is shown instead. */
function fence(args: Record<string, string>): number {
  const { token } = args;
  if (!token) return usage("fence needs --token");
  const p = paths(token);
  const unsafe = privateDir(p.dir);
  if (unsafe) {
    print({ error: unsafe, token });
    return 3;
  }
  const record: JobStatus = {
    version: 1,
    token,
    cwd: "",
    model: "",
    codex: "",
    phase: "fenced",
    mode: "start",
    pid: process.pid,
    pidStart: null,
    startedAt: new Date().toISOString(),
    resumes: 0,
    log: p.log,
  };
  createStatus(p.status, record);
  return show(args);
}

function resume(args: Record<string, string>): number {
  const { token } = args;
  if (!token) return usage("resume needs --token");
  const p = paths(token);
  const status = readStatus(p.status);
  if (!status || status.phase === "fenced") {
    print({ error: "no such token", token });
    return 3;
  }
  if (status.resumes >= 1) {
    print({ error: "the job was already resumed once", token });
    return 3;
  }
  if (jobAlive(status)) {
    print({ error: "the job is still running", token });
    return 3;
  }
  if (!status.sessionId) {
    print({ error: "the job has no session id to resume", token });
    return 3;
  }
  const next: JobStatus = { ...status, phase: "launching", mode: "resume", pid: process.pid, pidStart: processStartTime(process.pid), resumes: status.resumes + 1 };
  delete next.exitCode;
  delete next.finishedAt;
  writeStatus(p.status, next);
  return launchSupervisor(token, status.cwd);
}

/** The Codex session id in one line of `codex exec --json` output, if it carries one. */
export function sessionIdOf(line: string): string | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof event !== "object" || event === null) return undefined;
  const value = event as Record<string, unknown>;
  if (value.type === "thread.started" && typeof value.thread_id === "string") return value.thread_id;
  if (typeof value.session_id === "string") return value.session_id;
  const msg = value.msg as Record<string, unknown> | undefined;
  if (msg && typeof msg.session_id === "string") return msg.session_id;
  return undefined;
}

/** The detached supervisor: records itself, runs Codex, records the session and the exit. */
function supervise(args: Record<string, string>): number {
  const { token } = args;
  if (!token) return usage("supervise needs --token");
  const p = paths(token);
  const initial = readStatus(p.status);
  if (!initial) return 3;
  // Recorded before Codex is spawned, so from the first moment Codex can work, the record
  // names the process group it runs in.
  let status: JobStatus = { ...initial, phase: "running", pid: process.pid, pidStart: processStartTime(process.pid), group: true, startedAt: new Date().toISOString() };
  const update = (change: Partial<JobStatus>) => {
    status = { ...status, ...change };
    writeStatus(p.status, status);
  };
  update({});
  const codexArgs =
    status.mode === "resume"
      ? ["exec", "resume", "--json", "-c", 'sandbox_mode="danger-full-access"', "-m", status.model, status.sessionId!, "continue"]
      : ["exec", "--json", "--sandbox", "danger-full-access", "-m", status.model, "-C", status.cwd, "-"];
  const input = status.mode === "start" && existsSync(p.prompt) ? openSync(p.prompt, "r") : "ignore";
  const child = spawn(status.codex, codexArgs, { cwd: status.cwd, stdio: [input, "pipe", "inherit"], env: process.env });
  // The child holds the prompt open; the file itself is no longer needed.
  rmSync(p.prompt, { force: true });
  update(child.pid === undefined ? {} : { childPid: child.pid, childStart: processStartTime(child.pid) });
  const finish = (exitCode: number) => {
    if (status.phase === "exited") return;
    update({ phase: "exited", exitCode, finishedAt: new Date().toISOString() });
    process.exit(0);
  };
  // A stop request reaches Codex; the exit is recorded only once Codex has really ended.
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => child.kill("SIGTERM"));
  let buffered = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    process.stdout.write(text);
    buffered += text;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const id = status.sessionId ? undefined : sessionIdOf(line);
      if (id) update({ sessionId: id });
      newline = buffered.indexOf("\n");
    }
  });
  child.on("error", (error) => {
    process.stdout.write(`dispatch-job: cannot run ${status.codex}: ${error.message}\n`);
    finish(127);
  });
  child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
  return -1;
}

function slots(args: Record<string, string>): number {
  const { repo, host, tool, branch } = args;
  if (!repo || !host || !tool || !branch) return usage("slots needs --repo, --host, --tool and --branch");
  let claims: SlotClaim[];
  try {
    claims = JSON.parse(readStdin() || "[]") as SlotClaim[];
  } catch {
    return usage("slots reads a JSON list of claims on stdin");
  }
  if (!existsSync(repo)) {
    print({ applies: false, idle: 0, error: `no repository at ${repo}` });
    return 0;
  }
  const objects = mkdtempSync(join(tmpdir(), "dcl-slot-objects-"));
  try {
    const report = slotReport({ repo, host, tool, integrationBranch: branch, claims, env: readOnlyGitEnv(repo, objects) });
    const own = new RegExp(`^${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-${tool}-[1-9][0-9]*$`);
    print({ applies: report.slots.length > 0, idle: report.slots.filter((slot) => slot.idle && own.test(slot.name)).length });
    return 0;
  } finally {
    rmSync(objects, { recursive: true, force: true });
  }
}

function usage(message: string): number {
  process.stderr.write(`dispatch-job: ${message}\n`);
  return 2;
}

function parseArgs(rest: string[]): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith("--") || value === undefined) return null;
    values[key.slice(2)] = value;
  }
  return values;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  let code: number;
  if (!args) code = usage("arguments are --name value pairs");
  else if (args.token !== undefined && !TOKEN_PATTERN.test(args.token)) code = usage(`not a dispatch token: ${args.token}`);
  else if (command === "start") code = start(args);
  else if (command === "show") code = show(args);
  else if (command === "fence") code = fence(args);
  else if (command === "resume") code = resume(args);
  else if (command === "supervise") code = supervise(args);
  else if (command === "slots") code = slots(args);
  else code = usage(`unknown command ${command ?? "(none)"}`);
  // The supervisor stays alive until Codex exits; every other command ends here.
  if (code !== -1) process.exit(code);
}
