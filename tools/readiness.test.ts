import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ItemFile } from "./types.ts";
import { loadArchiveDir, loadForDeliveryDir, loadItemsDir } from "./parse.ts";
import {
  buildUniverse,
  computeReadiness,
  danglingDeps,
  DEP_SATISFIED_STATES,
  resolveReadiness,
} from "./readiness.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__");

/** Minimal ItemFile; override to shape a specific dependency scenario. */
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
    nextStep: "Do it",
    updated: "2026-07-10",
    links: {},
    ...overrides,
  };
}

describe("resolveReadiness", () => {
  test("an item with no depends-on is eligible", () => {
    const r = resolveReadiness(item({ slug: "a" }), buildUniverse([]));
    expect(r).toEqual({ slug: "a", eligible: true, deps: [] });
  });

  test.each([...DEP_SATISFIED_STATES])("a target in state %s satisfies the dependency", (state) => {
    const target = item({ slug: "t", state });
    const dependent = item({ slug: "a", dependsOn: ["t"] });
    const r = resolveReadiness(dependent, buildUniverse([target, dependent]));
    expect(r.eligible).toBe(true);
    expect(r.deps).toEqual([{ target: "t", status: "satisfied", targetState: state }]);
  });

  test.each(["idea", "spec-filed", "in-progress", "implemented", "blocked", "dropped"])(
    "an in-flight/terminal-abandoned target in state %s does NOT satisfy",
    (state) => {
      const target = item({ slug: "t", state });
      const dependent = item({ slug: "a", dependsOn: ["t"] });
      const r = resolveReadiness(dependent, buildUniverse([target, dependent]));
      expect(r.eligible).toBe(false);
      expect(r.deps).toEqual([{ target: "t", status: "unsatisfied", targetState: state }]);
    },
  );

  test("a target that resolves to no item is missing (and blocks)", () => {
    const dependent = item({ slug: "a", dependsOn: ["ghost"] });
    const r = resolveReadiness(dependent, buildUniverse([dependent]));
    expect(r.eligible).toBe(false);
    expect(r.deps).toEqual([{ target: "ghost", status: "missing" }]);
  });

  test("requires ALL targets satisfied; one unmet blocks", () => {
    const ok = item({ slug: "ok", state: "merged" });
    const bad = item({ slug: "bad", state: "in-progress" });
    const dependent = item({ slug: "a", dependsOn: ["ok", "bad"] });
    const r = resolveReadiness(dependent, buildUniverse([ok, bad, dependent]));
    expect(r.eligible).toBe(false);
    expect(r.deps.map((d) => d.status)).toEqual(["satisfied", "unsatisfied"]);
  });
});

describe("computeReadiness", () => {
  test("sorts by slug", () => {
    const r = computeReadiness([item({ slug: "c" }), item({ slug: "a" }), item({ slug: "b" })], buildUniverse([]));
    expect(r.map((x) => x.slug)).toEqual(["a", "b", "c"]);
  });
});

describe("danglingDeps", () => {
  test("collects only missing-target dependencies, as (slug, target) pairs", () => {
    const readiness = computeReadiness(
      [
        item({ slug: "a", dependsOn: ["ghost"] }),
        item({ slug: "b", dependsOn: ["real"] }),
      ],
      buildUniverse([item({ slug: "real", state: "merged" })]),
    );
    expect(danglingDeps(readiness)).toEqual([{ slug: "a", target: "ghost" }]);
  });
});

// Integration against the committed fixtures: targets satisfied via items/, archive/,
// and for-delivery/, plus the dangling-target trap.
describe("readiness over the fixture universe", () => {
  const active = loadItemsDir(join(FIXTURES, "items"));
  const universe = buildUniverse([
    ...active,
    ...loadForDeliveryDir(join(FIXTURES, "for-delivery")),
    ...loadArchiveDir(join(FIXTURES, "archive")),
  ]);
  const readiness = computeReadiness(active, universe);
  const bySlug = new Map(readiness.map((r) => [r.slug, r]));

  test("dep on a merged item (in items/) is satisfied", () => {
    expect(bySlug.get("atlas-ready-satisfied-dep")?.eligible).toBe(true);
  });

  test("dep on an accepted item (in archive/) is satisfied", () => {
    expect(bySlug.get("atlas-ready-dep-archived")?.eligible).toBe(true);
  });

  test("dep on a tested item (in for-delivery/) is satisfied", () => {
    expect(bySlug.get("atlas-ready-dep-fordelivery")?.eligible).toBe(true);
  });

  test("an item with no depends-on is eligible", () => {
    expect(bySlug.get("atlas-ready-unblocked")?.eligible).toBe(true);
  });

  test("dep on a spec-filed (unlanded) target blocks", () => {
    const r = bySlug.get("atlas-ready-blocked");
    expect(r?.eligible).toBe(false);
    expect(r?.deps).toEqual([
      { target: "atlas-dep-target-unmerged", status: "unsatisfied", targetState: "spec-filed" },
    ]);
  });

  test("a dangling depends-on target surfaces as missing and is reported by danglingDeps", () => {
    expect(bySlug.get("gamma-missing-dep")?.eligible).toBe(false);
    expect(danglingDeps(readiness)).toContainEqual({
      slug: "gamma-missing-dep",
      target: "gamma-does-not-exist",
    });
  });
});
