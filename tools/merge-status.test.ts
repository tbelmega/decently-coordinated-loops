import { describe, expect, test } from "bun:test";
import type { ItemFile } from "./types.ts";
import type { LoopsConfig } from "./config.ts";
import {
  applyMergedFrontmatter,
  buildMergeReport,
  itemsToFlipMerged,
  parsePrUrl,
  planLandedCheck,
  statusKeyFor,
  tokenPathForOrg,
  type PrStatus,
} from "./merge-status.ts";

/** Minimal ItemFile with only the fields the report reads; the rest are inert defaults. */
function item(overrides: Partial<ItemFile> & { slug: string }): ItemFile {
  return {
    path: `items/${overrides.slug}.md`,
    title: overrides.slug,
    project: "atlas",
    state: "implemented",
    owner: "-",
    autonomy: "auto",
    nextActor: "owner",
    dependsOn: [],
    nextStep: "",
    updated: "2026-07-10",
    links: {},
    ...overrides,
  };
}

function config(overrides: Partial<LoopsConfig> = {}): LoopsConfig {
  return {
    owner: "casey",
    priorityProjects: [],
    integrationBranch: "master",
    landedAdapter: "git",
    githubTokens: {},
    projects: {},
    review: {},
    ...overrides,
  };
}

describe("parsePrUrl", () => {
  test("extracts org, repo, and number from a PR URL", () => {
    expect(parsePrUrl("https://github.com/acme-org/atlas/pull/44")).toEqual({
      org: "acme-org",
      repo: "atlas",
      number: 44,
    });
  });

  test("tolerates a trailing path segment (e.g. /files)", () => {
    expect(parsePrUrl("https://github.com/other-org/blog/pull/7/files")).toEqual({
      org: "other-org",
      repo: "blog",
      number: 7,
    });
  });

  test("returns null for a non-PR GitHub URL", () => {
    expect(parsePrUrl("https://github.com/acme-org/atlas/issues/33")).toBeNull();
  });

  test("returns null for a bare branch ref", () => {
    expect(parsePrUrl("agents/worker-1")).toBeNull();
  });
});

describe("tokenPathForOrg", () => {
  test("returns the configured token path for a known org", () => {
    const cfg = config({ githubTokens: { "acme-org": "~/.secrets/gh-acme-org" } });
    expect(tokenPathForOrg(cfg, "acme-org")).toBe("~/.secrets/gh-acme-org");
  });

  test("returns null for an org with no configured token (caller falls back to ambient auth)", () => {
    const cfg = config({ githubTokens: { "acme-org": "~/.secrets/gh-acme-org" } });
    expect(tokenPathForOrg(cfg, "some-other-org")).toBeNull();
  });
});

describe("planLandedCheck", () => {
  const PR = "https://github.com/acme-org/atlas/pull/44";
  const BRANCH = "agents/worker-1";

  test("github adapter with a PR link is keyed and checked by the PR URL", () => {
    const plan = planLandedCheck(item({ slug: "a", links: { pr: PR } }), "github");
    expect(plan).toEqual({ kind: "github", ref: PR, pr: PR });
  });

  test("git adapter with a branch link is keyed and checked by the branch", () => {
    const plan = planLandedCheck(item({ slug: "a", links: { branch: BRANCH } }), "git");
    expect(plan).toEqual({ kind: "git", ref: BRANCH, branch: BRANCH });
  });

  test("git adapter with BOTH links keys by workRef (the PR URL), not the branch", () => {
    // regression: a git-adapter item carrying both a PR and a branch used to be stored
    // under its branch but looked up under workRef (the PR URL), so it was silently
    // skipped. The plan's ref must equal workRef so store-key and lookup-key match.
    const plan = planLandedCheck(item({ slug: "a", links: { pr: PR, branch: BRANCH } }), "git");
    expect(plan).toEqual({ kind: "git", ref: PR, branch: BRANCH });
  });

  test("github adapter with only a branch link is an error keyed by workRef", () => {
    const plan = planLandedCheck(item({ slug: "a", links: { branch: BRANCH } }), "github");
    expect(plan).toEqual({ kind: "error", ref: BRANCH, error: expect.stringContaining("links.pr") });
  });

  test("git adapter with only a PR link is an error keyed by workRef", () => {
    const plan = planLandedCheck(item({ slug: "a", links: { pr: PR } }), "git");
    expect(plan).toEqual({ kind: "error", ref: PR, error: expect.stringContaining("links.branch") });
  });

  test("returns null for an item with no work ref", () => {
    expect(planLandedCheck(item({ slug: "a", links: {} }), "git")).toBeNull();
  });
});

