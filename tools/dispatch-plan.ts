// Pure decisions of central dispatch: which items are eligible and in which order, which
// worker takes a start (or why none does), and what observing a dispatched thread or job
// leads to. Everything that needs IO (git history, worker probes, slot reports, T3 Code)
// comes in through PlanContext, so `plan` and `tick` share one decision path and the tests
// need no repository.
import { CLAIM_LINE_MARKER } from "./dispatch-messages.ts";
import { activeClaimToken, tokenLogLines } from "./claim.ts";
import type { LoopsConfig } from "./config.ts";
import type { DispatchExecutor, DispatchWorker } from "./dispatch-config.ts";
import { classifyStatus, type ThreadInfo } from "./dispatch-t3.ts";
import type { DispatchControl, DispatchEntry, DispatchKind, DispatchState } from "./dispatch-state.ts";
import type { JobObservation, WorkerProbe } from "./dispatch-workers.ts";
import { resolveReadiness } from "./readiness.ts";
import { OCCUPYING_STATES } from "./slots.ts";
import type { ItemFile } from "./types.ts";

export interface SlotRoom {
  /** False when the project has no permanent slots for this worker and tool: no slot check. */
  applies: boolean;
  /** Idle slots before subtracting dispatched items that have not recorded a worktree. */
  idle: number;
  /** Why the slot report could not be read; the worker then takes no build of the project. */
  error?: string;
}

/** One configured worker as this tick sees it. */
export interface WorkerView {
  worker: DispatchWorker;
  /** Null when the worker did not answer the probe; it gets nothing new in this tick. */
  probe: WorkerProbe | null;
  /** True once T3 Code on the worker failed to answer in this tick. */
  t3Down?: boolean;
}

export type T3Answer = "known" | "unknown" | "unreachable";

export interface PlanContext {
  /** Must carry a `dispatch` section. */
  config: LoopsConfig;
  /** The items in items/. */
  items: ItemFile[];
  /** Every known item, for dependency resolution. */
  universe: Map<string, ItemFile>;
  state: DispatchState;
  control: DispatchControl;
  now: Date;
  /** Time of the newest commit touching the item's file, or null. */
  lastCommitAt(path: string): Date | null;
  /** The configured workers in configuration order. */
  workers: WorkerView[];
  /** Whether T3 Code on the worker knows the project; asked only for T3 starts. */
  t3Project(worker: string, project: string): T3Answer;
  /** The worker's slot report for a project and slot tool; asked only for builds. */
  slotRoom(worker: string, project: string, tool: string): SlotRoom;
  /** Whether a merge's checkout is a Git work tree on the worker (null: no answer). */
  checkout(worker: string, path: string): boolean | null;
  /** Open stopped asks in the outbox. */
  stoppedAsks: number;
}

export type Eligibility = { kind: DispatchKind } | { skip: string };

const KIND_RANK: Record<string, number> = { verify: 0, merge: 1, "build:spec-filed": 2, "build:idea": 3 };

/** The slot tool and claim assignee of an executor: the T3 lane, or "codex". */
export function executorLane(executor: DispatchExecutor): string {
  return executor.type === "t3" ? executor.lane : "codex";
}

/** The directory a merge runs in: the recorded worktree, else the project's primary checkout
 * on the recorded host. */
export function mergeCheckout(item: ItemFile, config: LoopsConfig): string {
  return item.execution?.worktree ?? config.projects[item.project]!.repo!;
}

