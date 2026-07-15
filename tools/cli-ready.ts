#!/usr/bin/env bun
// `bun run ready` — the dependency gate for pickup. Reports which active items have all
// their `depends-on` targets satisfied (work on the integration branch) and which are
// blocked by an unsatisfied or missing target, so a dispatcher doesn't claim an item
// whose foundation hasn't landed.
//
// Board-state only: an `implemented` target counts as unsatisfied here (review
// requested ≠ landed). When any dependency rides on an in-flight target, confirm its
// real landed status with `bun run landed` before claiming (loops-pickup). Read-only —
// mutates nothing. Always exits 0; a dangling target is an integrity error reported by
// `bun run check`, not here.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadArchiveDir, loadForDeliveryDir, loadItemsDir } from "./parse.ts";
import { buildUniverse, computeReadiness } from "./readiness.ts";

const ROOT = process.cwd();

if (!existsSync(join(ROOT, "BOARD.md"))) {
  console.error(`not a loops data repo (no BOARD.md in ${ROOT}) — run from the data repo root`);
  process.exit(2);
}

const active = loadItemsDir(join(ROOT, "items"));
const universe = buildUniverse([
  ...active,
  ...loadForDeliveryDir(join(ROOT, "for-delivery")),
  ...loadArchiveDir(join(ROOT, "archive")),
]);

const readiness = computeReadiness(active, universe);
const ready = readiness.filter((r) => r.eligible);
const blocked = readiness.filter((r) => !r.eligible);

console.log(
  `Dependency readiness: ${readiness.length} active item(s) — ${ready.length} ready, ${blocked.length} blocked.\n`,
);

console.log("Ready (dependencies satisfied):");
if (!ready.length) {
  console.log("  (none)");
} else {
  for (const r of ready) {
    const note = r.deps.length
      ? r.deps.map((d) => `${d.target}: ${d.targetState}`).join(", ")
      : "no depends-on";
    console.log(`  · ${r.slug}  (${note})`);
  }
}

if (blocked.length) {
  console.log("\nBlocked by dependency:");
  for (const r of blocked) {
    const reasons = r.deps
      .filter((d) => d.status !== "satisfied")
      .map((d) => `${d.target} (${d.status === "missing" ? "not found" : d.targetState})`)
      .join(", ");
    console.log(`  ✗ ${r.slug}  → ${reasons}`);
  }
}

if (readiness.some((r) => r.deps.some((d) => d.targetState === "implemented"))) {
  console.log(
    "\nNote: an `implemented` target is not satisfied by board state alone (review requested ≠ landed) — confirm real landed status with `bun run landed` before claiming.",
  );
}
