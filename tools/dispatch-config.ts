// The optional `dispatch` section of loops.json: central dispatch, the program that assigns
// eligible board items and starts one job per item on a configured worker host
// (cli-dispatch.ts). Absent means central dispatch is off. Validation fails closed on unknown
// keys, like the review block.
import type { DispatchKind } from "./dispatch-state.ts";
import { TOOL_PATTERN } from "./slots.ts";

/** A named way to run a T3 Code thread: one provider and model. The name doubles as the
 * slot tool name, so it must be one token of lowercase letters and digits. */
export interface DispatchLane {
  name: string;
  provider: string;
  model: string;
}

export interface DispatchT3Config {
  /** The default `t3` executable of every worker (see `executable`). */
  bin: string;
  /** The permission mode every dispatched thread must report before it gets its work. */
  mode: string;
}

export interface DispatchCodexConfig {
  /** The default `codex` executable of every worker. */
  bin: string;
}

export const DISPATCH_KINDS: readonly DispatchKind[] = ["build", "verify", "merge"];

/** How one kind of work runs: as a T3 Code thread on a lane, or as a Codex CLI job. */
export type DispatchExecutor = { type: "t3"; lane: string } | { type: "codex-cli"; model: string };

export type ExecutorType = DispatchExecutor["type"];

/** A host that takes dispatched jobs. Executables are resolved on the worker itself. */
export interface DispatchWorker {
  /** The host token used in slot names and `execution.host`. */
  host: string;
  /** SSH destination; absent only for the control host, whose jobs run locally. */
  ssh?: string;
  /** How many jobs of any kind the worker runs at once. */
  slots: number;
  kinds: DispatchKind[];
  t3Bin?: string;
  codexBin?: string;
  /** The worker's DCL clone, which runs the job launcher. Absent: `$DCL_HOME` on the worker. */
  dclHome?: string;
  /** The login shell commands run through. Absent: the worker's `$SHELL`. */
  shell?: string;
}

export interface DispatchConfig {
  /** False lets `plan` and `status` work and makes `tick` refuse. */
  enabled: boolean;
  /** The control host: `plan` and `tick` refuse a different `--host`. */
  host: string;
  /** An item whose file had a commit within this many hours is skipped. */
  quietHours: number;
  /** How long a worker starts nothing after a failed start or a park. */
  retryCooldownMinutes: number;
  /** With more open stopped asks in the outbox than this, only `verify` starts. Off when absent. */
  ownerBackpressure?: number;
  excludeProjects: string[];
  t3: DispatchT3Config;
  codex: DispatchCodexConfig;
  lanes: DispatchLane[];
  workers: DispatchWorker[];
  executors: Record<DispatchKind, DispatchExecutor>;
}

export const DISPATCH_DEFAULTS = { quietHours: 6, retryCooldownMinutes: 60 } as const;

const TOP_KEYS = [
  "enabled",
  "host",
  "quietHours",
  "retryCooldownMinutes",
  "ownerBackpressure",
  "excludeProjects",
  "t3",
  "codex",
  "lanes",
  "workers",
  "executors",
] as const;
const LANE_KEYS = ["name", "provider", "model"] as const;
const T3_KEYS = ["bin", "mode"] as const;
const CODEX_KEYS = ["bin"] as const;
const WORKER_KEYS = ["host", "ssh", "slots", "kinds", "t3Bin", "codexBin", "dclHome", "shell"] as const;
/** Limits that existed before worker slots; named so an old configuration fails with a pointer. */
const REMOVED_LIMITS = ["maxThreads", "maxPerProject"] as const;
const REMOVED_LIMIT_MESSAGE = "was removed: worker slots are the only limit (set workers[].slots)";

