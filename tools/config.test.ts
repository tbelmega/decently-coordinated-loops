import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, projectLifecycle, resolveReviewConfig } from "./config.ts";
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

describe("resolveReviewConfig", () => {
  function config(projects: LoopsConfig["projects"]): LoopsConfig {
    return {
      owner: "casey",
      priorityProjects: [],
      integrationBranch: "master",
      landedAdapter: "git",
      githubTokens: {},
      projects,
      review: { reviewer: "codex", model: "frontier-1", effort: "high", maxRounds: 5 },
    };
  }

  test("returns the global block when no project name is given", () => {
    expect(resolveReviewConfig(config({}))).toEqual({
      reviewer: "codex",
      model: "frontier-1",
      effort: "high",
      maxRounds: 5,
    });
  });

  test("returns the global block for an unregistered project or one without an override", () => {
    const loops = config({ atlas: { repo: "~/atlas" } });
    expect(resolveReviewConfig(loops, "atlas")).toEqual(loops.review);
    expect(resolveReviewConfig(loops, "never-heard-of-it")).toEqual(loops.review);
  });

  test("merges project fields over the global block field by field", () => {
    const loops = config({
      atlas: { repo: "~/atlas", review: { maxRounds: 2, effort: "medium" } },
    });
    expect(resolveReviewConfig(loops, "atlas")).toEqual({
      reviewer: "codex",
      model: "frontier-1",
      effort: "medium",
      maxRounds: 2,
    });
  });

  test("replaces list-valued fields wholesale instead of concatenating", () => {
    const loops = config({});
    loops.review.metadataPaths = [".reviews/**"];
    loops.projects = { atlas: { review: { metadataPaths: ["docs/evidence/**"] } } };
    expect(resolveReviewConfig(loops, "atlas").metadataPaths).toEqual(["docs/evidence/**"]);
  });

  test("does not resolve an inherited Object property name", () => {
    expect(resolveReviewConfig(config({}), "constructor")).toEqual(config({}).review);
  });
});

describe("loadConfig review classes", () => {
  function loadWithClasses(classes: unknown): LoopsConfig {
    const root = tempRoot();
    try {
      writeFileSync(join(root, "loops.json"), JSON.stringify({ review: { reviewer: "codex", classes } }));
      return loadConfig(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("accepts a thresholded class and an exempt class", () => {
    const classes = [
      { name: "coordination-prose", match: ["OUTBOX.md"], waivablePriorities: ["P2", "P3"], guidance: "Only factual errors." },
      { name: "bookkeeping", match: [".reviews/**", "BOARD.md"], policy: "exempt" },
    ];
    expect(loadWithClasses(classes).review.classes).toEqual(classes as never);
  });

  test("rejects a class declaring both a threshold and the exempt policy, or neither", () => {
    expect(() =>
      loadWithClasses([{ name: "both", match: ["a.md"], waivablePriorities: ["P3"], policy: "exempt" }]),
    ).toThrow("exactly one of");
    expect(() => loadWithClasses([{ name: "neither", match: ["a.md"] }])).toThrow("exactly one of");
  });

  test("rejects unknown priorities, unsafe patterns, and duplicate class names", () => {
    expect(() =>
      loadWithClasses([{ name: "bad", match: ["a.md"], waivablePriorities: ["P4"] }]),
    ).toThrow("review.classes[0].waivablePriorities");
    expect(() =>
      loadWithClasses([{ name: "bad", match: ["../escape.md"], waivablePriorities: ["P3"] }]),
    ).toThrow("review.classes[0].match");
    expect(() =>
      loadWithClasses([
        { name: "twin", match: ["a.md"], waivablePriorities: ["P3"] },
        { name: "twin", match: ["b.md"], policy: "exempt" },
      ]),
    ).toThrow("duplicates class");
  });

  test("a project override replaces the class list wholesale", () => {
    const root = tempRoot();
    try {
      writeFileSync(
        join(root, "loops.json"),
        JSON.stringify({
          review: { reviewer: "codex", classes: [{ name: "global", match: ["a.md"], policy: "exempt" }] },
          projects: {
            atlas: { review: { classes: [{ name: "local", match: ["b.md"], waivablePriorities: ["P3"] }] } },
          },
        }),
      );
      const config = loadConfig(root);
      expect(resolveReviewConfig(config, "atlas").classes?.map((entry) => entry.name)).toEqual(["local"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadConfig review confirmation", () => {
  function loadWithConfirmation(confirmation: unknown): LoopsConfig {
    const root = tempRoot();
    try {
      writeFileSync(join(root, "loops.json"), JSON.stringify({ review: { reviewer: "codex", confirmation } }));
      return loadConfig(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("accepts the closed set and leaves an absent key undefined", () => {
    expect(loadWithConfirmation("full").review.confirmation).toBe("full");
    expect(loadWithConfirmation("scoped").review.confirmation).toBe("scoped");
    expect(loadWithConfirmation(undefined).review.confirmation).toBeUndefined();
  });

  test("rejects a value outside the closed set", () => {
    // Thrown rather than defaulted: a typo silently falling back to "full" would look
    // exactly like a project that never asked for scoped rounds.
    expect(() => loadWithConfirmation("remediation")).toThrow("review.confirmation must be one of full, scoped");
    expect(() => loadWithConfirmation(true)).toThrow("review.confirmation must be one of full, scoped");
  });

  test("names the project when the invalid value is in a project override", () => {
    const root = tempRoot();
    try {
      writeFileSync(
        join(root, "loops.json"),
        JSON.stringify({ projects: { atlas: { review: { confirmation: "narrow" } } } }),
      );
      expect(() => loadConfig(root)).toThrow("projects.atlas.review.confirmation must be one of full, scoped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a project override wins over the global confirmation scope", () => {
    const root = tempRoot();
    try {
      writeFileSync(
        join(root, "loops.json"),
        JSON.stringify({
          review: { reviewer: "codex", confirmation: "full" },
          projects: { atlas: { review: { confirmation: "scoped" } } },
        }),
      );
      const config = loadConfig(root);
      expect(resolveReviewConfig(config, "atlas").confirmation).toBe("scoped");
      expect(resolveReviewConfig(config, "other").confirmation).toBe("full");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadConfig project review blocks", () => {
  test("rejects an invalid project review block with an error naming the project", () => {
    const root = tempRoot();
    try {
      writeFileSync(
        join(root, "loops.json"),
        JSON.stringify({ projects: { atlas: { review: { maxRounds: 0 } } } }),
      );
      expect(() => loadConfig(root)).toThrow("projects.atlas.review.maxRounds must be a positive integer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a project review block that is not an object", () => {
    // A string, number or array exposes no checked field, so an unguarded validator
    // passes it and the project silently resolves to the broader global policy.
    // An explicit null is rejected with the rest: it is a malformed override, and
    // reading it as "no override" is the same silent fallthrough by another route.
    for (const review of ["typo", 7, [], null, true]) {
      const root = tempRoot();
      try {
        writeFileSync(join(root, "loops.json"), JSON.stringify({ projects: { atlas: { review } } }));
        expect(() => loadConfig(root)).toThrow("projects.atlas.review must be an object");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("accepts a valid project review override", () => {
    const root = tempRoot();
    try {
      writeFileSync(
        join(root, "loops.json"),
        JSON.stringify({
          review: { reviewer: "codex", maxRounds: 5 },
          projects: { atlas: { review: { maxRounds: 2 } } },
        }),
      );
      expect(loadConfig(root).projects.atlas?.review).toEqual({ maxRounds: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
