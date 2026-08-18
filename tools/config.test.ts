import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, projectLifecycle } from "./config.ts";
import type { LoopsConfig } from "./config.ts";

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
        projects: {
          atlas: { repo: "acme-org/atlas", landedAdapter: "git" as const },
          docs: { repo: "acme-org/docs", lifecycle: "no-deploy" as const },
        },
        review: {
          reviewer: "claude",
          model: "claude-opus-4-8",
          maxRounds: 5,
          effort: "high",
          auditPasses: ["diff", "integration", "adversarial"] as ("diff" | "integration" | "adversarial")[],
          metadataPaths: ["docs/release-state.md", "generated/**"],
        },
      };
      writeFileSync(join(root, "loops.json"), JSON.stringify(full));
      expect(loadConfig(root)).toEqual(full);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an invalid configured review round cap", () => {
    for (const maxRounds of [0, -1, 1.5, "5"]) {
      const root = tempRoot();
      try {
        writeFileSync(join(root, "loops.json"), JSON.stringify({ review: { maxRounds } }));
        expect(() => loadConfig(root)).toThrow(/review\.maxRounds must be a positive integer/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("rejects a review effort that is not a non-empty string", () => {
    for (const effort of ["", "   ", 5, true]) {
      const root = tempRoot();
      try {
        writeFileSync(join(root, "loops.json"), JSON.stringify({ review: { effort } }));
        expect(() => loadConfig(root)).toThrow(/review\.effort must be a non-empty string/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("rejects empty or unknown review audit passes", () => {
    for (const auditPasses of [[], ["diff", "diff"], ["diff", "unknown"], "diff"]) {
      const root = tempRoot();
      try {
        writeFileSync(join(root, "loops.json"), JSON.stringify({ review: { auditPasses } }));
        expect(() => loadConfig(root)).toThrow(/review\.auditPasses/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("rejects unsafe metadata path patterns", () => {
    for (const metadataPaths of [
      [],
      [""],
      ["/absolute.md"],
      ["../outside.md"],
      ["docs\\state.md"],
      ["docs/*.md"],
      ["docs/state.md", "docs/state.md"],
      "docs/state.md",
    ]) {
      const root = tempRoot();
      try {
        writeFileSync(join(root, "loops.json"), JSON.stringify({ review: { metadataPaths } }));
        expect(() => loadConfig(root)).toThrow(/review\.metadataPaths/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  test("accepts both project lifecycles", () => {
    const root = tempRoot();
    try {
      writeFileSync(
        join(root, "loops.json"),
        JSON.stringify({ projects: { atlas: { lifecycle: "deploy" }, docs: { lifecycle: "no-deploy" } } }),
      );
      const config = loadConfig(root);
      expect(config.projects.atlas.lifecycle).toBe("deploy");
      expect(config.projects.docs.lifecycle).toBe("no-deploy");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a lifecycle outside the closed set", () => {
    // Naming the project matters: an instance with sixteen of them needs to know which
    // entry to fix, and a silent fallback to "deploy" would leave the owner advancing
    // items by hand while believing the tail was collapsed.
    for (const lifecycle of ["no_deploy", "none", "", true, 1]) {
      const root = tempRoot();
      try {
        writeFileSync(join(root, "loops.json"), JSON.stringify({ projects: { docs: { lifecycle } } }));
        expect(() => loadConfig(root)).toThrow(/projects\.docs\.lifecycle must be one of deploy, no-deploy/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe("projectLifecycle", () => {
  function config(projects: LoopsConfig["projects"]): LoopsConfig {
    return {
      owner: "casey",
      priorityProjects: [],
      integrationBranch: "master",
      landedAdapter: "git",
      githubTokens: {},
      projects,
      review: {},
    };
  }

  test("returns the project's declared lifecycle", () => {
    expect(projectLifecycle(config({ docs: { lifecycle: "no-deploy" } }), "docs")).toBe("no-deploy");
    expect(projectLifecycle(config({ atlas: { lifecycle: "deploy" } }), "atlas")).toBe("deploy");
  });

  test("defaults to deploy for a registered project that declares none", () => {
    expect(projectLifecycle(config({ atlas: { repo: "acme-org/atlas" } }), "atlas")).toBe("deploy");
  });

  test("defaults to deploy for an unregistered or empty project name", () => {
    // Fail toward today's longer tail: an item whose `project:` matches nothing keeps the
    // owner's delivery/acceptance step rather than being archived on a typo.
    expect(projectLifecycle(config({}), "never-heard-of-it")).toBe("deploy");
    expect(projectLifecycle(config({}), "")).toBe("deploy");
  });

  test("defaults to deploy for an inherited Object property name", () => {
    // `projects` comes from JSON.parse, so a project literally named "constructor" or
    // "toString" resolves to a function on the prototype rather than a config entry.
    expect(projectLifecycle(config({}), "constructor")).toBe("deploy");
    expect(projectLifecycle(config({}), "toString")).toBe("deploy");
  });
});
