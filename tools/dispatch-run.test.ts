import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { t3Starter } from "./dispatch-t3.ts";
import { runPause, runPlan, runStatus, runTick, type RunDeps } from "./dispatch-run.ts";
import { processStartTime } from "./lock.ts";
import { readState } from "./dispatch-state.ts";
import { parseItemFileText } from "./parse.ts";
import { renderBoardMd } from "./render.ts";
import { createFakeT3, type FakeT3 } from "./test-fake-t3-harness.ts";
import { gitFixture, sh, type GitFixture } from "./test-git-fixture.ts";
import { TEST_IDENTITIES } from "./test-identities.ts";

const HOST = TEST_IDENTITIES.host;
const { household: HOUSEHOLD, calendar: DAYBOOK } = TEST_IDENTITIES.projects;
const REPOS: Record<string, string> = { [HOUSEHOLD]: "/work/household-app", [DAYBOOK]: "/work/daybook" };
const LATER = 7 * 3_600_000;

function itemText(slug: string, fields: Record<string, string> = {}): string {
  const merged: Record<string, string> = {
    title: `Title of ${slug}`,
    project: HOUSEHOLD,
    state: "merged",
    assignee: `${HOST}-claude-1`,
    autonomy: "auto",
    "next-actor": "agent",
    "next-step": "Agent: verify the merged change.",
    updated: "2026-11-10",
    ...fields,
  };
  const yaml = Object.entries(merged)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\nBody.\n\n## Log\n- 2026-11-10: Merged.\n`;
}

interface Board {
  fx: GitFixture;
  clone: string;
  fake: FakeT3;
  out: string[];
  statePath: string;
  deps(overrides?: Partial<RunDeps>): RunDeps;
  read(path: string): string;
  item(slug: string): ReturnType<typeof parseItemFileText>;
  commits(): string[];
}

function board(items: Record<string, string>, dispatch: Record<string, unknown> = {}, opts: { noDispatch?: boolean } = {}): Board {
  const fake = createFakeT3(Object.values(REPOS));
  const loops = {
    owner: TEST_IDENTITIES.owner,
    priorityProjects: [HOUSEHOLD, DAYBOOK],
    projects: Object.fromEntries(Object.entries(REPOS).map(([name, repo]) => [name, { repo }])),
    ...(opts.noDispatch
      ? {}
      : {
          dispatch: {
            enabled: true,
            host: HOST,
            maxThreads: 3,
            t3: { bin: fake.bin, mode: "auto" },
            lanes: [{ name: "claude", provider: "provider-a", model: "model-a" }],
            ...dispatch,
          },
        }),
  };
  const files: Record<string, string> = {
    "loops.json": `${JSON.stringify(loops, null, 2)}\n`,
    ".gitignore": ".loops-sync.lock\n",
  };
  for (const [slug, text] of Object.entries(items)) files[`items/${slug}.md`] = text;
  const seedDir = mkdtempSync(join(tmpdir(), "dcl-dispatch-seed-"));
  writeFileSync(join(seedDir, "loops.json"), files["loops.json"]!);
  const config = loadConfig(seedDir);
  const parsed = Object.entries(items)
    .filter(([, text]) => text.startsWith("---\n"))
    .map(([slug, text]) => parseItemFileText(`items/${slug}.md`, text));
  files["BOARD.md"] = renderBoardMd(parsed, config);
  const fx = gitFixture(files);
  const clone = fx.clone("dispatch-clone");
  const statePath = join(mkdtempSync(join(tmpdir(), "dcl-dispatch-state-")), "state.json");
  const out: string[] = [];
  let n = 0;
  return {
    fx,
    clone,
    fake,
    out,
    statePath,
    deps: (overrides = {}) => ({
      root: clone,
      config: loadConfig(clone),
      starter: t3Starter(fake.bin, fake.env),
      now: () => new Date(Date.now() + LATER),
      statePath,
      out: (line) => out.push(line),
      token: () => `d-${(++n).toString(16).padStart(8, "0")}`,
      ...overrides,
    }),
    read: (path) => readFileSync(join(clone, path), "utf8"),
    item: (slug) => parseItemFileText(`items/${slug}.md`, readFileSync(join(clone, `items/${slug}.md`), "utf8")),
    commits: () => sh(clone, ["log", "--format=%s"]).split("\n"),
  };
}

