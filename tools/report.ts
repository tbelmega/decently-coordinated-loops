import type { PreflightReport } from "./preflight.ts";
import type { DuplicateSlug, ItemAnomaly } from "./validate.ts";
import type { DanglingDep } from "./readiness.ts";

/** Human-readable preflight summary, shared by the sync and check CLIs. */
export function printPreflightReport(report: PreflightReport): void {
  console.log(`Preflight: ${report.orphanRows.length} orphan row(s), ${report.missingRows.length} missing row(s) (auto-added on regen), ${report.mismatches.length} field mismatch(es).`);

  if (report.orphanRows.length) {
    console.log("\nOrphan rows (no item file — filed in OUTBOX.md, kept on the board until a later sync sees the entry):");
    for (const row of report.orphanRows) {
      console.log(`  - ${row.path} (${row.title})`);
    }
  }

  if (report.missingRows.length) {
    console.log("\nItem files with no board row (auto-added on regen):");
    for (const slug of report.missingRows) {
      console.log(`  - ${slug}`);
    }
  }

  if (report.mismatches.length) {
    console.log("\nField mismatches (item file wins on regen):");
    for (const m of report.mismatches) {
      console.log(`  - ${m.slug}: ${m.field} board="${m.boardValue}" file="${m.fileValue}"`);
    }
  }
}

/** Human-readable closed-set validation summary. Shared by the sync CLI (advisory)
 * and the check CLI (which also exits non-zero on any anomaly). */
export function printValidationReport(anomalies: ItemAnomaly[]): void {
  if (!anomalies.length) return;
  console.log(`\nCanonical-field anomalies (${anomalies.length} item(s) with out-of-set values):`);
  for (const anomaly of anomalies) {
    for (const message of anomaly.messages) {
      console.log(`  - ${anomaly.slug}: ${message}`);
    }
  }
}

/** Human-readable duplicate-slug summary: one slug carried by more than one item
 * file across folders. An integrity error — the sync CLI stops before writing and the
 * check CLI exits non-zero. */
export function printDuplicateSlugs(duplicates: DuplicateSlug[]): void {
  if (!duplicates.length) return;
  console.log(`\nDuplicate slugs (${duplicates.length} — same slug on more than one item file):`);
  for (const dup of duplicates) {
    console.log(`  - ${dup.slug}: ${dup.paths.join(", ")}`);
  }
}

/** Human-readable dangling-dependency summary: a `depends-on` target that resolves to
 * no known item — the item can never become eligible. An integrity error the check CLI
 * exits non-zero on. */
export function printDanglingDeps(dangling: DanglingDep[]): void {
  if (!dangling.length) return;
  console.log(`\nDangling depends-on targets (${dangling.length} — target resolves to no item):`);
  for (const dep of dangling) {
    console.log(`  - ${dep.slug}: depends-on target "${dep.target}" not found`);
  }
}
