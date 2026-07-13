import { describe, expect, test } from "bun:test";
import type { ItemFile } from "./types.ts";
import { validateItem, validateItems } from "./validate.ts";

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
    nextStep: "",
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

  test("flags a non-canonical next-actor but leaves an empty one to the caller", () => {
    expect(validateItem(item({ nextActor: "nobody" }))[0]).toContain('next-actor "nobody"');
    expect(validateItem(item({ nextActor: "" }))).toEqual([]);
  });

  test("accepts the '-' autonomy sentinel but flags a typo", () => {
    expect(validateItem(item({ autonomy: "-" }))).toEqual([]);
    expect(validateItem(item({ autonomy: "supervized" }))[0]).toContain('autonomy "supervized"');
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