function lines(out: string[], prefix: string): string[] {
  return out.filter((line) => line.startsWith(prefix));
}

function callKinds(fake: FakeT3): string[] {
  return fake.read().calls.map((call) => call[1]!);
}

describe("off and disabled", () => {
  test("without a dispatch section every command says it is off and changes nothing", () => {
    const b = board({ a: itemText("a") }, {}, { noDispatch: true });
    const head = sh(b.clone, ["rev-parse", "HEAD"]);
    expect(runPlan(b.deps(), { host: HOST })).toBe(0);
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    expect(runStatus(b.deps())).toBe(0);
    expect(runPause(b.deps(), { paused: true })).toBe(0);
    expect(b.out.every((line) => line.startsWith("DISPATCH=off"))).toBe(true);
    expect(sh(b.clone, ["rev-parse", "HEAD"])).toBe(head);
    expect(existsSync(b.statePath)).toBe(false);
  });

  test("with enabled false, plan works and tick refuses", () => {
    const b = board({ a: itemText("a") }, { enabled: false });
    expect(runPlan(b.deps(), { host: HOST })).toBe(0);
    expect(lines(b.out, "START ")).toEqual([`START a kind=verify project=${HOUSEHOLD} lane=claude`]);
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(2);
    expect(existsSync(b.statePath)).toBe(false);
  });

  test("a wrong host is refused", () => {
    const b = board({ a: itemText("a") });
    expect(runPlan(b.deps(), { host: "workstation-two" })).toBe(2);
    expect(runTick(b.deps(), { host: "workstation-two", init: true })).toBe(2);
  });
});

describe("plan", () => {
  test("prints the commit and the ordered candidates, and changes nothing", () => {
    const b = board({
      a: itemText("a", { updated: "2026-11-05" }),
      b: itemText("b", { state: "implemented" }),
      c: itemText("c", { state: "idea", assignee: "-" }),
      d: itemText("d", { state: "in-progress" }),
      e: itemText("e", { project: DAYBOOK }),
    });
    const head = sh(b.clone, ["rev-parse", "HEAD"]);
    expect(runPlan(b.deps(), { host: HOST })).toBe(0);
    expect(b.out).toContain(`COMMIT=${head}`);
    expect(b.out).toContain("STATE=missing (a tick needs --init)");
    expect(lines(b.out, "START ").concat(lines(b.out, "SKIP "))).toEqual([
      `START a kind=verify project=${HOUSEHOLD} lane=claude`,
      `START b kind=merge project=${HOUSEHOLD} lane=claude`,
      `START e kind=verify project=${DAYBOOK} lane=claude`,
      `SKIP c kind=build project=${HOUSEHOLD} reason=project limit (2 of 2 for ${HOUSEHOLD})`,
    ]);
    expect(lines(b.out, "INELIGIBLE")).toEqual([`INELIGIBLE d project=${HOUSEHOLD} reason=in-progress`]);
    expect(sh(b.clone, ["rev-parse", "HEAD"])).toBe(head);
    expect(sh(b.clone, ["status", "--porcelain"])).toBe("");
    expect(existsSync(b.statePath)).toBe(false);
    expect(new Set(callKinds(b.fake))).toEqual(new Set(["list"]));
  });
});

