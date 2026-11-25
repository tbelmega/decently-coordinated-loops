// The commands of central dispatch (plan, tick, status, pause, resume) over a data repo
// checkout. cli-dispatch.ts is the thin entry point; everything with IO lives here, behind
// RunDeps, so the tests drive real git fixtures and a fake `t3` without a process boundary.
//
// Invariants of a tick (the full list: docs/design/central-dispatch-invariants.md):
// - One tick or pause runs at a time: each takes the data repo lock shared with sync
//   (lock.ts: held while its holder lives, taken over only from a gone holder) before the
//   state file is read or created, and holds it until it ends. The state file is written
//   only under it, and a run that finds it lost the lock stops without writing more.
// - Configuration is read again after every fetch, so a pushed disable, pause or lower
//   limit takes effect before the next start.
// - Every work-bearing message (the work message, a continue) is sent only after a fresh
//   read of the thread reports the configured permission mode, and only while the item
//   still carries this claim (dispatch-plan.ts → decideObservation).
// - A claim is decided from a freshly planned board after every rejected push; cleanup
//   writes check ownership on the state they are about to change.
// - A T3 Code answer the program cannot read, or no answer, fails the tick (exit 1) and
//   ends starting for it; the affected entry keeps its claim and its place.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { activeClaimToken, applyItemEdit, readClaimFields, type ClaimFieldValues } from "./claim.ts";
import { loadConfig, projectLifecycle, type LoopsConfig } from "./config.ts";
import type { DispatchConfig } from "./dispatch-config.ts";
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
} from "./dispatch-messages.ts";
import {
  decideObservation,
  planDispatch,
  T3_UNREACHABLE,
  type ItemObservation,
  type ObserveDecision,
  type PlanContext,
  type SlotRoom,
  type ThreadObservation,
} from "./dispatch-plan.ts";
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
import { t3Starter, type ThreadStarter } from "./dispatch-t3.ts";
import { formatSnapshotDate } from "./date.ts";
import { acquireLock, refreshLock, releaseOwnLock } from "./lock.ts";
import { isOpen, parseOutbox } from "./outbox.ts";
import { loadArchiveDir, loadForDeliveryDir, parseItemFileText } from "./parse.ts";
import { buildUniverse } from "./readiness.ts";
import { expandHome } from "./registration.ts";
import { replaceActiveRow } from "./render.ts";
import { readOnlyGitEnv, slotReport } from "./slots.ts";
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
  /** Replaces the `t3` command (tests). */
  starter?: ThreadStarter;
  token?(): string;
  slotRoom?(project: string, lane: string): SlotRoom;
  beforePush?(attempt: number): void;
  home?: string;
}

export function defaultStatePath(root: string): string {
  return statePath(root);
}

