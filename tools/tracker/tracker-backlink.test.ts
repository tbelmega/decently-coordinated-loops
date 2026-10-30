import { describe, expect, test } from "bun:test";
import { applyBacklinks, applyManagedLines, backlinkLine, branchLine, readBacklinkSlugs } from "./tracker-backlink.ts";

const SLUG = "household-app-slideshow-photo-management";

describe("applyBacklinks", () => {
  test("adds the slug line to a description that has none", () => {
    expect(applyBacklinks("Export the weekly report.", [SLUG])).toBe(`Export the weekly report.\n\n${backlinkLine(SLUG)}`);
  });

  test("a second run over the same description changes nothing", () => {
    const once = applyBacklinks("Export the weekly report.", [SLUG])!;
    expect(applyBacklinks(once, [SLUG])).toBeUndefined();
  });

  test("a changed slug refreshes the line instead of adding a second one", () => {
    const once = applyBacklinks("Body.", ["workboard-old-name"])!;
    const twice = applyBacklinks(once, [SLUG])!;
    expect(twice).toBe(`Body.\n\n${backlinkLine(SLUG)}`);
    expect(twice).not.toContain("workboard-old-name");
  });

  test("a ticket several work-streams serve carries a line for each, in a stable order", () => {
    expect(applyBacklinks("Body.", ["workboard-export", "daybook-import"])).toBe(
      "Body.\n\nDCL: daybook-import\nDCL: workboard-export",
    );
  });

  test("the collaborators' own text is preserved, wherever the line sits", () => {
    const description = `Intro.\n\n${backlinkLine(SLUG)}\n\nAcceptance criteria:\n- one`;
    expect(applyBacklinks(description, [SLUG])).toBeUndefined();
    expect(applyBacklinks(description, ["workboard-export"])).toBe(
      "Intro.\n\nAcceptance criteria:\n- one\n\nDCL: workboard-export",
    );
  });

  test("an empty description gets the line alone", () => {
    expect(applyBacklinks("", [SLUG])).toBe(backlinkLine(SLUG));
  });
});

describe("applyManagedLines", () => {
  test("writes the branch line after the slug line", () => {
    expect(applyManagedLines("Body.", { slugs: [SLUG], branches: ["agents/feature-x"] })).toBe(
      `Body.\n\n${backlinkLine(SLUG)}\n${branchLine("agents/feature-x")}`,
    );
  });

  test("clears a branch line once no branch is wanted, leaving the slug line", () => {
    const once = applyManagedLines("Body.", { slugs: [SLUG], branches: ["agents/feature-x"] })!;
    expect(applyManagedLines(once, { slugs: [SLUG], branches: [] })).toBe(`Body.\n\n${backlinkLine(SLUG)}`);
  });

  test("leaves slug lines alone when the slug lives in a field instead", () => {
    const description = `Body.\n\n${backlinkLine(SLUG)}`;
    expect(applyManagedLines(description, { branches: ["agents/feature-x"] })).toBe(
      `Body.\n\n${backlinkLine(SLUG)}\n\n${branchLine("agents/feature-x")}`,
    );
  });

  test("is idempotent with both kinds of line", () => {
    const once = applyManagedLines("Body.", { slugs: [SLUG], branches: ["https://example.test/pull/4"] })!;
    expect(applyManagedLines(once, { slugs: [SLUG], branches: ["https://example.test/pull/4"] })).toBeUndefined();
  });
});

describe("readBacklinkSlugs", () => {
  test("reads every slug line and ignores branch lines and prose", () => {
    const description = `Body mentioning DCL: inline.\n\n${backlinkLine("a-one")}\n${backlinkLine("b-two")}\n${branchLine("x")}`;
    expect(readBacklinkSlugs(description)).toEqual(["a-one", "b-two"]);
  });
});
