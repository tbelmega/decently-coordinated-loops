#!/usr/bin/env bun
// `bun run tracker-sync status [--apply]` - project the board's state onto the external
// tickets its items name.
//
// The board is the authority; the tracker is a projection of it. Moves are forward-only
// along the lifecycle, a ticket a human already moved further is left alone with a line
// on the item, and nothing is created here: creating, linking and splitting tickets are
// proposals for the owner, never an agent's initiative.
//
// Dry-run by default. `--apply` writes, and authorizes exactly two things on the
// tracker: a planned status transition, and the board slug in the ticket description.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type LoopsConfig } from "../config.ts";
import { formatSnapshotDate } from "../date.ts";
import { withLock } from "../lock.ts";
import { appendOutboxEntry, outboxHeading, replaceIfUnchanged, withOutboxLock } from "../outbox.ts";
import { loadArchiveDir, loadForDeliveryDir, loadItemsDir } from "../parse.ts";
import type { TrackerAdapter } from "./tracker-adapter.ts";
import type { TrackerConfig } from "./tracker-config.ts";
import { GithubProjectsAdapter, ghRequest, projectOrg } from "./tracker-github.ts";
import { LinearAdapter, httpRequest } from "./tracker-linear.ts";
import { ticketKey } from "./tracker-plan.ts";
import { runStatusPhase, type StatusRunReport, type TrackerFailure } from "./tracker-status.ts";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const phase = args[0];
const apply = args.includes("--apply");

if (!existsSync(join(ROOT, "BOARD.md"))) {
  console.error(`not a loops data repo (no BOARD.md in ${ROOT}) - run from the data repo root`);
  process.exit(2);
}
if (phase !== "status") {
  console.error("usage: bun run tracker-sync status [--apply]");
  process.exit(2);
}

const config = loadConfig(ROOT);

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

const items = [
  ...loadItemsDir(join(ROOT, "items")),
  ...loadForDeliveryDir(join(ROOT, "for-delivery")),
  ...loadArchiveDir(join(ROOT, "archive")),
];

const adapters = new Map<string, TrackerAdapter>();
const setupFailures: TrackerFailure[] = [];
for (const [name, tracker] of Object.entries(config.trackers)) {
  try {
    adapters.set(name, createAdapter(name, tracker, config));
  } catch (cause) {
    setupFailures.push({ tracker: name, message: (cause as Error).message });
  }
}

const rawText = new Map(items.map((item) => [item.path, readFileSync(join(ROOT, item.path), "utf8")]));
const report = await runStatusPhase({ items, config, adapters, rawText, today: formatSnapshotDate(new Date()), apply });
const failures = [...setupFailures, ...report.failures];

print(report, failures);

if (report.itemWrites.length) {
  await withLock(
    ROOT,
    () => {
      for (const write of report.itemWrites) writeFileSync(join(ROOT, write.path), write.rawText);
    },
    "tracker-sync run",
  );
}

// The one condition worth the owner's attention as an ask: until a token or an endpoint
// is fixed, nothing syncs at all, and every later run is silent about the same gap.
for (const failure of failures) fileOutboxEntry(failure);

if (failures.length) process.exit(1);

function print(report: StatusRunReport, failures: TrackerFailure[]): void {
  console.log(`Tracker status ${report.applied ? "apply" : "plan (dry run - pass --apply to write)"}:`);
  console.log(
    `  ${report.transitions.length} transition(s), ${report.backlinks.length} backlink write(s), ${report.notes.length} item note(s), ${report.holds.length} held ticket(s).`,
  );
  for (const transition of report.transitions) {
    console.log(`  - ${ticketKey(transition.ticket)}: ${transition.from} -> ${transition.to} (${transition.items.join(", ")})`);
  }
  for (const backlink of report.backlinks) console.log(`  - ${ticketKey(backlink.ticket)}: record the board slug`);
  for (const note of report.notes) console.log(`  - ${note.slug}: ${note.text}`);
  for (const hold of report.holds) {
    console.log(`  - ${ticketKey(hold.ticket)}: held where it is by ${hold.heldBy.join(", ")}`);
  }
  for (const unresolved of report.unresolved) {
    console.log(`  ! ${ticketKey(unresolved.ticket)}: ${unresolved.reason} (${unresolved.items.join(", ")})`);
  }
  for (const failure of failures) console.error(`  ! ${failure.tracker}: ${failure.message}`);
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

\`tracker-sync status\` could not reach the tracker \`${failure.tracker}\`: ${failure.message}

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
