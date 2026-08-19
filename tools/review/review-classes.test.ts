import { describe, expect, test } from "bun:test";
import type { ReviewClassConfig } from "../config.ts";
import { waiverRefusalReason } from "./review-classes.ts";

const classes: ReviewClassConfig[] = [
  { name: "bookkeeping", match: [".reviews/**", "BOARD.md"], waivablePriorities: ["P3"] },
  { name: "coordination-prose", match: ["OUTBOX.md", "queues/**"], waivablePriorities: ["P2", "P3"] },
  { name: "strict-overlap", match: ["queues/audit.md"], waivablePriorities: ["P3"] },
];

describe("waiverRefusalReason", () => {
  test("authorizes a waiver the named class covers", () => {
    expect(waiverRefusalReason({ file: "OUTBOX.md", priority: "P3" }, "coordination-prose", classes)).toBeNull();
  });

  test("fails closed without resolved classes or a file anchor", () => {
    expect(waiverRefusalReason({ file: "OUTBOX.md", priority: "P3" }, "coordination-prose", undefined)).toContain(
      "no review classes",
    );
    expect(waiverRefusalReason({ priority: "P3" }, "coordination-prose", classes)).toContain("no file anchor");
  });

  test("refuses an unknown class and a class that does not match the file", () => {
    expect(waiverRefusalReason({ file: "OUTBOX.md", priority: "P3" }, "no-such-class", classes)).toContain(
      "not in the resolved review classes",
    );
    expect(waiverRefusalReason({ file: "src/main.ts", priority: "P3" }, "coordination-prose", classes)).toContain(
      "does not match src/main.ts",
    );
  });

  test("refuses a priority above the class threshold", () => {
    expect(waiverRefusalReason({ file: "OUTBOX.md", priority: "P1" }, "coordination-prose", classes)).toContain(
      "does not waive P1",
    );
  });

  test("a file matched by several classes is waivable only if every class waives the priority", () => {
    // queues/audit.md matches coordination-prose (P2 waivable) and strict-overlap (P3 only).
    expect(waiverRefusalReason({ file: "queues/audit.md", priority: "P2" }, "coordination-prose", classes)).toContain(
      '"strict-overlap" does not waive P2',
    );
    expect(waiverRefusalReason({ file: "queues/audit.md", priority: "P3" }, "coordination-prose", classes)).toBeNull();
  });
});
