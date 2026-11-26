// The commands of central dispatch (plan, tick, status, pause, resume) over a data repo
// checkout. cli-dispatch.ts is the thin entry point; everything with IO lives here, behind
// RunDeps, so the tests drive real git fixtures, a fake `ssh`, a fake `t3` and a fake `codex`
// without a process boundary of their own.
//
// Invariants of a tick (the full list: docs/design/central-dispatch-invariants.md):
// - One tick or pause runs at a time: each takes the data repo lock shared with sync
//   (lock.ts: held while its holder lives, taken over only from a gone holder) before the
//   state file is read or created, and holds it until it ends. The state file is written
//   only under it, and a run that finds it lost the lock stops without writing more.
// - Configuration is read again after every fetch, so a pushed disable, pause or config
//   change takes effect before the next start.
// - Jobs run only on configured workers. An entry made before workers existed (no `worker`)
//   is observed on the control host and never sent work or a continue there.
// - An entry is saved with its worker, executor and route before its claim is pushed, and
//   holds a slot of that worker from then on, so a start whose answer is lost is adopted
//   by its claim token on the next tick instead of started twice.
// - An entry is observed through the route it was claimed with. A worker that does not
//   answer keeps every entry and claim it holds and gets nothing new in this tick.
// - Every work-bearing message to a T3 thread (the work message, a continue) is sent only
//   after a fresh read of the thread reports the configured permission mode, and only while
//   the item still carries this claim (dispatch-plan.ts -> decideObservation).
// - Before acting on a stopped thread or job (a continue, a resume or a park), the clone is
//   fetched again and the item re-read, so a result published after the tick began wins.
// - A claim is decided from a freshly planned board after every rejected push; cleanup
//   writes check ownership on the state they are about to change.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { activeClaimToken, applyItemEdit, readClaimFields, type ClaimFieldValues } from "./claim.ts";
import { loadConfig, projectLifecycle, type LoopsConfig } from "./config.ts";
import type { DispatchConfig, DispatchWorker } from "./dispatch-config.ts";
import { boardWrite, git, repairClone, syncCheckout, type PlannedWrite, type Reader, type WriteOptions, type WriteOutcome } from "./dispatch-git.ts";
import {
  claimLog,
  claimTag,
  handshakeMessage,
  parkLog,
  parkNextStep,
  releaseLog,
  resumeMessage,
  threadTitle,
  workMessage,
  type ParkedJob,
} from "./dispatch-messages.ts";
import {
  decideJobObservation,
  decideObservation,
  mergeCheckout,
  planDispatch,
  workerEntries,
  type ItemObservation,
  type ObserveDecision,
  type PlanContext,
  type SlotRoom,
  type T3Answer,
  type ThreadObservation,
  type WorkerView,
} from "./dispatch-plan.ts";
import { remoteRunner, routeFor, type Remote, type Route } from "./dispatch-remote.ts";
import {
  CONTROL_FILE,
  controlText,
  defaultControl,
  emptyState,
  readControl,
  readState,
  statePath,
  writeState,
  type DispatchControl,
  type DispatchEntry,
  type DispatchState,
} from "./dispatch-state.ts";
import { remoteT3Starter, t3Starter, type ThreadStarter } from "./dispatch-t3.ts";
import { checkoutExists, codexJobs, probeWorker, remoteSlotRoom, type JobObservation } from "./dispatch-workers.ts";
import { formatSnapshotDate } from "./date.ts";
import { acquireLock, refreshLock, releaseOwnLock } from "./lock.ts";
import { isOpen, parseOutbox } from "./outbox.ts";
import { loadArchiveDir, loadForDeliveryDir, parseItemFileText } from "./parse.ts";
import { buildUniverse } from "./readiness.ts";
import { expandHome } from "./registration.ts";
import { replaceActiveRow } from "./render.ts";
import type { ItemFile } from "./types.ts";

const LOCK_FILE = ".loops-sync.lock";
const IGNORE = [LOCK_FILE];

export interface RunDeps {
  root: string;
  /** The configuration read at start-up; a tick reads it again after each fetch. */
  config: LoopsConfig;
  now(): Date;
  statePath: string;
  out(line: string): void;
  /** Reads the configuration again; defaults to loops.json in `root`. */
  reload?(): LoopsConfig;
  /** Runs commands on workers; defaults to the system `ssh` (tests pass a fake). */
  remote?: Remote;
  /** Replaces the local `t3` command that observes legacy entries (tests). */
  starter?: ThreadStarter;
  token?(): string;
  beforePush?(attempt: number): void;
  home?: string;
}

export function defaultStatePath(root: string): string {
  return statePath(root);
}

function newToken(): string {
  return `d-${randomBytes(4).toString("hex")}`;
}

/** The real path, resolving symlinks in the longest part of it that exists, so a path that
 * does not exist yet still compares correctly with one that does. */
function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  }
}

/** Why an executable the control host itself runs must not be used, or null. One inside the
 * data repo would let anyone who can push to the board choose what the control host runs. */
export function localExecutableProblem(root: string, label: string, bin: string, home = process.env.HOME ?? ""): string | null {
  if (!bin.includes("/")) return null;
  const path = expandHome(bin, home);
  if (!isAbsolute(path)) return `${label} must be a command name, an absolute path or a ~/ path, not ${bin}`;
  const inside = relative(canonical(root), canonical(path));
  if (!inside.startsWith("..") && !isAbsolute(inside)) return `${label} must not point into the data repo`;
  return null;
}

/** The executables the control host runs: the local `t3` for legacy entries, and those of a
 * worker entry without SSH (the control host taking jobs itself). */
function localExecutablesProblem(root: string, dispatch: DispatchConfig, home: string | undefined, checkT3: boolean): string | null {
  const checks: [string, string | undefined][] = checkT3 ? [["dispatch.t3.bin", dispatch.t3.bin]] : [];
  dispatch.workers.forEach((worker, index) => {
    if (worker.ssh !== undefined) return;
    const route = routeFor(worker, dispatch);
    const label = `dispatch.workers[${index}]`;
    checks.push([`${label} t3 executable`, route.t3Bin], [`${label} codex executable`, route.codexBin], [`${label}.dclHome`, route.dclHome], [`${label}.shell`, route.shell]);
  });
  for (const [label, bin] of checks) {
    const problem = bin === undefined ? null : localExecutableProblem(root, label, bin, home);
    if (problem) return problem;
  }
  return null;
}

/** The project's repository path as configured; a leading `~/` is resolved by whichever
 * host uses it. */
