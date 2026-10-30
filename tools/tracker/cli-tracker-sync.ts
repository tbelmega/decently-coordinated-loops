#!/usr/bin/env bun
// `bun run tracker-sync <phase>` - keep the board and its external trackers in step.
//
//   status    [--tracker <name>] [--apply]   project board state onto linked tickets
//   pull      [--tracker <name>] [--project <project>] [--apply]
//                                            file every open, unlinked ticket as an idea
//   reconcile [--tracker <name>] [--record]  list every mismatch with a recommendation;
//                                            --record notes each on its items instead
//                                            of an interview (unattended runs)
//   set <ticket> (--status <name> | --close | --reopen) [--apply]
//                                            one owner-approved ticket change
//   link <item-slug> <ticket-id>             name a ticket on an item (board side only)
//
// The board is the authority; the tracker is a projection of it. The status push moves
// tickets forward only, a ticket a human already moved further is left alone with a line
// on the item, and nothing is created on the tracker: the pull files board items and
// writes only the slug back onto the ticket. `set` is the one way to move a ticket against
// the push, and runs only on the owner's direct answer.
//
// Dry-run by default for every phase that writes. A host without the tracker's credential
// skips it quietly: every write is derived from board state, so a host with access catches
// up in bulk later.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveProjectTracker, type LoopsConfig } from "../config.ts";
import { formatSnapshotDate } from "../date.ts";
import { withLock } from "../lock.ts";
import { appendOutboxEntry, outboxHeading, replaceIfUnchanged, withOutboxLock } from "../outbox.ts";
import { loadArchiveDir, loadForDeliveryDir, loadItemsDir } from "../parse.ts";
import type { ItemFile } from "../types.ts";
import type { TrackerAdapter } from "./tracker-adapter.ts";
import { isTicketId, TICKET_ID_FORMS, type TrackerConfig } from "./tracker-config.ts";
import { missingCredential } from "./tracker-credential.ts";
import { GithubProjectsAdapter, ghRequest, projectOrg } from "./tracker-github.ts";
import { resolveItemTickets } from "./tracker-items.ts";
import { LinearAdapter, httpRequest } from "./tracker-linear.ts";
import { ticketKey, type PlannerItem } from "./tracker-plan.ts";
import { planPull, setItemTickets, type PullPlan } from "./tracker-pull.ts";
import { applyPullPlan } from "./tracker-pull-apply.ts";
import { mismatchNotes, planReconcile } from "./tracker-reconcile.ts";
import { appendItemNote, runStatusPhase, type StatusRunReport, type TrackerFailure } from "./tracker-status.ts";

const USAGE = `usage:
  bun run tracker-sync status [--tracker <name>] [--apply]
  bun run tracker-sync pull [--tracker <name>] [--project <project>] [--apply]
  bun run tracker-sync reconcile [--tracker <name>] [--record]
  bun run tracker-sync set <tracker>/<id> (--status <name> | --close | --reopen) [--apply]
  bun run tracker-sync link <item-slug> <ticket-id>`;

const ROOT = process.cwd();
const args = process.argv.slice(2);
const phase = args[0];
const apply = args.includes("--apply");

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(USAGE);
  process.exit(2);
}

if (!existsSync(join(ROOT, "BOARD.md"))) {
  console.error(`not a loops data repo (no BOARD.md in ${ROOT}) - run from the data repo root`);
  process.exit(2);
}
if (!["status", "pull", "reconcile", "set", "link"].includes(phase ?? "")) usage();

const config = loadConfig(ROOT);
const today = formatSnapshotDate(new Date());
const items = [
  ...loadItemsDir(join(ROOT, "items")),
  ...loadForDeliveryDir(join(ROOT, "for-delivery")),
  ...loadArchiveDir(join(ROOT, "archive")),
];
const onlyTracker = flag("--tracker");
if (onlyTracker && !Object.prototype.hasOwnProperty.call(config.trackers, onlyTracker)) {
  usage(`no tracker named "${onlyTracker}" under trackers in loops.json`);
}

/** The adapter for one declared tracker. A Linear board needs its own personal key; a
 * GitHub project reuses whatever auth the rest of the board tooling already has for that
 * org, unless the tracker names a token file of its own. */
function createAdapter(name: string, tracker: TrackerConfig, config: LoopsConfig): TrackerAdapter {
  if (tracker.kind === "linear") {
    if (!tracker.tokenFile) throw new Error(`trackers.${name} needs a tokenFile holding a Linear personal key`);
    return new LinearAdapter(name, tracker, httpRequest(tracker.tokenFile));
  }
  return new GithubProjectsAdapter(name, tracker, ghRequest(tracker.tokenFile ?? config.githubTokens[projectOrg(tracker)]));
}

