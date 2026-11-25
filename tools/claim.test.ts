import { describe, expect, test } from "bun:test";
import { activeClaimToken, applyItemEdit, CLAIM_FIELDS, newestDispatchToken, readClaimFields, tokenLogLines } from "./claim.ts";
import { parseItemFileText } from "./parse.ts";
import { TEST_IDENTITIES } from "./test-identities.ts";

const SLUG = TEST_IDENTITIES.items.householdSlideshow;
const PATH = `items/${SLUG}.md`;

const ITEM = `---
title: Slideshow photo management
project: ${TEST_IDENTITIES.projects.household}
state: merged
assignee: ${TEST_IDENTITIES.host}-claude-1
autonomy: auto
next-actor: agent
fit: "small change; the review covers
  the UI part"
depends-on: []
next-step: "Agent: verify the merged change on the
  integration environment."
updated: 2026-11-01
execution:
  host: ${TEST_IDENTITIES.host}
  worktree: /work/household-app/.worktrees/${TEST_IDENTITIES.host}-claude-1
links:
  branch: agents/${TEST_IDENTITIES.host}-claude-1
---

Body text.

## Log
- 2026-11-01: Merged.

## Notes
Trailing section.
`;

describe("applyItemEdit", () => {
  test("changes exactly the listed fields and appends one log line to the Log section", () => {
    const result = applyItemEdit(PATH, ITEM, {
      fields: { assignee: "codex", executionHost: "workstation-two", updated: "2026-11-22" },
      log: "2026-11-22: Claimed by central dispatch (dispatch d-0123abcd).",
    });
    const before = parseItemFileText(PATH, ITEM);
    const after = parseItemFileText(PATH, result);
    expect(after.assignee).toBe("codex");
    expect(after.execution).toEqual({ host: "workstation-two", worktree: before.execution!.worktree });
    expect(after.updated).toBe("2026-11-22");
    const unchanged: Partial<typeof after> = { ...after, assignee: before.assignee, execution: before.execution, updated: before.updated };
    expect(unchanged).toEqual(before);
    expect(result).toContain("- 2026-11-01: Merged.\n- 2026-11-22: Claimed by central dispatch (dispatch d-0123abcd).\n\n## Notes");
    const changed = result.split("\n").filter((line) => !ITEM.split("\n").includes(line));
    expect(changed).toEqual([
      "assignee: codex",
      "updated: 2026-11-22",
      "  host: workstation-two",
      "- 2026-11-22: Claimed by central dispatch (dispatch d-0123abcd).",
    ]);
  });

  test("replaces a multi-line value, quotes values that need it, and removes a field set to null", () => {
    const parked = applyItemEdit(PATH, ITEM, {
      fields: { state: "blocked", nextActor: "owner", awaiting: "unblock", nextStep: 'Alice: look at thread "x [d-1]"; then unblock.' },
      log: "2026-11-22: Parked.",
    });
    const item = parseItemFileText(PATH, parked);
    expect(item.state).toBe("blocked");
    expect(item.awaiting).toBe("unblock");
    expect(item.nextStep).toBe('Alice: look at thread "x [d-1]"; then unblock.');
    expect(parked).not.toContain("integration environment");
    const restored = applyItemEdit(PATH, parked, {
      fields: { state: "merged", nextActor: "agent", awaiting: null, assignee: "-" },
      log: "2026-11-22: Released.",
    });
    const back = parseItemFileText(PATH, restored);
    expect(back.awaiting).toBeUndefined();
    expect(back.assignee).toBe("-");
    expect(restored).toContain('assignee: "-"');
    expect(restored).not.toContain("awaiting:");
  });

  test("adds and removes execution.host, dropping an empty execution block", () => {
    const bare = ITEM.replace(/execution:\n(  .*\n)+/, "");
    const added = applyItemEdit(PATH, bare, { fields: { executionHost: "workstation-one" }, log: "2026-11-22: a." });
    expect(parseItemFileText(PATH, added).execution).toEqual({ host: "workstation-one" });
    const removed = applyItemEdit(PATH, added, { fields: { executionHost: null }, log: "2026-11-22: b." });
    expect(parseItemFileText(PATH, removed).execution).toBeUndefined();
    expect(removed).not.toContain("execution:");
  });

  test("creates a Log section when the item has none", () => {
    const noLog = ITEM.replace(/## Log\n- 2026-11-01: Merged.\n\n/, "");
    const result = applyItemEdit(PATH, noLog, { fields: {}, log: "2026-11-22: First line." });
    expect(result.endsWith("## Log\n- 2026-11-22: First line.\n")).toBe(true);
  });

  test("refuses an item with frontmatter errors and a result that does not validate", () => {
    const broken = ITEM.replace("execution:\n", "execution:\n  room: x\n");
    expect(() => applyItemEdit(PATH, broken, { fields: { assignee: "codex" }, log: "2026-11-22: x." })).toThrow("frontmatter");
    expect(() => applyItemEdit(PATH, ITEM, { fields: { state: "bogus" }, log: "2026-11-22: x." })).toThrow("state");
  });
});

describe("representations the board accepts", () => {
  test("a legacy owner key becomes assignee", () => {
    const legacy = ITEM.replace(`assignee: ${TEST_IDENTITIES.host}-claude-1`, "owner: claude").replace(/execution:\n(  .*\n)+/, "");
    const result = applyItemEdit(PATH, legacy, { fields: { assignee: "codex" }, log: "2026-11-22: a." });
    expect(result).not.toContain("owner:");
    expect(parseItemFileText(PATH, result).assignee).toBe("codex");
  });

  test("values YAML would read as numbers or booleans stay strings", () => {
    for (const value of ["123", "yes", "off", "1e3"]) {
      const result = applyItemEdit(PATH, ITEM, { fields: { assignee: value }, log: "2026-11-22: a." });
      expect(parseItemFileText(PATH, result).assignee).toBe(value);
    }
  });

  test("an inline execution mapping is rewritten as a block and edited", () => {
    const inline = ITEM.replace(/execution:\n(  .*\n)+/, `execution: {host: ${TEST_IDENTITIES.host}, worktree: /work/x}\n`);
    const result = applyItemEdit(PATH, inline, { fields: { executionHost: "workstation-two" }, log: "2026-11-22: a." });
    expect(parseItemFileText(PATH, result).execution).toEqual({ host: "workstation-two", worktree: "/work/x" });
    expect(result).toContain("execution:\n  host: workstation-two\n  worktree: /work/x\n");
  });

  test("the worktree locator can be removed and restored with the host", () => {
    const moved = applyItemEdit(PATH, ITEM, { fields: { executionHost: "workstation-two", executionWorktree: null }, log: "2026-11-22: a." });
    expect(parseItemFileText(PATH, moved).execution).toEqual({ host: "workstation-two" });
    const back = applyItemEdit(PATH, moved, {
      fields: { executionHost: TEST_IDENTITIES.host, executionWorktree: "/work/household-app/.worktrees/x" },
      log: "2026-11-22: b.",
    });
    expect(parseItemFileText(PATH, back).execution).toEqual({ host: TEST_IDENTITIES.host, worktree: "/work/household-app/.worktrees/x" });
  });
});

describe("dispatch tokens on the log", () => {
  const withLines = applyItemEdit(PATH, applyItemEdit(PATH, ITEM, { fields: {}, log: "2026-11-22: Claimed (dispatch d-00000001)." }), {
    fields: {},
    log: "2026-11-22: Claimed again (dispatch d-00000002).",
  });

  test("finds the newest token and the lines that carry one token", () => {
    expect(newestDispatchToken(ITEM)).toBeNull();
    expect(newestDispatchToken(withLines)).toBe("d-00000002");
    expect(tokenLogLines(withLines, "d-00000001")).toEqual(["- 2026-11-22: Claimed (dispatch d-00000001)."]);
  });

  test("an ended line ends the active claim", () => {
    expect(activeClaimToken(withLines)).toBe("d-00000002");
    const ended = applyItemEdit(PATH, withLines, { fields: {}, log: "2026-11-22: Released (dispatch d-00000002 ended)." });
    expect(activeClaimToken(ended)).toBeNull();
    const held = applyItemEdit(PATH, withLines, { fields: {}, log: "2026-11-22: Held: not deployed (dispatch d-00000002)." });
    expect(activeClaimToken(held)).toBe("d-00000002");
  });

  test("only token suffixes on Log lines count, and an ended claim is not a claim", () => {
    const ended = applyItemEdit(PATH, withLines, { fields: {}, log: "2026-11-22: Released (dispatch d-00000002 ended)." });
    expect(newestDispatchToken(ended)).toBe("d-00000002");
    expect(tokenLogLines(ended, "d-00000002")).toHaveLength(1);
    const quoted = `${withLines}\n## Elsewhere\n- a quote (dispatch d-00000009).\n`;
    expect(newestDispatchToken(quoted)).toBe("d-00000002");
    const midLine = applyItemEdit(PATH, withLines, { fields: {}, log: "2026-11-22: mentions (dispatch d-00000007) in passing." });
    expect(newestDispatchToken(midLine)).toBe("d-00000002");
  });

  test("reads the claim fields as stored values", () => {
    expect(CLAIM_FIELDS).toContain("executionHost");
    expect(readClaimFields(parseItemFileText(PATH, ITEM))).toEqual({
      assignee: `${TEST_IDENTITIES.host}-claude-1`,
      state: "merged",
      nextActor: "agent",
      awaiting: null,
      nextStep: "Agent: verify the merged change on the integration environment.",
      updated: "2026-11-01",
      executionHost: TEST_IDENTITIES.host,
      executionWorktree: `/work/household-app/.worktrees/${TEST_IDENTITIES.host}-claude-1`,
    });
  });
});
