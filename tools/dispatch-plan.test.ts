import { describe, expect, test } from "bun:test";
import type { LoopsConfig } from "./config.ts";
import { validateDispatchConfig } from "./dispatch-config.ts";
import {
  decideJobObservation,
  decideObservation,
  eligibility,
  LEGACY_PARK_REASON,
  planDispatch,
  type JobObserveInput,
  type ObserveInput,
  type PlanContext,
  type WorkerView,
} from "./dispatch-plan.ts";
import { defaultControl, emptyState, type DispatchEntry, type DispatchState } from "./dispatch-state.ts";
import { parseItemFileText } from "./parse.ts";
import { buildUniverse } from "./readiness.ts";
import { TEST_IDENTITIES } from "./test-identities.ts";
import type { ItemFile } from "./types.ts";

const HOST = TEST_IDENTITIES.host;
const { calendar: DAYBOOK, coordination: WORKBOARD, integration: RELAY, household: HOUSEHOLD } = TEST_IDENTITIES.projects;
const NOW = new Date("2026-11-22T12:00:00Z");

function item(slug: string, fields: Record<string, string> = {}, body = "## Log\n- 2026-11-01: Filed.\n"): ItemFile {
  const merged: Record<string, string> = {
    title: `Title of ${slug}`,
    project: HOUSEHOLD,
    state: "merged",
    assignee: "-",
    autonomy: "auto",
    "next-actor": "agent",
    "next-step": "Agent: verify.",
    updated: "2026-11-10",
    ...fields,
  };
  const yaml = Object.entries(merged)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  const text = `---\n${yaml}\n---\n\n${body}`;
  const parsed = parseItemFileText(`items/${slug}.md`, text);
  return Object.assign(parsed, { text });
}

function config(dispatch: Record<string, unknown> = {}, extra: Partial<LoopsConfig> = {}): LoopsConfig {
  return {
    owner: TEST_IDENTITIES.owner,
    priorityProjects: [HOUSEHOLD, DAYBOOK],
    integrationBranch: "master",
    landedAdapter: "git",
    githubTokens: {},
    trackers: {},
    projects: {
      [HOUSEHOLD]: { repo: "/work/household-app" },
      [DAYBOOK]: { repo: "/work/daybook" },
      [WORKBOARD]: { repo: "/work/workboard" },
      [RELAY]: { repo: "/work/relay" },
    },
    review: {},
    dispatch: validateDispatchConfig({
      enabled: true,
      host: HOST,
      excludeProjects: [RELAY],
      lanes: [{ name: "claude", provider: "provider-a", model: "model-a" }],
      workers: [
        { host: "worker-a", ssh: "agent@worker-a", slots: 1 },
        { host: "worker-b", ssh: "agent@worker-b", slots: 2 },
        { host: HOST, slots: 1, kinds: ["merge"] },
      ],
      executors: {
        build: { type: "t3", lane: "claude" },
        verify: { type: "codex-cli", model: "model-c" },
        merge: { type: "codex-cli", model: "model-c" },
      },
      ...dispatch,
    }),
    ...extra,
  };
}

const ALL_REPOS = new Set([HOUSEHOLD, DAYBOOK, WORKBOARD, RELAY]);

function views(cfg: LoopsConfig, change: Record<string, Partial<WorkerView>> = {}): WorkerView[] {
  return cfg.dispatch!.workers.map((worker) => ({
    worker,
    probe: { repos: new Set(ALL_REPOS), launcher: true, codex: true },
    ...change[worker.host],
  }));
}

function context(items: ItemFile[], overrides: Partial<PlanContext> = {}): PlanContext {
  const cfg = overrides.config ?? config();
  return {
    config: cfg,
    workers: views(cfg),
    items,
    universe: buildUniverse(items),
    state: emptyState(),
    control: defaultControl(),
    now: NOW,
    lastCommitAt: () => new Date("2026-11-01T00:00:00Z"),
    slotRoom: () => ({ applies: false, idle: 0 }),
    checkout: () => true,
    stoppedAsks: 0,
    t3Project: () => "known",
    ...overrides,
  };
}