/** A host token as slot names use it: lowercase letters, digits and inner hyphens. */
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectRemovedLimits(value: Record<string, unknown>, label: string): void {
  for (const key of REMOVED_LIMITS) {
    if (key in value) throw new Error(`${label}.${key} ${REMOVED_LIMIT_MESSAGE}`);
  }
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is not a recognized key (expected one of ${allowed.join(", ")})`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

/** True when `path` names something inside `repo`. Both may start with `~/`; an absolute
 * path is compared with a `~/` repo by the part after the home directory, which can only
 * over-reject. */
function insideRepo(path: string, repo: string): boolean {
  const trimmed = repo.replace(/\/+$/, "");
  if (path === trimmed || path.startsWith(`${trimmed}/`)) return true;
  if (trimmed.startsWith("~/") && path.startsWith("/")) return path.includes(`${trimmed.slice(1)}/`);
  return false;
}

/**
 * A command name looked up on PATH, an absolute path, or a `~/` path in the home directory
 * of the host that runs it; never a relative path and never a path inside a registered
 * project repository. The host resolves the value on its own filesystem, so a board change
 * can choose among programs already installed there but cannot supply one.
 */
export function executable(value: unknown, label: string, projectRepos: readonly string[]): string {
  const text = nonEmptyString(value, label);
  if (!/^[A-Za-z0-9._-]+$/.test(text) && !text.startsWith("/") && !text.startsWith("~/")) {
    throw new Error(`${label} must be a command name, an absolute path or a ~/ path`);
  }
  if (text.includes("/") && projectRepos.some((repo) => insideRepo(text, repo))) {
    throw new Error(`${label} must not point into a project repository`);
  }
  return text;
}

/** Dispatched threads run in "auto", the mode of the owner's own threads; another mode is a
 * decision this configuration cannot make. */
function onlyAuto(value: unknown, label: string): string {
  if (value !== "auto") throw new Error(`${label} must be "auto"`);
  return value;
}

function integer(value: unknown, label: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`${label} must be an integer >= ${min}`);
  }
  return value;
}

function optionalInteger(value: unknown, label: string, min: number, fallback: number): number {
  return value === undefined ? fallback : integer(value, label, min);
}

function kindList(value: unknown, label: string): DispatchKind[] {
  if (value === undefined) return [...DISPATCH_KINDS];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty list of kinds`);
  for (const kind of value) {
    if (!DISPATCH_KINDS.includes(kind as DispatchKind)) throw new Error(`${label}: "${String(kind)}" is not one of ${DISPATCH_KINDS.join(", ")}`);
  }
  return [...new Set(value as DispatchKind[])];
}

function validateLanes(raw: unknown, label: string): DispatchLane[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${label} must be a non-empty list`);
  const seen = new Set<string>();
  return raw.map((lane, index): DispatchLane => {
    const path = `${label}[${index}]`;
    if (!isRecord(lane)) throw new Error(`${path} must be an object`);
    rejectRemovedLimits(lane, path);
    rejectUnknownKeys(lane, LANE_KEYS, path);
    const name = nonEmptyString(lane.name, `${path}.name`);
    if (!TOOL_PATTERN.test(name)) throw new Error(`${path}.name must be one token of lowercase letters and digits`);
    if (seen.has(name)) throw new Error(`${path}.name: duplicate lane name "${name}"`);
    seen.add(name);
    return { name, provider: nonEmptyString(lane.provider, `${path}.provider`), model: nonEmptyString(lane.model, `${path}.model`) };
  });
}

function validateWorkers(raw: unknown, label: string, controlHost: string, projectRepos: readonly string[]): DispatchWorker[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${label} must be a non-empty list`);
  const seen = new Set<string>();
  return raw.map((worker, index): DispatchWorker => {
    const path = `${label}[${index}]`;
    if (!isRecord(worker)) throw new Error(`${path} must be an object`);
    rejectUnknownKeys(worker, WORKER_KEYS, path);
    const host = nonEmptyString(worker.host, `${path}.host`);
    if (!HOST_PATTERN.test(host)) throw new Error(`${path}.host must be a host token (lowercase letters, digits and inner hyphens)`);
    if (seen.has(host)) throw new Error(`${path}.host: duplicate worker "${host}"`);
    seen.add(host);
    let ssh: string | undefined;
    if (worker.ssh === undefined) {
      if (host !== controlHost) throw new Error(`${path}.ssh is required for a worker other than the control host`);
    } else {
      ssh = nonEmptyString(worker.ssh, `${path}.ssh`);
      // An SSH destination is one argument; a leading "-" would be read as an option.
      if (ssh.startsWith("-") || /\s/.test(ssh)) throw new Error(`${path}.ssh must be an SSH destination such as user@host`);
    }
    const result: DispatchWorker = { host, slots: integer(worker.slots, `${path}.slots`, 1), kinds: kindList(worker.kinds, `${path}.kinds`) };
    if (ssh !== undefined) result.ssh = ssh;
    for (const key of ["t3Bin", "codexBin", "dclHome", "shell"] as const) {
      if (worker[key] !== undefined) result[key] = executable(worker[key], `${path}.${key}`, projectRepos);
    }
    return result;
  });
}