/** Adapters for the trackers this run covers. A tracker this host has no credential for
 * is reported and left out; one that cannot even be set up is a failure. */
function setUpAdapters(): { adapters: Map<string, TrackerAdapter>; failures: TrackerFailure[] } {
  const adapters = new Map<string, TrackerAdapter>();
  const failures: TrackerFailure[] = [];
  for (const [name, tracker] of Object.entries(config.trackers)) {
    if (onlyTracker && name !== onlyTracker) continue;
    const orgToken = tracker.kind === "github-projects" ? config.githubTokens[projectOrg(tracker)] : undefined;
    const missing = missingCredential(tracker, orgToken);
    if (missing) {
      const linked = new Set(
        items.flatMap((item) => resolveItemTickets(item, config)).filter((ref) => ref.tracker === name).map(ticketKey),
      );
      console.log(`${name}: skipped, ${missing}; ${linked.size} linked ticket(s) not checked - a host with access catches up`);
      continue;
    }
    try {
      adapters.set(name, createAdapter(name, tracker, config));
    } catch (cause) {
      failures.push({ tracker: name, message: (cause as Error).message });
    }
  }
  return { adapters, failures };
}

function readRaw(item: ItemFile): string {
  return readFileSync(join(ROOT, item.path), "utf8");
}

let failures: TrackerFailure[] = [];
switch (phase) {
  case "status":
    failures = await statusPhase();
    break;
  case "pull":
    failures = await pullPhase();
    break;
  case "reconcile":
    failures = await reconcilePhase();
    break;
  case "set":
    failures = await setPhase();
    break;
  case "link":
    linkPhase();
    break;
}

// The one condition worth the owner's attention as an ask: until a token or an endpoint
// is fixed, nothing syncs at all, and every later run is silent about the same gap.
for (const failure of failures) fileOutboxEntry(failure);
if (failures.length) process.exit(1);

async function statusPhase(): Promise<TrackerFailure[]> {
  const { adapters, failures: setup } = setUpAdapters();
  const rawText = new Map(items.map((item) => [item.path, readRaw(item)]));
  const report = await runStatusPhase({ items, config, adapters, rawText, today, apply });
  const failures = [...setup, ...report.failures];
  printStatus(report, failures);
  if (report.itemWrites.length) {
    await withLock(
      ROOT,
      () => {
        for (const write of report.itemWrites) writeFileSync(join(ROOT, write.path), write.rawText);
      },
      "tracker-sync run",
    );
  }
  return failures;
}

function printStatus(report: StatusRunReport, failures: TrackerFailure[]): void {
  console.log(`Tracker status ${report.applied ? "apply" : "plan (dry run - pass --apply to write)"}:`);
  console.log(
    `  ${report.transitions.length} transition(s), ${report.backlinks.length} backlink write(s), ${report.fieldWrites.length} field write(s), ${report.notes.length} item note(s), ${report.holds.length} held ticket(s).`,
  );
  for (const transition of report.transitions) {
    console.log(`  - ${ticketKey(transition.ticket)}: ${transition.from} -> ${transition.to} (${transition.items.join(", ")})`);
  }
  for (const backlink of report.backlinks) console.log(`  - ${ticketKey(backlink.ticket)}: record the board references`);
  for (const write of report.fieldWrites) {
    console.log(`  - ${ticketKey(write.ticket)}: ${write.field} = ${write.value || "(cleared)"}`);
  }
  for (const note of report.notes) console.log(`  - ${note.slug}: ${note.text}`);
  for (const hold of report.holds) {
    console.log(`  - ${ticketKey(hold.ticket)}: held where it is by ${hold.heldBy.join(", ")}`);
  }
  for (const unresolved of report.unresolved) {
    console.log(`  ! ${ticketKey(unresolved.ticket)}: ${unresolved.reason} (${unresolved.items.join(", ")})`);
  }
  for (const failure of failures) console.error(`  ! ${failure.tracker}: ${failure.message}`);
}

/** The project a tracker's new items are filed under: the one named, or the only project
 * pointing at the tracker. Guessing between several would file work under the wrong one. */