/** Item-level conditions: the kind, or why the item is never started as it is now. */
export function eligibility(item: ItemFile, ctx: PlanContext): Eligibility {
  const dispatch = ctx.config.dispatch!;
  const laneNames = new Set([...dispatch.lanes.map((lane) => lane.name), "codex"]);
  if (item.frontmatterErrors?.length) return { skip: `frontmatter error: ${item.frontmatterErrors[0]}` };
  if (ctx.state.entries.some((entry) => entry.slug === item.slug)) return { skip: "already dispatched" };
  if (item.state === "in-progress") return { skip: "in-progress" };
  if (item.state === "blocked") return { skip: "blocked" };
  if (item.nextActor !== "agent") return { skip: `next-actor ${item.nextActor || "missing"}` };

  let kind: DispatchKind;
  if (item.state === "merged") kind = "verify";
  else if (item.state === "implemented") kind = "merge";
  else if (item.state === "idea" || item.state === "spec-filed") {
    if (item.autonomy !== "auto") return { skip: "supervised, not yet implemented" };
    if (item.assignee !== "-" && !laneNames.has(item.assignee)) return { skip: `assignee ${item.assignee} is not a lane` };
    kind = "build";
  } else return { skip: `state ${item.state} is not dispatched` };

  if (!ctx.config.projects[item.project]?.repo) return { skip: "project has no repo in loops.json" };
  if (dispatch.excludeProjects.includes(item.project)) return { skip: "project excluded" };
  if (ctx.control.pausedProjects.includes(item.project)) return { skip: "project paused" };
  const readiness = resolveReadiness(item, ctx.universe);
  const open = readiness.deps.find((dep) => dep.status !== "satisfied");
  if (open) return { skip: `dependency ${open.target} ${open.status}` };
  return { kind };
}

export interface PlanRow {
  item: ItemFile;
  kind?: DispatchKind;
  /** The worker a start would use. */
  worker?: string;
  executor?: DispatchExecutor;
  /** The slot tool and assignee a start would use. */
  lane?: string;
  start: boolean;
  /** Why the item does not start; empty when it starts. */
  reason: string;
  /** For a start, why each other worker was passed over. */
  passed?: string[];
}

export interface Plan {
  rows: PlanRow[];
  /** Items with no kind, with their reason, for the `--all` listing. */
  ineligible: PlanRow[];
}

function rank(priorityProjects: string[], project: string): number {
  const index = priorityProjects.indexOf(project);
  return index === -1 ? priorityProjects.length : index;
}

interface Simulated {
  worker: string;
  project: string;
  lane: string;
  /** True until the dispatched item records a worktree that occupies a slot. */
  pendingSlot: boolean;
}

/** Entries that hold a worker slot: every entry with a worker, `starting` ones included.
 * Legacy entries hold none; they are counted separately. */
export function workerEntries(state: DispatchState, host: string): DispatchEntry[] {
  return state.entries.filter((entry) => entry.worker === host);
}

/** Why `view` cannot take this start, or null when it can. Cheap checks only; T3 and slot
 * checks follow for the worker chosen. */
function cheapProblem(view: WorkerView, item: ItemFile, kind: DispatchKind, executor: DispatchExecutor, used: number, ctx: PlanContext): string | null {
  const { worker, probe } = view;
  if (!worker.kinds.includes(kind)) return `takes no ${kind}`;
  if (!probe) return "unreachable";
  const until = ctx.state.cooldowns[worker.host];
  if (until && Date.parse(until) > ctx.now.getTime()) return `cooling down until ${until}`;
  if (used >= worker.slots) return `no free slot (${used} of ${worker.slots})`;
  if (!probe.repos.has(item.project)) return `no ${item.project} repo`;
  if (executor.type === "codex-cli" && !(probe.launcher && probe.codex)) return `codex-cli not ready (${probe.launcher ? "codex does not answer" : "no job launcher"})`;
  if (executor.type === "t3" && view.t3Down) return "t3 not ready";
  return null;
}

/** The ordered candidates with, for each, whether a tick would start it now and where.
 * Starts are simulated in order, so a later row sees the slots used by the rows before it. */
