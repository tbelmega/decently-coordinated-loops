import type { PreflightReport } from "./preflight.ts";
import type { ItemAnomaly } from "./validate.ts";

/** Human-readable preflight summary, shared by the sync and check CLIs. */
export function printPreflightReport(report: PreflightReport): void {
  console.log(`Preflight: ${report.orphanRows.length} orphan row(s), ${report.missingRows.length} missing row(s) (auto-added on regen), ${report.mismatches.length} field mismatch(es).`);

  if (report.orphanRows.length) {
    console.log("\nOrphan rows (no item file — routed to OUTBOX.md, dropped from board):");
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