function pullProject(name: string): string {
  const named = flag("--project");
  const projects = Object.keys(config.projects).filter((project) => resolveProjectTracker(config, project)?.name === name);
  if (named) {
    if (!projects.includes(named)) throw new Error(`project "${named}" does not use tracker ${name}`);
    return named;
  }
  if (projects.length === 1) return projects[0]!;
  throw new Error(`tracker ${name} serves ${projects.length} projects (${projects.join(", ")}) - name one with --project`);
}

async function pullPhase(): Promise<TrackerFailure[]> {
  const { adapters, failures } = setUpAdapters();
  const rawText = new Map(items.map((item) => [item.path, readRaw(item)]));
  console.log(`Tracker pull ${apply ? "apply" : "plan (dry run - pass --apply to file items and write backlinks)"}:`);
  for (const [name, adapter] of adapters) {
    try {
      if (!adapter.listOpenTickets) throw new Error(`the pull does not support ${config.trackers[name]!.kind} trackers yet`);
      const project = pullProject(name);
      const open = await adapter.listOpenTickets();
      const plan = planPull({ tracker: name, project, config, items, rawText, open });
      printPull(name, plan, adapter.skippedEntries?.());
      if (apply) {
        const result = await applyPullPlan({ root: ROOT, tracker: name, project, adapter, plan, config, items, today });
        for (const skipped of result.skipped) console.log(`  ! ${skipped.path}: not written, ${skipped.reason}`);
        console.log(
          `  ${name}: filed ${result.filed.length} item(s), linked ${result.linked.length} item(s), wrote ${result.backlinks} backlink(s). Run \`bun run sync\` to index the new items.`,
        );
      }
    } catch (cause) {
      failures.push({ tracker: name, message: (cause as Error).message });
    }
  }
  for (const failure of failures) console.error(`  ! ${failure.tracker}: ${failure.message}`);
  return failures;
}

function printPull(name: string, plan: PullPlan, skipped?: { pullRequests: number; drafts: number }): void {
  const skippedText = skipped ? `, ${skipped.pullRequests} pull request(s) and ${skipped.drafts} draft(s) skipped` : "";
  console.log(
    `  ${name}: ${plan.file.length} to file, ${plan.linkExisting.length} to link, ${plan.staleBacklinks.length} stale backlink(s), ${plan.alreadyLinked} already linked${skippedText}.`,
  );
  for (const link of plan.linkExisting) console.log(`  - ${ticketKey(link.ticket)}: link to ${link.slug} (${link.reason})`);
  for (const file of plan.file) {
    const matches = file.possibleMatches.length ? ` - possible match: ${file.possibleMatches.join(", ")}` : "";
    console.log(`  - ${ticketKey(file.ticket)}: file ${file.slug} (${file.record.status || "no status"})${matches}`);
  }
  for (const stale of plan.staleBacklinks) {
    console.log(`  ! ${ticketKey(stale.ticket)}: backlink names ${stale.slugs.join(", ")}, which no board item has`);
  }
}

async function reconcilePhase(): Promise<TrackerFailure[]> {
  const { adapters, failures } = setUpAdapters();
  const plannerItems: PlannerItem[] = items.map((item) => ({
    slug: item.slug,
    state: item.state,
    tickets: resolveItemTickets(item, config).filter((ref) => adapters.has(ref.tracker)),
  }));
  const record = args.includes("--record");
  const notes: { slug: string; text: string }[] = [];
  console.log(
    record ? "Tracker reconcile (recording each mismatch on its items):" : "Tracker reconcile (read-only; resolve each with the owner):",
  );
  for (const [name, adapter] of adapters) {
    const ids = [...new Set(plannerItems.flatMap((item) => item.tickets).filter((ref) => ref.tracker === name).map((ref) => ref.id))];
    try {
      const records = await adapter.fetchTickets(ids.sort());
      const scoped = plannerItems.map((item) => ({ ...item, tickets: item.tickets.filter((ref) => ref.tracker === name) }));
      const mismatches = planReconcile(scoped, records, { [name]: config.trackers[name]! });
      console.log(`  ${name}: ${mismatches.length} mismatch(es) across ${ids.length} linked ticket(s).`);
      for (const mismatch of mismatches) {
        console.log(`  - ${ticketKey(mismatch.ticket)} [${mismatch.kind}] ${mismatch.items.join(", ")}`);
        console.log(`      ${mismatch.detail}`);
        console.log(`      recommend: ${mismatch.recommendation}`);
      }
      notes.push(...mismatchNotes(mismatches));
    } catch (cause) {
      failures.push({ tracker: name, message: (cause as Error).message });
    }
  }
  if (record && notes.length) {
    const bySlug = new Map(items.map((item) => [item.slug, item]));
    let written = 0;
    await withLock(
      ROOT,
      () => {
        const pending = new Map<string, string>();
        for (const note of notes) {
          const item = bySlug.get(note.slug);
          if (!item) continue;
          const current = pending.get(item.path) ?? readRaw(item);
          const next = appendItemNote(current, note.text, today);
          if (next !== undefined) pending.set(item.path, next);
        }
        for (const [path, text] of pending) writeFileSync(join(ROOT, path), text);
        written = pending.size;
      },
      "tracker-sync reconcile",
    );
    console.log(`  recorded new notes on ${written} item(s).`);
  }
  for (const failure of failures) console.error(`  ! ${failure.tracker}: ${failure.message}`);
  return failures;
}

