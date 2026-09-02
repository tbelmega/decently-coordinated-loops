import { describe, expect, test } from "bun:test";
import { applyAnswer, parseOutbox } from "./outbox.ts";
import { TEST_IDENTITIES } from "./test-identities.ts";

const { host, projects } = TEST_IDENTITIES;

const OPEN = "# Outbox\n\n## Open\n";

function file(...entries: string[]): string {
  return OPEN + entries.join("\n");
}

const one = `### 41 — question · ${projects.calendar} · a title\n\nthe ask\n\n> A:\n`;
const two = `### 46 — decision · ${projects.coordination} · another\n\nmore prose\n\n> A:\n`;

function answerOf(text: string, id: number): string | null {
  const entry = parseOutbox(text, new Set()).entries.find((e) => e.id === id);
  return entry ? entry.answer : null;
}

describe("applyAnswer", () => {
  test("writes the answer onto the entry's > A: line", () => {
    const next = applyAnswer(file(one), 41, "(a)");
    expect(answerOf(next, 41)).toBe("(a)");
  });

  test("touches only the named entry", () => {
    const next = applyAnswer(file(one, two), 41, "(a)");
    expect(answerOf(next, 41)).toBe("(a)");
    expect(answerOf(next, 46)).toBeNull();
  });

  test("a multi-line answer becomes > continuation lines", () => {
    const next = applyAnswer(file(one), 41, `yes, but\nonly on ${host}`);
    expect(next).toContain(`> A: yes, but\n> only on ${host}`);
    expect(answerOf(next, 41)).toBe(`yes, but\nonly on ${host}`);
  });

  test("replaces an existing answer rather than appending a second one", () => {
    const next = applyAnswer(applyAnswer(file(one), 41, "(a)"), 41, "(b)");
    expect(answerOf(next, 41)).toBe("(b)");
    expect(next.match(/> A:/g)).toHaveLength(1);
  });

  test("keeps a paragraph that sits below the answer", () => {
    // a routing agent's `**Routed** →` line lives there; rewriting must not eat it
    const withRouted = "### 58 — question · fleet · t\n\nthe ask\n\n> A: approved\n\n**Routed** → [[alpha]]\n";
    const next = applyAnswer(file(withRouted), 58, "changed");
    expect(next).toContain("**Routed** → [[alpha]]");
    expect(answerOf(next, 58)).toBe("changed");
  });

  test("never edits anything above ## Open", () => {
    const header = "# Outbox\n\n**Entry contract:** do not touch this.\n\n## Open\n";
    const next = applyAnswer(header + one, 41, "(a)");
    expect(next.slice(0, next.indexOf("## Open"))).toBe(header.slice(0, header.indexOf("## Open")));
  });

  test("never deletes the entry - an answered entry still awaits routing", () => {
    const next = applyAnswer(file(one), 41, "(a)");
    expect(next).toContain(`### 41 — question · ${projects.calendar} · a title`);
    expect(next).toContain("the ask");
  });

  test("the result still parses with zero anomalies", () => {
    const payload = parseOutbox(applyAnswer(file(one, two), 41, "(a)"), new Set());
    expect(payload.anomalies).toEqual([]);
    expect(payload.entries).toHaveLength(2);
  });

  test("an unknown id is refused rather than silently doing nothing", () => {
    expect(() => applyAnswer(file(one), 999, "(a)")).toThrow(/999/);
  });

  test("a blank answer is refused - empty means never answered", () => {
    // clearing back to empty would make the answered/open distinction unreliable
    expect(() => applyAnswer(file(one), 41, "   ")).toThrow();
  });

  test("an answer containing a > line does not break the blockquote run", () => {
    const next = applyAnswer(file(one), 41, "see > this");
    expect(answerOf(next, 41)).toBe("see > this");
  });
});