export function planDispatch(ctx: PlanContext): Plan {
  const dispatch = ctx.config.dispatch!;
  const eligible: { item: ItemFile; kind: DispatchKind }[] = [];
  const ineligible: PlanRow[] = [];
  for (const item of ctx.items) {
    const result = eligibility(item, ctx);
    if ("kind" in result) eligible.push({ item, kind: result.kind });
    else ineligible.push({ item, start: false, reason: result.skip });
  }
  const kindKey = (c: { item: ItemFile; kind: DispatchKind }) => (c.kind === "build" ? `build:${c.item.state}` : c.kind);
  eligible.sort(
    (a, b) =>
      rank(ctx.config.priorityProjects, a.item.project) - rank(ctx.config.priorityProjects, b.item.project) ||
      KIND_RANK[kindKey(a)]! - KIND_RANK[kindKey(b)]! ||
      a.item.updated.localeCompare(b.item.updated) ||
      a.item.slug.localeCompare(b.item.slug),
  );

  const byslug = new Map(ctx.items.map((item) => [item.slug, item]));
  const sim: Simulated[] = ctx.state.entries.flatMap((entry) => {
    if (entry.worker === undefined) return [];
    const current = byslug.get(entry.slug);
    const occupies = current !== undefined && OCCUPYING_STATES.has(current.state) && current.execution?.worktree !== undefined;
    return [{ worker: entry.worker, project: entry.project, lane: entry.lane, pendingSlot: !occupies }];
  });
  const t3Cache = new Map<string, T3Answer>();
  const slotCache = new Map<string, SlotRoom>();
  const quietMs = dispatch.quietHours * 3_600_000;

  const t3Answer = (view: WorkerView, project: string): T3Answer => {
    const key = `${view.worker.host}\u0000${project}`;
    let answer = t3Cache.get(key);
    if (!answer) {
      answer = ctx.t3Project(view.worker.host, project);
      t3Cache.set(key, answer);
      if (answer === "unreachable") view.t3Down = true;
    }
    return answer;
  };
  const slotAnswer = (host: string, project: string, tool: string): SlotRoom => {
    const key = `${host}\u0000${project}\u0000${tool}`;
    let room = slotCache.get(key);
    if (!room) {
      room = ctx.slotRoom(host, project, tool);
      slotCache.set(key, room);
    }
    return room;
  };

  const rows: PlanRow[] = eligible.map(({ item, kind }) => {
    const executor = dispatch.executors[kind];
    const lane = executorLane(executor);
    const skip = (reason: string): PlanRow => ({ item, kind, executor, start: false, reason });
    if (ctx.control.paused) return skip(`central dispatch paused${ctx.control.note ? `: ${ctx.control.note}` : ""}`);
    if (quietMs > 0) {
      const last = ctx.lastCommitAt(item.path);
      if (last && ctx.now.getTime() - last.getTime() < quietMs) return skip(`quiet period (last commit ${last.toISOString()})`);
    }
    if (dispatch.ownerBackpressure !== undefined && kind !== "verify" && ctx.stoppedAsks > dispatch.ownerBackpressure) {
      return skip(`owner backpressure (${ctx.stoppedAsks} open stopped asks > ${dispatch.ownerBackpressure})`);
    }

    // A merge runs in the checkout it merges (the recorded worktree, else the project's
    // primary checkout there), so only the host that holds it can take it.
    const checkoutHost = kind === "merge" ? item.execution?.host : undefined;
    if (kind === "merge") {
      if (!checkoutHost) return skip("no recorded checkout host (execution.host) to merge on");
      const holder = ctx.workers.find((view) => view.worker.host === checkoutHost && view.worker.kinds.includes("merge"));
      if (!holder) return skip(`checkout on ${checkoutHost}, not a merge worker`);
    }

    const problems: string[] = [];
    const candidates: { view: WorkerView; free: number; order: number }[] = [];
    ctx.workers.forEach((view, order) => {
      const host = view.worker.host;
      if (checkoutHost !== undefined && host !== checkoutHost) {
        problems.push(`${host}: not the checkout host (${checkoutHost})`);
        return;
      }
      const used = sim.filter((s) => s.worker === host).length;
      const problem = cheapProblem(view, item, kind, executor, used, ctx);
      if (problem) problems.push(`${host}: ${problem}`);
      else candidates.push({ view, free: view.worker.slots - used, order });
    });
    candidates.sort((a, b) => b.free - a.free || a.order - b.order);

    // Every candidate is checked, also after one is chosen, so a start row names each other
    // worker's actual reason, not only its rank.
    const readiness = (view: WorkerView): string | null => {
      const host = view.worker.host;
      if (executor.type === "t3") {
        if (view.t3Down) return "t3 not ready";
        const t3 = t3Answer(view, item.project);
        if (t3 === "unreachable") return "t3 not ready";
        if (t3 === "unknown") return `T3 Code does not know ${item.project}`;
      }
      if (kind === "merge") {
        const path = mergeCheckout(item, ctx.config);
        const found = ctx.checkout(host, path);
        if (found !== true) return found === null ? "checkout check got no answer" : `no checkout at ${path}`;
      }
      if (kind === "build") {
        const room = slotAnswer(host, item.project, lane);
        if (room.error) return `slot report failed (${room.error})`;
        const pending = sim.filter((s) => s.worker === host && s.project === item.project && s.lane === lane && s.pendingSlot).length;
        if (room.applies && room.idle - pending <= 0) return `no idle ${lane} slot`;
      }
      return null;
    };
    let chosen: PlanRow | null = null;
    for (const { view } of candidates) {
      const host = view.worker.host;
      const problem = readiness(view);
      if (problem) problems.push(`${host}: ${problem}`);
      else if (chosen) problems.push(`${host}: ready, ranked after ${chosen.worker} (fewer free slots or later in configuration)`);
      else chosen = { item, kind, executor, worker: host, lane, start: true, reason: "", passed: problems };
    }
    if (chosen) {
      sim.push({ worker: chosen.worker!, project: item.project, lane, pendingSlot: kind === "build" });
      return chosen;
    }
    return skip(problems.length ? `no worker: ${problems.join("; ")}` : "no worker configured");
  });
  return { rows, ineligible };
}

