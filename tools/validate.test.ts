import { describe, expect, test } from "bun:test";
import type { ItemFile } from "./types.ts";
import { findDuplicateSlugs, validateItem, validateItems } from "./validate.ts";

/** Minimal canonical ItemFile; override to introduce a specific violation. */
function item(overrides: Partial<ItemFile>): ItemFile {
  return {
    slug: "x",
    path: "items/x.md",
    title: "X",
    project: "atlas",
    state: "in-progress",
    owner: "-",
    autonomy: "auto",
    nextActor: "agent",
    dependsOn: [],
    nextStep: "Do the thing",
    updated: "2026-07-10",
    links: {},
    ...overrides,
  };
}

describe("validateItem", () => {
  test("accepts a fully canonical item", () => {
    expect(validateItem(item({}))).toEqual([]);
  });

  test("accepts every new canonical state", () => {
    for (const state of ["merged", "tested", "delivered", "accepted"]) {
      expect(validateItem(item({ state, nextActor: "owner", awaiting: undefined }))).toEqual([]);
    }
  });

  test("flags a non-canonical state", () => {
    const messages = validateItem(item({ state: "done" }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('state "done" is not a canonical state');
  });

  test("hints when a state value is actually an awaiting sub-bucket", () => {
    const messages = validateItem(item({ state: "review-merge" }));
    expect(messages[0]).toContain("awaiting: review-merge");
  });

  test("flags a removed awaiting value (deploy/verify no longer exist)", () => {
    expect(validateItem(item({ nextActor: "owner", awaiting: "deploy" }))[0]).toContain(
      'awaiting "deploy" is not canonical',
    );
    expect(validateItem(item({ nextActor: "owner", awaiting: "verify" }))[0]).toContain(
      'awaiting "verify" is not canonical',
    );
  });

  test("accepts the new deliver/accept awaiting values", () => {
    expect(validateItem(item({ nextActor: "owner", awaiting: "deliver" }))).toEqual([]);
    expect(validateItem(item({ nextActor: "owner", awaiting: "accept" }))).toEqual([]);
  });

  test("flags a non-canonical next-actor", () => {
    expect(validateItem(item({ nextActor: "nobody" }))[0]).toContain('next-actor "nobody"');
  });

  test("accepts the '-' autonomy sentinel but flags a typo", () => {
    expect(validateItem(item({ autonomy: "-" }))).toEqual([]);
    expect(validateItem(item({ autonomy: "supervized" }))[0]).toContain('autonomy "supervized"');
  });

  test("accepts an absent or waived spec field but flags a typo", () => {
    expect(validateItem(item({}))).toEqual([]);
    expect(validateItem(item({ spec: "waived" }))).toEqual([]);
    expect(validateItem(item({ spec: "waved" }))[0]).toContain('spec "waved" is not canonical');
  });

  test("requires links.spec on a spec-filed item", () => {
    expect(
      validateItem(item({ state: "spec-filed", links: { spec: "docs/specs/x.md" } })),
    ).toEqual([]);
    expect(validateItem(item({ state: "spec-filed" }))[0]).toContain(
      "spec-filed requires a links.spec",
    );
  });

  test("requires spec-branch and spec-sha as a pair", () => {
    const paired = { "spec-branch": "pickup/x-spec", "spec-sha": "abc123" };
    expect(validateItem(item({ links: paired }))).toEqual([]);
    expect(validateItem(item({ links: { "spec-branch": "pickup/x-spec" } }))[0]).toContain(
      "must be recorded together",
    );
    expect(validateItem(item({ links: { "spec-sha": "abc123" } }))[0]).toContain(
      "must be recorded together",
    );
  });

  test("flags each blank required field with its own message", () => {
    expect(validateItem(item({ title: "" }))).toEqual(["title is required but empty"]);
    expect(validateItem(item({ project: "" }))).toEqual(["project is required but empty"]);
    expect(validateItem(item({ nextActor: "" }))).toEqual(["next-actor is required but empty"]);
    expect(validateItem(item({ nextStep: "" }))).toEqual(["next-step is required but empty"]);
    expect(validateItem(item({ updated: "" }))).toEqual(["updated is required but empty"]);
  });

  test("treats a whitespace-only required field as empty", () => {
    expect(validateItem(item({ nextStep: "   " }))).toEqual(["next-step is required but empty"]);
  });

  test("flags a blank state once (required), not also as non-canonical", () => {
    expect(validateItem(item({ state: "" }))).toEqual(["state is required but empty"]);
  });

  test("flags a blank next-actor once (required), not also as non-canonical", () => {
    expect(validateItem(item({ nextActor: "" }))).toEqual(["next-actor is required but empty"]);
  });
});

describe("validateItems", () => {
  test("returns only the items with violations, keyed by slug", () => {
    const anomalies = validateItems([
      item({ slug: "good" }),
      item({ slug: "bad-state", state: "done" }),
    ]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].slug).toBe("bad-state");
  });
});

describe("findDuplicateSlugs", () => {
  test("returns nothing when every slug is unique", () => {
    expect(
      findDuplicateSlugs([
        item({ slug: "a", path: "items/a.md" }),
        item({ slug: "b", path: "for-delivery/b.md" }),
      ]),
    ).toEqual([]);
  });

  test("reports a slug that appears in two folders, with both paths sorted", () => {
    const dupes = findDuplicateSlugs([
      item({ slug: "foo", path: "items/foo.md" }),
      item({ slug: "foo", path: "archive/foo.md" }),
      item({ slug: "unique", path: "items/unique.md" }),
    ]);
    expect(dupes).toEqual([{ slug: "foo", paths: ["archive/foo.md", "items/foo.md"] }]);
  });

  test("reports multiple duplicated slugs, sorted by slug", () => {
    const dupes = findDuplicateSlugs([
      item({ slug: "zed", path: "items/zed.md" }),
      item({ slug: "zed", path: "for-delivery/zed.md" }),
      item({ slug: "abe", path: "items/abe.md" }),
      item({ slug: "abe", path: "archive/abe.md" }),
    ]);
    expect(dupes.map((d) => d.slug)).toEqual(["abe", "zed"]);
  });
});
