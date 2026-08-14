// CLI-level regression for the one sync outcome that can destroy data: an orphan
// BOARD.md row is the only remaining copy of its work-stream (it has no item file), so a
// sync that cannot file it in OUTBOX.md must not regenerate the board without it.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DCL_HOME = resolve(import.meta.dirname, "..");
const SYNC = join(DCL_HOME, "tools", "cli-sync.ts");
const TEMPLATES = join(DCL_HOME, "setup", "templates");

const ORPHAN_ROW =
  "| [Ghost row](items/does-not-exist.md) | atlas | idea | owner | decide | - | codex/default | 2026-07-01 |\n";

/** Every repo this suite makes, so none is left in the system temp directory. */
const created: string[] = [];

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function dataRepoWithOrphanRow(): string {
  const root = mkdtempSync(join(tmpdir(), "dcl-sync-"));
  created.push(root);
  for (const dir of ["items", "for-delivery", "archive"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, "BOARD.md"), readFileSync(join(TEMPLATES, "BOARD.md"), "utf8") + ORPHAN_ROW);
  writeFileSync(join(root, "ARCHIVE.md"), readFileSync(join(TEMPLATES, "ARCHIVE.md"), "utf8"));
  writeFileSync(join(root, "OUTBOX.md"), "# Outbox\n\n## Open\n");
  writeFileSync(join(root, "loops.json"), `{"owner":"Casey"}\n`);
  return root;
}

const TERMINAL_ITEM = `---
title: "Moved on"
project: atlas
state: accepted
assignee: "-"
autonomy: "-"
next-actor: owner
next-step: "n/a - terminal"
updated: 2026-07-08
---
Fixture item.
`;

/** A data repo whose BOARD.md still carries a row for an item that has already been
 * hand-moved into a terminal folder, the shape a `git mv` into archive/ leaves behind. */
function dataRepoWithMovedItem(folder: "for-delivery" | "archive", state: string): string {
  const root = mkdtempSync(join(tmpdir(), "dcl-sync-"));
  created.push(root);
  for (const dir of ["items", "for-delivery", "archive"]) mkdirSync(join(root, dir));
  const row = `| [Moved on](items/moved-on.md) | atlas | ${state} | owner | deliver | - | - | 2026-07-08 |\n`;
  writeFileSync(join(root, "BOARD.md"), readFileSync(join(TEMPLATES, "BOARD.md"), "utf8") + row);
  writeFileSync(join(root, "ARCHIVE.md"), readFileSync(join(TEMPLATES, "ARCHIVE.md"), "utf8"));
  writeFileSync(join(root, "OUTBOX.md"), "# Outbox\n\n## Open\n");
  writeFileSync(join(root, "loops.json"), `{"owner":"Casey"}\n`);
  writeFileSync(join(root, folder, "moved-on.md"), TERMINAL_ITEM.replace("state: accepted", `state: ${state}`));
  return root;
}

