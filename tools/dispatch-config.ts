// The optional `dispatch` section of loops.json: central dispatch, the program that assigns
// eligible board items and starts one agent thread per item (cli-dispatch.ts). Absent means
// central dispatch is off. Validation fails closed on unknown keys, like the review block.
import { TOOL_PATTERN } from "./slots.ts";

/** A named way to run a thread: one provider and model, with its own thread limit. The name
 * doubles as the slot tool name, so it must be one token of lowercase letters and digits. */
export interface DispatchLane {
  name: string;
  provider: string;
  model: string;
  maxThreads: number;
}

export interface DispatchT3Config {
  /** The `t3` executable: a name on PATH or an absolute path. */
  bin: string;
  /** The permission mode every dispatched thread must report before it gets its work. */
  mode: string;
}

export interface DispatchConfig {
  /** False lets `plan` and `status` work and makes `tick` refuse. */
  enabled: boolean;
  /** The control host: `plan` and `tick` refuse a different `--host`. */
  host: string;
  maxThreads: number;
  maxPerProject: number;
  /** An item whose file had a commit within this many hours is skipped. */
  quietHours: number;
  /** How long a lane starts nothing after a failed start or a park. */
  retryCooldownMinutes: number;
  /** With more open stopped asks in the outbox than this, only `verify` starts. Off when absent. */
  ownerBackpressure?: number;
  excludeProjects: string[];
  t3: DispatchT3Config;
  lanes: DispatchLane[];
}

export const DISPATCH_DEFAULTS = { maxPerProject: 2, quietHours: 6, retryCooldownMinutes: 60 } as const;

const TOP_KEYS = [
  "enabled",
  "host",
  "maxThreads",
  "maxPerProject",
  "quietHours",
  "retryCooldownMinutes",
  "ownerBackpressure",
  "excludeProjects",
  "t3",
  "lanes",
] as const;
const LANE_KEYS = ["name", "provider", "model", "maxThreads"] as const;
const T3_KEYS = ["bin", "mode"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** A command name looked up on PATH, or an absolute path; never a path relative to the data
 * repo, so a board change cannot point the control host at a file it just committed. */
function commandOrAbsolutePath(value: unknown, label: string): string {
  const text = nonEmptyString(value, label);
  if (/^[A-Za-z0-9._-]+$/.test(text) || text.startsWith("/")) return text;
  throw new Error(`${label} must be a command name or an absolute path`);
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

/** Validates the raw `dispatch` value from loops.json and fills its defaults. Throws a
 * message naming the offending key on any malformed shape. */
export function validateDispatchConfig(raw: unknown): DispatchConfig {
  const label = "dispatch";
  if (!isRecord(raw)) throw new Error(`${label} must be an object`);
  rejectUnknownKeys(raw, TOP_KEYS, label);

  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error(`${label}.enabled must be a boolean`);
  const host = nonEmptyString(raw.host, `${label}.host`);
  if (raw.maxThreads === undefined) throw new Error(`${label}.maxThreads is required`);
  const maxThreads = integer(raw.maxThreads, `${label}.maxThreads`, 1);

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
      bin: raw.t3.bin === undefined ? "t3" : commandOrAbsolutePath(raw.t3.bin, `${label}.t3.bin`),
      mode: raw.t3.mode === undefined ? "auto" : onlyAuto(raw.t3.mode, `${label}.t3.mode`),
    };
  }

  if (!Array.isArray(raw.lanes) || raw.lanes.length === 0) throw new Error(`${label}.lanes must be a non-empty list`);
  const seen = new Set<string>();
  const lanes = raw.lanes.map((lane, index): DispatchLane => {
    const path = `${label}.lanes[${index}]`;
    if (!isRecord(lane)) throw new Error(`${path} must be an object`);
    rejectUnknownKeys(lane, LANE_KEYS, path);
    const name = nonEmptyString(lane.name, `${path}.name`);
    if (!TOOL_PATTERN.test(name)) throw new Error(`${path}.name must be one token of lowercase letters and digits`);
    if (seen.has(name)) throw new Error(`${path}.name: duplicate lane name "${name}"`);
    seen.add(name);
    return {
      name,
      provider: nonEmptyString(lane.provider, `${path}.provider`),
      model: nonEmptyString(lane.model, `${path}.model`),
      maxThreads: optionalInteger(lane.maxThreads, `${path}.maxThreads`, 1, maxThreads),
    };
  });

  return {
    enabled: raw.enabled ?? false,
    host,
    maxThreads,
    maxPerProject: optionalInteger(raw.maxPerProject, `${label}.maxPerProject`, 1, DISPATCH_DEFAULTS.maxPerProject),
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
    lanes,
  };
}
