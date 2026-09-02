import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadItemsDir } from "./parse.ts";
import { renderBoardMd, replaceActiveRow } from "./render.ts";
import type { LoopsConfig } from "./config.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__/items");

const CONFIG: LoopsConfig = {
  owner: "casey",
  priorityProjects: ["atlas"],
  integrationBranch: "master",
  landedAdapter: "git",
  githubTokens: {},
  projects: {},
  review: {},
};

describe("renderBoardMd", () => {
  const items = loadItemsDir(FIXTURES);
  const text = renderBoardMd(items, CONFIG);

  test("renders the standard header and active-table column headers", () => {
    expect(text).toContain("# Board");
    expect(text).toContain("the loops-board skill");
    expect(text).toContain("the loops-pickup skill");
    expect(text).toContain(
      "| Item | Project | State | Next-actor | Awaiting | Auto | Assignee | Updated |"
    );
  });

  test("renders the configured priorities line", () => {
    expect(text).toContain("Priorities: 1. atlas - 2. everything else by most recent activity.");
  });

  test("falls back to a plain note when no priority projects are configured", () => {
    const noPriority = renderBoardMd(items, { ...CONFIG, priorityProjects: [] });
    expect(noPriority).toContain("Priorities: most recent activity first.");
  });

  test("renders no Done section - terminal items belong in ARCHIVE.md, not BOARD.md", () => {
    expect(text).not.toContain("## Done");
    expect(text).not.toContain("Finished");
  });

  test("excludes non-active items (for-delivery/terminal) even if one slips through to the caller (defense-in-depth; the primary mechanism is moving them out of items/ before this is called)", () => {
    const withNonActive = [
      ...items,
      { ...items[0], slug: "sneaky-tested", path: "items/sneaky-tested.md", title: "Sneaky tested", state: "tested" },
      { ...items[0], slug: "sneaky-accepted", path: "items/sneaky-accepted.md", title: "Sneaky accepted", state: "accepted" },
    ];
    const rendered = renderBoardMd(withNonActive, CONFIG);
    expect(rendered).not.toContain("Sneaky tested");
    expect(rendered).not.toContain("Sneaky accepted");
  });

  test("active rows are ordered atlas-first, then most recent updated", () => {
    const lines = text.split("\n").filter((l) => l.startsWith("| ["));
    const atlasRows = lines.filter((l) => l.includes("| atlas |"));
    const otherRows = lines.filter((l) => !l.includes("| atlas |"));
    // every atlas row appears before every non-atlas row
    const lastAtlasIdx = lines.lastIndexOf(atlasRows[atlasRows.length - 1]);
    const firstOtherIdx = lines.indexOf(otherRows[0]);
    expect(lastAtlasIdx).toBeLessThan(firstOtherIdx);
  });

  test("row format matches the schema: title link, project, state, next-actor, awaiting, auto, assignee, updated", () => {
    const row = text
      .split("\n")
      .find((l) => l.includes("atlas-ready-unblocked.md"));
    expect(row).toBe(
      "| [Atlas ready unblocked](items/atlas-ready-unblocked.md) | atlas | spec-filed | agent | - | auto | - | 2026-07-03 |"
    );
  });
});

describe("replaceActiveRow", () => {
  const items = loadItemsDir(FIXTURES);
  const item = {
    ...items[0],
    slug: "atlas-search-index",
    path: "items/atlas-search-index.md",
    title: "Search index",
    project: "atlas",
    state: "merged",
    nextActor: "agent",
    awaiting: undefined,
    autonomy: "auto",
    assignee: "-",
    updated: "2026-07-10",
  };

  const board = `${renderBoardMd(items, CONFIG)}| [Search index](items/atlas-search-index.md) | atlas | implemented | owner | review-merge | auto | - | 2026-07-02 |\n`;

  test("rewrites only the matching row, in the standard row format", () => {
    const result = replaceActiveRow(board, item);
    expect(result).toContain(
      "| [Search index](items/atlas-search-index.md) | atlas | merged | agent | - | auto | - | 2026-07-10 |"
    );
    const row = result.split("\n").find((l) => l.includes("](items/atlas-search-index.md)"));
    expect(row).not.toContain("review-merge");
  });

  test("leaves every other row untouched", () => {
    const result = replaceActiveRow(board, item);
    expect(result).toContain("atlas-ready-unblocked.md");
  });

  test("returns the text unchanged when no row matches the item path", () => {
    const result = replaceActiveRow(board, { ...item, path: "items/absent.md" });
    expect(result).toBe(board);
  });
});
