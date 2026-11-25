// Pure decisions of central dispatch: which items are eligible and in which order, which
// limit stops a start, and what observing a dispatched thread leads to. Everything that
// needs IO (git history, the slot report, T3 Code) comes in through PlanContext callbacks,
// so `plan` and `tick` share one decision path and the tests need no repository.
import { CLAIM_LINE_MARKER } from "./dispatch-messages.ts";
import { activeClaimToken, tokenLogLines } from "./claim.ts";
import type { LoopsConfig } from "./config.ts";
import type { DispatchLane } from "./dispatch-config.ts";
import { classifyStatus, type ThreadInfo } from "./dispatch-t3.ts";
import type { DispatchControl, DispatchEntry, DispatchKind, DispatchState } from "./dispatch-state.ts";
import { resolveReadiness } from "./readiness.ts";
import { OCCUPYING_STATES } from "./slots.ts";
import type { ItemFile } from "./types.ts";

export interface SlotRoom {
  /** False when the project has no permanent slots for this host and lane: no slot check. */
  applies: boolean;
  /** Idle slots before subtracting dispatched items that have not recorded a worktree. */
  idle: number;
}

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
  slotRoom(project: string, lane: string): SlotRoom;
  /** Open stopped asks in the outbox. */
  stoppedAsks: number;
  t3Project(project: string): "known" | "unknown" | "unreachable";
}

/** The skip reason a plan gives while T3 Code does not answer; a tick treats it as a failure. */
export const T3_UNREACHABLE = "T3 Code does not answer";

export type Eligibility = { kind: DispatchKind } | { skip: string };

const KIND_RANK: Record<string, number> = { verify: 0, merge: 1, "build:spec-filed": 2, "build:idea": 3 };

/** Item-level conditions: the kind, or why the item is never started as it is now. */
export function eligibility(item: ItemFile, ctx: PlanContext): Eligibility {
  const dispatch = ctx.config.dispatch!;
  const laneNames = new Set(dispatch.lanes.map((lane) => lane.name));
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
  const recordedHost = item.execution?.host;
  if (kind === "merge" && item.execution?.worktree && recordedHost !== dispatch.host) {
    return { skip: `the recorded checkout is on ${recordedHost ?? "an unnamed host"}, not the control host` };
  }
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
  /** The lane a start would use. */
  lane?: string;
  start: boolean;
  /** Why the item does not start; empty when it starts. */
  reason: string;
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
  project: string;
  lane: string;
  /** True until the dispatched item records a worktree that occupies a slot. */
  pendingSlot: boolean;
}

function laneRoom(lane: DispatchLane, sim: Simulated[], ctx: PlanContext): string | null {
  const used = sim.filter((s) => s.lane === lane.name).length;
  if (used >= lane.maxThreads) return `lane ${lane.name} full (${used} of ${lane.maxThreads})`;
  const until = ctx.state.cooldowns[lane.name];
  if (until && Date.parse(until) > ctx.now.getTime()) return `lane ${lane.name} cooling down until ${until}`;
  return null;
}

function slotProblem(project: string, lane: string, sim: Simulated[], ctx: PlanContext, cache: Map<string, SlotRoom>): string | null {
  const key = `${project}\u0000${lane}`;
  let room = cache.get(key);
  if (!room) {
    room = ctx.slotRoom(project, lane);
    cache.set(key, room);
  }
  if (!room.applies) return null;
  const pending = sim.filter((s) => s.project === project && s.lane === lane && s.pendingSlot).length;
  return room.idle - pending > 0 ? null : `no idle slot for lane ${lane}`;
}

/** The ordered candidates with, for each, whether a tick would start it now. Starts are
 * simulated in order, so a later row sees the limits used by the rows before it. */
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
  const sim: Simulated[] = ctx.state.entries.map((entry) => {
    const current = byslug.get(entry.slug);
    const occupies = current !== undefined && OCCUPYING_STATES.has(current.state) && current.execution?.worktree !== undefined;
    return { project: entry.project, lane: entry.lane, pendingSlot: !occupies };
  });
  const slotCache = new Map<string, SlotRoom>();
  const t3Cache = new Map<string, ReturnType<PlanContext["t3Project"]>>();
  const quietMs = dispatch.quietHours * 3_600_000;

  const rows: PlanRow[] = eligible.map(({ item, kind }) => {
    const skip = (reason: string): PlanRow => ({ item, kind, start: false, reason });
    if (ctx.control.paused) return skip(`central dispatch paused${ctx.control.note ? `: ${ctx.control.note}` : ""}`);
    if (quietMs > 0) {
      const last = ctx.lastCommitAt(item.path);
      if (last && ctx.now.getTime() - last.getTime() < quietMs) return skip(`quiet period (last commit ${last.toISOString()})`);
    }
    if (dispatch.ownerBackpressure !== undefined && kind !== "verify" && ctx.stoppedAsks > dispatch.ownerBackpressure) {
      return skip(`owner backpressure (${ctx.stoppedAsks} open stopped asks > ${dispatch.ownerBackpressure})`);
    }
    if (sim.length >= dispatch.maxThreads) return skip(`global limit (${sim.length} of ${dispatch.maxThreads} dispatched)`);
    const inProject = sim.filter((s) => s.project === item.project).length;
    if (inProject >= dispatch.maxPerProject) return skip(`project limit (${inProject} of ${dispatch.maxPerProject} for ${item.project})`);

    let t3 = t3Cache.get(item.project);
    if (!t3) {
      t3 = ctx.t3Project(item.project);
      t3Cache.set(item.project, t3);
    }
    if (t3 === "unknown") return skip("T3 Code does not know the project");
    if (t3 === "unreachable") return skip(T3_UNREACHABLE);

    const pinned = dispatch.lanes.find((lane) => lane.name === item.assignee);
    const lanes = pinned ? [pinned] : dispatch.lanes;
    let lastSlotProblem: string | null = null;
    let lastRoomProblem: string | null = null;
    for (const lane of lanes) {
      const room = laneRoom(lane, sim, ctx);
      if (room) {
        lastRoomProblem = room;
        continue;
      }
      const slot = slotProblem(item.project, lane.name, sim, ctx, slotCache);
      if (slot) {
        lastSlotProblem = slot;
        continue;
      }
      sim.push({ project: item.project, lane: lane.name, pendingSlot: true });
      return { item, kind, lane: lane.name, start: true, reason: "" };
    }
    if (pinned) return skip(lastSlotProblem ?? lastRoomProblem!);
    return skip(lastSlotProblem ?? "no lane with room");
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

/** What observing one dispatched entry leads to (the observe table). */
export function decideObservation(input: ObserveInput): ObserveDecision {
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
