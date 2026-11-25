#!/usr/bin/env bun
// Test double for the T3 Code `t3` command, used by the dispatch tests. It keeps its "server"
// in the JSON file named by FAKE_T3_STATE and appends every invocation to that file's `calls`.
// Output shapes and error texts copy what `t3` 0.1.9 printed on a real server (names
// replaced). Knobs in the state file: `unreachable`, `failStart`, `loseStartOutput`,
// `mode` (runtime mode of new threads), `projects` (known project paths), `failSend`.
import { readFileSync, writeFileSync } from "node:fs";

interface FakeThread {
  threadId: string;
  projectPath: string;
  title: string;
  status: string;
  runtimeMode: string;
  pendingRequestCount: number;
  messages: { role: string; text: string }[];
}

interface FakeState {
  projects: string[];
  threads: FakeThread[];
  calls: string[][];
  unreachable?: boolean;
  failStart?: boolean;
  loseStartOutput?: boolean;
  failSend?: boolean;
  mode?: string;
  nextId?: number;
}

const statePath = process.env.FAKE_T3_STATE;
if (!statePath) {
  console.error("FAKE_T3_STATE is not set");
  process.exit(3);
}
const state = JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
save();

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function view(thread: FakeThread) {
  const { messages: _messages, projectPath: _projectPath, ...rest } = thread;
  return { ...rest, projectId: "project-1", interactionMode: "default" };
}

if (state.unreachable) {
  console.error("Could not reach the T3 Code server.");
  process.exit(1);
}

const [group, command] = args;
if (group !== "thread") {
  console.error("unknown command");
  process.exit(1);
}

if (command === "list") {
  const project = flag("--project") ?? process.cwd();
  if (!state.projects.includes(project)) {
    console.log(`No T3 Code project matches '${project}'. Pass a project id or a path inside a project.`);
    process.exit(0);
  }
  console.log(JSON.stringify(state.threads.filter((t) => t.projectPath === project).map(view)));
  process.exit(0);
}

if (command === "start") {
  const project = args[2]!;
  if (!state.projects.includes(project)) {
    console.error(`No T3 Code project matches '${project}'. Pass a project id or a path inside a project.`);
    process.exit(1);
  }
  if (state.failStart) {
    console.error(`Provider instance "${flag("--provider")}" is disabled for project project-1.`);
    process.exit(1);
  }
  const message = args[3] === "-" ? readFileSync(0, "utf8") : args[3]!;
  state.nextId = (state.nextId ?? 0) + 1;
  const thread: FakeThread = {
    threadId: `mcp:thread-${state.nextId}`,
    projectPath: project,
    title: flag("--title") ?? message.split("\n")[0]!,
    status: "running",
    runtimeMode: state.mode ?? "auto",
    pendingRequestCount: 0,
    messages: [{ role: "user", text: message }],
  };
  state.threads.push(thread);
  save();
  if (state.loseStartOutput) process.exit(1);
  console.log(JSON.stringify({ threadId: thread.threadId, projectId: "project-1", runId: `run:${thread.threadId}:1` }));
  process.exit(0);
}

const threadId = args[2]!;
const thread = state.threads.find((t) => t.threadId === threadId);
if (!thread) {
  console.error(`Thread ${threadId} is no longer available.`);
  process.exit(1);
}

if (command === "show") {
  console.log(JSON.stringify({ thread: view(thread), messages: thread.messages.slice(-1) }));
  process.exit(0);
}

if (command === "send") {
  if (state.failSend) {
    console.error("send failed");
    process.exit(1);
  }
  const message = args[3] === "-" ? readFileSync(0, "utf8") : args[3]!;
  thread.messages.push({ role: "user", text: message });
  thread.status = "running";
  save();
  console.log(JSON.stringify({ threadId, status: "starting", delivery: "started" }));
  process.exit(0);
}

console.error("unknown command");
process.exit(1);
