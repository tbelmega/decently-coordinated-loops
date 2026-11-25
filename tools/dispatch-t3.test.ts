import { describe, expect, test } from "bun:test";
import { classifyStatus, t3Starter } from "./dispatch-t3.ts";
import { createFakeT3 } from "./test-fake-t3-harness.ts";

const PROJECT = "/work/household-app";

function setup() {
  const fake = createFakeT3([PROJECT]);
  return { fake, starter: t3Starter(fake.bin, fake.env) };
}

const REQUEST = { project: PROJECT, title: "Slideshow [d-0123abcd]", provider: "provider-a", model: "model-a", message: "Reply ready." };

describe("classifyStatus", () => {
  test("sorts the statuses seen on a real server", () => {
    expect(["running", "starting"].map(classifyStatus)).toEqual(["running", "running"]);
    expect(["completed", "interrupted", "failed", "idle"].map(classifyStatus)).toEqual(["stopped", "stopped", "stopped", "stopped"]);
    expect(classifyStatus("paused-for-maintenance")).toBe("unknown");
  });
});

describe("t3Starter", () => {
  test("starts, lists, shows and sends", () => {
    const { fake, starter } = setup();
    const started = starter.start(REQUEST);
    expect(started).toEqual({ ok: true, value: { threadId: "mcp:thread-1" } });
    const listed = starter.list(PROJECT);
    expect(listed.ok && listed.value.map((t) => [t.threadId, t.title, t.status, t.runtimeMode])).toEqual([
      ["mcp:thread-1", REQUEST.title, "running", "auto"],
    ]);
    const shown = starter.show("mcp:thread-1");
    expect(shown.ok && shown.value.pendingRequestCount).toBe(0);
    expect(starter.send("mcp:thread-1", "Work.")).toEqual({ ok: true, value: null });
    const state = fake.read();
    expect(state.threads[0]!.messages.map((m) => m.text)).toEqual(["Reply ready.", "Work."]);
    expect(state.calls[0]).toEqual(["thread", "start", PROJECT, "-", "--title", REQUEST.title, "--provider", "provider-a", "--model", "model-a", "--json"]);
  });

  test("reports an unknown thread id, an unknown project, a failed start and an unreachable server", () => {
    const { fake, starter } = setup();
    expect(starter.show("mcp:nope")).toMatchObject({ ok: false, failure: "unknown-thread" });
    expect(starter.list("/elsewhere")).toMatchObject({ ok: false, failure: "unknown-project" });
    expect(starter.start({ ...REQUEST, project: "/elsewhere" })).toMatchObject({ ok: false, failure: "unknown-project" });
    fake.update((s) => (s.failStart = true));
    expect(starter.start(REQUEST)).toMatchObject({ ok: false, failure: "failed" });
    fake.update((s) => {
      s.failStart = false;
      s.unreachable = true;
    });
    expect(starter.show("mcp:thread-1")).toMatchObject({ ok: false, failure: "unreachable" });
    expect(starter.list(PROJECT)).toMatchObject({ ok: false, failure: "unreachable" });
  });

  test("a missing executable is unreachable", () => {
    const starter = t3Starter("/nonexistent/t3");
    expect(starter.list(PROJECT)).toMatchObject({ ok: false, failure: "unreachable" });
    expect(starter.start(REQUEST)).toMatchObject({ ok: false, failure: "unreachable" });
  });
});
