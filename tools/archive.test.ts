import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadItemsDir } from "./parse.ts";
import {
  currentFolder,
  FOR_DELIVERY_STATES,
  planMoves,
  reconcileArchiveRows,
  targetFolder,
  TERMINAL_STATES,
} from "./archive.ts";
import type { ItemFile } from "./types.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__/items");

function item(overrides: Partial<ItemFile> & { slug: string }): ItemFile {
  return {
    path: `items/${overrides.slug}.md`,
    title: overrides.slug,
    project: "atlas",
    state: "in-progress",
    owner: "-",
    autonomy: "auto",
    nextActor: "agent",
    dependsOn: [],
    nextStep: "",
    updated: "2026-07-10",
    links: {},
    ...overrides,
  };
}

describe("TERMINAL_STATES / FOR_DELIVERY_STATES", () => {
  test("terminal is exactly accepted and dropped (tested is no longer terminal)", () => {
    expect(TERMINAL_STATES.has("accepted")).toBe(true);
    expect(TERMINAL_STATES.has("dropped")).toBe(true);
    expect(TERMINAL_STATES.has("tested")).toBe(false);
  });

  test("for-delivery is exactly tested and delivered", () => {
    expect([...FOR_DELIVERY_STATES].sort()).toEqual(["delivered", "tested"]);
  });
});

describe("targetFolder", () => {
  test("in-flight states stay in items/", () => {
    for (const state of ["idea", "spec-filed", "in-progress", "implemented", "merged", "blocked"]) {
      expect(targetFolder(state)).toBe("items");
    }
  });

  test("tested and delivered route to for-delivery/", () => {
    expect(targetFolder("tested")).toBe("for-delivery");
    expect(targetFolder("delivered")).toBe("for-delivery");
  });

  test("accepted and dropped route to archive/", () => {
    expect(targetFolder("accepted")).toBe("archive");
    expect(targetFolder("dropped")).toBe("archive");
  });
});

describe("currentFolder", () => {
  test("derives the folder from the path prefix", () => {
    expect(currentFolder("items/x.md")).toBe("items");
    expect(currentFolder("for-delivery/x.md")).toBe("for-delivery");
    expect(currentFolder("archive/x.md")).toBe("archive");
  });
});

describe("planMoves", () => {
  test("moves a tested item from items/ to for-delivery/", () => {
    const moves = planMoves([item({ slug: "verified", state: "tested" })]);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ from: "items", to: "for-delivery" });
  });

  test("moves an accepted item that already sits in for-delivery/ to archive/", () => {
    const moves = planMoves([
      item({ slug: "done", state: "accepted", path: "for-delivery/done.md" }),
    ]);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ from: "for-delivery", to: "archive" });
  });

  test("leaves an item alone when its folder already matches its state", () => {
    const moves = planMoves([
      item({ slug: "stays", state: "merged" }),
      item({ slug: "parked", state: "delivered", path: "for-delivery/parked.md" }),
    ]);
    expect(moves).toEqual([]);
  });

  test("the current items/ fixtures need no moves (nothing terminal/for-delivery in items/)", () => {
    expect(planMoves(loadItemsDir(FIXTURES))).toEqual([]);
  });
});

describe("reconcileArchiveRows", () => {
  const ARCHIVE_MD = `# Archive

Terminal work-streams.

| Item | Project | Finished |
| --- | --- | --- |
`;

  test("is a no-op when there are no archived items", () => {
    expect(reconcileArchiveRows(ARCHIVE_MD, [])).toBe(ARCHIVE_MD);
  });

  test("appends a row per un-indexed archived item, linking to archive/<slug>.md", () => {
    const items = loadItemsDir(FIXTURES);
    const item = { ...items[0], slug: "some-slug", title: "Some Title", project: "atlas", updated: "2026-07-10" };
    const result = reconcileArchiveRows(ARCHIVE_MD, [item]);
    expect(result).toContain("| [Some Title](archive/some-slug.md) | atlas | 2026-07-10 |");
  });

  test("sorts a multi-item batch most-recently-finished first", () => {
    const items = loadItemsDir(FIXTURES);
    const older = { ...items[0], slug: "older", title: "Older", updated: "2026-07-01" };
    const newer = { ...items[0], slug: "newer", title: "Newer", updated: "2026-07-08" };
    const result = reconcileArchiveRows(ARCHIVE_MD, [older, newer]);
    expect(result.indexOf("Newer")).toBeLessThan(result.indexOf("Older"));
  });

  test("appends after existing rows without disturbing them", () => {
    const withExisting = `${ARCHIVE_MD}| [Old row](archive/old-row.md) | atlas | 2026-06-01 |\n`;
    const items = loadItemsDir(FIXTURES);
    const item = { ...items[0], slug: "fresh", title: "Fresh", updated: "2026-07-10" };
    const result = reconcileArchiveRows(withExisting, [item]);
    expect(result).toContain("Old row");
    expect(result).toContain("Fresh");
    expect(result.indexOf("Old row")).toBeLessThan(result.indexOf("Fresh"));
  });

  test("is idempotent: an already-indexed slug is not re-appended", () => {
    const items = loadItemsDir(FIXTURES);
    const item = { ...items[0], slug: "kept", title: "Kept", updated: "2026-07-10" };
    const once = reconcileArchiveRows(ARCHIVE_MD, [item]);
    const twice = reconcileArchiveRows(once, [item]);
    expect(twice).toBe(once);
    expect(once.match(/archive\/kept\.md/g)?.length).toBe(1);
  });

  test("adds only the missing row when reconciling the full archive set (crash recovery)", () => {
    const items = loadItemsDir(FIXTURES);
    const indexed = { ...items[0], slug: "indexed", title: "Indexed", updated: "2026-07-05" };
    const withOne = reconcileArchiveRows(ARCHIVE_MD, [indexed]);
    // A later run finds the folder holds both the indexed item and one whose row a
    // prior crash never wrote; only the missing row is added.
    const orphaned = { ...items[0], slug: "orphaned", title: "Orphaned", updated: "2026-07-06" };
    const result = reconcileArchiveRows(withOne, [indexed, orphaned]);
    expect(result.match(/archive\/indexed\.md/g)?.length).toBe(1);
    expect(result.match(/archive\/orphaned\.md/g)?.length).toBe(1);
  });
});
