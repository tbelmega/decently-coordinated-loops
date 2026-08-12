// CLI-level regression for the one sync outcome that can destroy data: an orphan
// BOARD.md row is the only remaining copy of its work-stream (it has no item file), so a
// sync that cannot file it in OUTBOX.md must not regenerate the board without it.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("cli-sync orphan routing", () => {
  test("files the orphan row and regenerates the board", () => {
    const root = dataRepoWithOrphanRow();
    const result = spawnSync("bun", [SYNC], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "OUTBOX.md"), "utf8")).toContain("items/does-not-exist.md");
    expect(readFileSync(join(root, "BOARD.md"), "utf8")).not.toContain("Ghost row");
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
