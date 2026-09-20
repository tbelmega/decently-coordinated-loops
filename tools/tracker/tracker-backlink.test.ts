import { describe, expect, test } from "bun:test";
import { applyBacklinks, backlinkLine } from "./tracker-backlink.ts";

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