function entry(slug: string, fields: Partial<DispatchEntry> = {}): DispatchEntry {
  return {
    slug,
    project: HOUSEHOLD,
    kind: "verify",
    lane: "claude",
    token: "d-00000001",
    worker: "worker-a",
    executor: "t3",
    phase: "running",
    title: `Title of ${slug} [d-00000001]`,
    threadId: "mcp:thread-1",
    claimedAt: "2026-11-22T10:00:00Z",
    claimState: "merged",
    replaced: { assignee: "-", executionHost: null },
    wrote: { assignee: "claude", executionHost: HOST },
    claimed: { nextActor: "agent", awaiting: null, nextStep: "Agent: verify." },
    startAttempted: true,
    resumes: 0,
    sendFailures: 0,
    ...fields,
  };
}

function summary(plan: ReturnType<typeof planDispatch>) {
  return plan.rows.map((row) => [row.item.slug, row.kind ?? "-", row.worker ?? "-", row.start ? "start" : row.reason]);
}

describe("eligibility", () => {
  test("recognizes the three kinds", () => {
    const ctx = context([]);
    expect(eligibility(item("a"), ctx)).toEqual({ kind: "verify" });
    expect(eligibility(item("b", { state: "implemented", autonomy: "supervised" }), ctx)).toEqual({ kind: "merge" });
    expect(eligibility(item("c", { state: "spec-filed" }), ctx)).toEqual({ kind: "build" });
    expect(eligibility(item("d", { state: "idea", assignee: "codex" }), ctx)).toEqual({ kind: "build" });
  });

  test.each([
    ["in-progress", { state: "in-progress" }, "in-progress"],
    ["blocked", { state: "blocked", "next-actor": "owner", awaiting: "unblock" }, "blocked"],
    ["owner's turn", { "next-actor": "owner", awaiting: "accept" }, "next-actor owner"],
    ["supervised build", { state: "idea", autonomy: "supervised" }, "supervised, not yet implemented"],
    ["build assigned to a non-lane", { state: "idea", assignee: `${HOST}-claude-1` }, "assignee"],
    ["tested", { state: "tested" }, "state tested is not dispatched"],
    ["excluded project", { project: RELAY }, "project excluded"],
    ["unknown project", { project: "nowhere" }, "no repo in loops.json"],
  ])("skips %s", (_name, fields, reason) => {
    const result = eligibility(item("x", fields), context([]));
    expect("skip" in result && result.skip).toContain(reason);
  });

  test("skips frontmatter errors, unsatisfied dependencies, paused projects and items already dispatched", () => {
    const broken = item("broken");
    broken.frontmatterErrors = ["execution must be a mapping"];
    const dep = item("dep", { state: "in-progress" });
    const waiting = item("waiting");
    waiting.dependsOn = ["dep"];
    const ctx = context([broken, dep, waiting], {
      control: { paused: false, pausedProjects: [DAYBOOK], note: "" },
      state: { ...emptyState(), entries: [entry("taken")] },
    });
    const reason = (i: ItemFile) => {
      const r = eligibility(i, ctx);
      return "skip" in r ? r.skip : r.kind;
    };
    expect(reason(broken)).toContain("frontmatter error");
    expect(reason(waiting)).toContain("dependency dep unsatisfied");
    expect(reason(item("p", { project: DAYBOOK }))).toContain("project paused");
    expect(reason(item("taken"))).toContain("already dispatched");
  });
});

