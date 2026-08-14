import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadArchiveDir, loadForDeliveryDir, loadItemsDir } from "./parse.ts";
import { runPreflight } from "./preflight.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__");

const HEADER = `| Item | Project | State | Next-actor | Awaiting | Auto | Assignee | Updated |
| --- | --- | --- | --- | --- | --- | --- | --- |
`;

describe("runPreflight", () => {
  const items = loadItemsDir(join(FIXTURES, "items"));
  const forDelivery = loadForDeliveryDir(join(FIXTURES, "for-delivery"));
  const archived = loadArchiveDir(join(FIXTURES, "archive"));
  const terminal = [...forDelivery, ...archived];

  test("detects an orphan row (board row with no matching item file)", () => {
    const boardText =
      HEADER +
      "| [Ghost row](items/does-not-exist.md) | alpha | idea | owner | decide | - | - | 2026-07-01 |\n";
    const report = runPreflight(boardText, items, terminal);
    expect(report.orphanRows.length).toBe(1);
    expect(report.orphanRows[0].path).toBe("items/does-not-exist.md");
  });

  test("detects a missing row (item file with no board row) for auto-add self-heal", () => {
    const boardText = HEADER; // no rows at all
    const report = runPreflight(boardText, items, terminal);
    expect(report.missingRows).toContain("alpha-needs-approve");
    expect(report.missingRows.length).toBe(items.length);
  });

  test("detects a field mismatch and reports item-file value as canonical", () => {
    const boardText =
      HEADER +
      "| [Alpha needs approve](items/alpha-needs-approve.md) | alpha | spec-filed | owner | decide | - | - | 2026-07-01 |\n";
    const report = runPreflight(boardText, items, terminal);
    const mismatch = report.mismatches.find((m) => m.slug === "alpha-needs-approve" && m.field === "awaiting");
    expect(mismatch).toBeDefined();
    expect(mismatch!.boardValue).toBe("decide");
    expect(mismatch!.fileValue).toBe("approve");
  });

  test("reports an assignee mismatch by its canonical field name", () => {
    const boardText =
      HEADER +
      "| [Alpha needs approve](items/alpha-needs-approve.md) | alpha | spec-filed | owner | approve | - | codex/default | 2026-07-01 |\n";
    const report = runPreflight(boardText, items, terminal);
    expect(report.mismatches).toContainEqual({
      slug: "alpha-needs-approve",
      field: "assignee",
      boardValue: "codex/default",
      fileValue: "-",
    });
  });

  test("no mismatch when board row matches the item file exactly", () => {
    const boardText =
      HEADER +
      "| [Alpha needs approve](items/alpha-needs-approve.md) | alpha | spec-filed | owner | approve | - | - | 2026-07-01 |\n";
    const report = runPreflight(boardText, items, terminal);
    expect(report.mismatches.length).toBe(0);
    expect(report.orphanRows.length).toBe(0);
  });

  test("ignores the Done section table (different column shape)", () => {
    const boardText =
      HEADER +
      "\n## Done\n\n| Item | Project | Finished |\n| --- | --- | --- |\n" +
      "| [Some done item](items/somewhere.md) | atlas | 2026-07-01 |\n";
    const report = runPreflight(boardText, items, terminal);
    expect(report.orphanRows.length).toBe(0);
  });

  // A row's link keeps naming `items/<slug>.md` after the file has moved to a terminal
  // folder, so resolving row identity by path made every such row look like an orphan:
  // an owner question filed for an item that exists, and the row dropped on the reasoning
  // that it had none. Identity is the slug, which survives the move. One case per folder.
  test("a row whose item moved to for-delivery/ is not an orphan", () => {
    const boardText =
      HEADER +
      "| [Eta tested, awaiting delivery](items/eta-tested.md) | atlas | tested | owner | deliver | auto | agent-x | 2026-07-08 |\n";
    const report = runPreflight(boardText, items, terminal);
    expect(report.orphanRows.length).toBe(0);
    expect(report.terminalRows.map((r) => r.itemPath)).toEqual(["for-delivery/eta-tested.md"]);
  });

  test("a row whose item moved to archive/ is not an orphan", () => {
    const boardText =
      HEADER +
      "| [Zeta accepted](items/zeta-accepted.md) | zeta | accepted | owner | - | - | agent-x | 2026-07-08 |\n";
    const report = runPreflight(boardText, items, terminal);
    expect(report.orphanRows.length).toBe(0);
    expect(report.terminalRows.map((r) => r.itemPath)).toEqual(["archive/zeta-accepted.md"]);
  });

  test("a terminal row is neither field-compared nor counted as a missing row", () => {
    // The regenerated board renders active items only, so the row is dropped either way.
    // Comparing its fields would report drift the caller cannot act on, and the item is
    // not an active file wanting a row back.
    const boardText =
      HEADER +
      "| [Zeta accepted](items/zeta-accepted.md) | zeta | idea | agent | - | auto | somebody-else | 2026-01-01 |\n";
    const report = runPreflight(boardText, items, terminal);
    expect(report.mismatches).toEqual([]);
    expect(report.missingRows).not.toContain("zeta-accepted");
  });

  // Whether a row may be dropped is decided by one question, and rounds 1-3 of review
  // each found a point-fix that answered it for some folder/state pairs and not others.
  // So the whole matrix is enumerated here rather than the pairs that happened to break.
  //
  // The question is not "is the file in a terminal folder" but "will the item be
  // reachable after this sync". `planMoves` is fed items/ and for-delivery/ only, so
  // archive/ is a one-way door: a file there that does not belong there is stranded, no
  // move repairs it, no integrity check objects to its canonical state, and its board row
  // is the last trace of it. Every misplacement outside archive/ is repaired in the same
  // run, so its stale row is simply dropped and re-rendered when the item lands back.
  const misfiledRow =
    HEADER + "| [Misfiled](items/misfiled.md) | zeta | in-progress | agent | - | auto | agent-x | 2026-07-08 |\n";

  const MATRIX = [
    { folder: "for-delivery", state: "in-progress", stranded: false, why: "planMoves carries it back to items/" },
    { folder: "for-delivery", state: "tested", stranded: false, why: "legitimately where it sits" },
    { folder: "for-delivery", state: "delivered", stranded: false, why: "legitimately where it sits" },
    { folder: "for-delivery", state: "accepted", stranded: false, why: "the ordinary accept flow; sync archives it" },
    { folder: "for-delivery", state: "dropped", stranded: false, why: "sync archives it in this run" },
    { folder: "for-delivery", state: "not-a-state", stranded: false, why: "unknown state means items/; sync repairs" },
    { folder: "archive", state: "in-progress", stranded: true, why: "stranded: nothing moves it out of archive/" },
    { folder: "archive", state: "tested", stranded: true, why: "stranded, and just as invisible as an active one" },
    { folder: "archive", state: "delivered", stranded: true, why: "stranded, and just as invisible as an active one" },
    { folder: "archive", state: "accepted", stranded: false, why: "legitimately where it sits" },
    { folder: "archive", state: "dropped", stranded: false, why: "legitimately where it sits" },
    { folder: "archive", state: "not-a-state", stranded: true, why: "unknown state does not mean archive/" },
  ] as const;

  for (const { folder, state, stranded, why } of MATRIX) {
    test(`${folder}/ + state ${state} -> ${stranded ? "orphan" : "stale row"} (${why})`, () => {
      const item = { ...archived[0], slug: "misfiled", path: `${folder}/misfiled.md`, state };
      const report = runPreflight(misfiledRow, items, [item]);
      if (stranded) {
        expect(report.terminalRows).toEqual([]);
        expect(report.orphanRows.map((r) => r.path)).toEqual(["items/misfiled.md"]);
      } else {
        expect(report.orphanRows).toEqual([]);
        expect(report.terminalRows.map((r) => r.itemPath)).toEqual([`${folder}/misfiled.md`]);
      }
    });
  }

  test("still an orphan when the item exists in no folder at all", () => {
    const boardText =
      HEADER +
      "| [Ghost row](items/does-not-exist.md) | alpha | idea | owner | decide | - | - | 2026-07-01 |\n";
    const report = runPreflight(boardText, items, terminal);
    expect(report.terminalRows.length).toBe(0);
    expect(report.orphanRows.map((r) => r.path)).toEqual(["items/does-not-exist.md"]);
  });

  test("parses a row whose title itself contains a bracketed fragment (regression: naive [^\\]]+ regex breaks on this)", () => {
    const boardText =
      HEADER +
      "| [Admin: Tenant Detail [S6] model-allowlist](items/alpha-needs-approve.md) | alpha | spec-filed | owner | approve | - | - | 2026-07-01 |\n";
    const report = runPreflight(boardText, items, terminal);
    expect(report.orphanRows.length).toBe(0);
    expect(report.missingRows).not.toContain("alpha-needs-approve");
    expect(report.mismatches.length).toBe(0);
  });
});
