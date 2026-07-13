import { describe, expect, test } from "bun:test";
import type { ItemFile } from "./types.ts";
import type { LoopsConfig } from "./config.ts";
import {
  applyMergedFrontmatter,
  buildMergeReport,
  itemsToFlipMerged,
  parsePrUrl,
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

describe("buildMergeReport", () => {
  const statuses = (entries: PrStatus[]): Map<string, PrStatus> =>
    new Map(entries.map((s) => [s.url, s]));

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
          url: "https://github.com/acme-org/atlas/pull/44",
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
      statuses([{ url: "https://github.com/acme-org/atlas/pull/44", state: "MERGED" }]),
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
      statuses([{ url: "https://github.com/acme-org/atlas/pull/50", state: "OPEN" }]),
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
      statuses([{ url: "https://github.com/acme-org/atlas/pull/51", state: "CLOSED" }]),
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
      statuses([{ url: "https://github.com/acme-org/atlas/pull/99", error: "gh exited 1" }]),
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
});

describe("itemsToFlipMerged", () => {
  const statuses = (entries: PrStatus[]): Map<string, PrStatus> =>
    new Map(entries.map((s) => [s.url, s]));

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
      statuses([{ url: "https://github.com/acme-org/atlas/pull/44", state: "MERGED" }]),
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
      statuses([{ url: "https://github.com/acme-org/atlas/pull/44", state: "MERGED" }]),
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
      statuses([{ url: "https://github.com/acme-org/atlas/pull/50", state: "OPEN" }]),
    );
    expect(flip).toEqual([]);
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
