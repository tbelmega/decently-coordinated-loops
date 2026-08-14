// CLI-level cover for the report-only integrity gate's exit code. `bun run check` is what
// agents run to decide a data repo is sound, so what it stays silent about is as much a
// contract as what it prints.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DCL_HOME = resolve(import.meta.dirname, "..");
const CHECK = join(DCL_HOME, "tools", "cli-check.ts");
const TEMPLATES = join(DCL_HOME, "setup", "templates");

const ITEM = `---
title: "Reopened"
project: atlas
state: in-progress
assignee: "-"
autonomy: "-"
next-actor: agent
next-step: "carry on"
updated: 2026-07-08
---
Fixture item.
`;

const created: string[] = [];

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

/** A data repo whose BOARD.md carries a row for an item whose file sits in `folder`. */
function dataRepo(folder: "items" | "for-delivery" | "archive"): string {
  const root = mkdtempSync(join(tmpdir(), "dcl-check-"));
  created.push(root);
  for (const dir of ["items", "for-delivery", "archive"]) mkdirSync(join(root, dir));
  const row = "| [Reopened](items/reopened.md) | atlas | in-progress | agent | - | - | - | 2026-07-08 |\n";
  writeFileSync(join(root, "BOARD.md"), readFileSync(join(TEMPLATES, "BOARD.md"), "utf8") + row);
  writeFileSync(join(root, "ARCHIVE.md"), readFileSync(join(TEMPLATES, "ARCHIVE.md"), "utf8"));
  writeFileSync(join(root, "OUTBOX.md"), "# Outbox\n\n## Open\n");
  writeFileSync(join(root, "loops.json"), `{"owner":"Casey"}\n`);
  writeFileSync(join(root, folder, "reopened.md"), ITEM);
  return root;
}

describe("cli-check on a board row whose item is in the wrong folder", () => {
  test("passes when the row and the item file agree", () => {
    const result = spawnSync("bun", [CHECK], { cwd: dataRepo("items"), encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  // Review R5-F1. Telling these rows apart from orphans stopped a false owner question,
  // which is the point of the change - but it must not also make the gate quieter. The
  // repo really is inconsistent here: the board links items/reopened.md while the
  // authoritative file is elsewhere, and until someone runs the mutating sync command that
  // link is broken and the work-stream is undispatchable.
  for (const folder of ["for-delivery", "archive"] as const) {
    test(`fails while an active item's file sits in ${folder}/`, () => {
      const result = spawnSync("bun", [CHECK], { cwd: dataRepo(folder), encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`${folder}/reopened.md`);
    });
  }
});
