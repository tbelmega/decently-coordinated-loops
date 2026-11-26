import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobAlive, sessionIdOf, type JobShow, type JobStatus } from "./dispatch-job.ts";

const LAUNCHER = join(import.meta.dir, "dispatch-job.ts");
const homes: string[] = [];

interface Home {
  home: string;
  codex: string;
  run(args: string[], input?: string): { status: number | null; json: Record<string, unknown> };
  configure(config: Record<string, unknown>): void;
  calls(): { args: string[]; cwd: string; stdin: string }[];
  status(token: string): JobStatus;
  waitFor(token: string, phase: string): JobStatus;
}

function fixture(): Home {
  const home = mkdtempSync(join(tmpdir(), "dcl-job-home-"));
  homes.push(home);
  const codex = join(home, "codex");
  writeFileSync(codex, `#!/bin/sh\nexec bun "${join(import.meta.dir, "test-fake-codex.ts")}" "$@"\n`);
  chmodSync(codex, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.XDG_STATE_HOME;
  const statusPath = (token: string) => join(home, ".local/state/dcl/jobs", `${token}.json`);
  return {
    home,
    codex,
    run(args, input = "") {
      const r = spawnSync("bun", [LAUNCHER, ...args], { input, env, encoding: "utf8", timeout: 30_000 });
      const line = (r.stdout ?? "").trim().split("\n").pop() ?? "";
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(line) as Record<string, unknown>;
      } catch {
        json = { raw: r.stdout, stderr: r.stderr };
      }
      return { status: r.status, json };
    },
    configure(config) {
      writeFileSync(join(home, "fake-codex.json"), JSON.stringify(config));
      if (config.hold) writeFileSync(join(home, "fake-codex-hold"), "");
    },
    calls() {
      const path = join(home, "fake-codex-calls.jsonl");
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    },
    status: (token) => JSON.parse(readFileSync(statusPath(token), "utf8")) as JobStatus,
    waitFor(token, phase) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (existsSync(statusPath(token))) {
          const status = JSON.parse(readFileSync(statusPath(token), "utf8")) as JobStatus;
          if (status.phase === phase) return status;
        }
        Bun.sleepSync(50);
      }
      throw new Error(`job ${token} never reached ${phase}`);
    },
  };
}

function release(h: Home): void {
  const hold = join(h.home, "fake-codex-hold");
  if (existsSync(hold)) unlinkSync(hold);
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    release({ home } as Home);
    Bun.sleepSync(100);
    rmSync(home, { recursive: true, force: true });
  }
});

const TOKEN = "d-0000000a";

