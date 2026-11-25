import { describe, expect, test } from "bun:test";
import type { LoopsConfig } from "./config.ts";
import { validateDispatchConfig } from "./dispatch-config.ts";
import {
  decideObservation,
  eligibility,
  planDispatch,
  type ObserveInput,
  type PlanContext,
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
      maxThreads: 3,
      excludeProjects: [RELAY],
      lanes: [
        { name: "claude", provider: "provider-a", model: "model-a", maxThreads: 2 },
        { name: "codex", provider: "provider-b", model: "model-b", maxThreads: 2 },
      ],
      ...dispatch,
    }),
    ...extra,
  };
}

function context(items: ItemFile[], overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    config: config(),
    items,
    universe: buildUniverse(items),
    state: emptyState(),
    control: defaultControl(),
    now: NOW,
    lastCommitAt: () => new Date("2026-11-01T00:00:00Z"),
    slotRoom: () => ({ applies: false, idle: 0 }),
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
  return plan.rows.map((row) => [row.item.slug, row.kind ?? "-", row.lane ?? "-", row.start ? "start" : row.reason]);
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
  test("orders by project rank, kind, then least recently updated, and assigns lanes", () => {
    const items = [
      item("daybook-verify", { project: DAYBOOK }),
      item("household-idea", { state: "idea", updated: "2026-11-01" }),
      item("household-spec", { state: "spec-filed", updated: "2026-11-05" }),
      item("household-verify-new", { updated: "2026-11-12" }),
      item("household-verify-old", { updated: "2026-11-02" }),
      item("household-merge", { state: "implemented", assignee: "codex" }),
    ];
    const plan = planDispatch(context(items, { config: config({ maxThreads: 10, maxPerProject: 10 }) }));
    expect(summary(plan)).toEqual([
      ["household-verify-old", "verify", "claude", "start"],
      ["household-verify-new", "verify", "claude", "start"],
      ["household-merge", "merge", "codex", "start"],
      ["household-spec", "build", "codex", "start"],
      ["household-idea", "build", "-", "no lane with room"],
      ["daybook-verify", "verify", "-", "no lane with room"],
    ]);
  });

  test("each limit alone stops a start", () => {
    const one = [item("a")];
    const starts = (overrides: Partial<PlanContext>) => planDispatch(context(one, overrides)).rows[0]!;
    expect(starts({}).start).toBe(true);

    const full: DispatchState = {
      ...emptyState(),
      entries: [entry("x", { project: DAYBOOK, lane: "codex" }), entry("y", { project: DAYBOOK, lane: "codex" }), entry("z", { project: WORKBOARD, lane: "claude" })],
    };
    expect(starts({ state: full }).reason).toBe("global limit (3 of 3 dispatched)");

    const project: DispatchState = { ...emptyState(), entries: [entry("x", { lane: "codex" }), entry("y", { lane: "codex" })] };
    expect(starts({ state: project }).reason).toBe(`project limit (2 of 2 for ${HOUSEHOLD})`);

    const lanes: DispatchState = {
      ...emptyState(),
      entries: [entry("x", { project: DAYBOOK }), entry("y", { project: WORKBOARD })],
      cooldowns: { codex: "2026-11-22T13:00:00Z" },
    };
    expect(starts({ state: lanes }).reason).toBe("no lane with room");

    const cooling: DispatchState = { ...emptyState(), cooldowns: { claude: "2026-11-22T13:00:00Z", codex: "2026-11-22T13:00:00Z" } };
    expect(starts({ state: cooling }).reason).toBe("no lane with room");
    const cooled: DispatchState = { ...emptyState(), cooldowns: { claude: "2026-11-22T11:00:00Z" } };
    expect(starts({ state: cooled }).start).toBe(true);

    const pinned = planDispatch(context([item("a", { assignee: "codex" })], { state: cooling })).rows[0]!;
    expect(pinned.reason).toBe("lane codex cooling down until 2026-11-22T13:00:00Z");

    expect(starts({ slotRoom: () => ({ applies: true, idle: 0 }) }).reason).toBe("no idle slot for lane codex");
    expect(starts({ slotRoom: (_p, lane) => ({ applies: true, idle: lane === "codex" ? 1 : 0 }) }).lane).toBe("codex");
    expect(starts({ slotRoom: () => ({ applies: false, idle: 0 }) }).start).toBe(true);

    expect(starts({ control: { paused: true, pausedProjects: [], note: "travel" } }).reason).toBe("central dispatch paused: travel");
    expect(starts({ lastCommitAt: () => new Date("2026-11-22T08:00:00Z") }).reason).toBe("quiet period (last commit 2026-11-22T08:00:00.000Z)");
    expect(starts({ t3Project: () => "unknown" }).reason).toBe("T3 Code does not know the project");
  });

  test("the slot check subtracts dispatched items of the same project and lane without a recorded worktree", () => {
    const items = [item("a"), item("b")];
    const plan = planDispatch(
      context(items, {
        config: config({ lanes: [{ name: "claude", provider: "p", model: "m" }] }),
        slotRoom: () => ({ applies: true, idle: 1 }),
      }),
    );
    expect(summary(plan)).toEqual([
      ["a", "verify", "claude", "start"],
      ["b", "verify", "-", "no idle slot for lane claude"],
    ]);
  });

  test("owner backpressure lets only verify start", () => {
    const items = [item("v"), item("m", { state: "implemented" }), item("b", { state: "idea" })];
    const ctx = context(items, { config: config({ ownerBackpressure: 2, maxPerProject: 5 }), stoppedAsks: 3 });
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
