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
import { orphanRoutingOutcome, routeOrphanRows } from "./outbox.ts";
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

    // Terminal items resolve row identity, nothing more: a row whose item has moved to
    // for-delivery/ or archive/ must not be routed to the owner as an orphan, and only
    // `items` below feeds the regenerated board.
    const report = runPreflight(boardText, items, [...forDeliveryItems, ...archiveItems], config);
    printPreflightReport(report);
    // Archive files are validated too, though sync never moves them: a file stranded there
    // is the one misplacement no run repairs, and if it was archived the ordinary way there
    // is no board row left to reveal it. Reporting it from the file is the only way it gets
    // said at all.
    printValidationReport(validateItems([...allItems, ...archiveItems], config));

    let retainedOrphanRows: string[] = [];
    if (report.orphanRows.length) {
      // Under the same `OUTBOX.md.lock` the other writers of this file take: sync's own
      // `.loops-sync.lock` serializes sync against sync, not against a board server or an
      // editor. A row that did not reach the outbox aborts the run BEFORE any move or
      // board regeneration — the row has no item file, so the board is its only remaining
      // copy, and regenerating without it would destroy the very thing the routing exists
      // to preserve.
      const routing = routeOrphanRows(OUTBOX_PATH, report.orphanRows);
      const outcome = orphanRoutingOutcome(routing, report.orphanRows.length);
      if (outcome.abort) throw new SyncAborted(outcome.message);
      console.log(`\n${outcome.message}`);
      // Two phases, because writing an entry and that entry still being there are not the
      // same fact. A row leaves the board only once a run OTHER than the one that wrote
      // its entry has seen that entry in `## Open`. Until then the row stays, so a
      // whole-file save that swallowed the entry costs a repeat, not the work-stream.
      if (routing.status === "routed") {
        const confirmed = new Set(routing.confirmed);
        retainedOrphanRows = report.orphanRows.filter((row) => !confirmed.has(row.path)).map((row) => row.raw);
      }
    }

    const moves = planMoves(allItems, config);
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
    // Unconditionally, not only when this run planned an archive move. The reconciliation
    // is derived and idempotent — it returns the text unchanged when nothing is missing —
    // so gating it bought nothing and cost the one case that needs it most: an item
    // hand-moved into archive/ is invisible to planMoves, so the guard was false exactly
    // when its ARCHIVE.md row was missing, leaving the item in neither derived index.
    const archived = loadArchiveDir(join(ROOT, "archive"));
    const archiveText = readFileSync(ARCHIVE_MD_PATH, "utf8");
    const reconciledArchive = reconcileArchiveRows(archiveText, archived, config);
    if (reconciledArchive !== archiveText) writeFileSync(ARCHIVE_MD_PATH, reconciledArchive);

    // Read items/ back rather than deriving the render set from the pre-move load. Both
    // directions matter: an item this run moved INTO items/ (a for-delivery/ file whose
    // state went active again) must get its row immediately rather than waiting for some
    // later sync, and a move that did NOT reach its destination must not be rendered as
    // though it had. performMoves logs and continues on an anomaly, so a file raced away
    // between load and move would otherwise appear as a board row linking to nothing.
    const active = moves.length ? loadItemsDir(ITEMS_DIR) : items;
    const board = renderBoardMd(active, config);
    writeFileSync(
      BOARD_PATH,
      retainedOrphanRows.length ? `${board.replace(/\n+$/, "")}\n${retainedOrphanRows.join("\n")}\n` : board,
    );
    console.log(
      `\nRegenerated BOARD.md (${active.length} active items, priority order` +
        (retainedOrphanRows.length ? `, plus ${retainedOrphanRows.length} unconfirmed orphan row(s)` : "") +
        ").",
    );
  });
} catch (error) {
  if (error instanceof SyncAborted) {
    console.error(`\n${error.message}`);
    process.exit(1);
  }
  throw error;
}
