import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { t3Starter } from "./dispatch-t3.ts";
import { runPause, runPlan, runStatus, runTick, type RunDeps } from "./dispatch-run.ts";
import { remoteRunner, type Remote } from "./dispatch-remote.ts";
import { processStartTime } from "./lock.ts";
import { readState } from "./dispatch-state.ts";
import { parseItemFileText } from "./parse.ts";
import { renderBoardMd } from "./render.ts";
import { createFakeT3, type FakeT3 } from "./test-fake-t3-harness.ts";
import { gitFixture, sh, type GitFixture } from "./test-git-fixture.ts";
import { TEST_IDENTITIES } from "./test-identities.ts";

const HOST = TEST_IDENTITIES.host;
const { household: HOUSEHOLD, calendar: DAYBOOK } = TEST_IDENTITIES.projects;
const LATER = 7 * 3_600_000;
const DCL_ROOT = join(import.meta.dir, "..");
const ALL_T3 = { build: { type: "t3", lane: "claude" }, verify: { type: "t3", lane: "claude" }, merge: { type: "t3", lane: "claude" } };
const CODEX_CHECKS = { build: { type: "t3", lane: "claude" }, verify: { type: "codex-cli", model: "model-c" }, merge: { type: "codex-cli", model: "model-c" } };

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

/** Processes that tests leave running (held fake Codex jobs) are released after each test. */
const holds: string[] = [];
afterEach(() => {
  for (const hold of holds.splice(0)) rmSync(hold, { force: true });
  Bun.sleepSync(150);
});

interface Worker {
  /** The worker's home under the fake ssh. */
  home: string;
  dir: string;
  control(change: { down?: boolean; dropReplyMatching?: string }): void;
  commands(): string[];
  codex(config: Record<string, unknown>): void;
  codexCalls(): { args: string[]; cwd: string; stdin: string }[];
  release(): void;
}

interface Board {
  fx: GitFixture;
  clone: string;
  fake: FakeT3;
  out: string[];
  statePath: string;
  /** The control host's home, where its own (local) jobs run. */
  localHome: string;
  workers: Record<string, Worker>;
  repos: Record<string, string>;
  deps(overrides?: Partial<RunDeps>): RunDeps;
  read(path: string): string;
  item(slug: string): ReturnType<typeof parseItemFileText>;
  commits(): string[];
  push(change: (session: string) => void, message: string): void;
}

interface BoardOptions {
  noDispatch?: boolean;
  /** Remote workers reached over the fake ssh; default: none, and the control host is the only worker. */
  remote?: string[];
  /** Slots of each worker. */
  slots?: number;
  executors?: Record<string, unknown>;
  /** Extra fields for each worker entry. */
  worker?: Record<string, unknown>;
}

