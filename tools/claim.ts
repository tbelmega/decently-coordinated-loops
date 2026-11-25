// Text-in, text-out edits of one item file for the claim, release and park writes of central
// dispatch: a fixed set of frontmatter fields plus one appended log line. Every other byte of
// the file is kept as written, so a diff shows exactly what the write changed. Pure.
import type { ProjectLifecycle } from "./config.ts";
import { parse as parseYaml } from "yaml";
import { parseItemFileText } from "./parse.ts";
import type { ItemFile } from "./types.ts";
import { validateItem } from "./validate.ts";

/** The fields a dispatch write may change, besides `updated`. */
export const CLAIM_FIELDS = ["assignee", "state", "nextActor", "awaiting", "nextStep", "updated", "executionHost", "executionWorktree"] as const;
export type ClaimField = (typeof CLAIM_FIELDS)[number];

/** Stored values of the claim fields; null means the field is absent. */
export type ClaimFieldValues = Partial<Record<ClaimField, string | null>>;

export interface ItemEdit {
  /** Fields to set; null removes the field. */
  fields: ClaimFieldValues;
  /** One log line without the leading "- ", e.g. "2026-11-22: Claimed ...". */
  log: string;
}

const TOP_LEVEL_KEY: Record<Exclude<ClaimField, "executionHost" | "executionWorktree">, string> = {
  assignee: "assignee",
  state: "state",
  nextActor: "next-actor",
  awaiting: "awaiting",
  nextStep: "next-step",
  updated: "updated",
};

/** Where a newly added key goes: after the first of these keys that exists. */
const INSERT_AFTER: Record<string, string[]> = {
  assignee: ["state", "project", "title"],
  state: ["project", "title"],
  "next-actor": ["autonomy", "assignee", "state"],
  awaiting: ["next-actor", "autonomy", "state"],
  "next-step": ["depends-on", "fit", "awaiting", "next-actor"],
  updated: ["next-step"],
};

const PLAIN_SCALAR = /^[A-Za-z/][A-Za-z0-9._/-]*$/;
const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;
const YAML_KEYWORDS = new Set(["true", "false", "null", "yes", "no", "on", "off", "y", "n", "nan", "inf"]);

/** A YAML scalar that reads back as this exact string: plain where that is unambiguous
 * (words, and dates, which the board's YAML schema keeps as strings), quoted otherwise. */
function scalar(value: string): string {
  if (PLAIN_DATE.test(value)) return value;
  if (PLAIN_SCALAR.test(value) && !YAML_KEYWORDS.has(value.toLowerCase())) return value;
  return JSON.stringify(value);
}

/** Index range [start, end) of the top-level key's line plus its indented continuation lines. */
function keyRange(lines: string[], key: string): [number, number] | null {
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end]!)) end++;
  return [start, end];
}

function setTopLevel(lines: string[], key: string, value: string | null): void {
  // An item still on the legacy `owner:` key moves to `assignee:` when its assignment is
  // written, as any substantive update does (loops-board).
  if (key === "assignee" && !keyRange(lines, "assignee") && keyRange(lines, "owner")) {
    const legacy = keyRange(lines, "owner")!;
    lines.splice(legacy[0], legacy[1] - legacy[0], `assignee: ${scalar(value ?? "-")}`);
    return;
  }
  const range = keyRange(lines, key);
  if (value === null) {
    if (range) lines.splice(range[0], range[1] - range[0]);
    return;
  }
  const line = `${key}: ${scalar(value)}`;
  if (range) {
    lines.splice(range[0], range[1] - range[0], line);
    return;
  }
  for (const anchor of INSERT_AFTER[key] ?? []) {
    const at = keyRange(lines, anchor);
    if (at) {
      lines.splice(at[1], 0, line);
      return;
    }
  }
  lines.push(line);
}

/** Rewrites an inline `execution: {host: x, worktree: y}` mapping as the equivalent block. */
function toBlockExecution(lines: string[], [start, end]: [number, number]): void {
  const parsed = parseYaml(lines.slice(start, end).join("\n")) as { execution?: unknown };
  const mapping = parsed?.execution;
  if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) throw new Error("execution must be a mapping");
  const block = ["execution:"];
  for (const [key, value] of Object.entries(mapping)) {
    if (typeof value !== "string") throw new Error(`execution.${key} must be a string`);
    block.push(`  ${key}: ${scalar(value)}`);
  }
  lines.splice(start, end - start, ...block);
}