describe("buildMergeReport", () => {
  // Test items default to project "atlas"; the status store is keyed by statusKey
  // (project + ref), so mirror that here.
  const statuses = (entries: PrStatus[], project = "atlas"): Map<string, PrStatus> =>
    new Map(entries.map((s) => [statusKeyFor(project, s.ref), s]));

  test("flags a MERGED PR whose item is still awaiting review-merge as stale", () => {
    const items = [
      item({
        slug: "atlas-search-index",
        state: "implemented",
        awaiting: "review-merge",
        links: { pr: "https://github.com/acme-org/atlas/pull/44" },
      }),
    ];
    const report = buildMergeReport(
      items,
      statuses([
        {
          ref: "https://github.com/acme-org/atlas/pull/44",
          state: "MERGED",
          mergedAt: "2026-07-10T23:11:40Z",
        },
      ]),
    );
    expect(report.stale.length).toBe(1);
    expect(report.stale[0].slug).toBe("atlas-search-index");
    expect(report.stale[0].mergedAt).toBe("2026-07-10T23:11:40Z");
  });

  test("does not flag a MERGED PR once the item has moved past review-merge", () => {
    const items = [
      item({
        slug: "atlas-done",
        state: "merged",
        awaiting: undefined,
        links: { pr: "https://github.com/acme-org/atlas/pull/44" },
      }),
    ];
    const report = buildMergeReport(
      items,
      statuses([{ ref: "https://github.com/acme-org/atlas/pull/44", state: "MERGED" }]),
    );
    expect(report.stale.length).toBe(0);
    expect(report.rows[0].state).toBe("MERGED");
  });

  test("does not flag an OPEN PR still awaiting review-merge", () => {
    const items = [
      item({
        slug: "atlas-open",
        awaiting: "review-merge",
        links: { pr: "https://github.com/acme-org/atlas/pull/50" },
      }),
    ];
    const report = buildMergeReport(
      items,
      statuses([{ ref: "https://github.com/acme-org/atlas/pull/50", state: "OPEN" }]),
    );
    expect(report.stale.length).toBe(0);
    expect(report.rows[0].state).toBe("OPEN");
  });

  test("marks a CLOSED-but-unmerged PR so the abandoned link is visible", () => {
    const items = [
      item({
        slug: "atlas-closed",
        awaiting: "review-merge",
        links: { pr: "https://github.com/acme-org/atlas/pull/51" },
      }),
    ];
    const report = buildMergeReport(
      items,
      statuses([{ ref: "https://github.com/acme-org/atlas/pull/51", state: "CLOSED" }]),
    );
    expect(report.rows[0].closedUnmerged).toBe(true);
    expect(report.stale.length).toBe(0);
  });

  test("carries a fetch error through as an ERROR row", () => {
    const items = [
      item({
        slug: "atlas-err",
        awaiting: "review-merge",
        links: { pr: "https://github.com/acme-org/atlas/pull/99" },
      }),
    ];
    const report = buildMergeReport(
      items,
      statuses([{ ref: "https://github.com/acme-org/atlas/pull/99", error: "gh exited 1" }]),
    );
    expect(report.rows[0].state).toBe("ERROR");
    expect(report.rows[0].error).toBe("gh exited 1");
    expect(report.stale.length).toBe(0);
  });

  test("skips items with no PR link and items whose PR was not fetched", () => {
    const items = [
      item({ slug: "no-pr" }),
      item({ slug: "unfetched", links: { pr: "https://github.com/acme-org/atlas/pull/1" } }),
    ];
    const report = buildMergeReport(items, statuses([]));
    expect(report.rows.length).toBe(0);
  });

  test("does not conflate two projects that share a branch name (git adapter)", () => {
    // Regression: the git adapter's workRef is a bare branch. Two items in different
    // projects both on `master` must resolve to their own status, not the first one
    // fetched. The store is keyed by statusKey (project + ref), so the map has a
    // distinct entry per project.
    const items = [
      item({ slug: "atlas-x", project: "atlas", state: "merged", links: { branch: "master" } }),
      item({ slug: "blog-y", project: "blog", state: "implemented", links: { branch: "master" } }),
    ];
    const statusByKey = new Map<string, PrStatus>([
      [statusKeyFor("atlas", "master"), { ref: "master", state: "MERGED" }],
      [statusKeyFor("blog", "master"), { ref: "master", state: "OPEN" }],
    ]);
    const report = buildMergeReport(items, statusByKey);
    const byslug = Object.fromEntries(report.rows.map((r) => [r.slug, r.state]));
    expect(byslug).toEqual({ "atlas-x": "MERGED", "blog-y": "OPEN" });
  });
});