function repoOf(config: LoopsConfig, project: string): string | undefined {
  return config.projects[project]?.repo;
}

function localRepo(config: LoopsConfig, project: string, home: string | undefined): string | undefined {
  const repo = repoOf(config, project);
  return repo === undefined ? undefined : expandHome(repo, home ?? process.env.HOME ?? "");
}

function integrationBranchOf(config: LoopsConfig, project: string): string {
  return config.projects[project]?.integrationBranch ?? config.integrationBranch;
}

interface Board {
  items: ItemFile[];
  universe: Map<string, ItemFile>;
  /** Item files that do not parse, with the reason. */
  unparseable: { path: string; reason: string }[];
}

/** Reads items/ one file at a time, so one damaged file is reported instead of stopping the
 * scan. A damaged item resolves as missing for dependencies, which never satisfies. */
function loadBoard(root: string): Board {
  const dir = join(root, "items");
  const items: ItemFile[] = [];
  const unparseable: Board["unparseable"] = [];
  for (const name of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : []) {
    const path = `items/${name}`;
    try {
      items.push(parseItemFileText(path, readFileSync(join(dir, name), "utf8")));
    } catch (error) {
      unparseable.push({ path, reason: (error as Error).message.split("\n")[0]! });
    }
  }
  let others: ItemFile[] = [];
  try {
    others = [...loadArchiveDir(join(root, "archive")), ...loadForDeliveryDir(join(root, "for-delivery"))];
  } catch {
    // A damaged archived item only weakens dependency resolution, which then fails closed.
  }
  return { items, universe: buildUniverse([...others, ...items]), unparseable };
}

function stoppedAsks(root: string, universe: Map<string, ItemFile>): number {
  const path = join(root, "OUTBOX.md");
  if (!existsSync(path)) return 0;
  return parseOutbox(readFileSync(path, "utf8"), universe).entries.filter((entry) => entry.kind === "ask" && isOpen(entry)).length;
}

interface Session {
  deps: RunDeps;
  config: LoopsConfig;
  dispatch: DispatchConfig;
  remote: Remote;
  /** The local `t3` command, for legacy entries on the control host. */
  local: ThreadStarter;
}

/** One probed worker, kept for the whole run. */
interface Probed {
  view: WorkerView;
  route: Route;
  /** The project paths the probe checked; a changed path means probing again. */
  repos: Record<string, string>;
  detail?: string;
}

function sameRoute(a: Route, b: Route): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Probes each configured worker once per run, reusing an earlier answer for an unchanged
 * route when the configuration is read again. */
class Workers {
  private readonly probed = new Map<string, Probed>();

  constructor(private session: Session) {}

  setSession(session: Session): void {
    this.session = session;
  }

  private repos(): Record<string, string> {
    const repos: Record<string, string> = {};
    for (const [name, project] of Object.entries(this.session.config.projects)) {
      if (project?.repo) repos[name] = project.repo;
    }
    return repos;
  }

  private probe(worker: DispatchWorker): Probed {
    const route = routeFor(worker, this.session.dispatch);
    const repos = this.repos();
    const known = this.probed.get(worker.host);
    if (known && sameRoute(known.route, route) && JSON.stringify(known.repos) === JSON.stringify(repos)) {
      known.view.worker = worker;
      return known;
    }
    const result = probeWorker(this.session.remote, route, repos);
    const probed: Probed = result.reachable
      ? { view: { worker, probe: result.probe }, route, repos }
      : { view: { worker, probe: null }, route, repos, detail: result.detail };
    this.probed.set(worker.host, probed);
    return probed;
  }

  /** The configured workers in order, probed. */
  all(): Probed[] {
    return this.session.dispatch.workers.map((worker) => this.probe(worker));
  }

  byHost(host: string): Probed | undefined {
    return this.all().find((p) => p.view.worker.host === host);
  }

  /** Marks a worker that stopped answering during the run. */
  markUnreachable(host: string): void {
    const probed = this.probed.get(host);
    if (probed) probed.view.probe = null;
  }

  markT3Down(host: string): void {
    const probed = this.probed.get(host);
    if (probed) probed.view.t3Down = true;
  }
}

function lines(probed: Probed, state: DispatchState): string {
  const { view } = probed;
  const used = workerEntries(state, view.worker.host).length;
  const head = `WORKER ${view.worker.host} kinds=${view.worker.kinds.join(",")} slots=${used}/${view.worker.slots}`;
  if (!view.probe) return `${head} unreachable${probed.detail ? ` (${probed.detail})` : ""}`;
  const repos = [...view.probe.repos].sort().join(",") || "none";
  return `${head} reachable repos=${repos} launcher=${view.probe.launcher ? "yes" : "no"} codex=${view.probe.codex ? "yes" : "no"}${view.t3Down ? " t3=down" : ""}`;
}

type Context = PlanContext & { board: Board };

function buildContext(session: Session, workers: Workers, state: DispatchState, control: DispatchControl): Context {
  const { deps } = session;
  const board = loadBoard(deps.root);
  const probed = workers.all();
  const routeOf = (host: string) => probed.find((p) => p.view.worker.host === host)!.route;
  return {
    config: session.config,
    items: board.items,
    universe: board.universe,
    board,
    state,
    control,
    now: deps.now(),
    lastCommitAt(path) {
      const log = git(deps.root, ["log", "-1", "--format=%cI", "--", path]);
      return log.ok && log.out ? new Date(log.out) : null;
    },
    workers: probed.map((p) => p.view),
    t3Project(host, project): T3Answer {
      const repo = repoOf(session.config, project);
      if (!repo) return "unknown";
      const listed = remoteT3Starter(session.remote, routeOf(host)).list(repo);
      if (listed.ok) return "known";
      return listed.failure === "unknown-project" ? "unknown" : "unreachable";
    },
    slotRoom(host, project, tool): SlotRoom {
      const repo = repoOf(session.config, project);
      if (!repo) return { applies: false, idle: 0 };
      const claims = board.items
        .filter((item) => item.project === project)
        .map((item) => ({ slug: item.slug, state: item.state, host: item.execution?.host, worktree: item.execution?.worktree }));
      const room = remoteSlotRoom(session.remote, routeOf(host), { repo, tool, integrationBranch: integrationBranchOf(session.config, project), claims });
      return room.ok ? { applies: room.applies, idle: room.idle } : { applies: true, idle: 0, error: room.detail };
    },
    checkout: (host, path) => checkoutExists(session.remote, routeOf(host), path),
    stoppedAsks: stoppedAsks(deps.root, board.universe),
  };
}