function validateExecutors(raw: unknown, label: string, lanes: DispatchLane[]): Record<DispatchKind, DispatchExecutor> {
  if (!isRecord(raw)) throw new Error(`${label} must be an object with an executor for each of ${DISPATCH_KINDS.join(", ")}`);
  rejectUnknownKeys(raw, DISPATCH_KINDS, label);
  const result = {} as Record<DispatchKind, DispatchExecutor>;
  for (const kind of DISPATCH_KINDS) {
    const path = `${label}.${kind}`;
    const value = raw[kind];
    if (value === undefined) throw new Error(`${path} is required: every kind of work needs an executor`);
    if (!isRecord(value)) throw new Error(`${path} must be an object`);
    if (value.type === "t3") {
      rejectUnknownKeys(value, ["type", "lane"], path);
      const lane = nonEmptyString(value.lane, `${path}.lane`);
      if (!lanes.some((l) => l.name === lane)) throw new Error(`${path}.lane "${lane}" is not a configured lane`);
      result[kind] = { type: "t3", lane };
    } else if (value.type === "codex-cli") {
      rejectUnknownKeys(value, ["type", "model"], path);
      result[kind] = { type: "codex-cli", model: nonEmptyString(value.model, `${path}.model`) };
    } else throw new Error(`${path}.type must be "t3" or "codex-cli"`);
  }
  return result;
}

/** Validates the raw `dispatch` value from loops.json and fills its defaults. Throws a
 * message naming the offending key on any malformed shape. `projectRepos` are the
 * registered repositories' paths, which no configured executable may point into. */
export function validateDispatchConfig(raw: unknown, projectRepos: readonly string[] = []): DispatchConfig {
  const label = "dispatch";
  if (!isRecord(raw)) throw new Error(`${label} must be an object`);
  rejectRemovedLimits(raw, label);
  rejectUnknownKeys(raw, TOP_KEYS, label);

  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error(`${label}.enabled must be a boolean`);
  const host = nonEmptyString(raw.host, `${label}.host`);

  let excludeProjects: string[] = [];
  if (raw.excludeProjects !== undefined) {
    if (!Array.isArray(raw.excludeProjects) || !raw.excludeProjects.every((p) => typeof p === "string" && p !== "")) {
      throw new Error(`${label}.excludeProjects must be a list of project names`);
    }
    excludeProjects = [...raw.excludeProjects] as string[];
  }

  let t3: DispatchT3Config = { bin: "t3", mode: "auto" };
  if (raw.t3 !== undefined) {
    if (!isRecord(raw.t3)) throw new Error(`${label}.t3 must be an object`);
    rejectUnknownKeys(raw.t3, T3_KEYS, `${label}.t3`);
    t3 = {
      bin: raw.t3.bin === undefined ? "t3" : executable(raw.t3.bin, `${label}.t3.bin`, projectRepos),
      mode: raw.t3.mode === undefined ? "auto" : onlyAuto(raw.t3.mode, `${label}.t3.mode`),
    };
  }

  let codex: DispatchCodexConfig = { bin: "codex" };
  if (raw.codex !== undefined) {
    if (!isRecord(raw.codex)) throw new Error(`${label}.codex must be an object`);
    rejectUnknownKeys(raw.codex, CODEX_KEYS, `${label}.codex`);
    codex = { bin: raw.codex.bin === undefined ? "codex" : executable(raw.codex.bin, `${label}.codex.bin`, projectRepos) };
  }

  const lanes = validateLanes(raw.lanes, `${label}.lanes`);
  const workers = validateWorkers(raw.workers, `${label}.workers`, host, projectRepos);
  const executors = validateExecutors(raw.executors, `${label}.executors`, lanes);

  return {
    enabled: raw.enabled ?? false,
    host,
    quietHours: optionalInteger(raw.quietHours, `${label}.quietHours`, 0, DISPATCH_DEFAULTS.quietHours),
    retryCooldownMinutes: optionalInteger(
      raw.retryCooldownMinutes,
      `${label}.retryCooldownMinutes`,
      0,
      DISPATCH_DEFAULTS.retryCooldownMinutes,
    ),
    ownerBackpressure: raw.ownerBackpressure === undefined ? undefined : integer(raw.ownerBackpressure, `${label}.ownerBackpressure`, 0),
    excludeProjects,
    t3,
    codex,
    lanes,
    workers,
    executors,
  };
}
