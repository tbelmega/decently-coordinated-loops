import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dclHead, dclHome, stampedVersion, STAMP_FILE } from "./version.ts";

describe("stampedVersion", () => {
  test("returns null when the data repo has no stamp", () => {
    const root = mkdtempSync(join(tmpdir(), "loops-ver-"));
    try {
      expect(stampedVersion(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns the trimmed stamped commit", () => {
    const root = mkdtempSync(join(tmpdir(), "loops-ver-"));
    try {
      writeFileSync(join(root, STAMP_FILE), "abc123def456\n");
      expect(stampedVersion(root)).toBe("abc123def456");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dclHome / dclHead", () => {
  test("dclHome resolves to this DCL checkout (the parent of tools/)", () => {
    // version.ts lives in tools/, so its home is the repo root — where package.json is.
    expect(dclHome().endsWith("/tools")).toBe(false);
  });

  test("dclHead reports a 40-char commit sha for this git checkout", () => {
    const head = dclHead();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  test("dclHead returns null when pointed at a non-git directory", () => {
    const root = mkdtempSync(join(tmpdir(), "loops-nogit-"));
    try {
      expect(dclHead(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