function newToken(): string {
  return `d-${randomBytes(4).toString("hex")}`;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Why the configured `t3` executable must not be run, or null. An executable inside the
 * data repo would let anyone who can push to the board choose what the control host runs. */
export function t3BinProblem(root: string, bin: string): string | null {
  if (!bin.includes("/")) return null;
  if (!isAbsolute(bin)) return `dispatch.t3.bin must be a command name or an absolute path, not ${bin}`;
  const inside = relative(canonical(root), canonical(bin));
  if (!inside.startsWith("..") && !isAbsolute(inside)) return "dispatch.t3.bin must not point into the data repo";
  return null;
}

function repoOf(config: LoopsConfig, project: string, home: string | undefined): string | undefined {
  const repo = config.projects[project]?.repo;
  return repo === undefined ? undefined : expandHome(repo, home ?? process.env.HOME ?? "");
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
  starter: ThreadStarter;
  /** Plan only: the slot probe must not write objects into project repositories. */
  readOnly: boolean;
}

function defaultSlotRoom(session: Session, items: ItemFile[], scratch: () => string): (project: string, lane: string) => SlotRoom {
  return (project, lane) => {
    const repo = repoOf(session.config, project, session.deps.home);
    if (!repo || !existsSync(repo)) return { applies: false, idle: 0 };
    const claims = items
      .filter((item) => item.project === project)
      .map((item) => ({ slug: item.slug, state: item.state, host: item.execution?.host, worktree: item.execution?.worktree }));
    const integrationBranch = session.config.projects[project]?.integrationBranch ?? session.config.integrationBranch;
    const env = session.readOnly ? readOnlyGitEnv(repo, scratch()) : undefined;
    const host = session.dispatch.host;
    const report = slotReport({ repo, host, tool: lane, integrationBranch, claims, env });
    const own = new RegExp(`^${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-${lane}-[1-9][0-9]*$`);
    return { applies: report.slots.length > 0, idle: report.slots.filter((slot) => slot.idle && own.test(slot.name)).length };
  };
}

type Context = PlanContext & { board: Board; cleanup(): void };

function buildContext(session: Session, state: DispatchState, control: DispatchControl): Context {
  const { deps } = session;
  const board = loadBoard(deps.root);
  let scratchDir: string | null = null;
  const scratch = () => (scratchDir ??= mkdtempSync(join(tmpdir(), "dcl-dispatch-objects-")));
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
    slotRoom: deps.slotRoom ?? defaultSlotRoom(session, board.items, scratch),
    stoppedAsks: stoppedAsks(deps.root, board.universe),
    t3Project(project) {
      const repo = repoOf(session.config, project, deps.home);
      if (!repo) return "unknown";
      const listed = session.starter.list(repo);
      if (listed.ok) return "known";
      return listed.failure === "unknown-project" ? "unknown" : "unreachable";
    },
    cleanup() {
      if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    },
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

function findByToken(session: Session, entry: DispatchEntry): ThreadObservation {
  const repo = repoOf(session.config, entry.project, session.deps.home);
  if (!repo) return { kind: "none" };
  const listed = session.starter.list(repo);
  if (!listed.ok) return listed.failure === "unknown-project" ? { kind: "none" } : { kind: "unreachable" };
  const found = listed.value.find((thread) => thread.title.endsWith(claimTag(entry.token)));
  return found ? { kind: "found-by-token", thread: found } : { kind: "none" };
}

function observeThread(session: Session, entry: DispatchEntry): ThreadObservation {
  if (!entry.threadId) return findByToken(session, entry);
  const shown = session.starter.show(entry.threadId);
  if (shown.ok) return { kind: "thread", thread: shown.value };
  return shown.failure === "unknown-thread" ? { kind: "unknown-thread" } : { kind: "unreachable" };
}

function describe(decision: ObserveDecision): string {
  switch (decision.action) {
    case "keep":
      return `keep (${decision.note})`;
    case "adopt":
      return `adopt thread ${decision.threadId}`;
    case "mode-mismatch":
      return `mode mismatch (thread reports ${decision.found || "no mode"})`;
    case "release":
    case "drop":
    case "park":
      return `${decision.action} (${decision.reason})`;
    default:
      return decision.action;
  }
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
function withHeartbeat(starter: ThreadStarter, root: string): ThreadStarter {
  return {
    start: (request) => (holdLock(root), starter.start(request)),
    list: (project) => (holdLock(root), starter.list(project)),
    show: (threadId) => (holdLock(root), starter.show(threadId)),
    send: (threadId, message) => (holdLock(root), starter.send(threadId, message)),
  };
}

function openSession(deps: RunDeps, config: LoopsConfig, readOnly: boolean): Session | string {
  const dispatch = config.dispatch!;
  const problem = deps.starter ? null : t3BinProblem(deps.root, dispatch.t3.bin);
  if (problem) return problem;
  const plain = deps.starter ?? t3Starter(dispatch.t3.bin);
  // plan and status hold no lock; a tick checks its lock before every call.
  const starter = readOnly ? plain : withHeartbeat(plain, deps.root);
  return { deps, config, dispatch, starter, readOnly };
}

function offLine(deps: RunDeps): number {
  deps.out("DISPATCH=off (no dispatch section in loops.json)");
  return 0;
}

/** `plan`: what a tick would do, computed from the checkout as it is. Changes nothing. */
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
  let unreachable = false;
  deps.out(`DISPATCH=${session.dispatch.enabled ? "enabled" : "disabled (enabled: false; tick refuses)"}`);
  deps.out(`COMMIT=${git(deps.root, ["rev-parse", "HEAD"]).out}`);
  deps.out("NOTE=plan reads this checkout as it is and never pulls; a tick pulls first");
  deps.out(`STATE=${stored ? `${state.entries.length} dispatched` : "missing (a tick needs --init)"}`);
  if (control.paused) deps.out(`PAUSED=yes${control.note ? ` (${control.note})` : ""}`);
  for (const entry of state.entries) {
    const decision = decideObservation({
      entry,
      item: observeItem(deps.root, entry.slug),
      thread: observeThread(session, entry),
      mode: session.dispatch.t3.mode,
    });
    if (decision.action === "unreachable") unreachable = true;
    deps.out(`OBSERVE ${entry.slug} ${describe(decision)}`);
  }
  const ctx = buildContext(session, state, control);
  try {
    const plan = planDispatch(ctx);
    let starts = 0;
    for (const row of plan.rows) {
      if (row.reason === T3_UNREACHABLE) unreachable = true;
      if (row.start) {
        starts++;
        deps.out(`START ${row.item.slug} kind=${row.kind} project=${row.item.project} lane=${row.lane}`);
      } else deps.out(`SKIP ${row.item.slug} kind=${row.kind} project=${row.item.project} reason=${row.reason}`);
    }
    for (const row of plan.ineligible) deps.out(`INELIGIBLE ${row.item.slug} project=${row.item.project} reason=${row.reason}`);
    for (const bad of ctx.board.unparseable) deps.out(`INELIGIBLE ${bad.path} reason=unparseable: ${bad.reason}`);
    deps.out(`STARTS=${starts}`);
  } finally {
    ctx.cleanup();
  }
  if (unreachable) deps.out("ERROR=T3 Code does not answer");
  return unreachable ? 1 : 0;
}

type Rows = ReturnType<typeof planDispatch>["rows"];

class Tick {
  private exitCode = 0;
  private stopReason: string | null = null;
  /** Items this tick already tried to claim, so a claim that turns out wrong is not retried. */
  private readonly attempted = new Set<string>();

  constructor(
    public session: Session,
    readonly state: DispatchState,
  ) {}

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

  coolDown(lane: string): void {
    this.state.cooldowns[lane] = new Date(this.deps.now().getTime() + this.dispatch.retryCooldownMinutes * 60_000).toISOString();
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
              nextStep: parkNextStep(this.session.config.owner, entry.title, reason, previous),
              updated: this.today(),
            },
            log: parkLog(this.today(), reason, entry.title, entry.token),
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
    if (outcome.status === "pushed") this.coolDown(entry.lane);
  }

  pauseFor(note: string): void {
    const outcome = writeControl(this.deps.root, (control) => ({ ...control, paused: true, note }), "Pause central dispatch", this.writeOptions());
    this.report(outcome, "pause");
  }

  /** The configured mode is checked by the caller on a fresh read of the thread. */
  private sendWork(entry: DispatchEntry): void {
    const sent = this.session.starter.send(
      entry.threadId!,
      workMessage({ slug: entry.slug, title: entry.title, kind: entry.kind, host: this.dispatch.host, lane: entry.lane, token: entry.token }),
    );
    if (sent.ok) {
      entry.phase = "running";
      this.save();
      this.deps.out(`RUNNING ${entry.slug} thread=${entry.threadId}`);
      return;
    }
    this.deps.out(`SEND ${entry.slug} failed: ${sent.detail} (retried next tick)`);
    if (sent.failure === "unreachable") this.stop(T3_UNREACHABLE, true);
  }

  private modeMismatch(entry: DispatchEntry, found: string): void {
    const expected = this.dispatch.t3.mode;
    this.deps.out(`MODE ${entry.slug} thread reports "${found}", expected "${expected}": nothing sent`);
    if (entry.phase !== "running") this.release(entry, `the thread reported permission mode "${found || "none"}" instead of "${expected}"`);
    this.pauseFor(`paused by central dispatch: thread "${entry.title}" reported permission mode "${found || "none"}" instead of "${expected}"`);
    this.stop("permission mode mismatch", true);
  }

  /** Observes one entry and acts on it. */
  observe(entry: DispatchEntry): void {
    for (let step = 0; step < 3; step++) {
      const decision = decideObservation({
        entry,
        item: observeItem(this.deps.root, entry.slug),
        thread: observeThread(this.session, entry),
        mode: this.dispatch.t3.mode,
      });
      this.deps.out(`OBSERVE ${entry.slug} ${describe(decision)}`);
      switch (decision.action) {
        case "keep":
          return;
        case "unreachable":
          this.stop(T3_UNREACHABLE, true);
          return;
        case "adopt":
          entry.threadId = decision.threadId;
          entry.phase = "started";
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
          if (attempted) this.coolDown(entry.lane);
          return;
        }
        case "drop":
          this.dropEntry(entry);
          return;
        case "resume": {
          const sent = this.session.starter.send(entry.threadId!, resumeMessage(entry.slug, entry.token));
          if (sent.ok) entry.resumes++;
          else entry.sendFailures++;
          this.save();
          if (!sent.ok && sent.failure === "unreachable") this.stop(T3_UNREACHABLE, true);
          return;
        }
        case "park":
          this.park(entry, decision.reason);
          return;
      }
    }
  }

  /** The current plan, from the board as the clone has it now. */
  plan(control: DispatchControl, state: DispatchState = this.state): Rows {
    const ctx = buildContext(this.session, state, control);
    try {
      return planDispatch(ctx).rows;
    } finally {
      ctx.cleanup();
    }
  }

  /** Claims and starts the first startable candidate. False when nothing more starts. */
  startNext(): boolean {
    if (!this.reload()) return false;
    const control = readControl(this.deps.root);
    if (control.paused) return false;
    const rows = this.plan(control);
    if (rows.some((r) => r.reason === T3_UNREACHABLE)) {
      this.stop(T3_UNREACHABLE, true);
      return false;
    }
    const row = rows.find((r) => r.start && !this.attempted.has(r.item.slug));
    if (!row) return false;
    this.attempted.add(row.item.slug);
    const token = (this.deps.token ?? newToken)();
    const entry: DispatchEntry = {
      slug: row.item.slug,
      project: row.item.project,
      kind: row.kind!,
      lane: row.lane!,
      token,
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
    this.start(entry);
    return this.stopReason === null;
  }

  /** The claim write, decided on every attempt from configuration and a plan read after
   * that attempt's fetch, so nothing pushed since the tick's own plan is missed. */
  private claimWrite(entry: DispatchEntry, read: Reader): PlannedWrite | null {
    if (!this.reload()) return null;
    const lane = this.dispatch.lanes.find((l) => l.name === entry.lane);
    if (!lane) return null;
    const others: DispatchState = { ...this.state, entries: this.state.entries.filter((e) => e.token !== entry.token) };
    const rows = this.plan(readControl(this.deps.root), others);
    const row = rows.find((r) => r.item.slug === entry.slug);
    if (!row?.start || row.lane !== entry.lane || row.kind !== entry.kind) return null;

    const path = itemPath(entry.slug);
    const text = read(path);
    if (text === null) return null;
    const item = parseItemFileText(path, text);
    const host = this.dispatch.host;
    const wrote: ClaimFieldValues = { assignee: lane.name, executionHost: host, updated: this.today() };
    if (entry.kind === "build") wrote.state = "in-progress";
    // A worktree recorded for another host is not a checkout on this one.
    if (item.execution?.worktree && item.execution.host !== host) wrote.executionWorktree = null;
    const current = readClaimFields(item);
    const replaced: ClaimFieldValues = {};
    for (const field of Object.keys(wrote) as (keyof ClaimFieldValues)[]) replaced[field] = current[field];
    let edited: string;
    try {
      edited = applyItemEdit(path, text, { fields: wrote, log: claimLog(this.today(), host, lane.name, entry.token) }, projectLifecycle(this.session.config, entry.project));
    } catch (error) {
      this.deps.out(`SKIP ${entry.slug} reason=the claim cannot be written: ${(error as Error).message}`);
      return null;
    }
    const after = parseItemFileText(path, edited);
    entry.replaced = replaced;
    entry.wrote = wrote;
    entry.claimed = readClaimFields(after);
    entry.claimState = after.state;
    // Saved before the push, so recovery after a crash can still restore what the claim replaced.
    this.save();
    return { files: this.boardFiles(path, edited, read), message: `Dispatch ${entry.slug} to ${host}/${lane.name}` };
  }

  private start(entry: DispatchEntry): void {
    const lane = this.dispatch.lanes.find((l) => l.name === entry.lane)!;
    const repo = repoOf(this.session.config, entry.project, this.deps.home)!;
    entry.startAttempted = true;
    this.save();
    const started = this.session.starter.start({ project: repo, title: entry.title, provider: lane.provider, model: lane.model, message: handshakeMessage(entry.token) });
    if (started.ok) {
      entry.threadId = started.value.threadId;
      entry.phase = "started";
      this.save();
      this.deps.out(`STARTED ${entry.slug} thread=${entry.threadId} lane=${lane.name}`);
    } else {
      const found = findByToken(this.session, entry);
      if (found.kind === "unreachable") {
        this.deps.out(`START ${entry.slug} outcome unknown: ${started.detail} (resolved next tick)`);
        this.stop(T3_UNREACHABLE, true);
        return;
      }
      if (found.kind !== "found-by-token") {
        this.deps.out(`START ${entry.slug} failed: ${started.detail}`);
        this.release(entry, `the thread could not be started (${started.detail})`);
        this.coolDown(lane.name);
        return;
      }
      entry.threadId = found.thread.threadId;
      entry.phase = "started";
      this.save();
      this.deps.out(`STARTED ${entry.slug} thread=${entry.threadId} lane=${lane.name} (found by its claim tag)`);
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

/** `tick`: observe, clean up, plan, claim and start. */
export function runTick(deps: RunDeps, opts: { host?: string; init?: boolean }): number {
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
          `ERROR=no state file at ${deps.statePath}: without it the program cannot count its live threads. Look in T3 Code for threads whose title ends with a claim tag such as [d-1a2b3c4d], then run tick --init.`,
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
    for (const entry of [...state.entries]) {
      tick.observe(entry);
      if (tick.stopped && tick.code !== 0) break;
    }
    let started = 0;
    while (!tick.stopped) {
      const before = state.entries.length;
      if (!tick.startNext()) break;
      if (state.entries.length > before) started++;
    }
    if (tick.stopped === T3_UNREACHABLE) deps.out("ERROR=T3 Code does not answer; nothing more is started in this tick");
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

/** `status`: dispatched items with thread and item state, cooldowns, pause flags. */
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
  for (const entry of stored.entries) {
    const item = observeItem(deps.root, entry.slug);
    const thread = observeThread(session, entry);
    const threadText =
      thread.kind === "thread" || thread.kind === "found-by-token"
        ? `${thread.thread.status}${thread.thread.pendingRequestCount ? " (waiting for the owner)" : ""}`
        : thread.kind;
    deps.out(
      `ITEM ${entry.slug} kind=${entry.kind} lane=${entry.lane} phase=${entry.phase} thread=${entry.threadId ?? "-"} thread-status=${threadText} item-state=${item.location === "items" ? item.item.state : "not active"} token=${entry.token}`,
    );
  }
  const now = deps.now().getTime();
  for (const [lane, until] of Object.entries(stored.cooldowns)) {
    if (Date.parse(until) > now) deps.out(`COOLDOWN ${lane} until ${until}`);
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