function itemPath(slug: string): string {
  return `items/${slug}.md`;
}

function observeItem(root: string, slug: string): ItemObservation {
  const path = join(root, itemPath(slug));
  if (!existsSync(path)) return { location: "elsewhere" };
  const text = readFileSync(path, "utf8");
  try {
    return { location: "items", item: parseItemFileText(itemPath(slug), text), text };
  } catch {
    return { location: "elsewhere" };
  }
}

/** The T3 command that reaches an entry's thread: its stored route, or locally for a legacy
 * entry. */
function starterFor(session: Session, entry: DispatchEntry): ThreadStarter {
  return entry.route ? remoteT3Starter(session.remote, entry.route) : session.local;
}

/** The project path T3 Code knows the entry's project by on the entry's host. */
function threadProject(session: Session, entry: DispatchEntry): string | undefined {
  if (entry.threadProject) return entry.threadProject;
  return entry.route ? repoOf(session.config, entry.project) : localRepo(session.config, entry.project, session.deps.home);
}

function findByToken(session: Session, entry: DispatchEntry): ThreadObservation {
  const repo = threadProject(session, entry);
  // Without the project the start was made in, absence proves nothing: the entry waits.
  if (!repo) return { kind: "unreachable" };
  const listed = starterFor(session, entry).list(repo);
  if (!listed.ok) return listed.failure === "unknown-project" ? { kind: "none" } : { kind: "unreachable" };
  const found = listed.value.find((thread) => thread.title.endsWith(claimTag(entry.token)));
  return found ? { kind: "found-by-token", thread: found } : { kind: "none" };
}

function observeThread(session: Session, entry: DispatchEntry): ThreadObservation {
  if (!entry.threadId) return findByToken(session, entry);
  const shown = starterFor(session, entry).show(entry.threadId);
  if (shown.ok) return { kind: "thread", thread: shown.value };
  return shown.failure === "unknown-thread" ? { kind: "unknown-thread" } : { kind: "unreachable" };
}

/** A job still `starting` is looked up with `fence`, so "no such job" stays true: a start
 * request still on its way refuses when it arrives. */
function observeJob(session: Session, entry: DispatchEntry): JobObservation {
  const jobs = codexJobs(session.remote, entry.route!);
  return entry.phase === "starting" ? jobs.fence(entry.token) : jobs.show(entry.token);
}

/** The same lookup, read-only, for plan and status. */
function peekJob(session: Session, entry: DispatchEntry): JobObservation {
  return codexJobs(session.remote, entry.route!).show(entry.token);
}

function decide(session: Session, entry: DispatchEntry, readOnly = false): ObserveDecision {
  const item = observeItem(session.deps.root, entry.slug);
  if (entry.executor === "codex-cli") {
    const job = readOnly ? peekJob(session, entry) : observeJob(session, entry);
    if (job.kind === "job") entry.jobLog = job.job.log;
    return decideJobObservation({ entry, item, job });
  }
  return decideObservation({ entry, item, thread: observeThread(session, entry), mode: session.dispatch.t3.mode });
}

function describe(decision: ObserveDecision): string {
  switch (decision.action) {
    case "keep":
      return `keep (${decision.note})`;
    case "adopt":
      return `adopt ${decision.threadId}`;
    case "mode-mismatch":
      return `mode mismatch (thread reports ${decision.found || "no mode"})`;
    case "release":
    case "drop":
    case "park":
      return `${decision.action} (${decision.reason})`;
    case "unreachable":
      return "keep (its worker does not answer)";
    default:
      return decision.action;
  }
}

/** The default log location of a Codex job, for an entry whose launcher never reported one. */
function defaultJobLog(token: string): string {
  return `~/.local/state/dcl/jobs/${token}.log`;
}

function parked(entry: DispatchEntry): ParkedJob {
  if (entry.executor !== "codex-cli") return { kind: "thread", title: entry.title };
  return { kind: "codex-job", token: entry.token, worker: entry.worker!, log: entry.jobLog ?? defaultJobLog(entry.token) };
}

function where(entry: DispatchEntry): string {
  return entry.worker === undefined ? "worker=- (legacy, control host)" : `worker=${entry.worker} executor=${entry.executor}`;
}

function hostProblem(dispatch: DispatchConfig, host: string | undefined): string | null {
  if (!host) return "--host is required";
  if (host !== dispatch.host) return `--host ${host} is not the control host ${dispatch.host} in loops.json`;
  return null;
}

/** Takes the data repo lock shared with sync; false after printing why when it is held. */
function enterRun(deps: RunDeps): boolean {
  if (acquireLock(deps.root).acquired) return true;
  deps.out("ERROR=another sync, tick or pause holds the data repo lock");
  return false;
}

/** Thrown when this run no longer holds the data repo lock: whoever holds it now owns the
 * state and the board writes, so this run stops without acting further. */
class LockLost extends Error {}

const LOCK_LOST = "ERROR=another process took over the data repo lock; this run stopped without writing more";

/** Renews the data repo lock, or throws `LockLost` when this run no longer holds it. */
function holdLock(root: string): void {
  if (!refreshLock(root)) throw new LockLost();
}

/** Checks and renews the data repo lock before every T3 Code call, so a tick never acts
 * on a lock it lost. */
function starterWithHeartbeat(starter: ThreadStarter, root: string): ThreadStarter {
  return {
    start: (request) => (holdLock(root), starter.start(request)),
    list: (project) => (holdLock(root), starter.list(project)),
    show: (threadId) => (holdLock(root), starter.show(threadId)),
    send: (threadId, message) => (holdLock(root), starter.send(threadId, message)),
  };
}

/** The same for every command run on a worker. */
function remoteWithHeartbeat(remote: Remote, root: string): Remote {
  return { run: (route, words, options) => (holdLock(root), remote.run(route, words, options)) };
}

function openSession(deps: RunDeps, config: LoopsConfig, readOnly: boolean): Session | string {
  const dispatch = config.dispatch!;
  const problem = localExecutablesProblem(deps.root, dispatch, deps.home, !deps.starter);
  if (problem) return problem;
  const local = deps.starter ?? t3Starter(expandHome(dispatch.t3.bin, deps.home ?? process.env.HOME ?? ""));
  const remote = guarded(deps.remote ?? remoteRunner(), guardRoots(deps, config));
  // plan and status hold no lock; a tick checks its lock before every call.
  if (readOnly) return { deps, config, dispatch, remote, local };
  return { deps, config, dispatch, remote: remoteWithHeartbeat(remote, deps.root), local: starterWithHeartbeat(local, deps.root) };
}