describe("tick", () => {
  test("needs a state file or --init", () => {
    const b = board({ a: itemText("a") });
    expect(runTick(b.deps(), { host: HOST })).toBe(2);
    expect(b.out.join("\n")).toContain("tick --init");
    expect(b.fake.read().calls).toEqual([]);
  });

  test("refuses a clone with changes it did not make", () => {
    const b = board({ a: itemText("a") });
    writeFileSync(join(b.clone, "items/a.md"), "edited by someone\n");
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(2);
    expect(b.read("items/a.md")).toBe("edited by someone\n");
  });

  test("claims exactly the listed fields, starts with the handshake, checks the mode and sends the work", () => {
    const b = board({ a: itemText("a") });
    const before = b.read("items/a.md");
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);

    const claim = sh(b.clone, ["show", "--name-only", "--format=%s", "HEAD"]).split("\n");
    expect(claim).toEqual([`Dispatch a to ${HOST}/claude`, "", "BOARD.md", "items/a.md"]);
    const after = b.read("items/a.md");
    const added = after.split("\n").filter((line) => !before.split("\n").includes(line));
    expect(added).toEqual([
      "assignee: claude",
      expect.stringMatching(/^updated: \d{4}-\d{2}-\d{2}$/),
      "execution:",
      `  host: ${HOST}`,
      expect.stringContaining(`Claimed by central dispatch for ${HOST}, lane claude (dispatch d-00000001).`),
    ]);
    expect(b.read("BOARD.md")).toContain("| claude |");
    expect(sh(b.fx.clone("check"), ["log", "-1", "--format=%s"])).toBe(`Dispatch a to ${HOST}/claude`);

    const thread = b.fake.read().threads[0]!;
    expect(thread.title).toBe("Title of a [d-00000001]");
    expect(thread.messages[0]!.text).toContain('Reply with the single word "ready"');
    expect(thread.messages[1]!.text).toContain("Claim token: d-00000001");
    expect(readState(b.statePath)!.entries.map((e) => [e.slug, e.phase, e.threadId])).toEqual([["a", "running", "mcp:thread-1"]]);
    expect(sh(b.clone, ["status", "--porcelain"])).toBe("");
  });

  test("a build claim sets in-progress; at most maxThreads and maxPerProject are started", () => {
    const b = board(
      {
        a: itemText("a", { state: "spec-filed", assignee: "-" }),
        b: itemText("b", { project: DAYBOOK }),
        c: itemText("c", { project: DAYBOOK }),
      },
      { maxThreads: 2 },
    );
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    expect(b.fake.read().threads.length).toBe(2);
    expect(b.item("a").state).toBe("in-progress");
    expect(b.item("b").assignee).toBe("claude");
    expect(b.item("c").assignee).toBe(`${HOST}-claude-1`);
    expect(lines(b.out, "SKIP c ")).toEqual([expect.stringContaining("reason=global limit (2 of 2 dispatched)")]);
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    expect(b.fake.read().threads.length).toBe(2);
  });

  test("a mode other than the configured one never receives work: released and paused", () => {
    const b = board({ a: itemText("a") });
    b.fake.update((s) => (s.mode = "full-access"));
    const original = b.item("a");
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(1);
    const thread = b.fake.read().threads[0]!;
    expect(thread.messages.length).toBe(1);
    const item = b.item("a");
    expect([item.assignee, item.execution]).toEqual([original.assignee, original.execution]);
    expect(b.read("items/a.md")).toContain("Released by central dispatch");
    const control = JSON.parse(b.read("dispatch-control.json"));
    expect(control.paused).toBe(true);
    expect(control.note).toContain('"full-access"');
    expect(readState(b.statePath)!.entries).toEqual([]);
  });

  test("a failed start restores the item plus two log lines and cools the lane down", () => {
    const b = board({ a: itemText("a"), b: itemText("b") });
    b.fake.update((s) => (s.failStart = true));
    const original = b.item("a");
    const originalText = b.read("items/a.md");
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    expect(b.item("a")).toEqual(original);
    const added = b.read("items/a.md").split("\n").filter((line) => line.startsWith("- ") && !originalText.includes(line));
    expect(added).toEqual([expect.stringContaining("Claimed by central dispatch"), expect.stringContaining("Released by central dispatch")]);
    expect(b.item("b").assignee).toBe(`${HOST}-claude-1`);
    const state = readState(b.statePath)!;
    expect(state.entries).toEqual([]);
    expect(Object.keys(state.cooldowns)).toEqual(["claude"]);
    expect(lines(b.out, "SKIP ")).toEqual([
      `SKIP a kind=verify project=${HOUSEHOLD} reason=no lane with room`,
      `SKIP b kind=verify project=${HOUSEHOLD} reason=no lane with room`,
    ]);
  });

  test("a start whose confirmation was lost is adopted through its tag and gets no second thread", () => {
    const b = board({ a: itemText("a") });
    b.fake.update((s) => {
      s.loseStartOutput = true;
      s.unreachable = false;
    });
    // The lost output is followed by an unreachable server, so the outcome stays unknown.
    const deps = b.deps();
    const starter = deps.starter!;
    let startCalled = false;
    deps.starter = {
      ...starter,
      start: (request) => ((startCalled = true), starter.start(request)),
      list: (project) => (startCalled ? { ok: false, failure: "unreachable", detail: "down" } : starter.list(project)),
    };
    expect(runTick(deps, { host: HOST, init: true })).toBe(1);
    expect(readState(b.statePath)!.entries.map((e) => e.phase)).toEqual(["starting"]);
    b.fake.update((s) => (s.loseStartOutput = false));
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    const state = b.fake.read();
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0]!.messages).toHaveLength(2);
    expect(readState(b.statePath)!.entries.map((e) => e.phase)).toEqual(["running"]);
  });

  test("with T3 Code unreachable the entry keeps its claim and nothing starts", () => {
    const b = board({ a: itemText("a"), b: itemText("b") }, { maxThreads: 1 });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    b.fake.update((s) => (s.unreachable = true));
    expect(runTick(b.deps(), { host: HOST })).toBe(1);
    expect(readState(b.statePath)!.entries.map((e) => e.slug)).toEqual(["a"]);
    expect(b.item("a").assignee).toBe("claude");
  });

  test("a stopped thread gets one continue, then the item is parked without an outbox entry", () => {
    const b = board({ a: itemText("a") });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    b.fake.update((s) => (s.threads[0]!.status = "completed"));
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    expect(b.fake.read().threads[0]!.messages.at(-1)!.text).toContain("Continue this item from its log");
    expect(readState(b.statePath)!.entries[0]!.resumes).toBe(1);
    b.fake.update((s) => (s.threads[0]!.status = "interrupted"));
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    const item = b.item("a");
    expect([item.state, item.nextActor, item.awaiting]).toEqual(["blocked", "owner", "unblock"]);
    expect(item.nextStep).toContain("Title of a [d-00000001]");
    expect(item.nextStep).toContain("back to merged");
    expect(existsSync(join(b.clone, "OUTBOX.md"))).toBe(false);
    const state = readState(b.statePath)!;
    expect(state.entries).toEqual([]);
    expect(Object.keys(state.cooldowns)).toEqual(["claude"]);
  });

  test("an unknown status is neither resumed nor parked; a failed send does not count as the resume", () => {
    const b = board({ a: itemText("a") });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    b.fake.update((s) => (s.threads[0]!.status = "hibernating"));
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    expect(b.fake.read().threads[0]!.messages).toHaveLength(2);
    expect(b.item("a").state).toBe("merged");
    b.fake.update((s) => {
      s.threads[0]!.status = "completed";
      s.failSend = true;
    });
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    const entry = readState(b.statePath)!.entries[0]!;
    expect([entry.resumes, entry.sendFailures]).toEqual([0, 1]);
    expect(b.item("a").state).toBe("merged");
  });

  test("a thread that ended on purpose is dropped; an unrelated commit is not taken for that", () => {
    const b = board({ a: itemText("a"), b: itemText("b") });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    const session = b.fx.clone("session");
    const text = b.fx.read(session, "items/a.md").replace(/\n$/, "\n- 2026-11-22: Someone wrote an unrelated line.\n");
    b.fx.write(session, "items/a.md", text);
    const textB = b.fx.read(session, "items/b.md").replace(/\n$/, "\n- 2026-11-22: Held: not deployed yet (dispatch d-00000002).\n");
    b.fx.write(session, "items/b.md", textB);
    b.fx.commitAll(session, "Session lines");
    sh(session, ["push", "--quiet"]);
    b.fake.update((s) => s.threads.forEach((t) => (t.status = "completed")));
    // A real clock: the session's commit puts both items inside the quiet period.
    expect(runTick(b.deps({ now: () => new Date() }), { host: HOST })).toBe(0);
    const state = readState(b.statePath)!;
    expect(state.entries.map((e) => [e.slug, e.resumes])).toEqual([["a", 1]]);
    expect(lines(b.out, "SKIP b ")).toEqual([expect.stringContaining("reason=quiet period")]);
  });

  test("cleanup never overwrites an item another claim took over", () => {
    const b = board({ a: itemText("a") });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    const session = b.fx.clone("session");
    const text = b.fx
      .read(session, "items/a.md")
      .replace("assignee: claude", "assignee: codex")
      .replace(/\n$/, "\n- 2026-11-22: Claimed by another program (dispatch d-ffffffff).\n");
    b.fx.write(session, "items/a.md", text);
    b.fx.commitAll(session, "Another claim");
    sh(session, ["push", "--quiet"]);
    b.fake.update((s) => s.threads.forEach((t) => (t.status = "completed")));
    // A real clock: the other claim's commit keeps the item inside the quiet period.
    runTick(b.deps({ now: () => new Date() }), { host: HOST });
    b.fake.update((s) => s.threads.forEach((t) => (t.status = "completed")));
    runTick(b.deps({ now: () => new Date() }), { host: HOST });
    expect(b.item("a").assignee).toBe("codex");
    expect(b.item("a").state).toBe("merged");
    expect(readState(b.statePath)!.entries).toEqual([]);
  });

  test("an item claimed by someone else during a rejected push is not started", () => {
    const b = board({ a: itemText("a") });
    const session = b.fx.clone("session");
    const deps = b.deps({
      beforePush: (attempt) => {
        if (attempt !== 1) return;
        const text = b.fx
          .read(session, "items/a.md")
          .replace('"state": "merged"', "")
          .replace(/state: "merged"/, 'state: "in-progress"')
          .replace(/\n$/, "\n- 2026-11-22: Claimed by a session.\n");
        b.fx.write(session, "items/a.md", text);
        b.fx.commitAll(session, "Session claims a");
        sh(session, ["push", "--quiet"]);
      },
    });
    expect(runTick(deps, { host: HOST, init: true })).toBe(0);
    expect(b.fake.read().threads).toEqual([]);
    expect(b.item("a").state).toBe("in-progress");
    expect(readState(b.statePath)!.entries).toEqual([]);
    expect(sh(b.clone, ["reflog", "--format=%gs"])).not.toMatch(/reset:/);
  });

  test("a first start that cools the lane down stops the second", () => {
    const b = board({ a: itemText("a"), b: itemText("b") });
    b.fake.update((s) => (s.failStart = true));
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    expect(b.fake.read().calls.filter((c) => c[1] === "start")).toHaveLength(1);
  });
});

