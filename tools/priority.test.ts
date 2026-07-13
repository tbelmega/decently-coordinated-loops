import { describe, expect, test } from "bun:test";
import type { ItemFile } from "./types.ts";
import { makePriorityCompare } from "./priority.ts";

function item(overrides: Partial<ItemFile> & { slug: string }): ItemFile {
  return {
    path: `items/${overrides.slug}.md`,
    title: overrides.slug,
    project: "atlas",
    state: "spec-filed",
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

describe("makePriorityCompare", () => {
  test("ranks listed projects ahead of unlisted ones, in list order", () => {
    const compare = makePriorityCompare(["atlas", "beta"]);
    const items = [
      item({ slug: "gamma-1", project: "gamma", updated: "2026-07-10" }),
      item({ slug: "beta-1", project: "beta", updated: "2026-07-10" }),
      item({ slug: "atlas-1", project: "atlas", updated: "2026-07-10" }),
    ];
    const sorted = [...items].sort(compare);
    expect(sorted.map((i) => i.slug)).toEqual(["atlas-1", "beta-1", "gamma-1"]);
  });

  test("an unlisted project ranks after every listed project", () => {
    const compare = makePriorityCompare(["atlas"]);
    const items = [
      item({ slug: "other", project: "zeta", updated: "2026-07-10" }),
      item({ slug: "atlas-1", project: "atlas", updated: "2026-07-01" }),
    ];
    const sorted = [...items].sort(compare);
    expect(sorted.map((i) => i.slug)).toEqual(["atlas-1", "other"]);
  });

  test("within the same project rank, most recently updated sorts first", () => {
    const compare = makePriorityCompare(["atlas"]);
    const items = [
      item({ slug: "older", project: "atlas", updated: "2026-07-01" }),
      item({ slug: "newer", project: "atlas", updated: "2026-07-09" }),
    ];
    const sorted = [...items].sort(compare);
    expect(sorted.map((i) => i.slug)).toEqual(["newer", "older"]);
  });

  test("ties on project rank and updated date break by slug", () => {
    const compare = makePriorityCompare([]);
    const items = [
      item({ slug: "zeta-item", project: "x", updated: "2026-07-10" }),
      item({ slug: "alpha-item", project: "x", updated: "2026-07-10" }),
    ];
    const sorted = [...items].sort(compare);
    expect(sorted.map((i) => i.slug)).toEqual(["alpha-item", "zeta-item"]);
  });

  test("an empty priority list ranks every project equally (falls through to updated/slug)", () => {
    const compare = makePriorityCompare([]);
    const items = [
      item({ slug: "a", project: "alpha", updated: "2026-07-01" }),
      item({ slug: "b", project: "beta", updated: "2026-07-05" }),
    ];
    const sorted = [...items].sort(compare);
    expect(sorted.map((i) => i.slug)).toEqual(["b", "a"]);
  });
});