async function setPhase(): Promise<TrackerFailure[]> {
  const target = args[1];
  const status = flag("--status");
  const close = args.includes("--close");
  const reopen = args.includes("--reopen");
  if (!target || target.startsWith("--")) usage("set needs a ticket, e.g. acme/#12");
  if ([status !== undefined, close, reopen].filter(Boolean).length !== 1) usage("set needs exactly one of --status <name>, --close, --reopen");
  const slash = target.indexOf("/");
  const name = slash === -1 ? onlyTracker : target.slice(0, slash);
  const id = slash === -1 ? target : target.slice(slash + 1);
  if (!name || !Object.prototype.hasOwnProperty.call(config.trackers, name)) usage(`name the ticket as <tracker>/<id>`);
  const { adapters, failures } = setUpAdapters();
  const adapter = adapters.get(name);
  if (!adapter) return failures;
  const change = status !== undefined ? `status ${status}` : close ? "closed" : "reopened";
  try {
    const [record] = await adapter.fetchTickets([id]);
    if (!record) throw new Error(`ticket ${id} is not on the tracker's board`);
    if (!apply) {
      console.log(`Would set ${name}/${id} to ${change} (currently ${record.status}${record.open === false ? ", closed" : ""}). Pass --apply on the owner's answer.`);
      return failures;
    }
    if (status !== undefined) await adapter.setStatus(record, status);
    else {
      if (!adapter.setOpen) throw new Error("this tracker has no separate open/closed state - set a status instead");
      await adapter.setOpen(record, reopen);
    }
    console.log(`Set ${name}/${id} to ${change}.`);
  } catch (cause) {
    failures.push({ tracker: name, message: `${name}/${id}: ${(cause as Error).message}` });
    console.error(`  ! ${name}/${id}: ${(cause as Error).message}`);
  }
  return failures;
}

function linkPhase(): void {
  const slug = args[1];
  const id = args[2];
  if (!slug || !id) usage("link needs an item slug and a ticket id");
  const item = items.find((candidate) => candidate.slug === slug);
  if (!item) usage(`no board item named ${slug}`);
  const resolved = resolveProjectTracker(config, item.project);
  if (!resolved) usage(`project ${item.project} declares no tracker`);
  if (!isTicketId(resolved.tracker.kind, id)) usage(`${id} is not a ${resolved.name} ticket id: expected ${TICKET_ID_FORMS[resolved.tracker.kind]}`);
  const next = setItemTickets(readRaw(item), [id]);
  if (next === undefined) {
    console.log(`${slug} already names ${id}.`);
    return;
  }
  writeFileSync(join(ROOT, item.path), next);
  console.log(`${slug} now names ${resolved.name}/${id}; the next \`tracker-sync status --apply\` writes the backlink.`);
}

function fileOutboxEntry(failure: TrackerFailure): void {
  const path = join(ROOT, "OUTBOX.md");
  if (!existsSync(path)) return;
  const marker = `<!-- loops:tracker-sync ${failure.tracker} -->`;
  const result = withOutboxLock(path, () => {
    const snapshot = readFileSync(path, "utf8");
    const next = appendOutboxEntry(snapshot, {
      marker,
      body: (id) => `
${outboxHeading(id, "question", "dcl", `tracker ${failure.tracker} cannot be synced`)}
${marker}

\`tracker-sync ${phase}\` could not reach the tracker \`${failure.tracker}\`: ${failure.message}

**The ask:** fix the credential or the endpoint. Until then the board's state reaches none of that tracker's tickets, and every collaborator reading it sees stale progress.

> A:
`,
    });
    return next === snapshot || replaceIfUnchanged(path, snapshot, next);
  });
  if (result === null || result === false) {
    console.error(`  ! could not record the ${failure.tracker} failure in OUTBOX.md - report it by hand`);
  }
}