function makeCodex(dir: string): string {
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/bin/sh\nexec bun "${join(import.meta.dir, "test-fake-codex.ts")}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function makeSsh(dir: string): string {
  const bin = join(dir, "ssh");
  writeFileSync(bin, `#!/bin/sh\nexec bun "${join(import.meta.dir, "test-fake-ssh.ts")}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function board(items: Record<string, string>, dispatch: Record<string, unknown> = {}, opts: BoardOptions = {}): Board {
  const tools = mkdtempSync(join(tmpdir(), "dcl-dispatch-tools-"));
  const sshRoot = join(tools, "hosts");
  const localHome = join(tools, "local-home");
  mkdirSync(localHome, { recursive: true });
  // Repositories live under each worker's home at the same relative path.
  const repos: Record<string, string> = { [HOUSEHOLD]: "~/work/household-app", [DAYBOOK]: "~/work/daybook" };
  const remote = opts.remote ?? [];
  const homes = [localHome, ...remote.map((host) => join(sshRoot, `agent@${host}`, "home"))];
  const absolute = (home: string, repo: string) => join(home, repo.slice(2));
  for (const home of homes) {
    for (const repo of Object.values(repos)) {
      mkdirSync(absolute(home, repo), { recursive: true });
      sh(absolute(home, repo), ["init", "--quiet"]);
    }
    // Each host's own guard roots: the directory it keeps its checkouts in.
    mkdirSync(join(home, ".config/dcl"), { recursive: true });
    writeFileSync(join(home, ".config/dcl/guard-roots"), "~/work\n");
  }
  const fake = createFakeT3(homes.flatMap((home) => Object.values(repos).map((repo) => absolute(home, repo))));
  const codexBin = makeCodex(tools);
  const sshBin = makeSsh(tools);
  const workerEntry = (host: string, ssh?: string) => ({
    host,
    ...(ssh ? { ssh } : {}),
    slots: opts.slots ?? 3,
    shell: "/bin/sh",
    t3Bin: fake.bin,
    codexBin,
    dclHome: DCL_ROOT,
    ...opts.worker,
  });
  const workers = remote.length ? remote.map((host) => workerEntry(host, `agent@${host}`)) : [workerEntry(HOST)];
  const loops = {
    owner: TEST_IDENTITIES.owner,
    priorityProjects: [HOUSEHOLD, DAYBOOK],
    projects: Object.fromEntries(Object.entries(repos).map(([name, repo]) => [name, { repo }])),
    ...(opts.noDispatch
      ? {}
      : {
          dispatch: {
            enabled: true,
            host: HOST,
            t3: { bin: fake.bin, mode: "auto" },
            lanes: [{ name: "claude", provider: "provider-a", model: "model-a" }],
            workers,
            executors: opts.executors ?? ALL_T3,
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
  const env: NodeJS.ProcessEnv = { ...fake.env, HOME: localHome, FAKE_SSH_ROOT: sshRoot };
  delete env.XDG_STATE_HOME;
  delete env.XDG_CONFIG_HOME;
  const workerFixture = (home: string, dir: string): Worker => ({
    home,
    dir,
    control: (change) => writeFileSync(join(dir, "control.json"), JSON.stringify(change)),
    commands: () => (existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string) : []),
    codex(config) {
      writeFileSync(join(home, "fake-codex.json"), JSON.stringify(config));
      if (config.hold) {
        writeFileSync(join(home, "fake-codex-hold"), "");
        holds.push(join(home, "fake-codex-hold"));
      }
    },
    codexCalls() {
      const path = join(home, "fake-codex-calls.jsonl");
      return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    },
    release: () => rmSync(join(home, "fake-codex-hold"), { force: true }),
  });
  const workerMap: Record<string, Worker> = { [HOST]: workerFixture(localHome, localHome) };
  for (const host of remote) {
    const dir = join(sshRoot, `agent@${host}`);
    workerMap[host] = workerFixture(join(dir, "home"), dir);
  }
  let n = 0;
  return {
    fx,
    clone,
    fake,
    out,
    statePath,
    localHome,
    workers: workerMap,
    repos,
    deps: (overrides = {}) => ({
      root: clone,
      config: loadConfig(clone),
      starter: t3Starter(fake.bin, fake.env),
      remote: remoteRunner({ sshBin, env }),
      now: () => new Date(Date.now() + LATER),
      statePath,
      out: (line) => out.push(line),
      token: () => `d-${(++n).toString(16).padStart(8, "0")}`,
      home: localHome,
      ...overrides,
    }),
    read: (path) => readFileSync(join(clone, path), "utf8"),
    item: (slug) => parseItemFileText(`items/${slug}.md`, readFileSync(join(clone, `items/${slug}.md`), "utf8")),
    commits: () => sh(clone, ["log", "--format=%s"]).split("\n"),
    push(change, message) {
      const session = fx.clone(`session-${++n}`);
      change(session);
      fx.commitAll(session, message);
      sh(session, ["push", "--quiet"]);
    },
  };
}

/** A runner that answers like an unreachable host for every call `fail` selects. */
function failing(remote: Remote, fail: (text: string) => boolean): Remote {
  return {
    run(route, words, options) {
      const text = words.map((w) => (typeof w === "string" ? w : w.raw)).join(" ");
      if (fail(text)) return { reached: false, status: 255, stdout: "", stderr: "", timedOut: true, detail: "no answer within 60s" };
      return remote.run(route, words, options);
    },
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
    expect(lines(b.out, "START ")).toEqual([`START a kind=verify project=${HOUSEHOLD} worker=${HOST} executor=t3 lane=claude`]);
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
      `START a kind=verify project=${HOUSEHOLD} worker=${HOST} executor=t3 lane=claude`,
      `START c kind=build project=${HOUSEHOLD} worker=${HOST} executor=t3 lane=claude`,
      `START e kind=verify project=${DAYBOOK} worker=${HOST} executor=t3 lane=claude`,
      `SKIP b kind=merge project=${HOUSEHOLD} reason=no recorded checkout host (execution.host) to merge on`,
    ]);
    expect(lines(b.out, "INELIGIBLE")).toEqual([`INELIGIBLE d project=${HOUSEHOLD} reason=in-progress`]);
    expect(lines(b.out, "WORKER ")).toEqual([`WORKER ${HOST} kinds=build,verify,merge slots=0/3 reachable repos=${DAYBOOK},${HOUSEHOLD} launcher=yes codex=yes`]);
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

  test("a build claim sets in-progress; no more than the worker's slots are started", () => {
    const b = board(
      {
        a: itemText("a", { state: "spec-filed", assignee: "-" }),
        b: itemText("b", { project: DAYBOOK }),
        c: itemText("c", { project: DAYBOOK }),
      },
      {},
      { slots: 2 },
    );
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    expect(b.fake.read().threads.length).toBe(2);
    expect(b.item("a").state).toBe("in-progress");
    expect(b.item("b").assignee).toBe("claude");
    expect(b.item("c").assignee).toBe(`${HOST}-claude-1`);
    expect(lines(b.out, "SKIP c ")).toEqual([expect.stringContaining(`reason=no worker: ${HOST}: no free slot (2 of 2)`)]);
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

  test("a failed start restores the item plus two log lines and cools the worker down", () => {
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
    expect(Object.keys(state.cooldowns)).toEqual([HOST]);
    expect(lines(b.out, "SKIP ")).toEqual([
      expect.stringMatching(new RegExp(`^SKIP a kind=verify project=${HOUSEHOLD} reason=no worker: ${HOST}: cooling down until `)),
      expect.stringMatching(new RegExp(`^SKIP b kind=verify project=${HOUSEHOLD} reason=no worker: ${HOST}: cooling down until `)),
    ]);
  });

  test("a start whose confirmation was lost is adopted through its tag and gets no second thread", () => {
    const b = board({ a: itemText("a") });
    b.fake.update((s) => (s.loseStartOutput = true));
    // The lost output is followed by a T3 Code that stops answering, so the outcome stays unknown.
    const deps = b.deps();
    let startCalled = false;
    deps.remote = failing(deps.remote!, (text) => {
      if (text.includes("thread start")) startCalled = true;
      return startCalled && text.includes("thread list");
    });
    expect(runTick(deps, { host: HOST, init: true })).toBe(0);
    expect(lines(b.out, "START a outcome unknown")).toHaveLength(1);
    expect(readState(b.statePath)!.entries.map((e) => e.phase)).toEqual(["starting"]);
    b.fake.update((s) => (s.loseStartOutput = false));
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    const state = b.fake.read();
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0]!.messages).toHaveLength(2);
    expect(readState(b.statePath)!.entries.map((e) => e.phase)).toEqual(["running"]);
  });

  test("with T3 Code unreachable the entry keeps its claim and no thread starts there", () => {
    const b = board({ a: itemText("a") }, {}, { slots: 2 });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    b.push((session) => b.fx.write(session, "items/b.md", itemText("b")), "File b");
    b.fake.update((s) => (s.unreachable = true));
    b.out.length = 0;
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    expect(lines(b.out, "UNREACHABLE a ")).toHaveLength(1);
    expect(lines(b.out, "SKIP b ")).toEqual([`SKIP b kind=verify project=${HOUSEHOLD} reason=no worker: ${HOST}: t3 not ready`]);
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
    expect(Object.keys(state.cooldowns)).toEqual([HOST]);
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
    expect(lines(b.out, "START ")).toEqual([`START a kind=verify project=${HOUSEHOLD} worker=${HOST} executor=t3 lane=claude`]);
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

  test("a start found failed on a later tick still cools the worker down", () => {
    const b = board({ a: itemText("a"), b: itemText("b") });
    b.fake.update((s) => (s.failStart = true));
    const deps = b.deps();
    let startCalled = false;
    deps.remote = failing(deps.remote!, (text) => {
      if (text.includes("thread start")) startCalled = true;
      return startCalled && text.includes("thread list");
    });
    expect(runTick(deps, { host: HOST, init: true })).toBe(0);
    expect(readState(b.statePath)!.entries.map((e) => [e.slug, e.phase, e.startAttempted])).toEqual([["a", "starting", true]]);
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    const state = readState(b.statePath)!;
    expect(state.entries).toEqual([]);
    expect(Object.keys(state.cooldowns)).toEqual([HOST]);
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

  test("the slot check on a worker counts only its tool's idle slots and plan writes no objects", () => {
    const b = board({ a: itemText("a", { state: "idea", assignee: "-" }) });
    const project = join(b.localHome, "work", "household-app");
    rmSync(project, { recursive: true, force: true });
    const fx = gitFixture({ "README.md": "project\n" });
    const origin = fx.clone("household-app");
    sh(b.localHome, ["clone", "--quiet", origin, project]);
    for (const tool of ["claude", "codex"]) {
      sh(project, ["branch", `agents/${HOST}-${tool}-1`]);
      sh(project, ["worktree", "add", "--quiet", join(project, ".worktrees", `${HOST}-${tool}-1`), `agents/${HOST}-${tool}-1`]);
    }
    // The claude slot carries work that is not integrated; the codex slot is idle.
    const slot = join(project, ".worktrees", `${HOST}-claude-1`);
    writeFileSync(join(slot, "work.md"), "unintegrated\n");
    sh(slot, ["add", "work.md"]);
    sh(slot, ["commit", "--quiet", "-m", "Unintegrated"]);
    const objects = () => sh(project, ["count-objects", "-v"]);
    const before = objects();
    expect(runPlan(b.deps(), { host: HOST })).toBe(0);
    expect(lines(b.out, "SKIP a ")).toEqual([`SKIP a kind=build project=${HOUSEHOLD} reason=no worker: ${HOST}: no idle claude slot`]);
    expect(objects()).toBe(before);
    sh(slot, ["reset", "--quiet", "--hard", "HEAD~1"]);
    b.out.length = 0;
    expect(runPlan(b.deps(), { host: HOST })).toBe(0);
    expect(lines(b.out, "START a ")).toHaveLength(1);
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
      `ITEM a kind=verify worker=${HOST} executor=t3 lane=claude phase=running thread=mcp:thread-1 thread-status=running item-state=merged token=d-00000001`,
    ]);
  });
});

function waitForJob(worker: Worker, token: string, phase: string): Record<string, unknown> {
  const path = join(worker.home, ".local/state/dcl/jobs", `${token}.json`);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const status = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (status.phase === phase) return status;
    }
    Bun.sleepSync(50);
  }
  throw new Error(`job ${token} never reached ${phase}`);
}

function logLine(slug: string, line: string): (session: string) => void {
  return (session) => {
    const path = join(session, "items", `${slug}.md`);
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n$/, `\n- 2026-11-26: ${line}\n`));
  };
}

describe("remote workers", () => {
  test("verify runs as a Codex job with the pickup prompt, on the worker with most free slots, never on the control host", () => {
    const b = board({ a: itemText("a"), c: itemText("c", { project: DAYBOOK }) }, {}, { remote: ["worker-a", "worker-b"], slots: 1, executors: CODEX_CHECKS });
    for (const host of ["worker-a", "worker-b"]) b.workers[host]!.codex({ sessionId: `s-${host}`, hold: true });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    expect(lines(b.out, "STARTED ")).toEqual([
      "STARTED a worker=worker-a executor=codex-cli job=d-00000001",
      "STARTED c worker=worker-b executor=codex-cli job=d-00000002",
    ]);
    const call = b.workers["worker-a"]!.codexCalls()[0]!;
    expect(call.args.slice(0, 6)).toEqual(["exec", "--json", "--sandbox", "danger-full-access", "-m", "model-c"]);
    expect(call.stdin).toContain("Central dispatch assigned you the board item a");
    expect(call.stdin).toContain("Host: worker-a. Lane: codex. Claim token: d-00000001.");
    expect(realpathSync(call.cwd)).toBe(realpathSync(join(b.workers["worker-a"]!.home, "work/household-app")));
    expect([b.item("a").assignee, b.item("a").execution?.host]).toEqual(["codex", "worker-a"]);
    expect(b.workers["worker-a"]!.commands().every((command) => command.includes("\nexec '/bin/sh' -lc "))).toBe(true);
    // The control host ran no job and no thread.
    expect(existsSync(join(b.localHome, ".local/state/dcl/jobs"))).toBe(false);
    expect(b.fake.read().calls.filter((c) => c[1] === "start")).toEqual([]);

    b.out.length = 0;
    expect(runStatus(b.deps())).toBe(0);
    expect(lines(b.out, "ITEM a ")).toEqual([
      `ITEM a kind=verify worker=worker-a executor=codex-cli lane=codex phase=running job=d-00000001 job-status=running session=s-worker-a job-log=worker-a:${join(b.workers["worker-a"]!.home, ".local/state/dcl/jobs/d-00000001.log")} item-state=merged token=d-00000001`,
    ]);
  });

  test("a stopped job is resumed once after a fresh fetch, then parked", () => {
    const b = board({ a: itemText("a") }, {}, { remote: ["worker-a"], executors: CODEX_CHECKS });
    const worker = b.workers["worker-a"]!;
    worker.codex({ sessionId: "s-1", exitCode: 0 });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    waitForJob(worker, "d-00000001", "exited");
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    expect(lines(b.out, "RESUME a ")).toEqual(["RESUME a started"]);
    expect(readState(b.statePath)!.entries[0]!.resumes).toBe(1);
    waitForJob(worker, "d-00000001", "exited");
    expect(worker.codexCalls().map((c) => c.args.slice(0, 2))).toEqual([["exec", "--json"], ["exec", "resume"]]);
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    const item = b.item("a");
    expect([item.state, item.nextActor, item.awaiting]).toEqual(["blocked", "owner", "unblock"]);
    expect(b.read("items/a.md")).toContain("it stopped again after one continue");
    expect(readState(b.statePath)!.cooldowns["worker-a"]).toBeDefined();
  });

  test("a result published after the tick's first fetch wins over a resume", () => {
    const b = board({ a: itemText("a") }, {}, { remote: ["worker-a"], executors: CODEX_CHECKS });
    const worker = b.workers["worker-a"]!;
    worker.codex({ sessionId: "s-1", exitCode: 0 });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    waitForJob(worker, "d-00000001", "exited");
    const deps = b.deps();
    const inner = deps.remote!;
    let published = false;
    deps.remote = {
      run(route, words, options) {
        const result = inner.run(route, words, options);
        // The job's own log line lands right after the tick fetched and observed the job.
        if (!published && words.includes("show")) {
          published = true;
          b.push((session) => {
            logLine("a", "Verified on dev (dispatch d-00000001).")(session);
            const path = join(session, "items/a.md");
            writeFileSync(path, readFileSync(path, "utf8").replace('state: "merged"', 'state: "tested"'));
          }, "Verify a");
        }
        return result;
      },
    };
    expect(runTick(deps, { host: HOST })).toBe(0);
    expect(lines(b.out, "OBSERVE a ")).toEqual(["OBSERVE a drop (item moved to tested)"]);
    expect(worker.codexCalls()).toHaveLength(1);
    expect(readState(b.statePath)!.entries).toEqual([]);
  });

  test("a job that stops before Codex reports a session is parked with the error from its log", () => {
    const b = board({ a: itemText("a") }, {}, { remote: ["worker-a"], executors: CODEX_CHECKS });
    const worker = b.workers["worker-a"]!;
    worker.codex({ exitCode: 1, stderr: "error: not logged in" });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    waitForJob(worker, "d-00000001", "exited");
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    expect(b.item("a").state).toBe("blocked");
    expect(b.item("a").nextStep).toContain("the Codex job stopped before it reported a session (error: not logged in)");
    expect(b.item("a").nextStep).toContain(`the Codex job d-00000001 on worker-a started by central dispatch`);
    expect(b.item("a").nextStep).toContain(`Look at its log (worker-a:${join(worker.home, ".local/state/dcl/jobs/d-00000001.log")})`);
    expect(worker.codexCalls()).toHaveLength(1);
  });

  test("a Codex start whose reply was lost keeps its slot and is adopted on the next tick, never started twice", () => {
    const b = board({ a: itemText("a"), b: itemText("b") }, {}, { remote: ["worker-a"], slots: 1, executors: CODEX_CHECKS });
    const worker = b.workers["worker-a"]!;
    worker.codex({ sessionId: "s-1", hold: true });
    worker.control({ dropReplyMatching: "--token" });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    expect(lines(b.out, "START a outcome unknown")).toHaveLength(1);
    expect(readState(b.statePath)!.entries.map((e) => [e.slug, e.phase])).toEqual([["a", "starting"]]);
    waitForJob(worker, "d-00000001", "running");
    worker.control({});
    b.out.length = 0;
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    expect(lines(b.out, "OBSERVE a ")).toEqual(["OBSERVE a adopt d-00000001", "OBSERVE a keep (running)"]);
    expect(readState(b.statePath)!.entries.map((e) => [e.slug, e.phase])).toEqual([["a", "running"]]);
    expect(lines(b.out, "SKIP b ")).toEqual([`SKIP b kind=verify project=${HOUSEHOLD} reason=no worker: worker-a: no free slot (1 of 1)`]);
    expect(worker.codexCalls()).toHaveLength(1);
  });

  test("an unreachable worker keeps its entries and claims and gets nothing new", () => {
    const b = board({ a: itemText("a") }, {}, { remote: ["worker-a"], slots: 2, executors: CODEX_CHECKS });
    const worker = b.workers["worker-a"]!;
    worker.codex({ sessionId: "s-1", hold: true });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    const claimed = b.read("items/a.md");
    const entries = readState(b.statePath)!.entries;
    b.push((session) => b.fx.write(session, "items/b.md", itemText("b")), "File b");
    worker.control({ down: true });
    b.out.length = 0;
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    expect(lines(b.out, "UNREACHABLE a ")).toHaveLength(1);
    expect(lines(b.out, "WORKER worker-a ")).toEqual([expect.stringContaining("unreachable")]);
    expect(lines(b.out, "SKIP b ")).toEqual([`SKIP b kind=verify project=${HOUSEHOLD} reason=no worker: worker-a: unreachable`]);
    expect(readState(b.statePath)!.entries).toEqual(entries);
    expect(b.read("items/a.md")).toBe(claimed);
  });

  test("an entry is observed through its stored route after its worker leaves the configuration", () => {
    const b = board({ a: itemText("a") }, {}, { remote: ["worker-a", "worker-b"], slots: 1, executors: CODEX_CHECKS });
    b.workers["worker-a"]!.codex({ sessionId: "s-1", hold: true });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    b.push((session) => {
      const loops = JSON.parse(b.fx.read(session, "loops.json"));
      loops.dispatch.workers = loops.dispatch.workers.filter((w: { host: string }) => w.host !== "worker-a");
      b.fx.write(session, "loops.json", JSON.stringify(loops, null, 2));
    }, "Remove worker-a");
    const before = b.workers["worker-a"]!.commands().length;
    b.out.length = 0;
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    expect(lines(b.out, "OBSERVE a ")).toEqual(["OBSERVE a keep (running)"]);
    expect(b.workers["worker-a"]!.commands().slice(before).some((c) => c.includes("show"))).toBe(true);
    expect(lines(b.out, "WORKER ")).toEqual([expect.stringMatching(/^WORKER worker-b /)]);
  });

  test("a worker without the repo or the job launcher is skipped with the reason", () => {
    const b = board({ a: itemText("a"), c: itemText("c", { project: DAYBOOK }) }, {}, { remote: ["worker-a"], executors: CODEX_CHECKS });
    rmSync(join(b.workers["worker-a"]!.home, "work/daybook"), { recursive: true });
    expect(runPlan(b.deps(), { host: HOST })).toBe(0);
    expect(lines(b.out, "SKIP c ")).toEqual([`SKIP c kind=verify project=${DAYBOOK} reason=no worker: worker-a: no ${DAYBOOK} repo`]);
    const noLauncher = board({ a: itemText("a") }, {}, { remote: ["worker-a"], executors: CODEX_CHECKS, worker: { dclHome: "~/no-dcl-here" } });
    expect(runPlan(noLauncher.deps(), { host: HOST })).toBe(0);
    expect(lines(noLauncher.out, "SKIP a ")).toEqual([`SKIP a kind=verify project=${HOUSEHOLD} reason=no worker: worker-a: codex-cli not ready (no job launcher)`]);
  });

  test("a hung T3 check blocks only builds on that worker", () => {
    const b = board({ v: itemText("v"), s: itemText("s", { state: "spec-filed", assignee: "-" }) }, {}, { remote: ["worker-a"], slots: 2, executors: CODEX_CHECKS });
    b.workers["worker-a"]!.codex({ sessionId: "s-1", hold: true });
    const deps = b.deps();
    deps.remote = failing(deps.remote!, (text) => text.includes("thread list"));
    expect(runTick(deps, { host: HOST, init: true })).toBe(0);
    expect(lines(b.out, "STARTED ")).toEqual(["STARTED v worker=worker-a executor=codex-cli job=d-00000001"]);
    expect(lines(b.out, "SKIP s ")).toEqual([`SKIP s kind=build project=${HOUSEHOLD} reason=no worker: worker-a: t3 not ready`]);
  });

  test("a legacy entry on the control host gets no continue: it is parked", () => {
    const b = board({ a: itemText("a") });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    const state = readState(b.statePath)!;
    for (const entry of state.entries) {
      delete entry.worker;
      delete entry.executor;
      delete entry.route;
    }
    writeFileSync(b.statePath, JSON.stringify(state));
    b.fake.update((s) => (s.threads[0]!.status = "completed"));
    const sends = () => b.fake.read().calls.filter((c) => c[1] === "send").length;
    const before = sends();
    b.out.length = 0;
    expect(runPlan(b.deps(), { host: HOST })).toBe(0);
    expect(b.out).toContain("LEGACY=1 entries on the control host from before workers (observed only; never sent work)");
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    expect(sends()).toBe(before);
    expect(b.item("a").state).toBe("blocked");
    expect(b.read("items/a.md")).toContain("dispatch no longer sends work or a continue");
  });

  test("a start that never reached the worker is fenced before its claim is released, so it cannot run later", () => {
    const b = board({ a: itemText("a") }, {}, { remote: ["worker-a"], executors: CODEX_CHECKS });
    const worker = b.workers["worker-a"]!;
    const deps = b.deps();
    deps.remote = failing(deps.remote!, (text) => text.includes("start --token"));
    expect(runTick(deps, { host: HOST, init: true })).toBe(0);
    expect(b.read("items/a.md")).toContain("Released by central dispatch");
    expect(readState(b.statePath)!.entries).toEqual([]);
    // The request arrives late: the launcher refuses the fenced token.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: worker.home };
    delete env.XDG_STATE_HOME;
    const late = spawnSync("bun", [join(DCL_ROOT, "tools/dispatch-job.ts"), "start", "--token", "d-00000001", "--cwd", worker.home, "--model", "m"], { env, input: "", encoding: "utf8" });
    expect(late.status).toBe(3);
    expect(worker.codexCalls()).toEqual([]);
  });

  test("an executable that resolves into a project repository on the worker is refused there", () => {
    const b = board({ a: itemText("a") }, {}, { remote: ["worker-a"], executors: CODEX_CHECKS, worker: { codexBin: "~/bin/codex" } });
    const worker = b.workers["worker-a"]!;
    const inRepo = join(worker.home, "work/household-app/bin");
    mkdirSync(inRepo, { recursive: true });
    makeCodex(inRepo);
    symlinkSync(inRepo, join(worker.home, "bin"));
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    expect(lines(b.out, "WORKER worker-a ")).toEqual([expect.stringContaining("dcl-guard: codex executable resolves into a project repository or the data repo; refused")]);
    expect(lines(b.out, "STARTED ")).toEqual([]);
    expect(worker.codexCalls()).toEqual([]);
  });

  test("a hung codex check disables only Codex jobs on that worker", () => {
    const b = board({ v: itemText("v"), s: itemText("s", { state: "spec-filed", assignee: "-" }) }, {}, { remote: ["worker-a"], slots: 2, executors: CODEX_CHECKS });
    const deps = b.deps();
    deps.remote = failing(deps.remote!, (text) => text.includes("--version"));
    expect(runPlan(deps, { host: HOST })).toBe(0);
    expect(lines(b.out, "WORKER worker-a ")).toEqual([expect.stringContaining("reachable repos=daybook,household-app launcher=yes codex=no")]);
    expect(lines(b.out, "SKIP v ")).toEqual([`SKIP v kind=verify project=${HOUSEHOLD} reason=no worker: worker-a: codex-cli not ready (codex does not answer)`]);
    expect(lines(b.out, "START s ")).toHaveLength(1);
  });

  test("a stopped thread in another mode whose result arrived after the first fetch pauses nothing", () => {
    const b = board({ a: itemText("a") });
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    b.fake.update((s) => {
      s.threads[0]!.status = "completed";
      s.threads[0]!.runtimeMode = "full-access";
    });
    const deps = b.deps();
    const inner = deps.remote!;
    let published = false;
    deps.remote = {
      run(route, words, options) {
        const result = inner.run(route, words, options);
        if (!published && words.includes("show")) {
          published = true;
          b.push((session) => {
            logLine("a", "Verified on dev (dispatch d-00000001).")(session);
            const path = join(session, "items/a.md");
            writeFileSync(path, readFileSync(path, "utf8").replace('state: "merged"', 'state: "tested"'));
          }, "Verify a");
        }
        return result;
      },
    };
    expect(runTick(deps, { host: HOST })).toBe(0);
    expect(existsSync(join(b.clone, "dispatch-control.json"))).toBe(false);
    expect(readState(b.statePath)!.entries).toEqual([]);
  });

  test("a tick fetches a configuration fixed upstream before refusing the one its clone has", () => {
    const b = board({ a: itemText("a") }, { maxThreads: 3 });
    expect(b.deps().config.dispatchError).toContain("maxThreads was removed");
    b.push((session) => {
      const loops = JSON.parse(b.fx.read(session, "loops.json"));
      delete loops.dispatch.maxThreads;
      b.fx.write(session, "loops.json", JSON.stringify(loops, null, 2));
    }, "Migrate the dispatch section");
    expect(runTick(b.deps(), { host: HOST, init: true })).toBe(0);
    expect(lines(b.out, "STARTED a ")).toHaveLength(1);
    const still = board({ a: itemText("a") }, { maxThreads: 3 });
    expect(runTick(still.deps(), { host: HOST, init: true })).toBe(2);
    expect(still.out).toContain("ERROR=loops.json: dispatch.maxThreads was removed: worker slots are the only limit (set workers[].slots)");
  });

  test("a T3 start whose reply was lost over SSH is adopted through the project path it was started with", () => {
    const b = board({ s: itemText("s", { state: "spec-filed", assignee: "-" }) }, {}, { remote: ["worker-a"] });
    const worker = b.workers["worker-a"]!;
    // The start runs on the worker but its reply is lost, and T3 Code stops answering lists.
    worker.control({ dropReplyMatching: "--title" });
    const deps = b.deps();
    let startCalled = false;
    deps.remote = failing(deps.remote!, (text) => {
      if (text.includes("thread start")) startCalled = true;
      return startCalled && text.includes("thread list");
    });
    expect(runTick(deps, { host: HOST, init: true })).toBe(0);
    expect(lines(b.out, "START s outcome unknown")).toHaveLength(1);
    expect(b.fake.read().threads).toHaveLength(1);
    // The project moves in configuration meanwhile; the lookup still uses the start's path.
    b.push((session) => {
      const loops = JSON.parse(b.fx.read(session, "loops.json"));
      loops.projects[HOUSEHOLD].repo = "~/elsewhere/household-app";
      b.fx.write(session, "loops.json", JSON.stringify(loops, null, 2));
    }, "Repoint the project");
    worker.control({});
    b.out.length = 0;
    expect(runTick(b.deps(), { host: HOST })).toBe(0);
    expect(lines(b.out, "OBSERVE s ")[0]).toMatch(/^OBSERVE s adopt /);
    expect(b.fake.read().threads).toHaveLength(1);
    expect(readState(b.statePath)!.entries.map((e) => e.phase)).toEqual(["running"]);
  });

  test("the guard also refuses executables in a data repo or a root the worker lists itself", () => {
    const viaData = board({ a: itemText("a") }, {}, { remote: ["worker-a"], executors: CODEX_CHECKS, worker: { codexBin: "~/board/tools/codex" } });
    const home = viaData.workers["worker-a"]!.home;
    mkdirSync(join(home, "board/tools"), { recursive: true });
    sh(join(home, "board"), ["init", "--quiet"]);
    writeFileSync(join(home, "board/BOARD.md"), "# Board\n");
    makeCodex(join(home, "board/tools"));
    expect(runPlan(viaData.deps(), { host: HOST })).toBe(0);
    expect(lines(viaData.out, "WORKER worker-a ")).toEqual([expect.stringContaining("dcl-guard: codex executable")]);

    const listed = board({ a: itemText("a") }, {}, { remote: ["worker-a"], executors: CODEX_CHECKS, worker: { codexBin: "~/vendor/codex" } });
    const listedHome = listed.workers["worker-a"]!.home;
    mkdirSync(join(listedHome, "vendor"), { recursive: true });
    makeCodex(join(listedHome, "vendor"));
    expect(runPlan(listed.deps(), { host: HOST })).toBe(0);
    expect(lines(listed.out, "WORKER worker-a ")).toEqual([expect.stringContaining("reachable")]);
    writeFileSync(join(listedHome, ".config/dcl/guard-roots"), "~/work\n~/vendor\n");
    listed.out.length = 0;
    expect(runPlan(listed.deps(), { host: HOST })).toBe(0);
    expect(lines(listed.out, "WORKER worker-a ")).toEqual([expect.stringContaining("dcl-guard: codex executable")]);
  });

  test("a host without guard roots refuses every command, so it reads as unreachable", () => {
    for (const content of [null, "\n  \n"]) {
      const b = board({ a: itemText("a") }, {}, { remote: ["worker-a"], executors: CODEX_CHECKS });
      const roots = join(b.workers["worker-a"]!.home, ".config/dcl/guard-roots");
      if (content === null) rmSync(roots);
      else writeFileSync(roots, content);
      expect(runPlan(b.deps(), { host: HOST })).toBe(0);
      expect(lines(b.out, "WORKER worker-a ")).toEqual([expect.stringContaining("dcl-guard: no guard roots")]);
      expect(lines(b.out, "START ")).toEqual([]);
    }
  });

  test("moving a project's configured root does not expose the old checkout's executables", () => {
    const b = board({ a: itemText("a") }, {}, { remote: ["worker-a"], executors: CODEX_CHECKS });
    const home = b.workers["worker-a"]!.home;
    mkdirSync(join(home, "work/household-app/tools"), { recursive: true });
    makeCodex(join(home, "work/household-app/tools"));
    b.push((session) => {
      const loops = JSON.parse(b.fx.read(session, "loops.json"));
      loops.projects[HOUSEHOLD].repo = "~/elsewhere/household-app";
      loops.dispatch.workers[0].codexBin = "~/work/household-app/tools/codex";
      b.fx.write(session, "loops.json", JSON.stringify(loops, null, 2));
    }, "Repoint the project and the executable");
    // plan never pulls; bring the dispatch clone up to the edited configuration.
    sh(b.clone, ["pull", "--quiet", "--ff-only"]);
    expect(lines(b.out, "WORKER ")).toEqual([]);
    expect(runPlan(b.deps(), { host: HOST })).toBe(0);
    expect(lines(b.out, "WORKER worker-a ")).toEqual([expect.stringContaining("dcl-guard: codex executable")]);
  });

  test("a directory inside some other checkout is not the project's repository", () => {
    const b = board({ a: itemText("a") }, {}, { remote: ["worker-a"], executors: CODEX_CHECKS });
    const home = b.workers["worker-a"]!.home;
    rmSync(join(home, "work/household-app"), { recursive: true });
    sh(join(home, "work"), ["init", "--quiet"]);
    mkdirSync(join(home, "work/household-app"));
    expect(runPlan(b.deps(), { host: HOST })).toBe(0);
    expect(lines(b.out, "SKIP a ")).toEqual([`SKIP a kind=verify project=${HOUSEHOLD} reason=no worker: worker-a: no ${HOUSEHOLD} repo`]);
  });
});
