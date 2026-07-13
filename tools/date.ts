/** Formats a Date as YYYY-MM-DD using its local calendar day (not UTC), so a
 * snapshot date matches the wall-clock day it was taken on. */
export function formatSnapshotDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
