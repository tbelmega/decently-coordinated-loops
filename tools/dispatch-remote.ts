// Remote execution for central dispatch: the only place that spawns SSH. A command runs on a
// worker as `ssh -o BatchMode=yes -o ConnectTimeout=<n> <target> '<shell> -lc <command>'`,
// through the worker's login shell so its tools resolve as in a terminal there; a worker
// without an SSH destination (the control host) runs the same shell text locally. Message
// bodies travel on stdin, never in the command line.
import { spawnSync } from "node:child_process";
import type { DispatchConfig, DispatchWorker } from "./dispatch-config.ts";

/** Where and with which executables an entry's commands run. Stored on the entry when it is
 * claimed, so a later configuration change cannot point observation at another machine. */
export interface Route {
  host: string;
  /** SSH destination; absent runs locally. */
  ssh?: string;
  /** Login shell; absent uses the worker's `$SHELL`. */
  shell?: string;
  t3Bin: string;
  codexBin: string;
  /** The worker's DCL clone; absent uses `$DCL_HOME` on the worker. */
  dclHome?: string;
}

export function routeFor(worker: DispatchWorker, dispatch: DispatchConfig): Route {
  const route: Route = { host: worker.host, t3Bin: worker.t3Bin ?? dispatch.t3.bin, codexBin: worker.codexBin ?? dispatch.codex.bin };
  if (worker.ssh !== undefined) route.ssh = worker.ssh;
  if (worker.shell !== undefined) route.shell = worker.shell;
  if (worker.dclHome !== undefined) route.dclHome = worker.dclHome;
  return route;
}

/** A word of a command line: a literal (quoted, with a leading `~/` expanded on the worker),
 * or shell text passed through unquoted. */
export type Word = string | { raw: string };

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Quotes one literal so the worker's shell reads it unchanged, except that a leading `~/`
 * becomes the worker's home directory. */
export function word(value: Word): string {
  if (typeof value !== "string") return value.raw;
  if (value === "~") return '"$HOME"';
  if (value.startsWith("~/")) return value.length === 2 ? '"$HOME"/' : `"$HOME"/${shellQuote(value.slice(2))}`;
  return shellQuote(value);
}

export function commandLine(words: Word[]): string {
  return words.map(word).join(" ");
}

/** The worker's DCL clone as a word. */
export function dclHomeWord(route: Route): Word {
  // Never `${DCL_HOME:?}`: that would end the whole shell, and a probe must still answer.
  return route.dclHome ?? { raw: '"${DCL_HOME:-/DCL_HOME-is-not-set}"' };
}

/** Exit status of a command the executable guard refused. */
export const GUARD_REFUSED = 97;

/** The host-owned list of guarded roots, one path per line (`~/` allowed): the directories
 * the host keeps checkouts in, which no board edit can move. Required: without at least one
 * root the guard refuses everything, since the project roots the controller names come from
 * the board and a board edit could move them away from a checkout. */
export const GUARD_ROOTS_FILE = '"${XDG_CONFIG_HOME:-$HOME/.config}/dcl/guard-roots"';

/** Shell functions that resolve a path on the host that runs them (symlinks included) and
 * refuse, with exit 97, an executable or launcher clone that resolves into a guarded root:
 * a root the controller names, a root in the host's own guard-roots file, or any Git
 * work tree that holds a `BOARD.md` (a data repo, wherever the worker keeps it). A host
 * without a guard-roots file, or with an empty one, or without `realpath`, refuses every
 * command, and so does a path that exists but does not resolve. */
export const GUARD_FUNCTIONS = [
  // realpath is required: without it a file symlink cannot be followed, so a path that
  // exists but does not resolve is reported as unresolvable and refused.
  'dcl_real() { if realpath "$1" 2>/dev/null; then return 0; elif [ -e "$1" ] || [ -L "$1" ]; then return 1; else printf "%s\\n" "$1"; fi; }',
  'dcl_under() { [ -e "$2" ] || return 1; rr=$(dcl_real "$2") || return 0; case "$1/" in "$rr"/*) return 0;; esac; return 1; }',
  'dcl_data_repo() { d=$1; [ -d "$d" ] || d=$(dirname "$d"); top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || return 1; [ -f "$top/BOARD.md" ]; }',
  `dcl_inside() { p=$(dcl_real "$1") || return 0; shift; for r in "$@"; do dcl_under "$p" "$r" && return 0; done; f=${GUARD_ROOTS_FILE}; while IFS= read -r r || [ -n "$r" ]; do case "$r" in "") continue;; "~/"*) r="$HOME/\${r#??}";; esac; dcl_under "$p" "$r" && return 0; done < "$f"; dcl_data_repo "$p"; }`,
  `dcl_guard() { label=$1; value=$2; shift 2; if ! command -v realpath >/dev/null 2>&1; then echo "dcl-guard: realpath is not installed; refused" >&2; exit ${GUARD_REFUSED}; fi; f=${GUARD_ROOTS_FILE}; if ! grep -q '[^[:space:]]' "$f" 2>/dev/null; then echo "dcl-guard: no guard roots in $f (list the directories this host keeps checkouts in); refused" >&2; exit ${GUARD_REFUSED}; fi;`+
    ' case "$value" in */*) path=$value;; *) path=$(command -v "$value" 2>/dev/null) || return 0;; esac; if dcl_inside "$path" "$@"; then echo "dcl-guard: $label resolves into a project repository or the data repo; refused" >&2; exit ' +
    String(GUARD_REFUSED) +
    "; fi; }",
].join("\n");

