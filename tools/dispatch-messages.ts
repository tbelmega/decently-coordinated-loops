// The fixed texts of central dispatch: thread titles, the messages it sends to a thread, and
// the log lines and next-step it writes on an item. No model writes any of them.
import type { DispatchKind } from "./dispatch-state.ts";

/** Every claim log line contains this, so the observer can tell the claim from the lines a
 * dispatched thread writes. */
export const CLAIM_LINE_MARKER = "Claimed by central dispatch";

export function claimTag(token: string): string {
  return `[${token}]`;
}

export function threadTitle(itemTitle: string, token: string): string {
  return `${itemTitle} ${claimTag(token)}`;
}

export function claimLog(date: string, host: string, lane: string, token: string): string {
  return `${date}: ${CLAIM_LINE_MARKER} for ${host}, lane ${lane} (dispatch ${token}).`;
}

export function releaseLog(date: string, reason: string, token: string): string {
  return `${date}: Released by central dispatch: ${reason}; the fields the claim wrote are restored where unchanged (dispatch ${token} ended).`;
}

/** What was parked, as the owner finds it: a T3 thread by its title, or a Codex job by its
 * worker and log file. */
export type ParkedJob = { kind: "thread"; title: string } | { kind: "codex-job"; token: string; worker: string; log: string };

function parkedName(job: ParkedJob): string {
  return job.kind === "thread" ? `the thread "${job.title}"` : `the Codex job ${job.token} on ${job.worker}`;
}

function lookAt(job: ParkedJob): string {
  return job.kind === "thread" ? "Look at the thread" : `Look at its log (${job.worker}:${job.log})`;
}

export function parkLog(date: string, reason: string, job: ParkedJob, token: string): string {
  return `${date}: Parked by central dispatch: ${parkedName(job)} stopped without finishing (${reason}) (dispatch ${token} ended).`;
}

export function parkNextStep(owner: string, job: ParkedJob, reason: string, previousState: string): string {
  const who = owner || "Owner";
  return `${who}: ${parkedName(job)} started by central dispatch stopped without finishing (${reason}). ${lookAt(job)}, then set the item back to ${previousState} with next-actor agent, or decide otherwise.`;
}

export function handshakeMessage(token: string): string {
  return [
    `This thread was started by DCL central dispatch (dispatch ${token}).`,
    'Reply with the single word "ready" and do nothing else. Your work follows in the next message.',
  ].join("\n");
}

const KIND_TEXT: Record<DispatchKind, string> = {
  verify: "verify the merged item (loops-pickup, Verify an integrated item)",
  merge: "merge the implemented item as the project's merge policy allows (the loops-pickup integration reference)",
  build: "work the item: spec drafting when it has no concrete spec, otherwise implementation (loops-pickup steps 4 and 5)",
};

export interface WorkMessageInput {
  slug: string;
  title: string;
  kind: DispatchKind;
  host: string;
  lane: string;
  token: string;
}

export function workMessage(input: WorkMessageInput): string {
  return [
    `Central dispatch assigned you the board item ${input.slug} ("${input.title}").`,
    `Kind: ${input.kind}, ${KIND_TEXT[input.kind]}.`,
    `Host: ${input.host}. Lane: ${input.lane}. Claim token: ${input.token}.`,
    "The claim is already made and pushed; do not claim it again.",
    'Follow the "Dispatched item" section of the loops-pickup skill: pull the data repo your configuration names, re-read the item, and stop without working unless its newest dispatch log line carries your claim token.',
  ].join("\n");
}

export function resumeMessage(slug: string, token: string): string {
  return [
    `Central dispatch: this thread stopped while the board item ${slug} still carries your claim (dispatch ${token}) and no line from you.`,
    'Continue this item from its log, following the "Dispatched item" section of the loops-pickup skill. If you cannot continue, park the item for the owner as that section says.',
  ].join("\n");
}