describe("review fixes", () => {
  test("a pulled disable stops the tick before any start", () => {
    const b = board({ a: itemText("a") });
    const session = b.fx.clone("session");
    const loops = JSON.parse(b.fx.read(session, "loops.json"));
    loops.dispatch.enabled = false;
    b.fx.write(session, "loops.json", JSON.stringify(loops, null, 2));
    b.fx.commitAll(session, "Disable central dispatch");
    sh(session, ["push", "--quiet"]);
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    expect(b.fake.read().threads).toEqual([]);
    expect(b.item("a").assignee).toBe(`${HOST}-claude-1`);
  });

  test("a pause pushed while a claim is being pushed is honored", () => {
    const b = board({ a: itemText("a") });
    const session = b.fx.clone("session");
    const deps = b.deps({
      beforePush: (attempt) => {
        if (attempt !== 1) return;
        b.fx.write(session, "dispatch-control.json", JSON.stringify({ paused: true, pausedProjects: [], note: "stop" }));
        b.fx.commitAll(session, "Pause");
        sh(session, ["push", "--quiet"]);
      },
    });
    expect(runTick(deps, { host: HOST, init: true })).toBe(0);
    expect(b.fake.read().threads).toEqual([]);
    expect(b.item("a").assignee).toBe(`${HOST}-claude-1`);
    expect(readState(b.statePath)!.entries).toEqual([]);
  });

  test("a tick that lost the data repo lock stops before it writes anything more", () => {
    const b = board({ a: itemText("a") });
    const session = b.fx.clone("session");
    const deps = b.deps({
      beforePush: (attempt) => {
        if (attempt !== 1) return;
        // Another writer takes the lock over and pushes, so the claim push is rejected.
        writeFileSync(join(b.clone, ".loops-sync.lock"), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
        b.fx.write(session, "notes.md", "elsewhere\n");
        b.fx.commitAll(session, "Unrelated");
        sh(session, ["push", "--quiet"]);
      },
    });
    expect(runTick(deps, { host: HOST, init: true })).toBe(1);
    expect(b.out).toContain("ERROR=another process took over the data repo lock; this run stopped without writing more");
    expect(sh(b.fx.clone("check"), ["log", "-1", "--format=%s"])).toBe("Unrelated");
    expect(b.fake.read().threads).toEqual([]);
    expect(existsSync(join(b.clone, ".loops-sync.lock"))).toBe(true);
  });

  test("a tick or pause refuses while another live process holds the data repo lock, however old", () => {
    const b = board({ a: itemText("a") });
    const lock = join(b.clone, ".loops-sync.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: "2000-01-01T00:00:00.000Z", pidStart: processStartTime(process.ppid) }));
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(1);
    expect(runPause(b.deps(), { paused: true })).toBe(1);
    expect(lines(b.out, "ERROR=")).toEqual([
      "ERROR=another sync, tick or pause holds the data repo lock",
      "ERROR=another sync, tick or pause holds the data repo lock",
    ]);
    expect(existsSync(b.statePath)).toBe(false);
    expect(b.fake.read().threads).toEqual([]);
    rmSync(lock);
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
  });

  test("the values a claim replaced are on disk before the claim is pushed", () => {
    const b = board({ a: itemText("a") });
    const seen: unknown[] = [];
    const deps = b.deps({ beforePush: () => seen.push(readState(b.statePath)!.entries[0]?.replaced) });
    expect(runTick(deps, { host: HOST, init: true })).toBe(0);
    expect(seen[0]).toEqual({ assignee: `${HOST}-claude-1`, executionHost: null, updated: "2026-11-10" });
  });

  test("a damaged item file is reported and does not stop the others", () => {
    const b = board({ a: itemText("a"), broken: "no frontmatter here\n" });
    expect(runPlan(b.deps(), { host: HOST })).toBe(0);
    expect(lines(b.out, "START ")).toEqual([`START a kind=verify project=${HOUSEHOLD} lane=claude`]);
    expect(lines(b.out, "INELIGIBLE items/broken.md")).toEqual([expect.stringContaining("reason=unparseable")]);
  });

  test("park leaves an item alone whose next step changed since the claim", () => {
    const b = board({ a: itemText("a") });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    b.fake.update((s) => (s.threads[0]!.status = "completed"));
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    const session = b.fx.clone("session");
    b.fx.write(session, "items/a.md", b.fx.read(session, "items/a.md").replace("Agent: verify the merged change.", "Alice: hold this until Monday."));
    b.fx.commitAll(session, "Owner note");
    sh(session, ["push", "--quiet"]);
    b.fake.update((s) => (s.threads[0]!.status = "completed"));
    expect(runTick(b.deps({ now: () => new Date() }), { host: HOST })).toBe(0);
    const item = b.item("a");
    expect([item.state, item.nextStep]).toEqual(["merged", "Alice: hold this until Monday."]);
    expect(readState(b.statePath)!.entries).toEqual([]);
  });

  test("a stopped thread whose mode changed gets no continue; dispatch pauses", () => {
    const b = board({ a: itemText("a") });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    b.fake.update((s) => {
      s.threads[0]!.status = "completed";
      s.threads[0]!.runtimeMode = "full-access";
    });
    expect(runTick(b.deps(), { host: HOST })).toBe(1);
    expect(b.fake.read().threads[0]!.messages).toHaveLength(2);
    expect(JSON.parse(b.read("dispatch-control.json")).paused).toBe(true);
    expect(readState(b.statePath)!.entries.map((e) => e.slug)).toEqual(["a"]);
  });

  test("a start found failed on a later tick still cools the lane down", () => {
    const b = board({ a: itemText("a"), b: itemText("b") });
    b.fake.update((s) => (s.failStart = true));
    const deps = b.deps();
    const starter = deps.starter!;
    let startCalled = false;
    deps.starter = {
      ...starter,
      start: (request) => ((startCalled = true), starter.start(request)),
      list: (project) => (startCalled ? { ok: false, failure: "unreachable", detail: "down" } : starter.list(project)),
    };
    expect(runTick(deps, { host: HOST, init: true })).toBe(1);
    expect(readState(b.statePath)!.entries.map((e) => [e.slug, e.phase, e.startAttempted])).toEqual([["a", "starting", true]]);
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    const state = readState(b.statePath)!;
    expect(state.entries).toEqual([]);
    expect(Object.keys(state.cooldowns)).toEqual(["claude"]);
    expect(b.fake.read().calls.filter((c) => c[1] === "start")).toHaveLength(1);
  });

  test("a t3 executable inside the data repo is refused", () => {
    const b = board({ a: itemText("a") }, {});
    const config = loadConfig(b.clone);
    config.dispatch!.t3.bin = join(b.clone, "t3");
    const deps = b.deps({ config });
    delete deps.starter;
    expect(runPlan(deps, { host: HOST })).toBe(2);
    expect(b.out.join("\n")).toContain("must not point into the data repo");
  });

  test("the slot check counts only the lane's own idle slots and plan writes no objects", () => {
    const fx = gitFixture({ "README.md": "project\n" });
    const project = fx.clone("household-app");
    sh(project, ["branch", `agents/${HOST}-codex-1`]);
    sh(project, ["worktree", "add", "--quiet", join(project, ".worktrees", `${HOST}-codex-1`), `agents/${HOST}-codex-1`]);
    sh(project, ["commit", "--quiet", "--allow-empty", "-m", "Unintegrated"]);
    const b = board({ a: itemText("a") }, { lanes: [{ name: "claude", provider: "p", model: "m" }, { name: "codex", provider: "p", model: "m" }] });
    const config = loadConfig(b.clone);
    config.projects[HOUSEHOLD]!.repo = project;
    b.fake.update((s) => s.projects.push(project));
    const objects = () => sh(project, ["count-objects", "-v"]);
    const before = objects();
    const deps = b.deps({ config });
    delete deps.slotRoom;
    expect(runPlan(deps, { host: HOST })).toBe(0);
    expect(lines(b.out, "START ")).toEqual([`START a kind=verify project=${HOUSEHOLD} lane=codex`]);
    expect(objects()).toBe(before);
  });
});

describe("pause, resume and status", () => {
  test("pause and resume commit only the control file; a paused tick starts nothing", () => {
    const b = board({ a: itemText("a") });
    expect(runPause(b.deps(), { paused: true, note: "travel" })).toBe(0);
    expect(sh(b.clone, ["show", "--name-only", "--format=%s", "HEAD"]).split("\n")).toEqual(["Pause central dispatch", "", "dispatch-control.json"]);
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    expect(b.fake.read().threads).toEqual([]);
    expect(b.out).toContain("PAUSED=yes (travel)");
    expect(runPause(b.deps(), { paused: false })).toBe(0);
    expect(JSON.parse(b.read("dispatch-control.json"))).toEqual({ paused: false, pausedProjects: [], note: "" });
    expect(runPause(b.deps(), { paused: true, project: HOUSEHOLD })).toBe(0);
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    expect(b.fake.read().threads).toEqual([]);
  });

  test("status lists dispatched items with thread and item state", () => {
    const b = board({ a: itemText("a") });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    b.out.length = 0;
    expect(runStatus(b.deps())).toBe(0);
    expect(lines(b.out, "ITEM ")).toEqual([
      "ITEM a kind=verify lane=claude phase=running thread=mcp:thread-1 thread-status=running item-state=merged token=d-00000001",
    ]);
  });
});
