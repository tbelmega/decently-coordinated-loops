import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, projectLifecycle, resolveReviewConfig, taxonomyEnabled } from "./config.ts";
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

  test("accepts thresholded classes with optional reviewer guidance", () => {
    const classes = [
      { name: "coordination-prose", match: ["OUTBOX.md"], waivablePriorities: ["P2", "P3"], guidance: "Only factual errors." },
      { name: "bookkeeping", match: [".reviews/**", "BOARD.md"], waivablePriorities: ["P3"] },
    ];
    expect(loadWithClasses(classes).review.classes).toEqual(classes as never);
  });

  test("rejects a class that waives nothing", () => {
    expect(() => loadWithClasses([{ name: "silent", match: ["a.md"] }])).toThrow(
      "review.classes[0].waivablePriorities",
    );
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
        { name: "twin", match: ["b.md"], waivablePriorities: ["P3"] },
      ]),
    ).toThrow("duplicates class");
  });

  test("a project override replaces the class list wholesale", () => {
    const root = tempRoot();
    try {
      writeFileSync(
        join(root, "loops.json"),
        JSON.stringify({
          review: { reviewer: "codex", classes: [{ name: "global", match: ["a.md"], waivablePriorities: ["P3"] }] },
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

describe("severityFloor (C1)", () => {
  function config(review: LoopsConfig["review"], projects: LoopsConfig["projects"] = {}): LoopsConfig {
    return {
      owner: "casey",
      priorityProjects: [],
      integrationBranch: "master",
      landedAdapter: "git",
      githubTokens: {},
      projects,
      review,
    };
  }

  test("resolves per project like every other review field", () => {
    const loops = config(
      { reviewer: "codex", severityFloor: "round-2-plus" },
      { atlas: { repo: "~/atlas", review: { severityFloor: "all-rounds" } } },
    );
    expect(resolveReviewConfig(loops).severityFloor).toBe("round-2-plus");
    expect(resolveReviewConfig(loops, "atlas").severityFloor).toBe("all-rounds");
  });

  test("taxonomyEnabled derives from the resolved keys, not a separate switch", () => {
    expect(taxonomyEnabled({})).toBe(false);
    expect(taxonomyEnabled({ severityFloor: false })).toBe(false);
    expect(taxonomyEnabled({ severityFloor: "round-2-plus" })).toBe(true);
    expect(taxonomyEnabled({ severityFloor: "all-rounds" })).toBe(true);
  });
});

describe("terminalRejection (C4)", () => {
  test("resolves per project, validates as boolean, and joins the taxonomy predicate", () => {
    const loops: LoopsConfig = {
      owner: "casey",
      priorityProjects: [],
      integrationBranch: "master",
      landedAdapter: "git",
      githubTokens: {},
      projects: { atlas: { repo: "~/atlas", review: { terminalRejection: true } } },
      review: { reviewer: "codex" },
    };
    expect(resolveReviewConfig(loops).terminalRejection).toBeUndefined();
    expect(resolveReviewConfig(loops, "atlas").terminalRejection).toBe(true);
    expect(taxonomyEnabled({ terminalRejection: true })).toBe(true);
    expect(taxonomyEnabled({ terminalRejection: false })).toBe(false);
    expect(taxonomyEnabled({ capExit: true })).toBe(true);
    expect(taxonomyEnabled({ capExit: false })).toBe(false);
  });

  test("scoped confirmation under personas needs the taxonomy for its P0 widening", () => {
    const personas = [
      { name: "diff" as const, fromRound: 1, toRound: 1 },
      { name: "confirmation" as const, fromRound: 2 },
    ];
    expect(taxonomyEnabled({ personas, confirmation: "scoped" })).toBe(true);
    expect(taxonomyEnabled({ personas, confirmation: "full" })).toBe(false);
    // Scoped without personas is the legacy engine, which has no widening rule.
    expect(taxonomyEnabled({ confirmation: "scoped" })).toBe(false);
  });
});

describe("resolved engine selection (C3)", () => {
  function config(review: LoopsConfig["review"], projects: LoopsConfig["projects"] = {}): LoopsConfig {
    return {
      owner: "casey",
      priorityProjects: [],
      integrationBranch: "master",
      landedAdapter: "git",
      githubTokens: {},
      projects,
      review,
    };
  }
  const personas = [
    { name: "diff" as const, fromRound: 1, toRound: 1 },
    { name: "confirmation" as const, fromRound: 2 },
  ];

  test("a project's auditPasses override replaces an inherited personas block, not joins it", () => {
    const resolved = resolveReviewConfig(
      config({ reviewer: "codex", personas }, { atlas: { repo: "~/atlas", review: { auditPasses: ["diff"] } } }),
      "atlas",
    );
    expect(resolved.auditPasses).toEqual(["diff"]);
    expect(resolved.personas).toBeUndefined();
  });

  test("a project's personas override replaces an inherited auditPasses list", () => {
    const resolved = resolveReviewConfig(
      config({ reviewer: "codex", auditPasses: ["diff", "integration"] }, {
        atlas: { repo: "~/atlas", review: { personas } },
      }),
      "atlas",
    );
    expect(resolved.personas).toEqual(personas);
    expect(resolved.auditPasses).toBeUndefined();
  });

  test("a project's personas override is validated as the resolved policy", () => {
    expect(() =>
      resolveReviewConfig(
        config({ reviewer: "codex", maxRounds: 4 }, {
          atlas: {
            repo: "~/atlas",
            // No persona covers round 3 or 4 of this project's own cap.
            review: { personas: [{ name: "diff", fromRound: 1, toRound: 1 }, { name: "confirmation", fromRound: 2, toRound: 2 }] },
          },
        }),
        "atlas",
      ),
    ).toThrow(/resolved review\.personas/);
  });

  test("a project's auditPasses override replaces a profile's personas too", () => {
    const resolved = resolveReviewConfig(
      config(
        { reviewer: "codex", profiles: { mvp: { personas } } },
        { atlas: { repo: "~/atlas", review: { profile: "mvp", auditPasses: ["adversarial"] } } },
      ),
      "atlas",
    );
    expect(resolved.auditPasses).toEqual(["adversarial"]);
    expect(resolved.personas).toBeUndefined();
  });
});

describe("personas validation (C3)", () => {
  function config(review: Record<string, unknown>): unknown {
    return { owner: "casey", projects: {}, review };
  }
  function load(review: Record<string, unknown>): void {
    const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "loops-cfg-"));
    require("node:fs").writeFileSync(require("node:path").join(dir, "loops.json"), JSON.stringify(config(review)));
    loadConfig(dir);
  }
  const base = () => [
    { name: "diff", fromRound: 1, toRound: 1 },
    { name: "confirmation", fromRound: 2 },
  ];

  test("a well-formed personas block loads, overlapping ranges included", () => {
    load({ reviewer: "codex", personas: [
      { name: "diff", fromRound: 1, toRound: 1 },
      { name: "adversarial", fromRound: 1, toRound: 2 },
      { name: "confirmation", fromRound: 2 },
    ]});
  });

  test("every malformed persona shape fails closed", () => {
    expect(() => load({ personas: base(), auditPasses: ["diff"] })).toThrow(/mutually exclusive/);
    expect(() => load({ personas: [] })).toThrow(/non-empty/);
    expect(() => load({ personas: [{ name: "sniper", fromRound: 1 }, base()[1]] })).toThrow(/name must be one of/);
    expect(() => load({ personas: [{ name: "diff", fromRound: 1, reviewer: "gpt" }, base()[1]] })).toThrow(/reviewer must be one of/);
    expect(() => load({ personas: [{ name: "diff", fromRound: 0 }, base()[1]] })).toThrow(/fromRound/);
    expect(() => load({ personas: [{ name: "diff", fromRound: 2, toRound: 1 }, base()[1]] })).toThrow(/toRound/);
    expect(() => load({ personas: [{ name: "diff", fromRound: 1 }] })).toThrow(/exactly one confirmation/);
    expect(() => load({ personas: [...base(), { name: "confirmation", fromRound: 2 }] })).toThrow(/exactly one confirmation/);
    expect(() => load({ personas: [base()[0], { name: "confirmation", fromRound: 3 }] })).toThrow(/every round from 2 up/);
    expect(() => load({ personas: [base()[0], { name: "confirmation", fromRound: 2, toRound: 4 }] })).toThrow(/every round from 2 up/);
    expect(() => load({ personas: [{ name: "diff", fromRound: 2, toRound: 2 }, { name: "confirmation", fromRound: 2 }] })).toThrow(/no persona covers round 1/);
  });

  test("personas resolve per project wholesale, like every list field", () => {
    const loops: LoopsConfig = {
      owner: "casey",
      priorityProjects: [],
      integrationBranch: "master",
      landedAdapter: "git",
      githubTokens: {},
      projects: { atlas: { repo: "~/atlas", review: { personas: [
        { name: "adversarial", fromRound: 1 },
        { name: "confirmation", fromRound: 2 },
      ] } } },
      review: { reviewer: "codex", personas: [
        { name: "diff", fromRound: 1, toRound: 1 },
        { name: "confirmation", fromRound: 2 },
      ] },
    };
    expect(resolveReviewConfig(loops, "atlas").personas!.map((persona) => persona.name)).toEqual([
      "adversarial",
      "confirmation",
    ]);
  });
});

describe("review profiles (C8)", () => {
  function loops(review: Record<string, unknown>, projects: Record<string, unknown> = {}): LoopsConfig {
    return {
      owner: "casey",
      priorityProjects: [],
      integrationBranch: "master",
      landedAdapter: "git",
      githubTokens: {},
      projects: projects as LoopsConfig["projects"],
      review: review as LoopsConfig["review"],
    };
  }
  const mvp = {
    maxRounds: 2,
    severityFloor: "all-rounds" as const,
    terminalRejection: true,
    capExit: true,
    personas: [
      {name: "diff" as const, fromRound: 1, toRound: 1, model: "sol", effort: "high"},
      {name: "adversarial" as const, fromRound: 1, toRound: 1, model: "sol", effort: "medium"},
      {name: "confirmation" as const, fromRound: 2, model: "terra", effort: "medium"},
    ],
  };

  test("resolution order: global block, then the profile, then project field overrides", () => {
    const config = loops(
      {reviewer: "codex", model: "terra", effort: "high", maxRounds: 5, profiles: {mvp}},
      {atlas: {repo: "~/atlas", review: {profile: "mvp", effort: "low"}}},
    );
    const resolved = resolveReviewConfig(config, "atlas");
    expect(resolved.maxRounds).toBe(2);
    expect(resolved.severityFloor).toBe("all-rounds");
    expect(resolved.terminalRejection).toBe(true);
    expect(resolved.capExit).toBe(true);
    expect(resolved.personas!.map((persona) => persona.name)).toEqual(["diff", "adversarial", "confirmation"]);
    // The project's remaining field override lands on top of the profile...
    expect(resolved.effort).toBe("low");
    // ...and the untouchable base fields pass through unchanged.
    expect(resolved.reviewer).toBe("codex");
    expect(resolved.model).toBe("terra");
  });

  test("a profile that sets personas drops an inherited legacy auditPasses", () => {
    const config = loops({reviewer: "codex", auditPasses: ["diff"], profiles: {mvp}, profile: "mvp"});
    const resolved = resolveReviewConfig(config);
    expect(resolved.personas).toBeDefined();
    expect(resolved.auditPasses).toBeUndefined();
  });

  test("an unknown profile fails resolution closed", () => {
    const config = loops({reviewer: "codex", profiles: {mvp}}, {atlas: {repo: "~/atlas", review: {profile: "turbo"}}});
    expect(() => resolveReviewConfig(config, "atlas")).toThrow(/review profile "turbo" is not defined/);
  });

  test("a profile is loop controls only: every governance field fails closed by name", () => {
    for (const [key, value] of [
      ["classes", [{name: "x", match: ["a/**"], waivablePriorities: ["P2"]}]],
      ["metadataPaths", [".reviews/**"]],
      ["rewrites", ["AGENTS.md"]],
      ["reviewer", "claude"],
      ["model", "cheap-model"],
      ["somethingNew", 1],
    ] as const) {
      const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "loops-prof-"));
      require("node:fs").writeFileSync(
        require("node:path").join(dir, "loops.json"),
        JSON.stringify({review: {reviewer: "codex", profiles: {bad: {[key]: value}}}}),
      );
      expect(() => loadConfig(dir)).toThrow(/not an allowed profile field/);
    }
  });

  test("profiles are defined on the global review block only", () => {
    const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "loops-prof-"));
    require("node:fs").writeFileSync(
      require("node:path").join(dir, "loops.json"),
      JSON.stringify({review: {reviewer: "codex"}, projects: {atlas: {repo: "~/a", review: {profiles: {mvp: {}}}}}}),
    );
    expect(() => loadConfig(dir)).toThrow(/global review block only/);
  });
});
