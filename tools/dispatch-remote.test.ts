import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandLine, GUARD_FUNCTIONS, GUARD_REFUSED, remoteRunner, routeFor, word, wrapLogin } from "./dispatch-remote.ts";
import { validateDispatchConfig } from "./dispatch-config.ts";

describe("quoting", () => {
  test("a literal reaches the worker's shell unchanged, except a leading ~/", () => {
    const home = mkdtempSync(join(tmpdir(), "dcl-remote-home-"));
    const values = ["plain", "with space", "it's", '"$HOME"', "$(touch nope)", "~/work/repo", "~", "a;b|c&d"];
    const r = spawnSync("/bin/sh", ["-c", `printf '%s\\n' ${commandLine(values)}`], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    expect(r.stdout.trim().split("\n")).toEqual(["plain", "with space", "it's", '"$HOME"', "$(touch nope)", `${home}/work/repo`, home, "a;b|c&d"]);
    expect(word({ raw: "$X" })).toBe("$X");
  });

  test("commands run through the configured login shell, or the worker's $SHELL", () => {
    const dispatch = validateDispatchConfig({
      host: "control",
      lanes: [{ name: "claude", provider: "p", model: "m" }],
      workers: [
        { host: "worker-a", ssh: "a@a", slots: 1 },
        { host: "worker-b", ssh: "a@b", slots: 1, shell: "/bin/bash", codexBin: "~/bin/codex" },
      ],
      executors: { build: { type: "t3", lane: "claude" }, verify: { type: "codex-cli", model: "x" }, merge: { type: "codex-cli", model: "x" } },
    });
    const [a, b] = dispatch.workers.map((worker) => routeFor(worker, dispatch));
    expect(a).toEqual({ host: "worker-a", ssh: "a@a", t3Bin: "t3", codexBin: "codex" });
    expect(b).toEqual({ host: "worker-b", ssh: "a@b", shell: "/bin/bash", t3Bin: "t3", codexBin: "~/bin/codex" });
    expect(wrapLogin(a!, "echo hi")).toBe(`exec "$SHELL" -lc 'echo hi'`);
    expect(wrapLogin(b!, "echo 'hi'")).toBe(`exec '/bin/bash' -lc 'echo '\\''hi'\\'''`);
  });

  test("a local route runs the same shell text without SSH; stdin carries the input", () => {
    const remote = remoteRunner();
    const result = remote.run({ host: "here", shell: "/bin/sh", t3Bin: "t3", codexBin: "codex" }, ["cat"], { input: "message body", timeoutMs: 10_000 });
    expect(result).toMatchObject({ reached: true, status: 0, stdout: "message body" });
  });

  test("an SSH connection failure is not reached; a remote command's own failure is", () => {
    const route = { host: "w", ssh: "a@w", t3Bin: "t3", codexBin: "codex" };
    const failing = remoteRunner({ sshBin: join(import.meta.dir, "test-ssh-255.sh") });
    expect(failing.run(route, ["true"], { timeoutMs: 5_000 }).reached).toBe(false);
  });
});

describe("executable guard", () => {
  // A host with guard roots `~/work`, a checkout there holding an executable, and a symlink
  // to it from outside every root.
  function host() {
    const home = mkdtempSync(join(tmpdir(), "dcl-guard-home-"));
    mkdirSync(join(home, ".config/dcl"), { recursive: true });
    writeFileSync(join(home, ".config/dcl/guard-roots"), "~/work\n");
    mkdirSync(join(home, "work/repo"), { recursive: true });
    writeFileSync(join(home, "work/repo/tool"), "#!/bin/sh\n");
    chmodSync(join(home, "work/repo/tool"), 0o755);
    mkdirSync(join(home, "bin"));
    symlinkSync(join(home, "work/repo/tool"), join(home, "bin/tool"));
    writeFileSync(join(home, "bin/plain"), "#!/bin/sh\n");
    chmodSync(join(home, "bin/plain"), 0o755);
    return home;
  }
  const guard = (home: string, path: string, extraPath?: string) =>
    spawnSync("/bin/sh", ["-c", `${GUARD_FUNCTIONS}\ndcl_guard tool ${path}\necho passed`], {
      env: { PATH: `${extraPath ? `${extraPath}:` : ""}${process.env.PATH}`, HOME: home },
      encoding: "utf8",
    });

  test("a symlink into a guarded root is refused; a plain executable outside passes", () => {
    const home = host();
    expect(guard(home, join(home, "bin/tool")).status).toBe(GUARD_REFUSED);
    expect(guard(home, join(home, "bin/plain")).stdout).toContain("passed");
  });

  test("when realpath fails or is missing, an existing path is refused", () => {
    const home = host();
    const broken = mkdtempSync(join(tmpdir(), "dcl-guard-bin-"));
    writeFileSync(join(broken, "realpath"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(broken, "realpath"), 0o755);
    expect(guard(home, join(home, "bin/plain"), broken).status).toBe(GUARD_REFUSED);
    const missing = spawnSync("/bin/sh", ["-c", `${GUARD_FUNCTIONS}\ndcl_guard tool ${join(home, "bin/plain")}\necho passed`], {
      env: { PATH: "/nonexistent", HOME: home },
      encoding: "utf8",
    });
    expect(missing.status).toBe(GUARD_REFUSED);
    expect(missing.stderr).toContain("realpath is not installed");
  });
});