describe("cli-sync rows whose item has moved to a terminal folder", () => {
  // The incident this covers: archiving an item by hand (`git mv items/ -> archive/`) and
  // then running sync filed an OUTBOX entry asking the owner to recreate an item that
  // existed and was authoritative one directory over. Nothing is missing here, so nothing
  // may be asked; the row is stale and regeneration drops it.
  for (const [folder, state] of [
    ["archive", "accepted"],
    ["for-delivery", "tested"],
  ] as const) {
    test(`does not file an owner question for an item sitting in ${folder}/`, () => {
      const root = dataRepoWithMovedItem(folder, state);

      const result = spawnSync("bun", [SYNC], { cwd: root, encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(readFileSync(join(root, "OUTBOX.md"), "utf8")).not.toContain("moved-on");
      expect(result.stdout).toContain("0 orphan row(s)");
      // The row is stale, not precious: the board renders active items only.
      expect(readFileSync(join(root, "BOARD.md"), "utf8")).not.toContain("Moved on");
    });
  }

  test("puts a reopened for-delivery/ item back on the board in the same run", () => {
    // Review R4-F1/R4-F2. Classifying the stale row as terminal is right, because sync
    // moves the file back to items/ itself. But regenerating from the set loaded before
    // that move left the reopened work-stream with no row at all until some later sync
    // ran, so it was invisible to a dispatcher in between. Rendering the post-move set
    // closes the gap in the same run.
    const root = dataRepoWithMovedItem("for-delivery", "in-progress");

    const result = spawnSync("bun", [SYNC], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "OUTBOX.md"), "utf8")).not.toContain("moved-on");
    expect(readFileSync(join(root, "items", "moved-on.md"), "utf8")).toContain("state: in-progress");
    // Present, and linking where the file now is rather than where it was loaded from.
    expect(readFileSync(join(root, "BOARD.md"), "utf8")).toContain("[Moved on](items/moved-on.md)");
  });

  test("indexes a hand-archived item in ARCHIVE.md even though it planned no move", () => {
    // Review R5-F5, the sibling of the bug this whole change is about. planMoves never
    // sees archive/, so gating the ARCHIVE.md reconciliation on "this run moved something
    // there" made the guard false in exactly the case that needs it: a hand-archived item
    // was dropped from BOARD.md and never added to ARCHIVE.md, so it appeared in neither
    // derived index and only the file itself remained.
    const root = dataRepoWithMovedItem("archive", "accepted");

    const result = spawnSync("bun", [SYNC], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "ARCHIVE.md"), "utf8")).toContain("archive/moved-on.md");
    expect(readFileSync(join(root, "BOARD.md"), "utf8")).not.toContain("Moved on");
  });

  test("clears the ARCHIVE.md row of a file reopened in place, and asks for it", () => {
    // Review R6-F2, the other half of the same invariant: an item accepted, archived and
    // indexed, then reopened by editing its state without moving the file. The append
    // filter alone leaves the earlier row standing, so ARCHIVE.md would keep reporting a
    // live work-stream as finished while OUTBOX.md asks the owner to revive it.
    const root = dataRepoWithMovedItem("archive", "in-progress");
    const archivePath = join(root, "ARCHIVE.md");
    const indexed = `${readFileSync(archivePath, "utf8")}| [Moved on](archive/moved-on.md) | atlas | 2026-07-08 |\n`;
    writeFileSync(archivePath, indexed);

    const result = spawnSync("bun", [SYNC], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(readFileSync(archivePath, "utf8")).not.toContain("archive/moved-on.md");
    expect(readFileSync(join(root, "OUTBOX.md"), "utf8")).toContain("stranded in archive/");
  });

  test("every row on the regenerated board links to a file that exists", () => {
    // Review R5-F3/F4/F6. performMoves logs and continues when neither source nor
    // destination exists, so a render set derived from the *planned* moves could publish
    // an active row for a file that was never written. Reading items/ back after the moves
    // makes that structurally impossible - the render input is a directory listing - and
    // this asserts the property on a run that really does move a file.
    const root = dataRepoWithMovedItem("for-delivery", "in-progress");

    const result = spawnSync("bun", [SYNC], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(0);
    const links = [...readFileSync(join(root, "BOARD.md"), "utf8").matchAll(/\]\((items\/[^)]+\.md)\)/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const [, path] of links) expect(existsSync(join(root, path))).toBe(true);
  });

  test("files nothing when an accepted item is still sitting in for-delivery/", () => {
    // Review R2-F1. The ordinary accept flow: the state moved on before sync did. This
    // run moves the file to archive/ itself, so a recovery question about it would be
    // asking the owner to repair something being repaired in the same run.
    const root = dataRepoWithMovedItem("for-delivery", "accepted");

    const result = spawnSync("bun", [SYNC], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "OUTBOX.md"), "utf8")).not.toContain("moved-on");
    expect(readFileSync(join(root, "BOARD.md"), "utf8")).not.toContain("Moved on");
    expect(readFileSync(join(root, "ARCHIVE.md"), "utf8")).toContain("archive/moved-on.md");
  });

  // Review R1-F1 and R3-F1. planMoves is fed items/ and for-delivery/ only, so nothing
  // brings an archive/ file back and no integrity check objects to its canonical state.
  // Dropping the row on folder alone would delete a live work-stream's last board trace
  // with nothing filed anywhere. `tested` is as stranded there as `in-progress`.
  for (const state of ["in-progress", "tested", "delivered"]) {
    test(`still routes an owner question for a ${state} item stranded in archive/`, () => {
      const root = dataRepoWithMovedItem("archive", state);

      const result = spawnSync("bun", [SYNC], { cwd: root, encoding: "utf8" });

      expect(result.status).toBe(0);
      const outbox = readFileSync(join(root, "OUTBOX.md"), "utf8");
      expect(outbox).toContain("items/moved-on.md");
      expect(readFileSync(join(root, "BOARD.md"), "utf8")).toContain("Moved on");

      // Review R4-F1: the entry must name the file that exists and ask for it to be
      // moved. "Create an item file" would be the wrong repair, and following it would
      // put a second file under this slug, which the duplicate-slug guard refuses to
      // sync past, leaving the owner worse off than before they answered.
      expect(outbox).toContain("stranded in archive/");
      expect(outbox).toContain("archive/moved-on.md");
      expect(outbox).toContain("Do not create a second item file");
      expect(outbox).not.toContain("**The ask:** create an item file");

      // Review R6-F1. Reconciling ARCHIVE.md on every run reaches these files too, and
      // indexing one would file live work as finished: the same item would be a retained
      // work-stream on BOARD.md and a completed row in ARCHIVE.md at once.
      expect(readFileSync(join(root, "ARCHIVE.md"), "utf8")).not.toContain("archive/moved-on.md");
    });
  }
});

