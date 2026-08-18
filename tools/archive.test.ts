import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadItemsDir } from "./parse.ts";
import {
  currentFolder,
  FOR_DELIVERY_STATES,
  itemTargetFolder,
  planMoves,
  reconcileArchiveRows,
  targetFolder,
  TERMINAL_STATES,
} from "./archive.ts";
import type { LoopsConfig } from "./config.ts";
import type { ItemFile } from "./types.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__/items");

function item(overrides: Partial<ItemFile> & { slug: string }): ItemFile {
  return {
    path: `items/${overrides.slug}.md`,
    title: overrides.slug,
    project: "atlas",
    state: "in-progress",
    assignee: "-",
    autonomy: "auto",
    nextActor: "agent",
    dependsOn: [],
    nextStep: "",
    updated: "2026-07-10",
    links: {},
    ...overrides,
  };
}

/** `atlas` (the item() default project) ends at the owner's acceptance; `docs` ends at
 * `tested`; `beta` is registered without a lifecycle; nothing else is registered at all. */
const CONFIG: LoopsConfig = {
  owner: "casey",
  priorityProjects: [],
  integrationBranch: "master",
  landedAdapter: "git",
  githubTokens: {},
  projects: {
    atlas: { lifecycle: "deploy" },
    docs: { lifecycle: "no-deploy" },
    beta: { repo: "acme-org/beta" },
  },
  review: {},
};

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
      expect(targetFolder(state, "deploy")).toBe("items");
      expect(targetFolder(state, "no-deploy")).toBe("items");
    }
  });

  test("tested and delivered route to for-delivery/ under the deploy tail", () => {
    expect(targetFolder("tested", "deploy")).toBe("for-delivery");
    expect(targetFolder("delivered", "deploy")).toBe("for-delivery");
  });

  test("accepted and dropped route to archive/", () => {
    expect(targetFolder("accepted", "deploy")).toBe("archive");
    expect(targetFolder("dropped", "deploy")).toBe("archive");
    expect(targetFolder("accepted", "no-deploy")).toBe("archive");
    expect(targetFolder("dropped", "no-deploy")).toBe("archive");
  });

  test("tested is terminal under the no-deploy tail", () => {
    // Option A of the spec: the item is archived AS tested. Nothing flips it to accepted,
    // so the record never claims an owner acceptance that never happened.
    expect(targetFolder("tested", "no-deploy")).toBe("archive");
  });

  test("delivered still routes to for-delivery/ under the no-deploy tail", () => {
    // The state vocabulary stays global and open to the owner's hand: only the tail's
    // termination point is configurable, so a hand-set `delivered` is still respected.
    expect(targetFolder("delivered", "no-deploy")).toBe("for-delivery");
  });

  test("defaults to the deploy tail when no lifecycle is given", () => {
    expect(targetFolder("tested")).toBe("for-delivery");
    expect(targetFolder("delivered")).toBe("for-delivery");
  });
});

describe("itemTargetFolder", () => {
  test("resolves the lifecycle from the item's project", () => {
    expect(itemTargetFolder(item({ slug: "a", project: "atlas", state: "tested" }), CONFIG)).toBe("for-delivery");
    expect(itemTargetFolder(item({ slug: "d", project: "docs", state: "tested" }), CONFIG)).toBe("archive");
  });

  test("a registered project without a lifecycle keeps the deploy tail", () => {
    expect(itemTargetFolder(item({ slug: "b", project: "beta", state: "tested" }), CONFIG)).toBe("for-delivery");
  });

  test("an unregistered project keeps the deploy tail", () => {
    // Fail toward the longer tail: a typo in `project:` must not archive verified work
    // behind the owner's back.
    expect(itemTargetFolder(item({ slug: "u", project: "typo-project", state: "tested" }), CONFIG)).toBe(
      "for-delivery",
    );
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
    const moves = planMoves([item({ slug: "verified", state: "tested" })], CONFIG);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ from: "items", to: "for-delivery" });
  });

  test("moves a no-deploy project's tested item straight from items/ to archive/", () => {
    const moves = planMoves([item({ slug: "verified", project: "docs", state: "tested" })], CONFIG);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ from: "items", to: "archive" });
  });

  test("carries a no-deploy project's tested item out of for-delivery/ (the rollout migration)", () => {
    // What the first sync after the config change does with items already parked there:
    // no migration step of its own, just the existing move machinery.
    const moves = planMoves(
      [item({ slug: "parked", project: "docs", state: "tested", path: "for-delivery/parked.md" })],
      CONFIG,
    );
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ from: "for-delivery", to: "archive" });
  });

  test("leaves a no-deploy project's hand-set delivered item in for-delivery/", () => {
    const moves = planMoves(
      [item({ slug: "handed", project: "docs", state: "delivered", path: "for-delivery/handed.md" })],
      CONFIG,
    );
    expect(moves).toEqual([]);
  });

  test("moves an accepted item that already sits in for-delivery/ to archive/", () => {
    const moves = planMoves([
      item({ slug: "done", state: "accepted", path: "for-delivery/done.md" }),
    ], CONFIG);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ from: "for-delivery", to: "archive" });
  });

  test("leaves an item alone when its folder already matches its state", () => {
    const moves = planMoves([
      item({ slug: "stays", state: "merged" }),
      item({ slug: "parked", state: "delivered", path: "for-delivery/parked.md" }),
    ], CONFIG);
    expect(moves).toEqual([]);
  });

  test("the current items/ fixtures need no moves (nothing terminal/for-delivery in items/)", () => {
    expect(planMoves(loadItemsDir(FIXTURES), CONFIG)).toEqual([]);
  });
});

