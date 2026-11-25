import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { DISPATCH_DEFAULTS, validateDispatchConfig } from "./dispatch-config.ts";
import { TEST_IDENTITIES } from "./test-identities.ts";

const HOST = TEST_IDENTITIES.host;

function minimal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: HOST,
    maxThreads: 3,
    lanes: [{ name: "claude", provider: "provider-a", model: "model-a" }],
    ...extra,
  };
}

describe("validateDispatchConfig", () => {
  test("fills the documented defaults", () => {
    const config = validateDispatchConfig(minimal());
    expect(config).toEqual({
      enabled: false,
      host: HOST,
      maxThreads: 3,
      maxPerProject: DISPATCH_DEFAULTS.maxPerProject,
      quietHours: DISPATCH_DEFAULTS.quietHours,
      retryCooldownMinutes: DISPATCH_DEFAULTS.retryCooldownMinutes,
      ownerBackpressure: undefined,
      excludeProjects: [],
      t3: { bin: "t3", mode: "auto" },
      lanes: [{ name: "claude", provider: "provider-a", model: "model-a", maxThreads: 3 }],
    });
    expect(DISPATCH_DEFAULTS).toEqual({ maxPerProject: 2, quietHours: 6, retryCooldownMinutes: 60 });
  });

  test("keeps every explicit value", () => {
    const config = validateDispatchConfig(
      minimal({
        enabled: true,
        maxPerProject: 1,
        quietHours: 0,
        retryCooldownMinutes: 5,
        ownerBackpressure: 10,
        excludeProjects: [TEST_IDENTITIES.projects.integration],
        t3: { bin: "/opt/t3", mode: "auto" },
        lanes: [
          { name: "claude", provider: "provider-a", model: "model-a", maxThreads: 2 },
          { name: "codex", provider: "provider-b", model: "model-b", maxThreads: 1 },
        ],
      }),
    );
    expect(config.enabled).toBe(true);
    expect(config.quietHours).toBe(0);
    expect(config.ownerBackpressure).toBe(10);
    expect(config.excludeProjects).toEqual([TEST_IDENTITIES.projects.integration]);
    expect(config.t3).toEqual({ bin: "/opt/t3", mode: "auto" });
    expect(config.lanes.map((lane) => [lane.name, lane.maxThreads])).toEqual([
      ["claude", 2],
      ["codex", 1],
    ]);
  });

  test.each([
    ["not an object", [], "dispatch must be an object"],
    ["missing host", { maxThreads: 3, lanes: [{ name: "a", provider: "p", model: "m" }] }, "dispatch.host"],
    ["missing maxThreads", { host: HOST, lanes: [{ name: "a", provider: "p", model: "m" }] }, "dispatch.maxThreads"],
    ["zero maxThreads", minimal({ maxThreads: 0 }), "dispatch.maxThreads"],
    ["no lanes", minimal({ lanes: [] }), "dispatch.lanes"],
    ["bad lane name", minimal({ lanes: [{ name: "Claude-1", provider: "p", model: "m" }] }), "dispatch.lanes[0].name"],
    ["duplicate lane", minimal({ lanes: [{ name: "a", provider: "p", model: "m" }, { name: "a", provider: "p", model: "m" }] }), "duplicate"],
    ["lane without model", minimal({ lanes: [{ name: "a", provider: "p" }] }), "dispatch.lanes[0].model"],
    ["unknown key", minimal({ maxthreads: 3 }), "dispatch.maxthreads is not a recognized key"],
    ["unknown lane key", minimal({ lanes: [{ name: "a", provider: "p", model: "m", effort: "x" }] }), "dispatch.lanes[0].effort"],
    ["unknown t3 key", minimal({ t3: { bin: "t3", project: "x" } }), "dispatch.t3.project"],
    ["enabled not boolean", minimal({ enabled: "yes" }), "dispatch.enabled"],
    ["a mode other than auto", minimal({ t3: { mode: "full-access" } }), 'dispatch.t3.mode must be "auto"'],
    ["a relative t3 path", minimal({ t3: { bin: "tools/t3" } }), "dispatch.t3.bin"],
    ["negative quietHours", minimal({ quietHours: -1 }), "dispatch.quietHours"],
    ["excludeProjects not strings", minimal({ excludeProjects: [1] }), "dispatch.excludeProjects"],
  ])("rejects %s", (_name, raw, message) => {
    expect(() => validateDispatchConfig(raw)).toThrow(message);
  });
});

describe("loadConfig dispatch section", () => {
  test("is absent when loops.json has none, and validated when present", () => {
    const root = mkdtempSync(join(tmpdir(), "loops-dispatch-config-"));
    try {
      writeFileSync(join(root, "loops.json"), JSON.stringify({ owner: TEST_IDENTITIES.owner }));
      expect(loadConfig(root).dispatch).toBeUndefined();
      writeFileSync(join(root, "loops.json"), JSON.stringify({ dispatch: minimal() }));
      expect(loadConfig(root).dispatch?.host).toBe(HOST);
      writeFileSync(join(root, "loops.json"), JSON.stringify({ dispatch: minimal({ bogus: 1 }) }));
      expect(() => loadConfig(root)).toThrow("dispatch.bogus");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
