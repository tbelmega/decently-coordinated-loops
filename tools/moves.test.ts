import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performMoves } from "./moves.ts";
import type { ItemFile } from "./types.ts";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "loops-moves-"));
  mkdirSync(join(root, "items"), { recursive: true });
  mkdirSync(join(root, "for-delivery"), { recursive: true });
  mkdirSync(join(root, "archive"), { recursive: true });
  return root;
}

function item(overrides: Partial<ItemFile> & { slug: string; path: string }): ItemFile {
  return {
    title: overrides.slug,
    project: "atlas",
    state: "tested",
    owner: "-",
    autonomy: "auto",
    nextActor: "agent",
    dependsOn: [],
    nextStep: "",
    updated: "2026-07-10",
    links: {},
    ...overrides,
  };
}

describe("performMoves", () => {
  test("moves a file from its source folder to its destination folder", () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, "items", "widget.md"), "---\nstate: tested\n---\nBody.\n");
      const move = {
        item: item({ slug: "widget", path: "items/widget.md" }),
        from: "items" as const,
        to: "for-delivery" as const,
      };
      const logs = performMoves(root, [move]);
      expect(logs).toEqual([{ slug: "widget", message: "moved (items -> for-delivery)" }]);
      expect(existsSync(join(root, "items", "widget.md"))).toBe(false);
      expect(readFileSync(join(root, "for-delivery", "widget.md"), "utf8")).toContain("Body.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is idempotent: skips when the source is gone and the destination already exists", () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, "for-delivery", "widget.md"), "---\nstate: tested\n---\nAlready there.\n");
      const move = {
        item: item({ slug: "widget", path: "items/widget.md" }),
        from: "items" as const,
        to: "for-delivery" as const,
      };
      const logs = performMoves(root, [move]);
      expect(logs).toEqual([{ slug: "widget", message: "already moved (items -> for-delivery)" }]);
      // destination content is untouched — no accidental overwrite
      expect(readFileSync(join(root, "for-delivery", "widget.md"), "utf8")).toContain("Already there.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("logs an anomaly and continues when neither source nor destination exists", () => {
    const root = tempRoot();
    try {
      const move = {
        item: item({ slug: "ghost", path: "items/ghost.md" }),
        from: "items" as const,
        to: "for-delivery" as const,
      };
      const logs = performMoves(root, [move]);
      expect(logs).toHaveLength(1);
      expect(logs[0].message).toContain("anomaly");
      expect(existsSync(join(root, "for-delivery", "ghost.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("processes a batch, one anomaly not blocking the rest", () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, "items", "real.md"), "---\nstate: tested\n---\nReal.\n");
      const moves = [
        { item: item({ slug: "ghost", path: "items/ghost.md" }), from: "items" as const, to: "archive" as const },
        { item: item({ slug: "real", path: "items/real.md" }), from: "items" as const, to: "for-delivery" as const },
      ];
      const logs = performMoves(root, moves);
      expect(logs.find((l) => l.slug === "ghost")?.message).toContain("anomaly");
      expect(logs.find((l) => l.slug === "real")?.message).toContain("moved");
      expect(existsSync(join(root, "for-delivery", "real.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
