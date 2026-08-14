#!/usr/bin/env bun
// `bun run check` — report-only integrity check. No write, no OUTBOX append.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadArchiveDir, loadForDeliveryDir, loadItemsDir } from "./parse.ts";
import { runPreflight } from "./preflight.ts";
import { printDanglingDeps, printDuplicateSlugs, printPreflightReport, printValidationReport } from "./report.ts";
import { findDuplicateSlugs, validateItems } from "./validate.ts";
import { buildUniverse, computeReadiness, danglingDeps } from "./readiness.ts";
import { dclHead, stampedVersion } from "./version.ts";

const ROOT = process.cwd();

if (!existsSync(join(ROOT, "BOARD.md"))) {
  console.error(`not a loops data repo (no BOARD.md in ${ROOT}) — run from the data repo root`);
  process.exit(2);
}

const boardText = readFileSync(join(ROOT, "BOARD.md"), "utf8");
const items = loadItemsDir(join(ROOT, "items"));
const forDeliveryItems = loadForDeliveryDir(join(ROOT, "for-delivery"));
const archiveItems = loadArchiveDir(join(ROOT, "archive"));

// Terminal items are passed for row identity only: a row whose item has moved to
// for-delivery/ or archive/ is stale, not orphaned, and must not be reported as one.
const report = runPreflight(boardText, items, [...forDeliveryItems, ...archiveItems]);
printPreflightReport(report);

const anomalies = validateItems([...items, ...forDeliveryItems, ...archiveItems]);
printValidationReport(anomalies);

// Duplicate slugs across items/, for-delivery/, and archive/: a slug is a file
// identity, so a collision lets one item's file overwrite another's on a move and
// misdirects depends-on resolution. An integrity error.
const duplicateSlugs = findDuplicateSlugs([...items, ...forDeliveryItems, ...archiveItems]);
printDuplicateSlugs(duplicateSlugs);

// Dangling depends-on: a target slug that resolves to no item anywhere (items/,
// for-delivery/, or archive/). The referrer can never become eligible, so it's an
// integrity error. Non-archived items are the ones an agent might act on, so those are
// what we check for dangling targets; every location feeds the resolution universe.
const universe = buildUniverse([...items, ...forDeliveryItems, ...archiveItems]);
const dangling = danglingDeps(computeReadiness([...items, ...forDeliveryItems], universe));
printDanglingDeps(dangling);

// Version-stamp drift check (warning only, never fails the run): the data repo records
// which DCL commit seeded it; if the DCL clone serving this run has moved on,
// templates/contracts may have evolved past what this instance was seeded with. Clear
// it with `bun run restamp` once the upgrade has been reviewed.
const stamped = stampedVersion(ROOT);
if (stamped) {
  const current = dclHead();
  if (current && stamped !== "unknown" && stamped !== current) {
    console.log(
      `\nNote: this data repo was seeded from DCL ${stamped.slice(0, 12)}, but the DCL clone is now at ${current.slice(0, 12)} — review the changes and run \`bun run restamp\` to acknowledge.`,
    );
  }
}

// terminalRows counts. The row and the folders disagree about where an item is, and this
// gate runs on the repo as it stands, before any sync repairs it: until then the board
// links `items/<slug>.md` for a file that is somewhere else, and for a reopened item that
// broken link is the only trace of a live work-stream. These rows failed this gate before
// they were told apart from orphans, and staying silent about them would make correct
// classification a weakening of the integrity check. `bun run sync` clears them.
if (
  report.orphanRows.length ||
  report.terminalRows.length ||
  report.mismatches.length ||
  anomalies.length ||
  duplicateSlugs.length ||
  dangling.length
) {
  process.exit(1);
}