describe("itemsToFlipMerged", () => {
  // Test items default to project "atlas"; the status store is keyed by statusKey
  // (project + ref), so mirror that here.
  const statuses = (entries: PrStatus[], project = "atlas"): Map<string, PrStatus> =>
    new Map(entries.map((s) => [statusKeyFor(project, s.ref), s]));

  test("returns an implemented item whose PR is MERGED", () => {
    const items = [
      item({
        slug: "atlas-search-index",
        state: "implemented",
        awaiting: "review-merge",
        links: { pr: "https://github.com/acme-org/atlas/pull/44" },
      }),
    ];
    const flip = itemsToFlipMerged(
      items,
      statuses([{ ref: "https://github.com/acme-org/atlas/pull/44", state: "MERGED" }]),
    );
    expect(flip.map((i) => i.slug)).toEqual(["atlas-search-index"]);
  });

  test("does not flip an already-merged item (idempotent)", () => {
    const items = [
      item({
        slug: "already-merged",
        state: "merged",
        links: { pr: "https://github.com/acme-org/atlas/pull/44" },
      }),
    ];
    const flip = itemsToFlipMerged(
      items,
      statuses([{ ref: "https://github.com/acme-org/atlas/pull/44", state: "MERGED" }]),
    );
    expect(flip).toEqual([]);
  });

  test("does not flip an implemented item whose PR is still OPEN", () => {
    const items = [
      item({
        slug: "still-open",
        state: "implemented",
        links: { pr: "https://github.com/acme-org/atlas/pull/50" },
      }),
    ];
    const flip = itemsToFlipMerged(
      items,
      statuses([{ ref: "https://github.com/acme-org/atlas/pull/50", state: "OPEN" }]),
    );
    expect(flip).toEqual([]);
  });

  test("does not flip on another project's same-named branch landing", () => {
    // Regression: `atlas` on `master` is still open; `blog` on `master` has landed.
    // Keying by bare branch would flip atlas off blog's result. statusKey keeps them
    // apart, so only the project whose own branch landed is flipped.
    const items = [
      item({ slug: "atlas-open", project: "atlas", state: "implemented", links: { branch: "master" } }),
      item({ slug: "blog-landed", project: "blog", state: "implemented", links: { branch: "master" } }),
    ];
    const statusByKey = new Map<string, PrStatus>([
      [statusKeyFor("atlas", "master"), { ref: "master", state: "OPEN" }],
      [statusKeyFor("blog", "master"), { ref: "master", state: "MERGED" }],
    ]);
    expect(itemsToFlipMerged(items, statusByKey).map((i) => i.slug)).toEqual(["blog-landed"]);
  });
});

describe("applyMergedFrontmatter", () => {
  const RAW = `---
title: "Atlas search index"
project: atlas
state: implemented
owner: agent-x
autonomy: supervised
next-actor: owner
awaiting: review-merge
next-step: "Owner: review + merge PR #44"
updated: 2026-07-02
links:
  pr: https://github.com/acme-org/atlas/pull/44
---

Context paragraph.

## Log
- 2026-07-02: PR filed.
`;

  const result = applyMergedFrontmatter(RAW, "2026-07-10");

  test("sets state to merged", () => {
    expect(result).toMatch(/^state: merged$/m);
  });

  test("sets next-actor to agent and autonomy to auto", () => {
    expect(result).toMatch(/^next-actor: agent$/m);
    expect(result).toMatch(/^autonomy: auto$/m);
  });

  test("removes the awaiting line (awaiting is only for next-actor: owner)", () => {
    expect(result).not.toMatch(/^awaiting:/m);
  });

  test("sets the verification next-step", () => {
    expect(result).toContain('next-step: "Verify per the project verify gate, then flip to tested"');
  });

  test("bumps updated to the given date", () => {
    expect(result).toMatch(/^updated: 2026-07-10$/m);
  });

  test("preserves the body and the links block verbatim", () => {
    expect(result).toContain("## Log");
    expect(result).toContain("- 2026-07-02: PR filed.");
    expect(result).toContain("  pr: https://github.com/acme-org/atlas/pull/44");
  });

  test("leaves the links.pr line untouched even though it contains a nested key", () => {
    // regression: a naive `state:`/`updated:` replace must anchor to the line start so
    // it never rewrites an indented nested key under links:
    expect(result.match(/pull\/44/g)?.length).toBe(1);
  });
});
