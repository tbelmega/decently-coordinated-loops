#!/usr/bin/env bun
// Test double for `ssh`, used by the dispatch tests. It runs the remote command with
// /bin/sh in a per-destination fixture home, `$FAKE_SSH_ROOT/<destination>/home`, and
// appends each command to `$FAKE_SSH_ROOT/<destination>/calls.jsonl`. Knobs in
// `$FAKE_SSH_ROOT/<destination>/control.json`: `down` (connection fails, exit 255) and
// `dropReplyMatching` (a command containing this text runs, but its reply is lost: no
// output and exit 255, as when the connection drops after the remote side acted).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Control {
  down?: boolean;
  dropReplyMatching?: string;
}

const args = process.argv.slice(2);
while (args[0] === "-o") args.splice(0, 2);
const [destination, command] = args;
if (!destination || command === undefined || args.length !== 2) {
  console.error("fake ssh: expected [-o option]... destination command");
  process.exit(254);
}
const dir = join(process.env.FAKE_SSH_ROOT!, destination);
const home = join(dir, "home");
mkdirSync(home, { recursive: true });
const controlPath = join(dir, "control.json");
const control: Control = existsSync(controlPath) ? (JSON.parse(readFileSync(controlPath, "utf8")) as Control) : {};
appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(command)}\n`);
if (control.down) {
  console.error(`ssh: connect to host ${destination} port 22: Operation timed out`);
  process.exit(255);
}
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SHELL: "/bin/sh" };
delete env.XDG_STATE_HOME;
const result = spawnSync("/bin/sh", ["-c", command], { input: readFileSync(0), env, encoding: "utf8" });
if (control.dropReplyMatching && command.includes(control.dropReplyMatching)) process.exit(255);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 255);
