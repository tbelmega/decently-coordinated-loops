import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { DISPATCH_DEFAULTS, validateDispatchConfig } from "./dispatch-config.ts";
import { TEST_IDENTITIES } from "./test-identities.ts";

const HOST = TEST_IDENTITIES.host;

const EXECUTORS = {
  build: { type: "t3", lane: "claude" },
  verify: { type: "codex-cli", model: "model-c" },
  merge: { type: "codex-cli", model: "model-c" },
} as const;

function minimal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: HOST,
    lanes: [{ name: "claude", provider: "provider-a", model: "model-a" }],
    workers: [{ host: "worker-a", ssh: "agent@worker-a", slots: 1 }],
    executors: EXECUTORS,
    ...extra,
  };
}

describe("validateDispatchConfig", () => {
  test("fills the documented defaults", () => {
    const config = validateDispatchConfig(minimal());
    expect(config).toEqual({
      enabled: false,
      host: HOST,
      quietHours: DISPATCH_DEFAULTS.quietHours,
      retryCooldownMinutes: DISPATCH_DEFAULTS.retryCooldownMinutes,
      ownerBackpressure: undefined,
      excludeProjects: [],
      t3: { bin: "t3", mode: "auto" },
      codex: { bin: "codex" },
      lanes: [{ name: "claude", provider: "provider-a", model: "model-a" }],
      workers: [{ host: "worker-a", ssh: "agent@worker-a", slots: 1, kinds: ["build", "verify", "merge"] }],
      executors: EXECUTORS,
    });
    expect(DISPATCH_DEFAULTS).toEqual({ quietHours: 6, retryCooldownMinutes: 60 });
  });

  test("keeps every explicit value", () => {
    const config = validateDispatchConfig(
      minimal({
        enabled: true,
        quietHours: 0,
        retryCooldownMinutes: 5,
        ownerBackpressure: 10,
        excludeProjects: [TEST_IDENTITIES.projects.integration],
        t3: { bin: "/opt/t3", mode: "auto" },
        codex: { bin: "~/.local/bin/codex" },
        workers: [
          { host: "worker-a", ssh: "agent@worker-a", slots: 2, t3Bin: "~/.t3/bin/t3", codexBin: "/opt/codex", dclHome: "~/dcl", shell: "/bin/bash" },
          { host: HOST, slots: 1, kinds: ["merge"] },
        ],
      }),
    );
    expect(config.enabled).toBe(true);
    expect(config.quietHours).toBe(0);
    expect(config.ownerBackpressure).toBe(10);
    expect(config.excludeProjects).toEqual([TEST_IDENTITIES.projects.integration]);
    expect(config.t3).toEqual({ bin: "/opt/t3", mode: "auto" });
    expect(config.codex).toEqual({ bin: "~/.local/bin/codex" });
    expect(config.workers).toEqual([
      { host: "worker-a", ssh: "agent@worker-a", slots: 2, kinds: ["build", "verify", "merge"], t3Bin: "~/.t3/bin/t3", codexBin: "/opt/codex", dclHome: "~/dcl", shell: "/bin/bash" },
      { host: HOST, slots: 1, kinds: ["merge"] },
    ]);
  });

  test.each([
    ["maxThreads", minimal({ maxThreads: 3 }), "dispatch.maxThreads was removed: worker slots are the only limit (set workers[].slots)"],
    ["maxPerProject", minimal({ maxPerProject: 2 }), "dispatch.maxPerProject was removed"],
    ["a lane maxThreads", minimal({ lanes: [{ name: "claude", provider: "p", model: "m", maxThreads: 1 }] }), "dispatch.lanes[0].maxThreads was removed"],
  ])("rejects the removed limit %s with a pointer to slots", (_name, raw, message) => {
    expect(() => validateDispatchConfig(raw)).toThrow(message);
  });

  test.each([
    ["not an object", [], "dispatch must be an object"],
    ["missing host", { lanes: [{ name: "a", provider: "p", model: "m" }], workers: [], executors: EXECUTORS }, "dispatch.host"],
    ["no lanes", minimal({ lanes: [] }), "dispatch.lanes"],
    ["bad lane name", minimal({ lanes: [{ name: "Claude-1", provider: "p", model: "m" }] }), "dispatch.lanes[0].name"],
    ["duplicate lane", minimal({ lanes: [{ name: "a", provider: "p", model: "m" }, { name: "a", provider: "p", model: "m" }] }), "duplicate"],
    ["lane without model", minimal({ lanes: [{ name: "a", provider: "p" }] }), "dispatch.lanes[0].model"],
    ["unknown key", minimal({ maxthreads: 3 }), "dispatch.maxthreads is not a recognized key"],
    ["unknown lane key", minimal({ lanes: [{ name: "a", provider: "p", model: "m", effort: "x" }] }), "dispatch.lanes[0].effort"],
    ["unknown t3 key", minimal({ t3: { bin: "t3", project: "x" } }), "dispatch.t3.project"],
    ["unknown codex key", minimal({ codex: { bin: "codex", model: "x" } }), "dispatch.codex.model"],
    ["enabled not boolean", minimal({ enabled: "yes" }), "dispatch.enabled"],
    ["a mode other than auto", minimal({ t3: { mode: "full-access" } }), 'dispatch.t3.mode must be "auto"'],
    ["a relative t3 path", minimal({ t3: { bin: "tools/t3" } }), "dispatch.t3.bin"],
    ["negative quietHours", minimal({ quietHours: -1 }), "dispatch.quietHours"],
    ["excludeProjects not strings", minimal({ excludeProjects: [1] }), "dispatch.excludeProjects"],
    ["no workers", minimal({ workers: [] }), "dispatch.workers must be a non-empty list"],
    ["a worker without ssh that is not the control host", minimal({ workers: [{ host: "worker-a", slots: 1 }] }), "dispatch.workers[0].ssh is required"],
    ["zero slots", minimal({ workers: [{ host: "worker-a", ssh: "a@b", slots: 0 }] }), "dispatch.workers[0].slots must be an integer >= 1"],
    ["missing slots", minimal({ workers: [{ host: "worker-a", ssh: "a@b" }] }), "dispatch.workers[0].slots"],
    ["a duplicate worker", minimal({ workers: [{ host: "worker-a", ssh: "a@b", slots: 1 }, { host: "worker-a", ssh: "a@c", slots: 1 }] }), "duplicate worker"],
    ["a host that is no slot token", minimal({ workers: [{ host: "Worker_A", ssh: "a@b", slots: 1 }] }), "dispatch.workers[0].host must be a host token"],
    ["an ssh option", minimal({ workers: [{ host: "worker-a", ssh: "-oProxyCommand=x", slots: 1 }] }), "dispatch.workers[0].ssh must be an SSH destination"],
    ["an unknown kind", minimal({ workers: [{ host: "worker-a", ssh: "a@b", slots: 1, kinds: ["deploy"] }] }), 'dispatch.workers[0].kinds: "deploy"'],
    ["empty kinds", minimal({ workers: [{ host: "worker-a", ssh: "a@b", slots: 1, kinds: [] }] }), "dispatch.workers[0].kinds"],
    ["an unknown worker key", minimal({ workers: [{ host: "worker-a", ssh: "a@b", slots: 1, busy: true }] }), "dispatch.workers[0].busy"],
    ["a relative worker executable", minimal({ workers: [{ host: "worker-a", ssh: "a@b", slots: 1, codexBin: "bin/codex" }] }), "dispatch.workers[0].codexBin must be a command name"],
    ["no executors", minimal({ executors: undefined }), "dispatch.executors must be an object"],
    ["a kind without an executor", minimal({ executors: { build: EXECUTORS.build, verify: EXECUTORS.verify } }), "dispatch.executors.merge is required"],
    ["an unknown executor type", minimal({ executors: { ...EXECUTORS, merge: { type: "shell" } } }), "dispatch.executors.merge.type"],
    ["a t3 executor on an unknown lane", minimal({ executors: { ...EXECUTORS, build: { type: "t3", lane: "other" } } }), 'dispatch.executors.build.lane "other"'],
    ["a codex executor without a model", minimal({ executors: { ...EXECUTORS, verify: { type: "codex-cli" } } }), "dispatch.executors.verify.model"],
    ["an unknown kind of executor", minimal({ executors: { ...EXECUTORS, deploy: EXECUTORS.verify } }), "dispatch.executors.deploy"],
  ])("rejects %s", (_name, raw, message) => {
    expect(() => validateDispatchConfig(raw)).toThrow(message);
  });

  test("an executable may not point into a project repository, in either spelling", () => {
    const repos = ["~/workspace/household-app", "/srv/daybook"];
    const worker = (codexBin: string) => minimal({ workers: [{ host: "worker-a", ssh: "a@b", slots: 1, codexBin }] });
    expect(() => validateDispatchConfig(worker("~/workspace/household-app/bin/codex"), repos)).toThrow("must not point into a project repository");
    expect(() => validateDispatchConfig(worker("/home/agent/workspace/household-app/codex"), repos)).toThrow("must not point into a project repository");
    expect(() => validateDispatchConfig(worker("/srv/daybook/codex"), repos)).toThrow("must not point into a project repository");
    expect(() => validateDispatchConfig(minimal({ t3: { bin: "~/workspace/household-app/t3" } }), repos)).toThrow("dispatch.t3.bin must not point into");
    expect(validateDispatchConfig(worker("~/.local/bin/codex"), repos).workers[0]!.codexBin).toBe("~/.local/bin/codex");
    expect(validateDispatchConfig(worker("codex"), repos).workers[0]!.codexBin).toBe("codex");
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
      // A refused dispatch section leaves the rest of the configuration usable.
      writeFileSync(join(root, "loops.json"), JSON.stringify({ owner: TEST_IDENTITIES.owner, dispatch: minimal({ bogus: 1 }) }));
      const refused = loadConfig(root);
      expect(refused.dispatch).toBeUndefined();
      expect(refused.dispatchError).toContain("dispatch.bogus");
      expect(refused.owner).toBe(TEST_IDENTITIES.owner);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
