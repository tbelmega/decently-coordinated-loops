import { describe, expect, test } from "bun:test";
import { appendOrphanRowEntry } from "./outbox.ts";
import type { OrphanRow } from "./preflight.ts";

const orphan: OrphanRow = {
  title: "Ghost row",
  path: "items/does-not-exist.md",
  project: "atlas",
  state: "idea",
  nextActor: "owner",
  awaiting: "decide",
  auto: "-",
  owner: "-",
  updated: "2026-07-01",
};

describe("appendOrphanRowEntry", () => {
  test("appends a new sequential entry after the highest existing ID", () => {
    const outbox = `# Outbox\n\n## Open\n\n### 1 — question: foo\n- type: question\n> A:\n\n### 2 — question: bar\n- type: question\n> A:\n`;
    const result = appendOrphanRowEntry(outbox, orphan);
    expect(result).toContain("### 3 — question: orphan BOARD.md row with no item file");
    expect(result).toContain("items/does-not-exist.md");
    expect(result.indexOf("### 3")).toBeGreaterThan(result.indexOf("### 2"));
  });

  test("starts at 1 when there are no existing entries", () => {
    const outbox = `# Outbox\n\n## Open\n`;
    const result = appendOrphanRowEntry(outbox, orphan);
    expect(result).toContain("### 1 — question: orphan BOARD.md row with no item file");
  });
});