/** Where no configured executable may resolve on any host: every project repository, and the
 * data repo (as this host has it, and at the same place under a worker's home). */
function guardRoots(deps: RunDeps, config: LoopsConfig): string[] {
  const roots = Object.values(config.projects).flatMap((project) => (project?.repo ? [project.repo] : []));
  const root = canonical(deps.root);
  roots.push(root);
  const home = deps.home ?? process.env.HOME;
  if (home) {
    const inHome = relative(canonical(home), root);
    if (inHome && !inHome.startsWith("..") && !isAbsolute(inHome)) roots.push(`~/${inHome}`);
  }
  return roots;
}

function guarded(remote: Remote, roots: string[]): Remote {
  return { run: (route, words, options) => remote.run(route, words, { ...options, guard: roots }) };
}

function offLine(deps: RunDeps): number {
  deps.out("DISPATCH=off (no dispatch section in loops.json)");
  return 0;
}

function legacyLine(deps: RunDeps, state: DispatchState): void {
  const legacy = state.entries.filter((entry) => entry.worker === undefined).length;
  if (legacy) deps.out(`LEGACY=${legacy} entries on the control host from before workers (observed only; never sent work)`);
}

/** `plan`: what a tick would do, computed from the checkout as it is. Changes nothing on
 * the board, in the state file or on any worker. */
export function runPlan(deps: RunDeps, opts: { host?: string }): number {
  if (!deps.config.dispatch) return offLine(deps);
  const problem = hostProblem(deps.config.dispatch, opts.host);
  if (problem) {
    deps.out(`ERROR=${problem}`);
    return 2;
  }
  const session = openSession(deps, deps.config, true);
  if (typeof session === "string") {
    deps.out(`ERROR=${session}`);
    return 2;
  }
  const stored = readState(deps.statePath);
  const state = stored ?? emptyState();
  const control = readControl(deps.root);
  deps.out(`DISPATCH=${session.dispatch.enabled ? "enabled" : "disabled (enabled: false; tick refuses)"}`);
  deps.out(`COMMIT=${git(deps.root, ["rev-parse", "HEAD"]).out}`);
  deps.out("NOTE=plan reads this checkout as it is and never pulls; a tick pulls first");
  deps.out(`STATE=${stored ? `${state.entries.length} dispatched` : "missing (a tick needs --init)"}`);
  if (control.paused) deps.out(`PAUSED=yes${control.note ? ` (${control.note})` : ""}`);
  legacyLine(deps, state);
  for (const entry of state.entries) deps.out(`OBSERVE ${entry.slug} ${where(entry)} ${describe(decide(session, entry, true))}`);
  const workers = new Workers(session);
  const ctx = buildContext(session, workers, state, control);
  const plan = planDispatch(ctx);
  for (const probed of workers.all()) deps.out(lines(probed, state));
  let starts = 0;
  for (const row of plan.rows) {
    if (row.start) {
      starts++;
      const passed = row.passed?.length ? ` passed=${row.passed.join("; ")}` : "";
      deps.out(`START ${row.item.slug} kind=${row.kind} project=${row.item.project} worker=${row.worker} executor=${row.executor!.type} lane=${row.lane}${passed}`);
    } else deps.out(`SKIP ${row.item.slug} kind=${row.kind} project=${row.item.project} reason=${row.reason}`);
  }
  for (const row of plan.ineligible) deps.out(`INELIGIBLE ${row.item.slug} project=${row.item.project} reason=${row.reason}`);
  for (const bad of ctx.board.unparseable) deps.out(`INELIGIBLE ${bad.path} reason=unparseable: ${bad.reason}`);
  deps.out(`STARTS=${starts}`);
  return 0;
}

type Rows = ReturnType<typeof planDispatch>["rows"];

class Tick {
  private exitCode = 0;
  private stopReason: string | null = null;
  /** Items this tick already tried to claim, so a claim that turns out wrong is not retried. */
  private readonly attempted = new Set<string>();
  readonly workers: Workers;

  constructor(
    public session: Session,
    readonly state: DispatchState,
  ) {
    this.workers = new Workers(session);
  }

  get deps(): RunDeps {
    return this.session.deps;
  }

  get dispatch(): DispatchConfig {
    return this.session.dispatch;
  }

  get code(): number {
    return this.exitCode;
  }

  get stopped(): string | null {
    return this.stopReason;
  }

  /** Ends starting for this tick; `failure` also makes the tick exit 1. */
  stop(reason: string, failure: boolean): void {
    this.stopReason ??= reason;
    if (failure) this.exitCode = 1;
  }

  save(): void {
    holdLock(this.deps.root);
    writeState(this.deps.statePath, this.state);
  }

  today(): string {
    return formatSnapshotDate(this.deps.now());
  }

  /** Reads loops.json again; false when it no longer allows this tick to go on. */
  reload(): boolean {
    let config: LoopsConfig;
    try {
      config = (this.deps.reload ?? (() => loadConfig(this.deps.root)))();
    } catch (error) {
      this.deps.out(`ERROR=loops.json: ${(error as Error).message}`);
      this.stop("configuration unreadable", true);
      return false;
    }
    if (config.dispatchError) {
      this.deps.out(`ERROR=loops.json: ${config.dispatchError}`);
      this.stop("configuration refused", true);
      return false;
    }
    if (!config.dispatch || !config.dispatch.enabled || config.dispatch.host !== this.dispatch.host) {
      this.deps.out("NOTE=the pulled loops.json no longer enables central dispatch on this host; nothing more starts");
      this.stop("disabled", false);
      return false;
    }
    const session = openSession(this.deps, config, false);
    if (typeof session === "string") {
      this.deps.out(`ERROR=${session}`);
      this.stop("configuration refused", true);
      return false;
    }
    this.session = session;
    this.workers.setSession(session);
    return true;
  }

  private writeOptions() {
    return { ignore: IGNORE, beforePush: this.deps.beforePush, heartbeat: () => holdLock(this.deps.root) };
  }

  dropEntry(entry: DispatchEntry): void {
    const index = this.state.entries.findIndex((e) => e.token === entry.token);
    if (index !== -1) this.state.entries.splice(index, 1);
    this.save();
  }

