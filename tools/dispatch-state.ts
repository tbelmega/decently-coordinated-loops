// The two files central dispatch keeps besides configuration: the committed control file
// (pause flags, live coordination data in the data repo) and the state file outside the
// repository (what the program has dispatched and lane cooldowns). The state file is
// written atomically and only while the data repo's lock is held.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ClaimFieldValues } from "./claim.ts";

export type DispatchKind = "verify" | "merge" | "build";

/** starting: claimed, no thread id recorded; started: thread id recorded, work not
 * confirmed sent; running: work message sent. */
export type EntryPhase = "starting" | "started" | "running";

export interface DispatchEntry {
  slug: string;
  project: string;
  kind: DispatchKind;
  lane: string;
  token: string;
  phase: EntryPhase;
  /** The thread title, which ends with the claim tag. */
  title: string;
  threadId?: string;
  /** ISO time the claim was made. */
  claimedAt: string;
  /** The item's state right after the claim. */
  claimState: string;
  /** Values the claim replaced, restored by a release where unchanged since. */
  replaced: ClaimFieldValues;
  /** Values the claim wrote. */
  wrote: ClaimFieldValues;
  /** Every claim field right after the claim; cleanup that overwrites fields (park)
   * happens only while the item still matches it. */
  claimed: ClaimFieldValues;
  /** True once `thread start` was called, so a start that is later found to have failed
   * still cools the lane down. */
  startAttempted: boolean;
  /** Successful "continue" sends. */
  resumes: number;
  /** Failed "continue" sends. */
  sendFailures: number;
}

export interface DispatchState {
  version: 1;
  entries: DispatchEntry[];
  /** Lane name -> ISO time its cooldown ends. */
  cooldowns: Record<string, string>;
}

export function emptyState(): DispatchState {
  return { version: 1, entries: [], cooldowns: {} };
}

export const CONTROL_FILE = "dispatch-control.json";

export interface DispatchControl {
  paused: boolean;
  pausedProjects: string[];
  note: string;
}

export function defaultControl(): DispatchControl {
  return { paused: false, pausedProjects: [], note: "" };
}

/** Reads the control file; absent means not paused. Throws on a malformed file, since a
 * pause that cannot be read must not be taken for "not paused". */
export function readControl(root: string): DispatchControl {
  const path = join(root, CONTROL_FILE);
  if (!existsSync(path)) return defaultControl();
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DispatchControl>;
  if (typeof raw !== "object" || raw === null) throw new Error(`${CONTROL_FILE} must be an object`);
  if (raw.paused !== undefined && typeof raw.paused !== "boolean") throw new Error(`${CONTROL_FILE}: paused must be a boolean`);
  if (raw.pausedProjects !== undefined && (!Array.isArray(raw.pausedProjects) || !raw.pausedProjects.every((p) => typeof p === "string"))) {
    throw new Error(`${CONTROL_FILE}: pausedProjects must be a list of project names`);
  }
  return { paused: raw.paused ?? false, pausedProjects: raw.pausedProjects ?? [], note: typeof raw.note === "string" ? raw.note : "" };
}

export function controlText(control: DispatchControl): string {
  return `${JSON.stringify(control, null, 2)}\n`;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The state file for a data repo clone: under DCL_DISPATCH_STATE_DIR, else the user's state
 * directory, keyed by the clone's canonical path (a moved clone has no state file). */
export function statePath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.DCL_DISPATCH_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state"), "dcl", "dispatch");
  const key = createHash("sha256").update(canonical(root)).digest("hex").slice(0, 16);
  return join(base, `${key}.json`);
}

export function readState(path: string): DispatchState | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as DispatchState;
  if (raw.version !== 1 || !Array.isArray(raw.entries)) throw new Error(`${path}: not a dispatch state file`);
  return { version: 1, entries: raw.entries, cooldowns: raw.cooldowns ?? {} };
}

export function writeState(path: string, state: DispatchState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, path);
}
