// The thread starter of central dispatch: the four operations the dispatch program needs
// from T3 Code (start, list, show, send), run through its `t3` command. The status lists
// and error texts are what `t3` 0.1.9 reported on a real server for a running, a finished,
// an interrupted and a failed thread, and for an unknown thread id or project.
import { spawnSync } from "node:child_process";

export interface ThreadInfo {
  threadId: string;
  title: string;
  status: string;
  runtimeMode: string;
  pendingRequestCount: number;
}

export type StarterFailure =
  /** T3 Code answered that it does not know this thread id. */
  | "unknown-thread"
  /** T3 Code answered that no project matches the path. */
  | "unknown-project"
  /** The command ran and reported a failure. */
  | "failed"
  /** No answer from T3 Code, or an answer the adapter cannot read. */
  | "unreachable";

export type StarterResult<T> = { ok: true; value: T } | { ok: false; failure: StarterFailure; detail: string };

export interface StartRequest {
  /** Path of the project's repository; T3 Code resolves the project from it. */
  project: string;
  title: string;
  provider: string;
  model: string;
  message: string;
}

export interface ThreadStarter {
  start(request: StartRequest): StarterResult<{ threadId: string }>;
  list(project: string): StarterResult<ThreadInfo[]>;
  show(threadId: string): StarterResult<ThreadInfo>;
  send(threadId: string, message: string): StarterResult<null>;
}

/** Statuses of a thread whose current turn is still going. */
export const RUNNING_STATUSES: ReadonlySet<string> = new Set(["running", "starting"]);
/** Statuses of a thread that is not working and waits for a message. */
export const STOPPED_STATUSES: ReadonlySet<string> = new Set(["completed", "interrupted", "failed", "idle"]);

export type StatusClass = "running" | "stopped" | "unknown";

export function classifyStatus(status: string): StatusClass {
  if (RUNNING_STATUSES.has(status)) return "running";
  if (STOPPED_STATUSES.has(status)) return "stopped";
  return "unknown";
}

const UNKNOWN_THREAD = /is no longer available/;
const UNKNOWN_PROJECT = /No T3 Code project matches/;
const TIMEOUT_MS = 120_000;

function readThread(raw: unknown): ThreadInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.threadId !== "string" || typeof value.status !== "string") return null;
  return {
    threadId: value.threadId,
    title: typeof value.title === "string" ? value.title : "",
    status: value.status,
    runtimeMode: typeof value.runtimeMode === "string" ? value.runtimeMode : "",
    pendingRequestCount: typeof value.pendingRequestCount === "number" ? value.pendingRequestCount : 0,
  };
}

/** One bounded line of a diagnostic, so command output never floods a log or reaches the
 * board verbatim. Thread messages are never part of it: only stderr is used. */
function diagnostic(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The `t3` command as a ThreadStarter. `bin` is a name on PATH or a path. */
export function t3Starter(bin: string, env: NodeJS.ProcessEnv = process.env): ThreadStarter {
  function run(args: string[], input?: string) {
    const result = spawnSync(bin, args, { encoding: "utf8", input, env, timeout: TIMEOUT_MS });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    return { spawned: !result.error, status: result.status, stdout, stderr, detail: diagnostic(stderr || String(result.error ?? "") || "no diagnostic") };
  }

  function failure<T>(r: ReturnType<typeof run>, onFailure: StarterFailure): StarterResult<T> {
    const text = `${r.stderr}\n${r.stdout}`;
    if (!r.spawned || r.status === null) return { ok: false, failure: "unreachable", detail: r.detail };
    if (UNKNOWN_THREAD.test(text)) return { ok: false, failure: "unknown-thread", detail: r.detail };
    if (UNKNOWN_PROJECT.test(text)) return { ok: false, failure: "unknown-project", detail: r.detail };
    return { ok: false, failure: onFailure, detail: r.detail };
  }

  return {
    start(request) {
      const r = run(
        ["thread", "start", request.project, "-", "--title", request.title, "--provider", request.provider, "--model", request.model, "--json"],
        request.message,
      );
      if (r.status !== 0) return failure(r, "failed");
      const parsed = parseJson(r.stdout) as { threadId?: unknown } | undefined;
      if (typeof parsed?.threadId !== "string") return { ok: false, failure: "unreachable", detail: "unreadable start output" };
      return { ok: true, value: { threadId: parsed.threadId } };
    },
    list(project) {
      const r = run(["thread", "list", "--project", project, "--json"]);
      if (r.status !== 0) return failure(r, "unreachable");
      const parsed = parseJson(r.stdout);
      // `t3 thread list` prints the unknown-project notice on stdout and exits 0.
      if (parsed === undefined && UNKNOWN_PROJECT.test(r.stdout)) return { ok: false, failure: "unknown-project", detail: diagnostic(r.stdout) };
      if (!Array.isArray(parsed)) return { ok: false, failure: "unreachable", detail: "unreadable list output" };
      const threads = parsed.map(readThread);
      if (threads.some((t) => t === null)) return { ok: false, failure: "unreachable", detail: "unreadable thread in list output" };
      return { ok: true, value: threads as ThreadInfo[] };
    },
    show(threadId) {
      const r = run(["thread", "show", threadId, "--messages", "1", "--json"]);
      if (r.status !== 0) return failure(r, "unreachable");
      const thread = readThread((parseJson(r.stdout) as { thread?: unknown } | undefined)?.thread);
      if (!thread) return { ok: false, failure: "unreachable", detail: "unreadable show output" };
      return { ok: true, value: thread };
    },
    send(threadId, message) {
      const r = run(["thread", "send", threadId, "-", "--json"], message);
      if (r.status !== 0) return failure(r, "failed");
      return { ok: true, value: null };
    },
  };
}