  /** Starts nothing on the entry's worker (or, for a legacy entry, its lane) for a while. */
  coolDown(entry: DispatchEntry): void {
    const key = entry.worker ?? entry.lane;
    this.state.cooldowns[key] = new Date(this.deps.now().getTime() + this.dispatch.retryCooldownMinutes * 60_000).toISOString();
    this.save();
  }

  report(outcome: WriteOutcome, what: string): void {
    if (outcome.status === "error") {
      this.deps.out(`ERROR=${what}: ${outcome.detail}`);
      this.stop("a board write failed", true);
    } else this.deps.out(`WRITE ${what} ${outcome.status}`);
  }

  private boardFiles(path: string, edited: string, read: Reader): Record<string, string> {
    const files: Record<string, string> = { [path]: edited };
    const board = read("BOARD.md");
    if (board !== null) files["BOARD.md"] = replaceActiveRow(board, parseItemFileText(path, edited));
    return files;
  }

  /** Restores each field the claim wrote, where it still holds that value. */
  release(entry: DispatchEntry, reason: string): void {
    const path = itemPath(entry.slug);
    const outcome = boardWrite(
      this.deps.root,
      (read) => {
        const text = read(path);
        if (text === null || activeClaimToken(text) !== entry.token) return null;
        const current = readClaimFields(parseItemFileText(path, text));
        const fields: ClaimFieldValues = {};
        for (const [field, wrote] of Object.entries(entry.wrote) as [keyof ClaimFieldValues, string | null][]) {
          if (current[field] === wrote) fields[field] = entry.replaced[field] ?? null;
        }
        const edited = applyItemEdit(path, text, { fields, log: releaseLog(this.today(), reason, entry.token) }, projectLifecycle(this.session.config, entry.project));
        return { files: this.boardFiles(path, edited, read), message: `Release ${entry.slug} from central dispatch` };
      },
      this.writeOptions(),
    );
    this.report(outcome, `release ${entry.slug}`);
    if (outcome.status === "error" || outcome.status === "rejected") return;
    this.dropEntry(entry);
  }

  park(entry: DispatchEntry, reason: string): void {
    const path = itemPath(entry.slug);
    const previous = entry.replaced.state ?? entry.claimState;
    const outcome = boardWrite(
      this.deps.root,
      (read) => {
        const text = read(path);
        if (text === null || activeClaimToken(text) !== entry.token) return null;
        const item = parseItemFileText(path, text);
        const claimed = entry.claimed;
        const unchanged =
          item.state === entry.claimState &&
          item.nextActor === claimed.nextActor &&
          (item.awaiting ?? null) === (claimed.awaiting ?? null) &&
          item.nextStep === claimed.nextStep;
        if (!unchanged) return null;
        const edited = applyItemEdit(
          path,
          text,
          {
            fields: {
              state: "blocked",
              nextActor: "owner",
              awaiting: "unblock",
              nextStep: parkNextStep(this.session.config.owner, parked(entry), reason, previous),
              updated: this.today(),
            },
            log: parkLog(this.today(), reason, parked(entry), entry.token),
          },
          projectLifecycle(this.session.config, entry.project),
        );
        return { files: this.boardFiles(path, edited, read), message: `Park ${entry.slug} for the owner after central dispatch` };
      },
      this.writeOptions(),
    );
    this.report(outcome, `park ${entry.slug}`);
    if (outcome.status === "error" || outcome.status === "rejected") return;
    this.dropEntry(entry);
    if (outcome.status === "pushed") this.coolDown(entry);
  }

  pauseFor(note: string): void {
    const outcome = writeControl(this.deps.root, (control) => ({ ...control, paused: true, note }), "Pause central dispatch", this.writeOptions());
    this.report(outcome, "pause");
  }

  private workText(entry: DispatchEntry): string {
    return workMessage({ slug: entry.slug, title: entry.title, kind: entry.kind, host: entry.worker ?? this.dispatch.host, lane: entry.lane, token: entry.token });
  }

  /** A worker that stops answering keeps what it holds and gets nothing new in this tick. */
  private unreachable(entry: DispatchEntry, detail: string): void {
    this.deps.out(`UNREACHABLE ${entry.slug} ${where(entry)}: ${detail}`);
    if (entry.worker === undefined) return;
    if (entry.executor === "t3") this.workers.markT3Down(entry.worker);
    else this.workers.markUnreachable(entry.worker);
  }

  /** The configured mode is checked by the caller on a fresh read of the thread. */
  private sendWork(entry: DispatchEntry): void {
    const sent = starterFor(this.session, entry).send(entry.threadId!, this.workText(entry));
    if (sent.ok) {
      entry.phase = "running";
      this.save();
      this.deps.out(`RUNNING ${entry.slug} thread=${entry.threadId}`);
      return;
    }
    this.deps.out(`SEND ${entry.slug} failed: ${sent.detail} (retried next tick)`);
    if (sent.failure === "unreachable") this.unreachable(entry, "T3 Code does not answer");
  }

  private modeMismatch(entry: DispatchEntry, found: string): void {
    const expected = this.dispatch.t3.mode;
    this.deps.out(`MODE ${entry.slug} thread reports "${found}", expected "${expected}": nothing sent`);
    if (entry.phase !== "running") this.release(entry, `the thread reported permission mode "${found || "none"}" instead of "${expected}"`);
    this.pauseFor(`paused by central dispatch: thread "${entry.title}" reported permission mode "${found || "none"}" instead of "${expected}"`);
    this.stop("permission mode mismatch", true);
  }

  private resume(entry: DispatchEntry): void {
    if (entry.executor === "codex-cli") {
      const resumed = codexJobs(this.session.remote, entry.route!).resume(entry.token);
      if (!resumed.ok && !resumed.reached) {
        this.unreachable(entry, resumed.detail);
        return;
      }
      if (resumed.ok) entry.resumes++;
      else entry.sendFailures++;
      this.save();
      this.deps.out(`RESUME ${entry.slug} ${resumed.ok ? "started" : `failed: ${resumed.detail}`}`);
      return;
    }
    const sent = starterFor(this.session, entry).send(entry.threadId!, resumeMessage(entry.slug, entry.token));
    if (!sent.ok && sent.failure === "unreachable") {
      this.unreachable(entry, "T3 Code does not answer");
      return;
    }
    if (sent.ok) entry.resumes++;
    else entry.sendFailures++;
    this.save();
  }

