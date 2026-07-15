#!/usr/bin/env bun
// `bun run sync` — headless board regen: preflight (routes orphan rows to
// OUTBOX.md), moves item files between items/ <-> for-delivery/ <-> archive/ as
// their state dictates, appends ARCHIVE.md rows, then regenerates BOARD.md.
// Guarded by a lock file so two runs (e.g. a scheduled tick overlapping a manual
// run) can't race on the same data repo.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "./lock.ts";
import { loadConfig } from "./config.ts";
import { loadForDeliveryDir, loadItemsDir } from "./parse.ts";
import { runPreflight } from "./preflight.ts";
import { renderBoardMd } from "./render.ts";
import { appendArchiveRows, planMoves } from "./archive.ts";
import { appendOrphanRowEntry } from "./outbox.ts";
import { performMoves } from "./moves.ts";
import { printPreflightReport, printValidationReport } from "./report.ts";
import { validateItems } from "./validate.ts";

const ROOT = process.cwd();
const BOARD_PATH = join(ROOT, "BOARD.md");

if (!existsSync(BOARD_PATH)) {
  console.error(`not a loops data repo (no BOARD.md in ${ROOT}) — run from the data repo root`);
  process.exit(2);
}

await withLock(ROOT, () => {
  const OUTBOX_PATH = join(ROOT, "OUTBOX.md");
  const ARCHIVE_MD_PATH = join(ROOT, "ARCHIVE.md");
  const ITEMS_DIR = join(ROOT, "items");
  const FOR_DELIVERY_DIR = join(ROOT, "for-delivery");

  const config = loadConfig(ROOT);
  const boardText = readFileSync(BOARD_PATH, "utf8");
  const items = loadItemsDir(ITEMS_DIR);
  // for-delivery/ items can advance to accepted/dropped and need moving to
  // archive/, so they're loaded into the move planner too (not just items/).
  const forDeliveryItems = loadForDeliveryDir(FOR_DELIVERY_DIR);
  const allItems = [...items, ...forDeliveryItems];

  const report = runPreflight(boardText, items);
  printPreflightReport(report);
  printValidationReport(validateItems(allItems));

  if (report.orphanRows.length) {
    let outboxText = readFileSync(OUTBOX_PATH, "utf8");
    for (const orphan of report.orphanRows) {
      outboxText = appendOrphanRowEntry(outboxText, orphan);
    }
    writeFileSync(OUTBOX_PATH, outboxText);
    console.log(`\nRouted ${report.orphanRows.length} orphan row(s) to OUTBOX.md.`);
  }

  const moves = planMoves(allItems);
  if (moves.length) {
    const logs = performMoves(ROOT, moves);
    console.log(`\nMoved ${moves.length} item(s):`);
    for (const log of logs) console.log(`  - ${log.slug}: ${log.message}`);

    const archived = moves.filter((m) => m.to === "archive").map((m) => m.item);
    if (archived.length) {
      const archiveText = readFileSync(ARCHIVE_MD_PATH, "utf8");
      writeFileSync(ARCHIVE_MD_PATH, appendArchiveRows(archiveText, archived));
    }
  }

  const active = items.filter((i) => !moves.some((m) => m.item.slug === i.slug));
  writeFileSync(BOARD_PATH, renderBoardMd(active, config));
  console.log(`\nRegenerated BOARD.md (${active.length} active items, priority order).`);
});
