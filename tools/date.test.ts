import { describe, expect, test } from "bun:test";
import { formatSnapshotDate } from "./date.ts";

describe("formatSnapshotDate", () => {
  test("formats a date as YYYY-MM-DD", () => {
    expect(formatSnapshotDate(new Date(2026, 6, 12))).toBe("2026-07-12");
  });

  test("pads single-digit months and days", () => {
    expect(formatSnapshotDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