  /** Fetches the clone again before an action on a stopped thread or job (a continue, a
   * resume, a park, or the pause a mode mismatch causes); false when the clone could not be
   * brought up to date, and the entry then waits for the next tick. */
  private refresh(entry: DispatchEntry): boolean {
    const synced = syncCheckout(this.deps.root, IGNORE);
    if (synced.ok && !synced.behind) return true;
    this.deps.out(`OBSERVE ${entry.slug} keep (the clone could not be fetched again before acting: ${synced.ok ? "fast-forward failed" : synced.detail})`);
    return false;
  }

  /** Observes one entry and acts on it. */
  observe(entry: DispatchEntry): void {
    let refreshed = false;
    for (let step = 0; step < 4; step++) {
      const decision = decide(this.session, entry);
      if ((decision.action === "park" || decision.action === "resume" || decision.action === "mode-mismatch") && !refreshed) {
        refreshed = true;
        if (!this.refresh(entry)) return;
        // The fetched configuration decides too: a disable or a pause published meanwhile wins.
        if (!this.reload() || readControl(this.deps.root).paused) return;
        continue;
      }
      this.deps.out(`OBSERVE ${entry.slug} ${describe(decision)}`);
      switch (decision.action) {
        case "keep":
          return;
        case "unreachable":
          this.unreachable(entry, entry.executor === "codex-cli" ? "the worker does not answer" : "T3 Code does not answer");
          return;
        case "adopt":
          if (entry.executor === "codex-cli") entry.phase = "running";
          else {
            entry.threadId = decision.threadId;
            entry.phase = "started";
          }
          this.save();
          continue;
        case "send-work":
          this.sendWork(entry);
          return;
        case "mode-mismatch":
          this.modeMismatch(entry, decision.found);
          return;
        case "release": {
          const attempted = entry.startAttempted;
          this.release(entry, decision.reason);
          if (attempted) this.coolDown(entry);
          return;
        }
        case "drop":
          this.dropEntry(entry);
          return;
        case "resume":
          this.resume(entry);
          return;
        case "park":
          this.park(entry, decision.reason);
          return;
      }
    }
  }

  /** The current plan, from the board as the clone has it now. */
  plan(control: DispatchControl, state: DispatchState = this.state): Rows {
    return planDispatch(buildContext(this.session, this.workers, state, control)).rows;
  }

  /** Claims and starts the first startable candidate. False when nothing more starts. */
  startNext(): boolean {
    if (!this.reload()) return false;
    const control = readControl(this.deps.root);
    if (control.paused) return false;
    const rows = this.plan(control);
    const row = rows.find((r) => r.start && !this.attempted.has(r.item.slug));
    if (!row) return false;
    this.attempted.add(row.item.slug);
    const worker = this.dispatch.workers.find((w) => w.host === row.worker)!;
    const token = (this.deps.token ?? newToken)();
    const entry: DispatchEntry = {
      slug: row.item.slug,
      project: row.item.project,
      kind: row.kind!,
      lane: row.lane!,
      token,
      worker: worker.host,
      executor: row.executor!.type,
      route: routeFor(worker, this.dispatch),
      phase: "starting",
      title: threadTitle(row.item.title, token),
      claimedAt: this.deps.now().toISOString(),
      claimState: row.item.state,
      replaced: {},
      wrote: {},
      claimed: {},
      startAttempted: false,
      resumes: 0,
      sendFailures: 0,
    };
    // Saved before the claim is pushed: from here on the entry holds its worker's slot.
    this.state.entries.push(entry);
    this.save();

    const outcome = boardWrite(this.deps.root, (read) => this.claimWrite(entry, read), this.writeOptions());
    this.report(outcome, `claim ${entry.slug}`);
    if (outcome.status !== "pushed") {
      this.dropEntry(entry);
      if (outcome.status === "rejected") this.stop("claim pushes keep being rejected", false);
      return outcome.status === "nothing" || outcome.status === "dropped";
    }
    this.save();
    // The work goes out only against a clone that has the pushed claim and the configuration
    // fetched with it. Otherwise the entry keeps its slot unstarted, and the next tick
    // releases it as never started.
    const problem = this.startProblem(entry, outcome.behind);
    if (problem) {
      this.deps.out(`START ${entry.slug} held: ${problem} (released next tick)`);
      this.stop(problem, false);
      return false;
    }
    this.start(entry);
    return this.stopReason === null;
  }

  /** Why the claimed entry must not be started now, or null. */
  private startProblem(entry: DispatchEntry, behind: boolean): string | null {
    if (behind) return "the clone could not be fast-forwarded to the pushed claim";
    if (!this.reload()) return "the fetched configuration no longer allows starts";
    if (readControl(this.deps.root).paused) return "central dispatch was paused";
    const item = observeItem(this.deps.root, entry.slug);
    if (item.location !== "items" || activeClaimToken(item.text) !== entry.token) return "the claim is no longer the item's active claim";
    return null;
  }

  /** The claim write, decided on every attempt from configuration and a plan read after
   * that attempt's fetch, so nothing pushed since the tick's own plan is missed. */
  private claimWrite(entry: DispatchEntry, read: Reader): PlannedWrite | null {
    if (!this.reload()) return null;
    const others: DispatchState = { ...this.state, entries: this.state.entries.filter((e) => e.token !== entry.token) };
    const rows = this.plan(readControl(this.deps.root), others);
    const row = rows.find((r) => r.item.slug === entry.slug);
    if (!row?.start || row.worker !== entry.worker || row.kind !== entry.kind || row.lane !== entry.lane) return null;
    const worker = this.dispatch.workers.find((w) => w.host === entry.worker);
    if (!worker || !sameRoute(routeFor(worker, this.dispatch), entry.route!)) return null;

    const path = itemPath(entry.slug);
    const text = read(path);
    if (text === null) return null;
    const item = parseItemFileText(path, text);
    const host = entry.worker!;
    const wrote: ClaimFieldValues = { assignee: entry.lane, executionHost: host, updated: this.today() };
    if (entry.kind === "build") wrote.state = "in-progress";
    // A worktree recorded for another host is not a checkout on this one.
    if (item.execution?.worktree && item.execution.host !== host) wrote.executionWorktree = null;
    const current = readClaimFields(item);
    const replaced: ClaimFieldValues = {};
    for (const field of Object.keys(wrote) as (keyof ClaimFieldValues)[]) replaced[field] = current[field];
    let edited: string;
    try {
      edited = applyItemEdit(path, text, { fields: wrote, log: claimLog(this.today(), host, entry.lane, entry.token) }, projectLifecycle(this.session.config, entry.project));
    } catch (error) {
      this.deps.out(`SKIP ${entry.slug} reason=the claim cannot be written: ${(error as Error).message}`);
      return null;
    }
    const after = parseItemFileText(path, edited);
    entry.replaced = replaced;
    entry.wrote = wrote;
    entry.claimed = readClaimFields(after);
    entry.claimState = after.state;
    if (entry.executor === "codex-cli") entry.cwd = entry.kind === "merge" ? mergeCheckout(after, this.session.config) : repoOf(this.session.config, entry.project)!;
    else entry.threadProject = repoOf(this.session.config, entry.project)!;
    // Saved before the push, so recovery after a crash can still restore what the claim replaced.
    this.save();
    return { files: this.boardFiles(path, edited, read), message: `Dispatch ${entry.slug} to ${host}/${entry.lane}` };
  }