function guardCall(label: string, value: Word, roots: string[]): string {
  return `dcl_guard ${shellQuote(label)} ${word(value)} ${roots.map(word).join(" ")}`;
}

/** The shell text that runs `inner` through the route's login shell. With `roots`, the
 * configured shell is checked before it runs, and the executables and launcher clone the
 * route names are checked inside the login shell, where their names resolve, before
 * `inner` runs: the host decides on its own filesystem, so no spelling of a path escapes. */
export function wrapLogin(route: Route, inner: string, roots?: string[]): string {
  const shell = route.shell === undefined ? '"$SHELL"' : word(route.shell);
  if (!roots) return `exec ${shell} -lc ${shellQuote(inner)}`;
  const outer = `${guardCall("shell", route.shell ?? { raw: '"$SHELL"' }, roots)}\n`;
  const checks = [
    guardCall("t3 executable", route.t3Bin, roots),
    guardCall("codex executable", route.codexBin, roots),
    guardCall("DCL clone", dclHomeWord(route), roots),
  ].join("\n");
  return `${GUARD_FUNCTIONS}\n${outer}exec ${shell} -lc ${shellQuote(`${GUARD_FUNCTIONS}\n${checks}\n${inner}`)}`;
}

export interface RemoteResult {
  /** False when the command never ran: SSH could not connect, or the process did not spawn. */
  reached: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** One bounded line describing a failure, from stderr. */
  detail: string;
}

export interface RunOptions {
  input?: string;
  timeoutMs: number;
  /** Paths no executable of the route may resolve into (project repositories, the data
   * repo), checked on the host itself before the command runs. */
  guard?: string[];
}

export interface Remote {
  /** Runs `words` on the route's host through its login shell. */
  run(route: Route, words: Word[], options: RunOptions): RemoteResult;
}

export const SSH_CONNECT_TIMEOUT_SECONDS = 5;

/** OpenSSH's own exit status for "could not connect or authenticate". */
const SSH_FAILURE = 255;

/** One bounded line of a diagnostic, so command output never floods a log or reaches the
 * board verbatim. */
export function diagnostic(text: string): string {
  const line =
    text
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

export interface RemoteOptions {
  /** The `ssh` executable; tests pass a fake. */
  sshBin?: string;
  env?: NodeJS.ProcessEnv;
  connectTimeoutSeconds?: number;
}

export function remoteRunner(options: RemoteOptions = {}): Remote {
  const sshBin = options.sshBin ?? "ssh";
  const connect = options.connectTimeoutSeconds ?? SSH_CONNECT_TIMEOUT_SECONDS;
  return {
    run(route, words, { input, timeoutMs, guard }) {
      const text = wrapLogin(route, commandLine(words), guard);
      const [bin, args] = route.ssh
        ? [sshBin, ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connect}`, route.ssh, text]]
        : ["/bin/sh", ["-c", text]];
      const result = spawnSync(bin, args, { encoding: "utf8", input: input ?? "", env: options.env ?? process.env, timeout: timeoutMs });
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
      const reached = !result.error && !timedOut && result.status !== null && !(route.ssh && result.status === SSH_FAILURE);
      const detail = timedOut ? `no answer within ${Math.round(timeoutMs / 1000)}s` : diagnostic(stderr || String(result.error ?? "") || `exit ${result.status}`);
      // A refused executable is a configuration fault on a host that answered, not a fact about
      // any job; callers see it as no answer, so nothing is started, released or adopted.
      if (reached && result.status === GUARD_REFUSED && stderr.includes("dcl-guard:")) {
        return { reached: false, status: result.status, stdout: "", stderr, timedOut, detail };
      }
      return { reached, status: result.status, stdout, stderr, timedOut, detail };
    },
  };
}
