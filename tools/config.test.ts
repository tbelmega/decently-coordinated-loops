import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "loops-config-"));
}

describe("loadConfig", () => {
  test("returns all defaults when loops.json is missing", () => {
    const root = tempRoot();
    try {
      expect(loadConfig(root)).toEqual({
        owner: "",
        priorityProjects: [],
        integrationBranch: "master",
        landedAdapter: "git",
        githubTokens: {},
        projects: {},
        review: {},
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("merges a partial file over the defaults", () => {
    const root = tempRoot();
    try {
      writeFileSync(
        join(root, "loops.json"),
        JSON.stringify({ owner: "casey", priorityProjects: ["atlas", "beta"] }),
      );
      const config = loadConfig(root);
      expect(config.owner).toBe("casey");
      expect(config.priorityProjects).toEqual(["atlas", "beta"]);
      // untouched fields still fall back to defaults
      expect(config.integrationBranch).toBe("master");
      expect(config.landedAdapter).toBe("git");
      expect(config.githubTokens).toEqual({});
      expect(config.projects).toEqual({});
      expect(config.review).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a fully specified file is returned as-is", () => {
    const root = tempRoot();
    try {
      const full = {
        owner: "casey",
        priorityProjects: ["atlas"],
        integrationBranch: "main",
        landedAdapter: "github" as const,
        githubTokens: { "acme-org": "~/.secrets/gh-acme" },
        projects: { atlas: { repo: "acme-org/atlas", landedAdapter: "git" as const } },
        review: { reviewer: "claude", model: "claude-opus-4-8" },
      };
      writeFileSync(join(root, "loops.json"), JSON.stringify(full));
      expect(loadConfig(root)).toEqual(full);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