  private start(entry: DispatchEntry): void {
    if (entry.executor === "codex-cli") this.startJob(entry);
    else this.startThread(entry);
  }

  private startJob(entry: DispatchEntry): void {
    const executor = this.dispatch.executors[entry.kind];
    const model = executor.type === "codex-cli" ? executor.model : "";
    const jobs = codexJobs(this.session.remote, entry.route!);
    entry.startAttempted = true;
    this.save();
    const started = jobs.start({ token: entry.token, cwd: entry.cwd!, model, prompt: this.workText(entry) });
    if (started.ok) {
      entry.phase = "running";
      if (started.job.found) entry.jobLog = started.job.log;
      this.save();
      this.deps.out(`STARTED ${entry.slug} worker=${entry.worker} executor=codex-cli job=${entry.token}`);
      return;
    }
    const shown = jobs.fence(entry.token);
    if (shown.kind === "job") {
      entry.phase = "running";
      entry.jobLog = shown.job.log;
      this.save();
      this.deps.out(`STARTED ${entry.slug} worker=${entry.worker} executor=codex-cli job=${entry.token} (found by its token)`);
      return;
    }
    if (shown.kind === "unreachable") {
      this.deps.out(`START ${entry.slug} outcome unknown: ${started.detail} (resolved next tick)`);
      this.workers.markUnreachable(entry.worker!);
      return;
    }
    this.deps.out(`START ${entry.slug} failed: ${started.detail}`);
    this.release(entry, `the job could not be started (${started.detail})`);
    this.coolDown(entry);
  }

  private startThread(entry: DispatchEntry): void {
    const executor = this.dispatch.executors[entry.kind];
    const lane = this.dispatch.lanes.find((l) => l.name === (executor.type === "t3" ? executor.lane : entry.lane))!;
    const starter = starterFor(this.session, entry);
    entry.startAttempted = true;
    this.save();
    const started = starter.start({
      project: threadProject(this.session, entry)!,
      title: entry.title,
      provider: lane.provider,
      model: lane.model,
      message: handshakeMessage(entry.token),
    });
    if (started.ok) {
      entry.threadId = started.value.threadId;
      entry.phase = "started";
      this.save();
      this.deps.out(`STARTED ${entry.slug} worker=${entry.worker} thread=${entry.threadId} lane=${lane.name}`);
    } else {
      const found = findByToken(this.session, entry);
      if (found.kind === "unreachable") {
        this.deps.out(`START ${entry.slug} outcome unknown: ${started.detail} (resolved next tick)`);
        this.workers.markT3Down(entry.worker!);
        return;
      }
      if (found.kind !== "found-by-token") {
        this.deps.out(`START ${entry.slug} failed: ${started.detail}`);
        this.release(entry, `the thread could not be started (${started.detail})`);
        this.coolDown(entry);
        return;
      }
      entry.threadId = found.thread.threadId;
      entry.phase = "started";
      this.save();
      this.deps.out(`STARTED ${entry.slug} worker=${entry.worker} thread=${entry.threadId} lane=${lane.name} (found by its claim tag)`);
    }
    // The mode check and the claim check read the thread and the item afresh.
    this.observe(entry);
  }
}

function writeControl(
  root: string,
  change: (control: DispatchControl) => DispatchControl,
  message: string,
  options: WriteOptions,
): WriteOutcome {
  return boardWrite(
    root,
    (read) => {
      const text = read(CONTROL_FILE);
      const current = text === null ? defaultControl() : (JSON.parse(text) as DispatchControl);
      const next = change({ ...defaultControl(), ...current });
      const nextText = controlText(next);
      if (text === nextText) return null;
      return { files: { [CONTROL_FILE]: nextText }, message };
    },
    options,
  );
}

/** `tick`: observe, clean up, probe, plan, claim and start. */
export function runTick(deps: RunDeps, opts: { host?: string; init?: boolean }): number {
  if (deps.config.dispatchError) {
    const fetched = refetchRefusedConfig(deps);
    if (typeof fetched === "number") return fetched;
    deps = { ...deps, config: fetched };
  }
  const initial = deps.config.dispatch;
  if (!initial) return offLine(deps);
  if (!initial.enabled) {
    deps.out("ERROR=central dispatch is disabled (dispatch.enabled is false); plan and status still work");
    return 2;
  }
  const problem = hostProblem(initial, opts.host);
  if (problem) {
    deps.out(`ERROR=${problem}`);
    return 2;
  }
  if (!enterRun(deps)) return 1;
  try {
    let state = readState(deps.statePath);
    if (!state) {
      if (!opts.init) {
        deps.out(
          `ERROR=no state file at ${deps.statePath}: without it the program cannot count its live jobs. Look in T3 Code on each worker for threads whose title ends with a claim tag such as [d-1a2b3c4d], and in ~/.local/state/dcl/jobs on each worker for Codex jobs, then run tick --init.`,
        );
        return 2;
      }
      state = emptyState();
      writeState(deps.statePath, state);
      deps.out(`STATE=created ${deps.statePath}`);
    }
    const repaired = repairClone(deps.root, IGNORE);
    if (!repaired.ok) {
      deps.out(`ERROR=${repaired.problem}`);
      return 2;
    }
    for (const note of repaired.repaired) deps.out(`REPAIRED ${note}`);
    const synced = syncCheckout(deps.root, IGNORE);
    if (!synced.ok || synced.behind) {
      deps.out(`ERROR=could not bring the clone up to date: ${synced.ok ? "fast-forward failed" : synced.detail}`);
      return 1;
    }

    const session = openSession(deps, deps.config, false);
    if (typeof session === "string") {
      deps.out(`ERROR=${session}`);
      return 2;
    }
    const tick = new Tick(session, state);
    if (!tick.reload()) return tick.code;
    legacyLine(deps, state);
    for (const entry of [...state.entries]) {
      tick.observe(entry);
      if (tick.stopped && tick.code !== 0) break;
    }
    if (!tick.stopped) for (const probed of tick.workers.all()) deps.out(lines(probed, state));
    let started = 0;
    while (!tick.stopped) {
      const before = state.entries.length;
      if (!tick.startNext()) break;
      if (state.entries.length > before) started++;
    }
    if (tick.code === 0) {
      const control = readControl(deps.root);
      if (control.paused) deps.out(`PAUSED=yes${control.note ? ` (${control.note})` : ""}`);
      for (const row of tick.plan(control)) {
        deps.out(`SKIP ${row.item.slug} kind=${row.kind} project=${row.item.project} reason=${row.start ? "not started in this tick" : row.reason}`);
      }
    }
    deps.out(`DISPATCHED=${state.entries.length} STARTED_THIS_TICK=${started}`);
    return tick.code;
  } catch (error) {
    if (!(error instanceof LockLost)) throw error;
    deps.out(LOCK_LOST);
    return 1;
  } finally {
    releaseOwnLock(deps.root);
  }
}