describe("planDispatch", () => {
  test("orders by project rank, kind, then least recently updated, and picks the worker with most free slots", () => {
    const items = [
      item("daybook-verify", { project: DAYBOOK }),
      item("household-idea", { state: "idea", updated: "2026-11-01" }),
      item("household-spec", { state: "spec-filed", updated: "2026-11-05" }),
      item("household-verify-new", { updated: "2026-11-12" }),
      item("household-verify-old", { updated: "2026-11-02" }),
      Object.assign(item("household-merge", { state: "implemented" }), { execution: { host: "worker-b" } }),
    ];
    const plan = planDispatch(context(items));
    expect(summary(plan)).toEqual([
      ["household-verify-old", "verify", "worker-b", "start"],
      ["household-verify-new", "verify", "worker-a", "start"],
      ["household-merge", "merge", "worker-b", "start"],
      ["household-spec", "build", "-", `no worker: worker-a: no free slot (1 of 1); worker-b: no free slot (2 of 2); ${HOST}: takes no build`],
      ["household-idea", "build", "-", `no worker: worker-a: no free slot (1 of 1); worker-b: no free slot (2 of 2); ${HOST}: takes no build`],
      ["daybook-verify", "verify", "-", `no worker: worker-a: no free slot (1 of 1); worker-b: no free slot (2 of 2); ${HOST}: takes no verify`],
    ]);
    expect(plan.rows[0]!.executor).toEqual({ type: "codex-cli", model: "model-c" });
    expect(plan.rows[0]!.lane).toBe("codex");
  });

  test("a start lists why the other workers were passed over", () => {
    const cfg = config({ workers: [{ host: "worker-a", ssh: "a@a", slots: 1 }, { host: "worker-b", ssh: "a@b", slots: 1 }] });
    const row = planDispatch(context([item("b", { state: "idea" })], { config: cfg, slotRoom: (w) => ({ applies: true, idle: w === "worker-a" ? 0 : 1 }) })).rows[0]!;
    expect(row).toMatchObject({ start: true, worker: "worker-b", passed: ["worker-a: no idle claude slot"] });
    const three = config({ workers: [{ host: "worker-a", ssh: "a@a", slots: 2 }, { host: "worker-b", ssh: "a@b", slots: 1 }, { host: "worker-c", ssh: "a@c", slots: 1, kinds: ["merge"] }] });
    const first = planDispatch(context([item("v")], { config: three })).rows[0]!;
    expect(first.passed).toEqual(["worker-c: takes no verify", "worker-b: ready, ranked after worker-a (fewer free slots or later in configuration)"]);
    // A worker ranked after the chosen one still reports its own reason when it has one.
    const later = config({ workers: [{ host: "worker-a", ssh: "a@a", slots: 2 }, { host: "worker-b", ssh: "a@b", slots: 1 }] });
    const build = planDispatch(context([item("b", { state: "idea" })], { config: later, slotRoom: (w) => ({ applies: true, idle: w === "worker-a" ? 1 : 0 }) })).rows[0]!;
    expect(build).toMatchObject({ start: true, worker: "worker-a", passed: ["worker-b: no idle claude slot"] });
  });

  test("ties go to the worker listed first; a build uses the T3 lane", () => {
    const cfg = config({
      workers: [
        { host: "worker-a", ssh: "a@a", slots: 1 },
        { host: "worker-b", ssh: "a@b", slots: 1 },
      ],
    });
    const plan = planDispatch(context([item("b", { state: "idea" }), item("v")], { config: cfg }));
    expect(plan.rows.map((row) => [row.item.slug, row.worker, row.executor?.type, row.lane])).toEqual([
      ["v", "worker-a", "codex-cli", "codex"],
      ["b", "worker-b", "t3", "claude"],
    ]);
  });

  test("every entry with a worker holds one of its slots, starting ones included; legacy entries hold none", () => {
    const state: DispatchState = {
      ...emptyState(),
      entries: [
        entry("x", { worker: "worker-b", phase: "starting", threadId: undefined }),
        entry("y", { worker: "worker-b", executor: "codex-cli", lane: "codex" }),
        entry("legacy-1", { worker: undefined, executor: undefined }),
        entry("legacy-2", { worker: undefined, executor: undefined }),
      ],
    };
    expect(summary(planDispatch(context([item("a"), item("b")], { state })))).toEqual([
      ["a", "verify", "worker-a", "start"],
      ["b", "verify", "-", `no worker: worker-a: no free slot (1 of 1); worker-b: no free slot (2 of 2); ${HOST}: takes no verify`],
    ]);
  });

  test("a worker is skipped for each reason, with one reason per worker", () => {
    const one = [item("a")];
    const cfg = config({ workers: [{ host: "worker-a", ssh: "a@a", slots: 1 }] });
    const reason = (overrides: Partial<PlanContext>) => planDispatch(context(one, { config: cfg, ...overrides })).rows[0]!.reason;
    const view = (change: Partial<WorkerView>) => views(cfg, { "worker-a": change });
    expect(reason({})).toBe("");
    expect(reason({ workers: view({ probe: null }) })).toBe("no worker: worker-a: unreachable");
    expect(reason({ workers: view({ probe: { repos: new Set([DAYBOOK]), launcher: true, codex: true } }) })).toBe(`no worker: worker-a: no ${HOUSEHOLD} repo`);
    expect(reason({ workers: view({ probe: { repos: ALL_REPOS, launcher: false, codex: true } }) })).toBe("no worker: worker-a: codex-cli not ready (no job launcher)");
    expect(reason({ workers: view({ probe: { repos: ALL_REPOS, launcher: true, codex: false } }) })).toBe("no worker: worker-a: codex-cli not ready (codex does not answer)");
    const cooling: DispatchState = { ...emptyState(), cooldowns: { "worker-a": "2026-11-22T13:00:00Z" } };
    expect(reason({ state: cooling })).toBe("no worker: worker-a: cooling down until 2026-11-22T13:00:00Z");
    const cooled: DispatchState = { ...emptyState(), cooldowns: { "worker-a": "2026-11-22T11:00:00Z" } };
    expect(reason({ state: cooled })).toBe("");
    expect(reason({ control: { paused: true, pausedProjects: [], note: "travel" } })).toBe("central dispatch paused: travel");
    expect(reason({ lastCommitAt: () => new Date("2026-11-22T08:00:00Z") })).toBe("quiet period (last commit 2026-11-22T08:00:00.000Z)");
  });

  test("a build needs T3 Code on the worker and an idle slot there; T3 down blocks only builds", () => {
    const cfg = config({ workers: [{ host: "worker-a", ssh: "a@a", slots: 2 }] });
    const build = [item("b", { state: "idea" })];
    const row = (overrides: Partial<PlanContext>, items = build) => planDispatch(context(items, { config: cfg, ...overrides })).rows[0]!;
    expect(row({}).start).toBe(true);
    expect(row({ t3Project: () => "unknown" }).reason).toBe(`no worker: worker-a: T3 Code does not know ${HOUSEHOLD}`);
    expect(row({ t3Project: () => "unreachable" }).reason).toBe("no worker: worker-a: t3 not ready");
    expect(row({ slotRoom: () => ({ applies: true, idle: 0 }) }).reason).toBe("no worker: worker-a: no idle claude slot");
    expect(row({ slotRoom: () => ({ applies: true, idle: 0, error: "no answer within 120s" }) }).reason).toBe("no worker: worker-a: slot report failed (no answer within 120s)");
    expect(row({ slotRoom: (_w, _p, tool) => ({ applies: true, idle: tool === "claude" ? 1 : 0 }) }).start).toBe(true);

    // A T3 failure marks the worker for the rest of the plan; a Codex verify still starts there.
    const plan = planDispatch(context([item("v"), item("b", { state: "idea" }), item("c", { state: "idea" })], { config: cfg, t3Project: () => "unreachable" }));
    expect(plan.rows.map((r) => (r.start ? "start" : r.reason))).toEqual(["start", "no worker: worker-a: t3 not ready", "no worker: worker-a: t3 not ready"]);
  });

  test("the slot check subtracts dispatched builds of the same worker, project and tool without a recorded worktree", () => {
    const cfg = config({ workers: [{ host: "worker-a", ssh: "a@a", slots: 3 }] });
    const plan = planDispatch(context([item("a", { state: "idea" }), item("b", { state: "idea" })], { config: cfg, slotRoom: () => ({ applies: true, idle: 1 }) }));
    expect(summary(plan)).toEqual([
      ["a", "build", "worker-a", "start"],
      ["b", "build", "-", "no worker: worker-a: no idle claude slot"],
    ]);
  });

  test("a merge goes only to the worker that holds its recorded checkout", () => {
    const merge = (host: string) => {
      const it = item("m", { state: "implemented" });
      it.execution = { host, worktree: `/work/household-app/.worktrees/${host}-claude-1` };
      return it;
    };
    const row = (it: ItemFile, overrides: Partial<PlanContext> = {}) => planDispatch(context([it], overrides)).rows[0]!;
    expect(row(merge(HOST))).toMatchObject({ start: true, worker: HOST });
    // No recorded worktree: the primary checkout on the recorded host, never another host.
    const primary = item("m", { state: "implemented" });
    primary.execution = { host: "worker-a" };
    expect(row(primary)).toMatchObject({ start: true, worker: "worker-a" });
    const paths: string[] = [];
    row(primary, { checkout: (_w, path) => (paths.push(path), true) });
    expect(paths).toEqual(["/work/household-app"]);
    expect(row(item("m", { state: "implemented" })).reason).toBe("no recorded checkout host (execution.host) to merge on");
    expect(row(merge(HOST), { checkout: () => false }).reason).toBe(
      `no worker: worker-a: not the checkout host (${HOST}); worker-b: not the checkout host (${HOST}); ${HOST}: no checkout at /work/household-app/.worktrees/${HOST}-claude-1`,
    );
    expect(row(merge(HOST), { checkout: () => null }).reason).toBe(`no worker: worker-a: not the checkout host (${HOST}); worker-b: not the checkout host (${HOST}); ${HOST}: checkout check got no answer`);
    expect(row(merge("worker-a"))).toMatchObject({ start: true, worker: "worker-a" });
    expect(row(merge("elsewhere")).reason).toBe("checkout on elsewhere, not a merge worker");
    const verifyOnly = config({ workers: [{ host: "worker-a", ssh: "a@a", slots: 1, kinds: ["verify"] }] });
    expect(row(merge("worker-a"), { config: verifyOnly }).reason).toBe("checkout on worker-a, not a merge worker");
    const full: DispatchState = { ...emptyState(), entries: [entry("x", { worker: HOST, executor: "codex-cli", lane: "codex" })] };
    expect(row(merge(HOST), { state: full }).reason).toBe(`no worker: worker-a: not the checkout host (${HOST}); worker-b: not the checkout host (${HOST}); ${HOST}: no free slot (1 of 1)`);
  });

  test("owner backpressure lets only verify start", () => {
    const items = [item("v"), Object.assign(item("m", { state: "implemented" }), { execution: { host: HOST } }), item("b", { state: "idea" })];
    const ctx = context(items, { config: config({ ownerBackpressure: 2 }), stoppedAsks: 3 });
    expect(summary(planDispatch(ctx)).map((row) => row[3])).toEqual(["start", "owner backpressure (3 open stopped asks > 2)", "owner backpressure (3 open stopped asks > 2)"]);
    expect(summary(planDispatch({ ...ctx, stoppedAsks: 2 })).map((row) => row[3])).toEqual(["start", "start", "start"]);
  });
});

