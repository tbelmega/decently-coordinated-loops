import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadItemsDir } from "./parse.ts";
import { runPreflight } from "./preflight.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__/items");

const HEADER = `| Item | Project | State | Next-actor | Awaiting | Auto | Assignee | Updated |
| --- | --- | --- | --- | --- | --- | --- | --- |
`;

describe("runPreflight", () => {
  const items = loadItemsDir(FIXTURES);

  test("detects an orphan row (board row with no matching item file)", () => {
    const boardText =
      HEADER +
      "| [Ghost row](items/does-not-exist.md) | alpha | idea | owner | decide | - | - | 2026-07-01 |\n";
    const report = runPreflight(boardText, items);
    expect(report.orphanRows.length).toBe(1);
    expect(report.orphanRows[0].path).toBe("items/does-not-exist.md");
  });

  test("detects a missing row (item file with no board row) for auto-add self-heal", () => {
    const boardText = HEADER; // no rows at all
    const report = runPreflight(boardText, items);
    expect(report.missingRows).toContain("alpha-needs-approve");
    expect(report.missingRows.length).toBe(items.length);
  });

  test("detects a field mismatch and reports item-file value as canonical", () => {
    const boardText =
      HEADER +
      "| [Alpha needs approve](items/alpha-needs-approve.md) | alpha | spec-filed | owner | decide | - | - | 2026-07-01 |\n";
    const report = runPreflight(boardText, items);
    const mismatch = report.mismatches.find((m) => m.slug === "alpha-needs-approve" && m.field === "awaiting");
    expect(mismatch).toBeDefined();
    expect(mismatch!.boardValue).toBe("decide");
    expect(mismatch!.fileValue).toBe("approve");
  });

  test("reports an assignee mismatch by its canonical field name", () => {
    const boardText =
      HEADER +
      "| [Alpha needs approve](items/alpha-needs-approve.md) | alpha | spec-filed | owner | approve | - | codex/default | 2026-07-01 |\n";
    const report = runPreflight(boardText, items);
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
    const report = runPreflight(boardText, items);
    expect(report.mismatches.length).toBe(0);
    expect(report.orphanRows.length).toBe(0);
  });

  test("ignores the Done section table (different column shape)", () => {
    const boardText =
      HEADER +
      "\n## Done\n\n| Item | Project | Finished |\n| --- | --- | --- |\n" +
      "| [Some done item](items/somewhere.md) | atlas | 2026-07-01 |\n";
    const report = runPreflight(boardText, items);
    expect(report.orphanRows.length).toBe(0);
  });

  test("parses a row whose title itself contains a bracketed fragment (regression: naive [^\\]]+ regex breaks on this)", () => {
    const boardText =
      HEADER +
      "| [Admin: Tenant Detail [S6] model-allowlist](items/alpha-needs-approve.md) | alpha | spec-filed | owner | approve | - | - | 2026-07-01 |\n";
    const report = runPreflight(boardText, items);
    expect(report.orphanRows.length).toBe(0);
    expect(report.missingRows).not.toContain("alpha-needs-approve");
    expect(report.mismatches.length).toBe(0);
  });
});
