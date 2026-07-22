import { describe, expect, test } from "bun:test";
import { reviewPrompt } from "./review-prompt.ts";

describe("reviewPrompt", () => {
  const base = "aaaaaaaaaaaa";
  const head = "bbbbbbbbbbbb";

  test("scopes the review to the exact committed change", () => {
    const prompt = reviewPrompt(base, head, []);
    expect(prompt).toContain(`${base}..${head}`);
  });

  test("demands exhaustive coverage of every changed file and hunk", () => {
    const prompt = reviewPrompt(base, head, []);
    // The reviewer has read-only git access; instruct it to enumerate the file set.
    expect(prompt).toContain(`git diff --name-only ${base}..${head}`);
    expect(prompt).toContain("every hunk");
    expect(prompt.toLowerCase()).toContain("do not stop after the first");
  });

  test("requires judging changes against existing code and architecture", () => {
    const prompt = reviewPrompt(base, head, []);
    const lower = prompt.toLowerCase();
    expect(lower).toContain("existing");
    expect(lower).toContain("architecture");
  });

  test("keeps the empty-findings sentinel and omits prior notes when there are none", () => {
    const prompt = reviewPrompt(base, head, []);
    expect(prompt).toContain("An empty findings array means no actionable findings.");
    expect(prompt).not.toContain("Earlier rounds");
  });

  test("includes prior dispositioned findings so they are not re-raised", () => {
    const prompt = reviewPrompt(base, head, ["F1 rejected: not a real bug", "F2 accepted"]);
    expect(prompt).toContain("Earlier rounds");
    expect(prompt).toContain("F1 rejected: not a real bug");
    expect(prompt).toContain("F2 accepted");
  });
});