describe("decideObservation", () => {
  const merged = item("a", {}, "## Log\n- 2026-11-22: Claimed by central dispatch for host, lane claude (dispatch d-00000001).\n");
  const base = (overrides: Partial<ObserveInput>): ObserveInput => ({
    entry: entry("a"),
    item: { location: "items", item: merged, text: (merged as ItemFile & { text: string }).text },
    thread: { kind: "thread", thread: { threadId: "mcp:thread-1", title: "t", status: "running", runtimeMode: "auto", pendingRequestCount: 0 } },
    mode: "auto",
    ...overrides,
  });
  const stopped = { kind: "thread" as const, thread: { threadId: "mcp:thread-1", title: "t", status: "completed", runtimeMode: "auto", pendingRequestCount: 0 } };

  test("starting: adopt a thread found by token, release when T3 Code has none, keep when it does not answer", () => {
    const starting = entry("a", { phase: "starting", threadId: undefined });
    expect(decideObservation(base({ entry: starting, thread: { kind: "found-by-token", thread: stopped.thread } }))).toEqual({ action: "adopt", threadId: "mcp:thread-1" });
    expect(decideObservation(base({ entry: starting, thread: { kind: "none" } })).action).toBe("release");
    expect(decideObservation(base({ entry: starting, thread: { kind: "unreachable" } })).action).toBe("unreachable");
  });

  test("started: send the work after the mode check", () => {
    const started = entry("a", { phase: "started" });
    expect(decideObservation(base({ entry: started })).action).toBe("send-work");
    expect(decideObservation(base({ entry: started, mode: "full-access" })).action).toBe("mode-mismatch");
  });

  test("started: a thread that already recorded its finish never gets the work again", () => {
    // The work send succeeded but the phase was not saved; the thread then finished.
    const started = entry("a", { phase: "started" });
    const finished = `${(merged as ItemFile & { text: string }).text}- 2026-11-22: Verified on dev (dispatch d-00000001).\n`;
    const view = { location: "items" as const, item: merged, text: finished };
    expect(decideObservation(base({ entry: started, item: view })).action).toBe("keep");
    expect(decideObservation(base({ entry: started, item: view, thread: stopped }))).toMatchObject({ action: "drop", reason: "the thread ended on purpose" });
  });

  test("running rows of the observe table", () => {
    expect(decideObservation(base({})).action).toBe("keep");
    const unknown = { kind: "thread" as const, thread: { ...stopped.thread, status: "hibernating" } };
    expect(decideObservation(base({ thread: unknown }))).toMatchObject({ action: "keep", note: "unknown status hibernating" });
    const waiting = { kind: "thread" as const, thread: { ...stopped.thread, pendingRequestCount: 1 } };
    expect(decideObservation(base({ thread: waiting }))).toMatchObject({ action: "keep", note: "waiting for the owner" });

    const movedState = item("a", { state: "tested" });
    expect(decideObservation(base({ thread: stopped, item: { location: "items", item: movedState, text: "" } })).action).toBe("drop");
    const ownerTurn = item("a", { "next-actor": "owner", awaiting: "accept" });
    expect(decideObservation(base({ thread: stopped, item: { location: "items", item: ownerTurn, text: "" } })).action).toBe("drop");
    expect(decideObservation(base({ thread: stopped, item: { location: "elsewhere" } })).action).toBe("drop");

    const withLine = `${(merged as ItemFile & { text: string }).text}- 2026-11-22: Held: dev not deployed (dispatch d-00000001).\n`;
    expect(decideObservation(base({ thread: stopped, item: { location: "items", item: merged, text: withLine } })).action).toBe("drop");
    const unrelated = `${(merged as ItemFile & { text: string }).text}- 2026-11-22: Someone else wrote here.\n`;
    expect(decideObservation(base({ thread: stopped, item: { location: "items", item: merged, text: unrelated } })).action).toBe("resume");

    expect(decideObservation(base({ thread: stopped })).action).toBe("resume");
    expect(decideObservation(base({ thread: stopped, entry: entry("a", { resumes: 1 }) })).action).toBe("park");
    expect(decideObservation(base({ thread: stopped, entry: entry("a", { sendFailures: 1 }) })).action).toBe("resume");
    expect(decideObservation(base({ thread: stopped, entry: entry("a", { sendFailures: 2 }) })).action).toBe("park");
    expect(decideObservation(base({ thread: { kind: "unknown-thread" } })).action).toBe("park");
    expect(decideObservation(base({ thread: { kind: "unknown-thread" }, item: { location: "elsewhere" } })).action).toBe("drop");
    expect(decideObservation(base({ thread: { kind: "unreachable" } })).action).toBe("unreachable");
  });

  test("work is sent and continued only under an active claim and the configured mode", () => {
    const newer = item("a", {}, "## Log\n- 2026-11-22: Claimed by central dispatch for host, lane claude (dispatch d-00000001).\n- 2026-11-22: Claimed by central dispatch for host, lane codex (dispatch d-00000002).\n");
    const newerView = { location: "items" as const, item: newer, text: (newer as ItemFile & { text: string }).text };
    expect(decideObservation(base({ entry: entry("a", { phase: "started" }), item: newerView })).action).toBe("release");
    expect(decideObservation(base({ thread: stopped, item: newerView })).action).toBe("drop");
    const otherMode = { kind: "thread" as const, thread: { ...stopped.thread, runtimeMode: "full-access" } };
    expect(decideObservation(base({ thread: otherMode })).action).toBe("mode-mismatch");
  });

  test("an item edited since the claim is left alone instead of parked", () => {
    const edited = item("a", { "next-step": "Alice: decided something else." }, "## Log\n- 2026-11-22: Claimed by central dispatch for host, lane claude (dispatch d-00000001).\n");
    const view = { location: "items" as const, item: edited, text: (edited as ItemFile & { text: string }).text };
    expect(decideObservation(base({ thread: stopped, item: view, entry: entry("a", { resumes: 1 }) }))).toMatchObject({ action: "drop" });
  });
});

