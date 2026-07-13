#!/usr/bin/env bun
// `bun run check` — report-only integrity check. No write, no OUTBOX append.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadForDeliveryDir, loadItemsDir } from "./parse.ts";
import { runPreflight } from "./preflight.ts";
import { printPreflightReport, printValidationReport } from "./report.ts";
import { validateItems } from "./validate.ts";

const ROOT = process.cwd();

if (!existsSync(join(ROOT, "BOARD.md"))) {
  console.error(`not a loops data repo (no BOARD.md in ${ROOT}) — run from the data repo root`);
  process.exit(2);
}

const boardText = readFileSync(join(ROOT, "BOARD.md"), "utf8");
const items = loadItemsDir(join(ROOT, "items"));
const forDeliveryItems = loadForDeliveryDir(join(ROOT, "for-delivery"));

const report = runPreflight(boardText, items);
printPreflightReport(report);

const anomalies = validateItems([...items, ...forDeliveryItems]);
printValidationReport(anomalies);

// Version-stamp drift check (warning only, never fails the run): the data repo
// records which DCL commit seeded it; if the DCL clone serving this run has moved
// on, templates/contracts may have evolved past what this instance was seeded with.
const stampPath = join(ROOT, ".loops-version");
if (existsSync(stampPath)) {
  const stamped = readFileSync(stampPath, "utf8").trim();
  const dclHome = resolve(import.meta.dirname, "..");
  const head = spawnSync("git", ["-C", dclHome, "rev-parse", "HEAD"], { encoding: "utf8" });
  const current = head.status === 0 ? head.stdout.trim() : null;
  if (current && stamped !== "unknown" && stamped !== current) {
    console.log(
      `\nNote: this data repo was seeded from DCL ${stamped.slice(0, 12)}, but the DCL clone is now at ${current.slice(0, 12)} — check its changelog for contract changes.`,
    );
  }
}

if (report.orphanRows.length || report.mismatches.length || anomalies.length) {
  process.exit(1);
}