function setExecutionChild(lines: string[], child: "host" | "worktree", value: string | null): void {
  const range = keyRange(lines, "execution");
  if (!range) {
    if (value !== null) lines.push("execution:", `  ${child}: ${scalar(value)}`);
    return;
  }
  if (lines[range[0]]!.trim() !== "execution:") toBlockExecution(lines, range);
  const [start, end] = keyRange(lines, "execution")!;
  const childIndex = lines.slice(start + 1, end).findIndex((line) => new RegExp(`^\\s+${child}:`).test(line));
  if (value === null) {
    if (childIndex === -1) return;
    lines.splice(start + 1 + childIndex, 1);
    if (end - start - 1 === 1) lines.splice(start, 1);
    return;
  }
  const line = `  ${child}: ${scalar(value)}`;
  if (childIndex === -1) lines.splice(start + 1, 0, line);
  else lines[start + 1 + childIndex] = line;
}

function appendLog(body: string, log: string): string {
  const entry = `- ${log}`;
  const lines = body.split("\n");
  const heading = lines.findIndex((line) => line.trim() === "## Log");
  if (heading === -1) {
    const trimmed = body.replace(/\n*$/, "");
    return `${trimmed}\n\n## Log\n${entry}\n`;
  }
  let end = heading + 1;
  while (end < lines.length && !/^#{1,2} /.test(lines[end]!)) end++;
  let insertAt = end;
  while (insertAt > heading + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
  lines.splice(insertAt, 0, entry);
  return lines.join("\n");
}

/** Applies one dispatch write to an item file's text. Throws when the item has frontmatter
 * errors before the edit, or when the edit adds a validation message. */
export function applyItemEdit(path: string, text: string, edit: ItemEdit, lifecycle?: ProjectLifecycle): string {
  const before = parseItemFileText(path, text);
  if (before.frontmatterErrors?.length) {
    throw new Error(`${path}: refusing to edit an item with frontmatter errors: ${before.frontmatterErrors.join("; ")}`);
  }
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) throw new Error(`${path}: no frontmatter block`);
  const lines = match[1]!.split("\n");
  for (const [field, value] of Object.entries(edit.fields)) {
    if (value === undefined) continue;
    if (field === "executionHost") setExecutionChild(lines, "host", value);
    else if (field === "executionWorktree") setExecutionChild(lines, "worktree", value);
    else setTopLevel(lines, TOP_LEVEL_KEY[field as keyof typeof TOP_LEVEL_KEY], value);
  }
  const rest = text.slice(match[0].length);
  const result = `---\n${lines.join("\n")}\n---${appendLog(rest, edit.log)}`;

  const after = parseItemFileText(path, result);
  const known = new Set(validateItem(before, lifecycle));
  const added = validateItem(after, lifecycle).filter((message) => !known.has(message));
  if (added.length) throw new Error(`${path}: the edit would not validate: ${added.join("; ")}`);
  return result;
}

/** The stored values of the claim fields on a parsed item. */
export function readClaimFields(item: ItemFile): Required<ClaimFieldValues> {
  return {
    assignee: item.assignee,
    state: item.state,
    nextActor: item.nextActor,
    awaiting: item.awaiting ?? null,
    nextStep: item.nextStep,
    updated: item.updated,
    executionHost: item.execution?.host ?? null,
    executionWorktree: item.execution?.worktree ?? null,
  };
}

/** A log line that carries a claim token ends with `(dispatch <token>)` and a period. A
 * line that ends a claim (release, park) carries `(dispatch <token> ended)` instead, so it
 * never reads as the claim's own line. */
const TOKEN_AT_END = /\(dispatch (d-[0-9a-f]{8})\)\.?\s*$/;

/** The bullet lines of the item's `## Log` section. */
export function logLines(text: string): string[] {
  const lines = text.split("\n");
  const heading = lines.findIndex((line) => line.trim() === "## Log");
  if (heading === -1) return [];
  const result: string[] = [];
  for (let i = heading + 1; i < lines.length && !/^#{1,2} /.test(lines[i]!); i++) {
    if (lines[i]!.startsWith("- ")) result.push(lines[i]!);
  }
  return result;
}

const TOKEN_EVENT = /\(dispatch (d-[0-9a-f]{8})( ended)?\)\.?\s*$/;

/** The token of the claim that is active on the item: the newest dispatch line is a claim
 * (or a line a dispatched thread wrote under it) and no `(dispatch <token> ended)` line
 * follows it. Null when the newest dispatch event ended a claim, or there is none. */
export function activeClaimToken(text: string): string | null {
  let active: string | null = null;
  for (const line of logLines(text)) {
    const match = TOKEN_EVENT.exec(line);
    if (match) active = match[2] ? null : match[1]!;
  }
  return active;
}

/** The claim token of the newest log line that carries one, or null. */
export function newestDispatchToken(text: string): string | null {
  let newest: string | null = null;
  for (const line of logLines(text)) {
    const match = TOKEN_AT_END.exec(line);
    if (match) newest = match[1]!;
  }
  return newest;
}

/** The log lines that carry `token`. */
export function tokenLogLines(text: string, token: string): string[] {
  return logLines(text).filter((line) => TOKEN_AT_END.exec(line)?.[1] === token);
}