/** A dispatch section the clone has refuses; the dedicated clone is brought up to date under
 * the lock first, so a configuration already fixed upstream is used instead of stalling the
 * program until someone updates the clone by hand. Returns the fresh configuration, or the
 * exit code after printing why it still cannot run. */
function refetchRefusedConfig(deps: RunDeps): LoopsConfig | number {
  if (!enterRun(deps)) return 1;
  try {
    const repaired = repairClone(deps.root, IGNORE);
    if (!repaired.ok) {
      deps.out(`ERROR=${repaired.problem}`);
      return 2;
    }
    const synced = syncCheckout(deps.root, IGNORE);
    if (!synced.ok || synced.behind) {
      deps.out(`ERROR=could not bring the clone up to date: ${synced.ok ? "fast-forward failed" : synced.detail}`);
      return 1;
    }
    let config: LoopsConfig;
    try {
      config = (deps.reload ?? (() => loadConfig(deps.root)))();
    } catch (error) {
      deps.out(`ERROR=loops.json: ${(error as Error).message}`);
      return 2;
    }
    if (config.dispatchError) {
      deps.out(`ERROR=loops.json: ${config.dispatchError}`);
      return 2;
    }
    return config;
  } finally {
    releaseOwnLock(deps.root);
  }
}

/** `status`: dispatched items with worker, executor, thread or job, and item state;
 * cooldowns and pause flags. */
export function runStatus(deps: RunDeps): number {
  if (!deps.config.dispatch) return offLine(deps);
  const session = openSession(deps, deps.config, true);
  if (typeof session === "string") {
    deps.out(`ERROR=${session}`);
    return 2;
  }
  const stored = readState(deps.statePath);
  const control = readControl(deps.root);
  deps.out(`DISPATCH=${session.dispatch.enabled ? "enabled" : "disabled"}`);
  deps.out(`PAUSED=${control.paused ? `yes${control.note ? ` (${control.note})` : ""}` : "no"}`);
  if (control.pausedProjects.length) deps.out(`PAUSED_PROJECTS=${control.pausedProjects.join(",")}`);
  if (!stored) {
    deps.out(`STATE=missing (${deps.statePath})`);
    return 0;
  }
  deps.out(`STATE=${stored.entries.length} dispatched`);
  legacyLine(deps, stored);
  for (const entry of stored.entries) {
    const item = observeItem(deps.root, entry.slug);
    const itemState = item.location === "items" ? item.item.state : "not active";
    let run: string;
    if (entry.executor === "codex-cli") {
      const job = peekJob(session, entry);
      const jobText =
        job.kind === "job"
          ? `${job.job.alive ? "running" : `stopped (exit ${job.job.exitCode ?? "unknown"})`}${job.job.sessionId ? ` session=${job.job.sessionId}` : ""}`
          : job.kind;
      const log = job.kind === "job" ? job.job.log : (entry.jobLog ?? defaultJobLog(entry.token));
      run = `job=${entry.token} job-status=${jobText} job-log=${entry.worker}:${log}`;
    } else {
      const thread = observeThread(session, entry);
      const threadText =
        thread.kind === "thread" || thread.kind === "found-by-token"
          ? `${thread.thread.status}${thread.thread.pendingRequestCount ? " (waiting for the owner)" : ""}`
          : thread.kind;
      run = `thread=${entry.threadId ?? "-"} thread-status=${threadText}`;
    }
    deps.out(`ITEM ${entry.slug} kind=${entry.kind} ${where(entry)} lane=${entry.lane} phase=${entry.phase} ${run} item-state=${itemState} token=${entry.token}`);
  }
  const now = deps.now().getTime();
  for (const [key, until] of Object.entries(stored.cooldowns)) {
    if (Date.parse(until) > now) deps.out(`COOLDOWN ${key} until ${until}`);
  }
  return 0;
}

/** `pause` / `resume`: set or clear a pause in the control file; commits only that file. */
export function runPause(deps: RunDeps, opts: { paused: boolean; project?: string; note?: string }): number {
  if (!deps.config.dispatch) return offLine(deps);
  if (!enterRun(deps)) return 1;
  try {
    const change = (control: DispatchControl): DispatchControl => {
      if (opts.project) {
        const others = control.pausedProjects.filter((p) => p !== opts.project);
        return { ...control, pausedProjects: opts.paused ? [...others, opts.project] : others };
      }
      return { ...control, paused: opts.paused, note: opts.paused ? (opts.note ?? "") : "" };
    };
    const what = `${opts.paused ? "Pause" : "Resume"} central dispatch${opts.project ? ` for ${opts.project}` : ""}`;
    const outcome = writeControl(deps.root, change, what, {
      ignore: IGNORE,
      beforePush: deps.beforePush,
      heartbeat: () => holdLock(deps.root),
    });
    if (outcome.status === "error") {
      deps.out(`ERROR=${outcome.detail}`);
      return 1;
    }
    deps.out(`WRITE ${what.toLowerCase()} ${outcome.status}`);
    if (outcome.status === "pushed" && outcome.behind) deps.out("NOTE=this checkout was not fast-forwarded (local changes or commits); pull it to see the change");
    return outcome.status === "rejected" ? 1 : 0;
  } catch (error) {
    if (!(error instanceof LockLost)) throw error;
    deps.out(LOCK_LOST);
    return 1;
  } finally {
    releaseOwnLock(deps.root);
  }
}