describe("legacy entries", () => {
  const claimed = item("a", {}, "## Log\n- 2026-11-22: Claimed by central dispatch for host, lane claude (dispatch d-00000001).\n");
  const view = { location: "items" as const, item: claimed, text: (claimed as ItemFile & { text: string }).text };
  const legacy = (fields: Partial<DispatchEntry> = {}) => entry("a", { worker: undefined, executor: undefined, ...fields });
  const stopped = { kind: "thread" as const, thread: { threadId: "mcp:thread-1", title: "t", status: "completed", runtimeMode: "auto", pendingRequestCount: 0 } };

  test("are observed but parked wherever they would get work or a continue", () => {
    expect(decideObservation({ entry: legacy(), item: view, thread: stopped, mode: "auto" })).toEqual({ action: "park", reason: LEGACY_PARK_REASON });
    expect(decideObservation({ entry: legacy({ phase: "started" }), item: view, thread: stopped, mode: "auto" })).toEqual({ action: "park", reason: LEGACY_PARK_REASON });
    const running = { kind: "thread" as const, thread: { ...stopped.thread, status: "running" } };
    expect(decideObservation({ entry: legacy(), item: view, thread: running, mode: "auto" }).action).toBe("keep");
    expect(decideObservation({ entry: legacy(), item: { location: "elsewhere" }, thread: stopped, mode: "auto" }).action).toBe("drop");
  });
});