describe("reconcileArchiveRows", () => {
  const ARCHIVE_MD = `# Archive

Terminal work-streams.

| Item | Project | Finished |
| --- | --- | --- |
`;

  // Every fixture below carries a terminal state, because that is what an archived item
  // is. The items/ fixtures these are spread from are all active, so an inherited state
  // would describe a file stranded in archive/, which is the one thing this must not index.
  test("is a no-op when there are no archived items", () => {
    expect(reconcileArchiveRows(ARCHIVE_MD, [], CONFIG)).toBe(ARCHIVE_MD);
  });

  test("appends a row per un-indexed archived item, linking to archive/<slug>.md", () => {
    const items = loadItemsDir(FIXTURES);
    const item = {
      ...items[0],
      slug: "some-slug",
      title: "Some Title",
      project: "atlas",
      state: "accepted",
      updated: "2026-07-10",
    };
    const result = reconcileArchiveRows(ARCHIVE_MD, [item], CONFIG);
    expect(result).toContain("| [Some Title](archive/some-slug.md) | atlas | 2026-07-10 |");
  });

  test("sorts a multi-item batch most-recently-finished first", () => {
    const items = loadItemsDir(FIXTURES);
    const older = { ...items[0], slug: "older", title: "Older", state: "accepted", updated: "2026-07-01" };
    const newer = { ...items[0], slug: "newer", title: "Newer", state: "accepted", updated: "2026-07-08" };
    const result = reconcileArchiveRows(ARCHIVE_MD, [older, newer], CONFIG);
    expect(result.indexOf("Newer")).toBeLessThan(result.indexOf("Older"));
  });

  test("appends after existing rows without disturbing them", () => {
    const withExisting = `${ARCHIVE_MD}| [Old row](archive/old-row.md) | atlas | 2026-06-01 |\n`;
    const items = loadItemsDir(FIXTURES);
    const item = { ...items[0], slug: "fresh", title: "Fresh", state: "accepted", updated: "2026-07-10" };
    const result = reconcileArchiveRows(withExisting, [item], CONFIG);
    expect(result).toContain("Old row");
    expect(result).toContain("Fresh");
    expect(result.indexOf("Old row")).toBeLessThan(result.indexOf("Fresh"));
  });

  test("is idempotent: an already-indexed slug is not re-appended", () => {
    const items = loadItemsDir(FIXTURES);
    const item = { ...items[0], slug: "kept", title: "Kept", state: "accepted", updated: "2026-07-10" };
    const once = reconcileArchiveRows(ARCHIVE_MD, [item], CONFIG);
    const twice = reconcileArchiveRows(once, [item], CONFIG);
    expect(twice).toBe(once);
    expect(once.match(/archive\/kept\.md/g)?.length).toBe(1);
  });

  test("adds only the missing row when reconciling the full archive set (crash recovery)", () => {
    const items = loadItemsDir(FIXTURES);
    const indexed = { ...items[0], slug: "indexed", title: "Indexed", state: "accepted", updated: "2026-07-05" };
    const withOne = reconcileArchiveRows(ARCHIVE_MD, [indexed], CONFIG);
    // A later run finds the folder holds both the indexed item and one whose row a
    // prior crash never wrote; only the missing row is added.
    const orphaned = { ...items[0], slug: "orphaned", title: "Orphaned", state: "dropped", updated: "2026-07-06" };
    const result = reconcileArchiveRows(withOne, [indexed, orphaned], CONFIG);
    expect(result.match(/archive\/indexed\.md/g)?.length).toBe(1);
    expect(result.match(/archive\/orphaned\.md/g)?.length).toBe(1);
  });

  // Round-6 attempt 1 (invalidated mid-run, so its findings carry no ledger ID). Sitting
  // in archive/ is not being terminal. A file hand-moved there with
  // a live state is stranded: preflight keeps its board row and asks the owner to move it
  // back, so indexing it here would record the same work-stream as both live and finished
  // in the two derived indexes. Every non-terminal state, not just the active ones.
  for (const state of ["idea", "in-progress", "blocked", "tested", "delivered", "merged"]) {
    test(`does not index a ${state} file stranded in archive/`, () => {
      const items = loadItemsDir(FIXTURES);
      const item = { ...items[0], slug: "stranded", title: "Stranded", state, updated: "2026-07-10" };
      expect(reconcileArchiveRows(ARCHIVE_MD, [item], CONFIG)).toBe(ARCHIVE_MD);
    });
  }

  // The same rule read through a no-deploy project: `tested` is where that project's
  // lifecycle ends, so the file belongs in archive/ and its row is the ordinary
  // most-recently-finished entry rather than a stranding to keep quiet about.
  test("indexes a no-deploy project's tested file, which is terminal there", () => {
    const items = loadItemsDir(FIXTURES);
    const item = { ...items[0], slug: "shipped", title: "Shipped", project: "docs", state: "tested", updated: "2026-07-10" };
    expect(reconcileArchiveRows(ARCHIVE_MD, [item], CONFIG)).toContain("| [Shipped](archive/shipped.md) | docs | 2026-07-10 |");
  });

  test("still refuses a deploy project's tested file, which is stranded there", () => {
    const items = loadItemsDir(FIXTURES);
    const item = { ...items[0], slug: "stranded", title: "Stranded", project: "atlas", state: "tested", updated: "2026-07-10" };
    expect(reconcileArchiveRows(ARCHIVE_MD, [item], CONFIG)).toBe(ARCHIVE_MD);
  });

  // Round 6, R6-F1/F2/F4. Round-6 attempt 2 had me delete the row of an already-indexed
  // file that went stranded. That is the tidier-looking rule and the destructive one: an
  // item archived the ordinary way has no board row, so this row is its last derived
  // trace, and deleting it left a live work-stream indexed nowhere at all. The staleness
  // is real but it is a reporting problem, and validateItem reports it from the file.
  test("keeps the row of an already-indexed file whose state left archive/", () => {
    const items = loadItemsDir(FIXTURES);
    const done = { ...items[0], slug: "reopened", title: "Reopened", state: "accepted", updated: "2026-07-10" };
    const indexed = reconcileArchiveRows(ARCHIVE_MD, [done], CONFIG);
    expect(indexed).toContain("archive/reopened.md");

    expect(reconcileArchiveRows(indexed, [{ ...done, state: "in-progress" }], CONFIG)).toBe(indexed);
  });

  // R6-F3, the same rule's other casualty: the removal matched any line carrying the link,
  // so a hand-written note about an archived item was deleted along with its row. Appending
  // only cannot touch prose, which is the point.
  test("never rewrites hand-written prose that links to an archived item", () => {
    const items = loadItemsDir(FIXTURES);
    const item = { ...items[0], slug: "noted", title: "Noted", state: "accepted", updated: "2026-07-10" };
    const prose = `${ARCHIVE_MD}\nSee [Noted](archive/noted.md) for the rationale we kept.\n`;
    expect(reconcileArchiveRows(prose, [{ ...item, state: "in-progress" }], CONFIG)).toBe(prose);
    expect(reconcileArchiveRows(prose, [item], CONFIG)).toContain("for the rationale we kept.");
  });

  test("indexes the terminal files in a batch that also holds a stranded one", () => {
    const items = loadItemsDir(FIXTURES);
    const done = { ...items[0], slug: "done", title: "Done", state: "accepted", updated: "2026-07-10" };
    const stranded = { ...items[0], slug: "stranded", title: "Stranded", state: "in-progress", updated: "2026-07-11" };
    const result = reconcileArchiveRows(ARCHIVE_MD, [done, stranded], CONFIG);
    expect(result).toContain("archive/done.md");
    expect(result).not.toContain("archive/stranded.md");
  });
});