export type ThreadObservation =
  | { kind: "thread"; thread: ThreadInfo }
  /** Phase "starting": a thread of the project whose title carries the claim tag. */
  | { kind: "found-by-token"; thread: ThreadInfo }
  /** Phase "starting": T3 Code answered and no thread carries the tag. */
  | { kind: "none" }
  | { kind: "unknown-thread" }
  | { kind: "unreachable" };

export type ItemObservation = { location: "items"; item: ItemFile; text: string } | { location: "elsewhere" };

export interface ObserveInput {
  entry: DispatchEntry;
  item: ItemObservation;
  thread: ThreadObservation;
  /** The configured permission mode. */
  mode: string;
}

export type ObserveDecision =
  | { action: "keep"; note: string }
  | { action: "adopt"; threadId: string }
  | { action: "send-work" }
  | { action: "mode-mismatch"; found: string }
  | { action: "release"; reason: string }
  | { action: "drop"; reason: string }
  | { action: "resume" }
  | { action: "park"; reason: string }
  | { action: "unreachable" };

/** Why the item is no longer this entry's to act on, or null while the claim is active:
 * still on the active board, in the claimed state, the agent's turn, and with this claim
 * the newest dispatch token on its log. */
function claimEnded(entry: DispatchEntry, item: ItemObservation): string | null {
  if (item.location !== "items") return "item left the active board";
  if (activeClaimToken(item.text) !== entry.token) return "the claim is no longer active on the item";
  if (item.item.state !== entry.claimState) return `item moved to ${item.item.state}`;
  if (item.item.nextActor === "owner") return "item waits for the owner";
  return null;
}

/** True while the fields park would overwrite still hold what the claim left there. */
function unchangedSinceClaim(entry: DispatchEntry, item: ItemObservation): boolean {
  if (item.location !== "items") return false;
  const claimed = entry.claimed;
  return (
    (item.item.awaiting ?? null) === (claimed.awaiting ?? null) &&
    item.item.nextStep === (claimed.nextStep ?? item.item.nextStep) &&
    item.item.nextActor === (claimed.nextActor ?? item.item.nextActor)
  );
}

function endedOnPurpose(entry: DispatchEntry, item: ItemObservation): boolean {
  if (item.location !== "items") return false;
  return tokenLogLines(item.text, entry.token).some((line) => !line.includes(CLAIM_LINE_MARKER));
}

function parkOrDrop(entry: DispatchEntry, item: ItemObservation, reason: string): ObserveDecision {
  if (!unchangedSinceClaim(entry, item)) return { action: "drop", reason: "the item changed since the claim; left as it is" };
  return { action: "park", reason };
}

/** The reason a legacy entry is parked where it would otherwise get work or a continue. */
export const LEGACY_PARK_REASON = "it runs on the control host, where dispatch no longer sends work or a continue";

/** Entries made before workers existed run on the control host, which does no agent work
 * unless a worker entry allows it: they are observed, and parked where they would get more. */
function observeOnly(entry: DispatchEntry, item: ItemObservation, decision: ObserveDecision): ObserveDecision {
  if (entry.worker !== undefined) return decision;
  if (decision.action === "send-work" || decision.action === "resume") return parkOrDrop(entry, item, LEGACY_PARK_REASON);
  return decision;
}

/** What observing one dispatched T3 thread leads to (the observe table). */
export function decideObservation(input: ObserveInput): ObserveDecision {
  return observeOnly(input.entry, input.item, decideThread(input));
}

