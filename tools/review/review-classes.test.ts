import { describe, expect, test } from "bun:test";
import type { ReviewClassConfig } from "../config.ts";
import { isExemptOnly, waiverRefusalReason } from "./review-classes.ts";

const classes: ReviewClassConfig[] = [
  { name: "bookkeeping", match: [".reviews/**", "BOARD.md"], policy: "exempt" },
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

  test("a matching exempt class refuses the waiver it cannot authorize", () => {
    // The same overlap isExemptOnly refuses: an exempt class declares no waivable
    // priorities, so it cannot authorize one, and a path declared both exempt and
    // thresholded is a contradictory config that fails closed on both halves.
    const overlapping: ReviewClassConfig[] = [
      { name: "evidence", match: ["docs/**"], policy: "exempt" },
      { name: "runbooks", match: ["docs/runbooks/**"], waivablePriorities: ["P3"] },
    ];
    expect(
      waiverRefusalReason({ file: "docs/runbooks/restore.md", priority: "P3" }, "runbooks", overlapping),
    ).toContain('"evidence" does not waive P3');
    // A path the exempt class alone matches keeps the exempt short-circuit; nothing
    // reaches the waiver path for it, and naming the exempt class as the authorizer
    // still refuses.
    expect(waiverRefusalReason({ file: "docs/notes.md", priority: "P3" }, "evidence", overlapping)).toContain(
      '"evidence" does not waive P3',
    );
  });
});

describe("isExemptOnly", () => {
  test("true only when every matching class is exempt", () => {
    expect(isExemptOnly(".reviews/ledger.json", classes)).toBe(true);
    expect(isExemptOnly("BOARD.md", classes)).toBe(true);
    expect(isExemptOnly("OUTBOX.md", classes)).toBe(false);
    expect(isExemptOnly("src/main.ts", classes)).toBe(false);
  });

  test("a file matched by an exempt and a thresholded class stays reviewable", () => {
    const overlapping: ReviewClassConfig[] = [
      { name: "evidence", match: ["docs/**"], policy: "exempt" },
      { name: "runbooks", match: ["docs/runbooks/**"], waivablePriorities: ["P3"] },
    ];
    expect(isExemptOnly("docs/notes.md", overlapping)).toBe(true);
    expect(isExemptOnly("docs/runbooks/restore.md", overlapping)).toBe(false);
  });
});
