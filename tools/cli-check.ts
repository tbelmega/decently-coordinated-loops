#!/usr/bin/env bun
// `bun run check` — report-only integrity check. No write, no OUTBOX append.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

if (report.orphanRows.length || report.mismatches.length || anomalies.length) {
  process.exit(1);
}