function decideThread(input: ObserveInput): ObserveDecision {
  const { entry, item, thread, mode } = input;
  // The entry keeps its claim and its place; the tick starts nothing after this answer.
  if (thread.kind === "unreachable") return { action: "unreachable" };

  // A started thread that already wrote a line under its token got its work (the send
  // succeeded but its phase was never saved), so it is observed like a running one and
  // never receives the work a second time.
  const workDelivered = entry.phase === "started" && endedOnPurpose(entry, item);
  if ((entry.phase === "starting" || entry.phase === "started") && !workDelivered) {
    if (entry.phase === "starting" && thread.kind === "found-by-token") return { action: "adopt", threadId: thread.thread.threadId };
    if (thread.kind === "none" || thread.kind === "unknown-thread") return { action: "release", reason: "the thread was never started" };
    const ended = claimEnded(entry, item);
    if (ended) return { action: "release", reason: `${ended} before the thread got its work` };
    if (thread.thread.runtimeMode !== mode) return { action: "mode-mismatch", found: thread.thread.runtimeMode };
    return { action: "send-work" };
  }

  const ended = claimEnded(entry, item);
  if (thread.kind === "unknown-thread" || thread.kind === "none") {
    if (ended) return { action: "drop", reason: ended };
    if (endedOnPurpose(entry, item)) return { action: "drop", reason: "the thread ended on purpose" };
    return parkOrDrop(entry, item, "T3 Code no longer knows the thread");
  }
  if (thread.kind !== "thread") return { action: "keep", note: "unexpected observation" };
  const status = classifyStatus(thread.thread.status);
  if (status === "running") return { action: "keep", note: "running" };
  if (status === "unknown") return { action: "keep", note: `unknown status ${thread.thread.status}` };
  if (thread.thread.pendingRequestCount > 0) return { action: "keep", note: "waiting for the owner" };
  if (ended) return { action: "drop", reason: ended };
  if (endedOnPurpose(entry, item)) return { action: "drop", reason: "the thread ended on purpose" };
  if (entry.resumes >= 1 || entry.sendFailures >= 2) {
    return parkOrDrop(entry, item, entry.resumes >= 1 ? "it stopped again after one continue" : "two continue messages could not be sent");
  }
  if (thread.thread.runtimeMode !== mode) return { action: "mode-mismatch", found: thread.thread.runtimeMode };
  return { action: "resume" };
}

export interface JobObserveInput {
  entry: DispatchEntry;
  item: ItemObservation;
  job: JobObservation;
}

/** What observing one dispatched Codex job leads to: the observe table, with the launcher's
 * status file in place of the thread. Alive is running; exited or a dead supervisor is
 * stopped. A stopped job resumes once, and only with a session id to resume. */
export function decideJobObservation(input: JobObserveInput): ObserveDecision {
  const { entry, item, job } = input;
  if (job.kind === "unreachable") return { action: "unreachable" };
  if (entry.phase === "starting") {
    if (job.kind === "job") return { action: "adopt", threadId: entry.token };
    return { action: "release", reason: "the job was never started" };
  }
  const ended = claimEnded(entry, item);
  if (job.kind === "none") {
    if (ended) return { action: "drop", reason: ended };
    if (endedOnPurpose(entry, item)) return { action: "drop", reason: "the job ended on purpose" };
    return parkOrDrop(entry, item, "the job's status file on its worker is gone");
  }
  if (job.job.alive) return { action: "keep", note: "running" };
  if (ended) return { action: "drop", reason: ended };
  if (endedOnPurpose(entry, item)) return { action: "drop", reason: "the job ended on purpose" };
  if (!job.job.sessionId) {
    const why = job.job.logTail || `exit ${job.job.exitCode ?? "unknown"}`;
    return parkOrDrop(entry, item, `the Codex job stopped before it reported a session (${why})`);
  }
  // The worker counts resumes too: a resume whose reply was lost still used the one allowed.
  const resumes = Math.max(entry.resumes, job.job.resumes);
  if (resumes >= 1 || entry.sendFailures >= 2) {
    return parkOrDrop(entry, item, resumes >= 1 ? "it stopped again after one continue" : "two resumes could not be started");
  }
  return { action: "resume" };
}