describe("cli-sync orphan routing", () => {
  test("files the entry and keeps the row until a later run has seen it", () => {
    // Two phases on purpose. Writing an entry and that entry still being there are not
    // the same fact, and the row is the work-stream's only remaining copy, so it may not
    // leave the board on the strength of a write this same run made.
    const root = dataRepoWithOrphanRow();

    const first = spawnSync("bun", [SYNC], { cwd: root, encoding: "utf8" });
    expect(first.status).toBe(0);
    expect(readFileSync(join(root, "OUTBOX.md"), "utf8")).toContain("items/does-not-exist.md");
    expect(readFileSync(join(root, "BOARD.md"), "utf8")).toContain("Ghost row");
    expect(first.stdout).toContain("kept until a later sync");

    const second = spawnSync("bun", [SYNC], { cwd: root, encoding: "utf8" });
    expect(second.status).toBe(0);
    expect(readFileSync(join(root, "BOARD.md"), "utf8")).not.toContain("Ghost row");
    // Still exactly one entry: the second run recognised its own marker, not re-filed.
    const outbox = readFileSync(join(root, "OUTBOX.md"), "utf8");
    expect([...outbox.matchAll(/<!-- loops:orphan /g)]).toHaveLength(1);
  });

  test("re-files the entry, and keeps the row again, if the entry was swallowed", () => {
    // The case the two phases exist for: something replaced OUTBOX.md wholesale between
    // runs. The row is still on the board, so nothing is lost and the next run refiles.
    const root = dataRepoWithOrphanRow();
    expect(spawnSync("bun", [SYNC], { cwd: root, encoding: "utf8" }).status).toBe(0);
    writeFileSync(join(root, "OUTBOX.md"), "# Outbox\n\n## Open\n"); // an editor's save

    const again = spawnSync("bun", [SYNC], { cwd: root, encoding: "utf8" });
    expect(again.status).toBe(0);
    expect(readFileSync(join(root, "OUTBOX.md"), "utf8")).toContain("items/does-not-exist.md");
    expect(readFileSync(join(root, "BOARD.md"), "utf8")).toContain("Ghost row");
  });

  test("reports a repairable outbox instead of a stack trace, board intact", () => {
    // OUTBOX.md is a file the owner edits: missing, or with its `## Open` section removed,
    // are states to explain rather than crash on.
    for (const damage of [null, "# Outbox\n\nnothing routable here\n"]) {
      const root = dataRepoWithOrphanRow();
      const board = readFileSync(join(root, "BOARD.md"), "utf8");
      if (damage === null) rmSync(join(root, "OUTBOX.md"));
      else writeFileSync(join(root, "OUTBOX.md"), damage);

      const result = spawnSync("bun", [SYNC], { cwd: root, encoding: "utf8" });

      expect(result.status).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("NOT routed");
      expect(output).toContain("OUTBOX.md");
      expect(output).not.toContain("at <anonymous>");
      expect(readFileSync(join(root, "BOARD.md"), "utf8")).toBe(board);
    }
  });

  test("aborts and leaves BOARD.md untouched when the outbox lock is held", () => {
    const root = dataRepoWithOrphanRow();
    const board = readFileSync(join(root, "BOARD.md"), "utf8");
    const outbox = readFileSync(join(root, "OUTBOX.md"), "utf8");
    writeFileSync(join(root, "OUTBOX.md.lock"), "999");

    const result = spawnSync("bun", [SYNC], { cwd: root, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("NOT routed");
    // Both surfaces intact: the row is still on the board, so the next sync can route it.
    expect(readFileSync(join(root, "BOARD.md"), "utf8")).toBe(board);
    expect(readFileSync(join(root, "OUTBOX.md"), "utf8")).toBe(outbox);
  });
});