describe("decideJobObservation", () => {
  const claimed = item("a", {}, "## Log\n- 2026-11-22: Claimed by central dispatch for worker-a, lane codex (dispatch d-00000001).\n");
  const text = (claimed as ItemFile & { text: string }).text;
  const view = { location: "items" as const, item: claimed, text };
  const job = (fields: Record<string, unknown> = {}): JobObserveInput["job"] => ({
    kind: "job",
    job: {
      found: true,
      version: 1,
      token: "d-00000001",
      cwd: "/work/household-app",
      model: "model-c",
      codex: "codex",
      phase: "exited",
      mode: "start",
      pid: 1,
      pidStart: "x",
      sessionId: "session-1",
      exitCode: 0,
      startedAt: "2026-11-22T10:00:00Z",
      resumes: 0,
      log: "/log",
      alive: false,
      logTail: "",
      ...fields,
    } as Extract<JobObserveInput["job"], { kind: "job" }>["job"],
  });
  const codexEntry = (fields: Partial<DispatchEntry> = {}) => entry("a", { executor: "codex-cli", lane: "codex", threadId: undefined, ...fields });
  const decide = (overrides: Partial<JobObserveInput>) => decideJobObservation({ entry: codexEntry(), item: view, job: job(), ...overrides });

  test("starting: adopt a job its worker knows, release when the start never ran, keep when the worker does not answer", () => {
    const starting = codexEntry({ phase: "starting" });
    expect(decide({ entry: starting })).toEqual({ action: "adopt", threadId: "d-00000001" });
    expect(decide({ entry: starting, job: { kind: "none" } })).toEqual({ action: "release", reason: "the job was never started" });
    expect(decide({ entry: starting, job: { kind: "unreachable", detail: "x" } }).action).toBe("unreachable");
  });

  test("running: a live job is kept, a stopped one resumes once with a session, then parks", () => {
    expect(decide({ job: job({ alive: true, phase: "running" }) })).toEqual({ action: "keep", note: "running" });
    expect(decide({}).action).toBe("resume");
    expect(decide({ entry: codexEntry({ resumes: 1 }) })).toMatchObject({ action: "park", reason: "it stopped again after one continue" });
    // The resume's reply was lost: the controller never counted it, the worker did.
    expect(decide({ job: job({ resumes: 1 }) })).toMatchObject({ action: "park", reason: "it stopped again after one continue" });
    expect(decide({ entry: codexEntry({ sendFailures: 2 }) })).toMatchObject({ action: "park", reason: "two resumes could not be started" });
    expect(decide({ job: { kind: "unreachable", detail: "x" } }).action).toBe("unreachable");
  });

  test("a job that stopped before Codex reported a session parks with the reason from its log", () => {
    expect(decide({ job: job({ sessionId: undefined, exitCode: 1, logTail: "error: not logged in" }) })).toEqual({
      action: "park",
      reason: "the Codex job stopped before it reported a session (error: not logged in)",
    });
    expect(decide({ job: job({ sessionId: undefined, exitCode: 127 }) })).toMatchObject({ reason: "the Codex job stopped before it reported a session (exit 127)" });
  });

  test("a line under the claim token means the job ended on purpose, whatever the process state", () => {
    const finished = { ...view, text: `${text}- 2026-11-22: Verified (dispatch d-00000001).\n` };
    expect(decide({ item: finished })).toEqual({ action: "drop", reason: "the job ended on purpose" });
    expect(decide({ item: finished, job: job({ sessionId: undefined }) })).toEqual({ action: "drop", reason: "the job ended on purpose" });
    expect(decide({ item: finished, job: { kind: "none" } })).toEqual({ action: "drop", reason: "the job ended on purpose" });
    expect(decide({ item: { location: "elsewhere" } })).toMatchObject({ action: "drop" });
  });

  test("a job whose status file is gone is parked unless the item says otherwise", () => {
    expect(decide({ job: { kind: "none" } })).toMatchObject({ action: "park", reason: "the job's status file on its worker is gone" });
  });
});
