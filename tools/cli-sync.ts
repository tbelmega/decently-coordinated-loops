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
import { loadArchiveDir, loadForDeliveryDir, loadItemsDir } from "./parse.ts";
import { runPreflight } from "./preflight.ts";
import { renderBoardMd } from "./render.ts";
import { planMoves, reconcileArchiveRows } from "./archive.ts";
import { routeOrphanRows } from "./outbox.ts";
import { performMoves } from "./moves.ts";
import { printDuplicateSlugs, printPreflightReport, printValidationReport } from "./report.ts";
import { findDuplicateSlugs, validateItems } from "./validate.ts";

const ROOT = process.cwd();
const BOARD_PATH = join(ROOT, "BOARD.md");

if (!existsSync(BOARD_PATH)) {
  console.error(`not a loops data repo (no BOARD.md in ${ROOT}) — run from the data repo root`);
  process.exit(2);
}

/** A deliberate, message-only abort from inside the locked section — thrown (not
 * process.exit) so withLock's finally still releases the lock, then caught below to
 * exit non-zero without a stack trace. */
class SyncAborted extends Error {}

try {
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
    const archiveItems = loadArchiveDir(join(ROOT, "archive"));
    const allItems = [...items, ...forDeliveryItems];

    // Fail before any write on a duplicate slug: a move writes `<slug>.md`, so a slug
    // shared across folders would let one item's file overwrite another's, and
    // depends-on would resolve to the wrong target. Include archive/ — an accept-move
    // into a slug already archived is exactly the overwrite we must stop.
    const duplicateSlugs = findDuplicateSlugs([...allItems, ...archiveItems]);
    if (duplicateSlugs.length) {
      printDuplicateSlugs(duplicateSlugs);
      throw new SyncAborted("Refusing to sync: resolve the duplicate slug(s) above before re-running.");
    }

    const report = runPreflight(boardText, items);
    printPreflightReport(report);
    printValidationReport(validateItems(allItems));

    if (report.orphanRows.length) {
      // Under the same `OUTBOX.md.lock` the other writers of this file take, with their
      // compare-and-swap: sync's own `.loops-sync.lock` serializes sync against sync, not
      // against a board server or an editor writing the outbox. Nothing here is retried —
      // the rows stay orphaned, so the next sync files them again — but every outcome is
      // reported, because a routing that silently did not happen is exactly how an owner
      // ask goes missing.
      const routing = routeOrphanRows(OUTBOX_PATH, report.orphanRows);
      const rows = `${report.orphanRows.length} orphan row(s)`;
      if (routing.status === "routed") console.log(`\nRouted ${routing.count} orphan row(s) to OUTBOX.md.`);
      else if (routing.status === "unchanged") console.log(`\n${rows} already recorded in OUTBOX.md.`);
      else if (routing.status === "locked") {
        console.log(`\n${rows} NOT routed: OUTBOX.md.lock is held by another writer. Re-run sync.`);
      } else console.log(`\n${rows} NOT routed: OUTBOX.md changed while sync held the lock. Re-run sync.`);
    }

    const moves = planMoves(allItems);
    if (moves.length) {
      const logs = performMoves(ROOT, moves);
      console.log(`\nMoved ${moves.length} item(s):`);
      for (const log of logs) console.log(`  - ${log.slug}: ${log.message}`);
    }

    // Reconcile ARCHIVE.md against the archive/ folder's actual contents (derived,
    // idempotent) rather than only appending the just-moved batch. If a previous run
    // crashed after moving a file but before indexing it, the missing row is added
    // here on the next run — the move and the index are recoverable as one derived
    // operation. Reload the folder so freshly-moved files are included.
    if (moves.some((m) => m.to === "archive")) {
      const archived = loadArchiveDir(join(ROOT, "archive"));
      const archiveText = readFileSync(ARCHIVE_MD_PATH, "utf8");
      writeFileSync(ARCHIVE_MD_PATH, reconcileArchiveRows(archiveText, archived));
    }

    const active = items.filter((i) => !moves.some((m) => m.item.slug === i.slug));
    writeFileSync(BOARD_PATH, renderBoardMd(active, config));
    console.log(`\nRegenerated BOARD.md (${active.length} active items, priority order).`);
  });
} catch (error) {
  if (error instanceof SyncAborted) {
    console.error(`\n${error.message}`);
    process.exit(1);
  }
  throw error;
}
