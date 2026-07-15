// Dependency readiness: resolve each item's `depends-on` targets against the known
// item universe (items/, for-delivery/, archive/) and classify. Pure — no IO.
//
// The satisfaction rule is the loops-board "Dependencies & readiness" contract, and
// this module implements the *board-state* half of it: a target counts as satisfied
// once its work is on the integration branch, which its recorded state proves for
// `merged`/`tested`/`delivered`/`accepted`. In-flight states (`implemented`,
// `spec-filed`, …) are NOT satisfied here — an `implemented` target means review
// requested, not landed. Confirm real landed status for in-flight targets with
// `bun run landed` before claiming (loops-pickup dependency gate); that dynamic check
// is deliberately out of this pure module.
import type { ItemFile } from "./types.ts";

/** States whose recorded value proves the work is on the integration branch. Matches
 *  loops-board → "Dependencies & readiness". `dropped` is absent (an abandoned target
 *  never satisfies), as is `implemented` (review requested ≠ landed). */
export const DEP_SATISFIED_STATES: ReadonlySet<string> = new Set([
  "merged",
  "tested",
  "delivered",
  "accepted",
]);

export type DepStatus = "satisfied" | "unsatisfied" | "missing";

/** One resolved `depends-on` target of an item. */
export interface DepResolution {
  /** The depends-on target slug, verbatim. */
  target: string;
  status: DepStatus;
  /** The target's state — present only when the target resolves to a known item. */
  targetState?: string;
}

export interface ItemReadiness {
  slug: string;
  /** True when every depends-on target is satisfied (or the item has none). */
  eligible: boolean;
  /** One resolution per depends-on target, in declared order; `[]` when none. */
  deps: DepResolution[];
}

/** Pure: build the slug -> item lookup from every known item across items/,
 *  for-delivery/, and archive/, so a target satisfied in any location resolves. A
 *  well-formed repo has one file (one slug) per item; on a stray collision the last
 *  entry wins, which is harmless for a satisfaction lookup. */
export function buildUniverse(items: ItemFile[]): Map<string, ItemFile> {
  return new Map(items.map((item) => [item.slug, item]));
}

/** Pure: resolve one item's depends-on targets against a slug -> item universe. */
export function resolveReadiness(item: ItemFile, universe: Map<string, ItemFile>): ItemReadiness {
  const deps: DepResolution[] = item.dependsOn.map((target) => {
    const found = universe.get(target);
    if (!found) return { target, status: "missing" };
    return {
      target,
      status: DEP_SATISFIED_STATES.has(found.state) ? "satisfied" : "unsatisfied",
      targetState: found.state,
    };
  });
  return {
    slug: item.slug,
    eligible: deps.every((dep) => dep.status === "satisfied"),
    deps,
  };
}

/** Pure: readiness for each `evaluate` item, sorted by slug. `universe` should cover
 *  every location a target might live (items/ + for-delivery/ + archive/). */
export function computeReadiness(
  evaluate: ItemFile[],
  universe: Map<string, ItemFile>,
): ItemReadiness[] {
  return evaluate
    .map((item) => resolveReadiness(item, universe))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** A `depends-on` target that resolves to no known item — a data-integrity error the
 *  check command reports (an item can never become eligible while a target is dangling). */
export interface DanglingDep {
  slug: string;
  target: string;
}

/** Pure: every dangling (missing-target) dependency across a readiness set, in
 *  (slug, declared-order) order. */
export function danglingDeps(readiness: ItemReadiness[]): DanglingDep[] {
  const out: DanglingDep[] = [];
  for (const item of readiness) {
    for (const dep of item.deps) {
      if (dep.status === "missing") out.push({ slug: item.slug, target: dep.target });
    }
  }
  return out;
}
