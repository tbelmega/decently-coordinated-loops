// Creates a fake `t3` executable backed by test-fake-t3.ts, for tests only.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeT3 {
  /** Path of the executable to configure as `dispatch.t3.bin`. */
  bin: string;
  /** Environment that points the executable at its state file. */
  env: NodeJS.ProcessEnv;
  read(): FakeT3State;
  update(change: (state: FakeT3State) => void): void;
}

export interface FakeT3Thread {
  threadId: string;
  projectPath: string;
  title: string;
  status: string;
  runtimeMode: string;
  pendingRequestCount: number;
  messages: { role: string; text: string }[];
}

export interface FakeT3State {
  projects: string[];
  threads: FakeT3Thread[];
  calls: string[][];
  unreachable?: boolean;
  failStart?: boolean;
  loseStartOutput?: boolean;
  failSend?: boolean;
  mode?: string;
  nextId?: number;
}

export function createFakeT3(projects: string[], dir = mkdtempSync(join(tmpdir(), "dcl-fake-t3-"))): FakeT3 {
  const statePath = join(dir, "fake-t3-state.json");
  const bin = join(dir, "t3");
  writeFileSync(statePath, JSON.stringify({ projects, threads: [], calls: [] } satisfies FakeT3State));
  writeFileSync(bin, `#!/bin/sh\nexec bun "${join(import.meta.dir, "test-fake-t3.ts")}" "$@"\n`);
  chmodSync(bin, 0o755);
  const read = () => JSON.parse(readFileSync(statePath, "utf8")) as FakeT3State;
  return {
    bin,
    env: { ...process.env, FAKE_T3_STATE: statePath },
    read,
    update(change) {
      const state = read();
      change(state);
      writeFileSync(statePath, JSON.stringify(state));
    },
  };
}