describe("dispatch-job launcher", () => {
  test("start records the job before Codex runs, supervises it, and records session and exit", () => {
    const h = fixture();
    h.configure({ sessionId: "session-1", exitCode: 0, hold: true });
    const work = join(h.home, "work");
    mkdirSync(work);
    const started = h.run(["start", "--token", TOKEN, "--cwd", work, "--model", "model-c", "--codex", h.codex], "Do the item.");
    expect(started.status).toBe(0);
    expect(started.json).toMatchObject({ token: TOKEN, phase: "running", mode: "start", cwd: work });

    const running = h.waitFor(TOKEN, "running");
    expect(jobAlive(running)).toBe(true);
    const shown = h.run(["show", "--token", TOKEN]).json as JobShow;
    expect(shown).toMatchObject({ found: true, alive: true, phase: "running" });

    release(h);
    const exited = h.waitFor(TOKEN, "exited");
    expect(exited).toMatchObject({ sessionId: "session-1", exitCode: 0 });
    expect(h.run(["show", "--token", TOKEN]).json).toMatchObject({ found: true, alive: false, sessionId: "session-1" });
    expect(h.calls()).toEqual([
      { args: ["exec", "--json", "--sandbox", "danger-full-access", "-m", "model-c", "-C", work, "-"], cwd: expect.stringContaining("work"), stdin: "Do the item." },
    ]);
    expect(readFileSync(exited.log, "utf8")).toContain('"thread.started"');
  });

  test("a second start of a token refuses and starts nothing", () => {
    const h = fixture();
    h.configure({ sessionId: "s", exitCode: 0 });
    expect(h.run(["start", "--token", TOKEN, "--cwd", h.home, "--model", "m", "--codex", h.codex]).status).toBe(0);
    h.waitFor(TOKEN, "exited");
    const again = h.run(["start", "--token", TOKEN, "--cwd", h.home, "--model", "m", "--codex", h.codex]);
    expect(again.status).toBe(3);
    expect(again.json).toEqual({ error: "a job with this token exists or was fenced", token: TOKEN });
    expect(h.calls()).toHaveLength(1);
  });

  test("show tells a token that never started from one that did", () => {
    const h = fixture();
    expect(h.run(["show", "--token", TOKEN]).json).toEqual({ found: false, token: TOKEN });
  });

  test("a job that exits before Codex reports a session has no session id and keeps the error in its log", () => {
    const h = fixture();
    h.configure({ exitCode: 1, stderr: "error: not logged in" });
    h.run(["start", "--token", TOKEN, "--cwd", h.home, "--model", "m", "--codex", h.codex]);
    h.waitFor(TOKEN, "exited");
    const shown = h.run(["show", "--token", TOKEN]).json;
    expect(shown).toMatchObject({ found: true, alive: false, exitCode: 1, logTail: "error: not logged in" });
    expect(shown.sessionId).toBeUndefined();
    expect(h.run(["resume", "--token", TOKEN])).toMatchObject({ status: 3, json: { error: "the job has no session id to resume" } });
  });

  test("a missing Codex executable or working directory is recorded as an exit, not a hang", () => {
    const h = fixture();
    h.run(["start", "--token", TOKEN, "--cwd", h.home, "--model", "m", "--codex", join(h.home, "no-such-codex")]);
    expect(h.waitFor(TOKEN, "exited").exitCode).toBe(127);
    const other = "d-0000000b";
    const missing = h.run(["start", "--token", other, "--cwd", join(h.home, "gone"), "--model", "m", "--codex", h.codex]);
    expect(missing.json).toMatchObject({ phase: "exited", exitCode: 127 });
    expect(h.run(["show", "--token", other]).json).toMatchObject({ logTail: expect.stringContaining("does not exist") });
  });

  test("resume continues the recorded session once the job stopped, and refuses while it runs", () => {
    const h = fixture();
    h.configure({ sessionId: "session-1", exitCode: 0, hold: true });
    h.run(["start", "--token", TOKEN, "--cwd", h.home, "--model", "m", "--codex", h.codex]);
    h.waitFor(TOKEN, "running");
    expect(h.run(["resume", "--token", TOKEN])).toMatchObject({ status: 3, json: { error: "the job is still running" } });
    release(h);
    h.waitFor(TOKEN, "exited");
    h.configure({ exitCode: 0 });
    const resumed = h.run(["resume", "--token", TOKEN]);
    expect(resumed.status).toBe(0);
    const done = h.waitFor(TOKEN, "exited");
    expect(done).toMatchObject({ mode: "resume", resumes: 1, sessionId: "session-1", exitCode: 0 });
    expect(h.calls()[1]!.args).toEqual(["exec", "resume", "--json", "-c", 'sandbox_mode="danger-full-access"', "-m", "m", "session-1", "continue"]);
  });

  test("a job stays alive while its Codex process lives, even after its supervisor is killed", () => {
    const h = fixture();
    h.configure({ sessionId: "s", exitCode: 0, hold: true });
    h.run(["start", "--token", TOKEN, "--cwd", h.home, "--model", "m", "--codex", h.codex]);
    const running = h.waitFor(TOKEN, "running");
    expect(running.childPid).toBeGreaterThan(0);
    // After a reboot the pids may be reused: a record from before this boot is never alive.
    expect(jobAlive({ ...running, pidStart: "Thu Jan  1 00:00:00 1970", childStart: "Thu Jan  1 00:00:00 1970", startedAt: "1970-01-01T00:00:00.000Z" })).toBe(false);
    process.kill(running.pid, "SIGKILL");
    Bun.sleepSync(200);
    expect(h.run(["show", "--token", TOKEN]).json).toMatchObject({ found: true, alive: true, phase: "running" });
    // Even a record that never got to name the child: Codex runs in the supervisor's group.
    const { childPid: _pid, childStart: _start, ...unnamed } = running;
    expect(jobAlive(unnamed as typeof running)).toBe(true);
    expect(h.run(["resume", "--token", TOKEN])).toMatchObject({ status: 3, json: { error: "the job is still running" } });
    release(h);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && h.run(["show", "--token", TOKEN]).json.alive) Bun.sleepSync(100);
    expect(h.run(["show", "--token", TOKEN]).json).toMatchObject({ found: true, alive: false });
  });

  test("a stop request reaches Codex, and the exit is recorded only once Codex has ended", () => {
    const h = fixture();
    h.configure({ sessionId: "s", exitCode: 0, hold: true });
    h.run(["start", "--token", TOKEN, "--cwd", h.home, "--model", "m", "--codex", h.codex]);
    const running = h.waitFor(TOKEN, "running");
    process.kill(running.pid, "SIGTERM");
    const exited = h.waitFor(TOKEN, "exited");
    expect(exited.exitCode).not.toBe(0);
    expect(jobAlive(exited)).toBe(false);
  });

  test("fence makes a missing token final: a start that arrives later refuses", () => {
    const h = fixture();
    expect(h.run(["fence", "--token", TOKEN]).json).toEqual({ found: false, token: TOKEN, fenced: true });
    expect(h.run(["show", "--token", TOKEN]).json).toEqual({ found: false, token: TOKEN, fenced: true });
    const late = h.run(["start", "--token", TOKEN, "--cwd", h.home, "--model", "m", "--codex", h.codex]);
    expect(late).toMatchObject({ status: 3, json: { error: "a job with this token exists or was fenced" } });
    expect(h.calls()).toEqual([]);
    // An existing job is shown, not fenced.
    const other = "d-0000000b";
    h.configure({ sessionId: "s", exitCode: 0 });
    h.run(["start", "--token", other, "--cwd", h.home, "--model", "m", "--codex", h.codex]);
    h.waitFor(other, "exited");
    expect(h.run(["fence", "--token", other]).json).toMatchObject({ found: true, token: other });
  });

  test("a job is resumed at most once, and its files are owner-only with no prompt left behind", () => {
    const h = fixture();
    h.configure({ sessionId: "s", exitCode: 0 });
    h.run(["start", "--token", TOKEN, "--cwd", h.home, "--model", "m", "--codex", h.codex], "secret prompt");
    const done = h.waitFor(TOKEN, "exited");
    expect(h.run(["resume", "--token", TOKEN]).status).toBe(0);
    h.waitFor(TOKEN, "exited");
    expect(h.run(["resume", "--token", TOKEN])).toMatchObject({ status: 3, json: { error: "the job was already resumed once" } });
    const dir = join(h.home, ".local/state/dcl/jobs");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of [`${TOKEN}.json`, `${TOKEN}.log`]) expect(statSync(join(dir, file)).mode & 0o077).toBe(0);
    expect(existsSync(join(dir, `${TOKEN}.prompt`))).toBe(false);
    expect(done.log).toBe(join(dir, `${TOKEN}.log`));
  });

  test("slots answers for a missing repository without failing", () => {
    const h = fixture();
    const r = h.run(["slots", "--repo", join(h.home, "none"), "--host", "worker-a", "--tool", "claude", "--branch", "master"], "[]");
    expect(r).toMatchObject({ status: 0, json: { applies: false, idle: 0 } });
  });

  test("rejects a token that is not a dispatch token", () => {
    const h = fixture();
    expect(h.run(["show", "--token", "../x"]).status).toBe(2);
  });
});

describe("sessionIdOf", () => {
  test("reads the session from the events Codex prints", () => {
    expect(sessionIdOf('{"type":"thread.started","thread_id":"abc"}')).toBe("abc");
    expect(sessionIdOf('{"id":"0","msg":{"type":"session_configured","session_id":"def"}}')).toBe("def");
    expect(sessionIdOf('{"type":"turn.started"}')).toBeUndefined();
    expect(sessionIdOf("not json")).toBeUndefined();
  });
});
