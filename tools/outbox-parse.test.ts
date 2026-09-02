import { describe, expect, test } from "bun:test";
import { isOpen, parseOutbox } from "./outbox.ts";
import { TEST_IDENTITIES } from "./test-identities.ts";

const { host, items, owner, projects } = TEST_IDENTITIES;

// These synthetic entries preserve realistic OUTBOX shapes: sparse ids, project and
// item tokens, multi-line answers, riders, links, and entries without a board item.

const CONTRACT_PROSE = `# Outbox

The mirror of [INBOX.md](INBOX.md): everything the fleet needs FROM ${owner}.

**Entry contract (for agents):**

- Append entries under "Open" with a sequential ID.
- Dedup before appending; don't re-ask what an existing entry covers.

**Interview mode:** when ${owner} says "interview me", pull the board and this file.

## Open
`;

const KNOWN = new Set(["alpha", "beta", items.householdSlideshow]);

/** Build a whole OUTBOX.md from entry chunks, so every test exercises the real
 * "skip the contract prose" path rather than a convenient substring. */
function file(...entries: string[]): string {
  return CONTRACT_PROSE + entries.join("\n");
}

function parse(text: string, known: ReadonlySet<string> = KNOWN) {
  return parseOutbox(text, known, new Date("2026-08-11T12:00:00Z"));
}

function only(text: string, known: ReadonlySet<string> = KNOWN) {
  const payload = parse(text, known);
  expect(payload.entries).toHaveLength(1);
  return payload.entries[0];
}

describe("finding the entries", () => {
  test("starts at ## Open, so the contract prose is never an entry", () => {
    const payload = parse(file(`### 41 — question · ${projects.calendar} · a title\n\nbody\n\n> A:\n`));
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].id).toBe(41);
  });

  test("a file with no ## Open reports an anomaly rather than guessing", () => {
    const payload = parse("# Outbox\n\nsome prose\n");
    expect(payload.entries).toEqual([]);
    expect(payload.anomalies[0].kind).toBe("unparseable-heading");
  });

  test("ids are sparse, and that is normal, not corruption", () => {
    // entries are deleted as they are routed, so gaps are the steady state
    const payload = parse(file(
      `### 41 — question · ${projects.calendar} · one\n\nbody\n\n> A:\n`,
      `### 46 — decision · ${projects.coordination} · two\n\nbody\n\n> A:\n`,
      `### 70 — decision · ${projects.integration} · three\n\nbody\n\n> A:\n`,
    ));
    expect(payload.entries.map((e) => e.id)).toEqual([41, 46, 70]);
    expect(payload.anomalies).toEqual([]);
  });

  test("does not require a blank line after the heading", () => {
    // entry #54 put `Source:` on the very next line
    const e = only(file("### 54 — question · fleet · no blank line\nSource: [x](items/alpha.md)\n\n> A:\n"));
    expect(e.title).toBe("no blank line");
    expect(e.itemSlug).toBe("alpha");
  });

  test("a title may contain the separators the heading splits on", () => {
    const e = only(file(
      `### 62 — approval · ${projects.integration} · GitHub \`bug\` label — one cause · five rulings\n\nb\n\n> A:\n`,
    ));
    expect(e.type).toBe("approval");
    expect(e.project).toBe(projects.integration);
    expect(e.title).toBe("GitHub `bug` label — one cause · five rulings");
  });

  test("project may name something with no board items at all", () => {
    // `fleet` was the single most common project value with no items behind it
    expect(only(file("### 1 — question · fleet · t\n\nb\n\n> A:\n")).project).toBe("fleet");
  });
});

describe("open vs answered - the only thing that drives attention", () => {
  test("an empty > A: is open", () => {
    const e = only(file("### 1 — question · a · t\n\nb\n\n> A:\n"));
    expect(e.answer).toBeNull();
    expect(isOpen(e)).toBe(true);
  });

  test("a whitespace-only answer is still open", () => {
    expect(isOpen(only(file("### 1 — question · a · t\n\nb\n\n> A:   \n")))).toBe(true);
  });

  test("an answered entry carries its text", () => {
    const e = only(file("### 1 — question · a · t\n\nb\n\n> A: (a)\n"));
    expect(e.answer).toBe("(a)");
    expect(isOpen(e)).toBe(false);
  });

  test("a multi-line answer keeps its continuation lines", () => {
    const e = only(file(`### 1 — question · a · t\n\nb\n\n> A: yes, but\n> only on ${host}\n`));
    expect(e.answer).toBe(`yes, but\nonly on ${host}`);
  });

  test("a paragraph after the answer is body addenda, not answer", () => {
    // entry #58: answer, blank line, then a routing agent's `**Routed** →` paragraph
    const e = only(file(
      "### 58 — question · fleet · t\n\nthe ask\n\n> A: approved\n\n**Routed 2026-08-10** → [[alpha]]\n",
    ));
    expect(e.answer).toBe("approved");
    expect(e.body).toContain("the ask");
    expect(e.body).toContain("**Routed 2026-08-10**");
  });

  test("Update and Rider paragraphs stay in the body as current truth", () => {
    // #57 and #58 carried these, appended by later sessions on other machines
    const e = only(file(
      `### 57 — decision · ${projects.integration} · t\n\noriginal ask\n\n**Rider (2026-08-11):** and also this\n\n> A:\n`,
    ));
    expect(e.body).toContain("original ask");
    expect(e.body).toContain("**Rider (2026-08-11):**");
  });
});

describe("kind - equal loudness, two hues (D1)", () => {
  test("decision is a notice: the agent acted and wants a veto", () => {
    expect(only(file("### 1 — decision · a · t\n\nb\n\n> A:\n")).kind).toBe("notice");
  });

  test("every other type is an ask: the agent stopped and is waiting", () => {
    for (const type of ["question", "proposal", "approval", "decide"]) {
      expect(only(file(`### 1 — ${type} · a · t\n\nb\n\n> A:\n`)).kind).toBe("ask");
    }
  });

  test("an unknown type is an anomaly but the entry still parses, as an ask", () => {
    const payload = parse(file("### 1 — urgent · a · t\n\nb\n\n> A:\n"));
    expect(payload.entries[0].kind).toBe("ask");
    expect(payload.anomalies[0].kind).toBe("unknown-type");
  });

  test("a notice with an empty answer is still open - type never decides that", () => {
    // the whole point of D1: a mislabelled entry errs toward too much attention
    expect(isOpen(only(file("### 1 — decision · a · t\n\nb\n\n> A:\n")))).toBe(true);
  });
});

describe("resolving the item", () => {
  test("tier 1: an explicit `- item:` line beats every fallback", () => {
    const e = only(file(
      "### 1 — question · a · t\n\n- item: beta\nSource: [alpha](items/alpha.md)\n\n> A:\n",
    ));
    expect(e.itemSlug).toBe("beta");
  });

  test("tier 2: the first items/*.md link", () => {
    const e = only(file(
      "### 1 — question · a · t\n\nSource: [alpha](items/alpha.md) and [beta](items/beta.md)\n\n> A:\n",
    ));
    expect(e.itemSlug).toBe("alpha");
  });

  test("tier 2 is known wrong for #46, and tier 1 is the fix", () => {
    // its Source: names the item the finding was raised ON, then the one it is ABOUT
    const body = `### 46 — decision · ${projects.coordination} · t\n\n` +
      "Source: review finding on [x](items/alpha.md), raised against [y](items/beta.md)\n\n> A:\n";
    expect(only(file(body)).itemSlug).toBe("alpha"); // the wrong one, knowingly
    expect(only(file(body.replace("Source:", "- item: beta\nSource:"))).itemSlug).toBe("beta");
  });

  test("tier 3: a backticked bare slug on a Source: line, if the item exists", () => {
    const e = only(file(
      `### 64 — approval · ${projects.household} · t\n\nSource: \`${items.householdSlideshow}\`, batched\n\n> A:\n`,
    ));
    expect(e.itemSlug).toBe(items.householdSlideshow);
  });

  test("tier 3 ignores a backticked word that is not a known item", () => {
    expect(only(file(`### 1 — question · a · t\n\nSource: \`systemctl\` on ${host}\n\n> A:\n`)).itemSlug)
      .toBeNull();
  });

  test("a [[wikilink]] is deliberately not a fourth tier", () => {
    // entry #70 carries one. It renders as a link, but it does not claim to be the
    // entry's subject. Asserted so nobody "fixes" this into a resolution tier.
    expect(only(file(`### 70 — decision · ${projects.integration} · t\n\nsuperseded by [[alpha]]\n\n> A:\n`)).itemSlug)
      .toBeNull();
  });

  test("a link inside the answer does not become the entry's item", () => {
    // that is the owner answering, not the entry declaring what it is about
    expect(only(file("### 1 — question · a · t\n\njust prose\n\n> A: see [beta](items/beta.md)\n")).itemSlug)
      .toBeNull();
  });

  test("resolves a slug whose item has moved to for-delivery or archive", () => {
    // an entry outlives the item it references; resolving against active items alone
    // drops the join exactly when the entry is oldest (review R1-F17/R2-F15)
    const known = new Set(["shipped", "accepted-long-ago"]);
    expect(only(file("### 1 — question · a · t\n\nSource: `shipped`\n\n> A:\n"), known).itemSlug)
      .toBe("shipped");
    expect(only(file("### 2 — question · a · t\n\nSource: `accepted-long-ago`\n\n> A:\n"), known).itemSlug)
      .toBe("accepted-long-ago");
  });

  test("no item at all is normal, not an edge case", () => {
    expect(only(file("### 1 — question · fleet · t\n\njust prose\n\n> A:\n")).itemSlug).toBeNull();
  });
});

describe("anomalies are reported, never silently dropped", () => {
  test("an unparseable heading does not swallow the entries around it", () => {
    const payload = parse(file(
      "### 1 — question · a · one\n\nb\n\n> A:\n",
      "### not an entry heading at all\n\nb\n\n> A:\n",
      "### 3 — question · a · three\n\nb\n\n> A:\n",
    ));
    expect(payload.entries.map((e) => e.id)).toEqual([1, 3]);
    expect(payload.anomalies).toHaveLength(1);
    expect(payload.anomalies[0].kind).toBe("unparseable-heading");
  });

  test("a duplicate id is reported and both entries survive", () => {
    const payload = parse(file(
      "### 7 — question · a · first\n\nb\n\n> A:\n",
      "### 7 — question · a · second\n\nb\n\n> A:\n",
    ));
    expect(payload.entries).toHaveLength(2);
    expect(payload.anomalies[0].kind).toBe("duplicate-id");
  });
});

describe("entryHash - the 409 guard's basis", () => {
  test("is stable across reads of identical text", () => {
    const text = file("### 1 — question · a · t\n\nb\n\n> A:\n");
    expect(parse(text).entries[0].entryHash).toBe(parse(text).entries[0].entryHash);
  });

  test("changes when the body changes", () => {
    const a = only(file("### 1 — question · a · t\n\nb\n\n> A:\n"));
    const b = only(file("### 1 — question · a · t\n\nb edited\n\n> A:\n"));
    expect(a.entryHash).not.toBe(b.entryHash);
  });

  test("changes when the answer changes", () => {
    const a = only(file("### 1 — question · a · t\n\nb\n\n> A:\n"));
    const b = only(file("### 1 — question · a · t\n\nb\n\n> A: (a)\n"));
    expect(a.entryHash).not.toBe(b.entryHash);
  });
});

describe("the `## Open` section is a boundary, not a starting point", () => {
  test("entries under a later section are not open entries", () => {
    // OUTBOX.md may grow an `## Answered` or `## Routed` archive; those entries must
    // not badge cards or become writable through the answer UI (review R1-F19)
    const payload = parse(
      CONTRACT_PROSE +
      "### 1 — question · a · live\n\nbody\n\n> A:\n\n" +
      "## Answered\n\n### 2 — question · a · archived\n\nbody\n\n> A: settled\n",
    );
    expect(payload.entries.map((e) => e.id)).toEqual([1]);
    expect(payload.anomalies).toEqual([]);
  });

  test("the last section still parses to the end of the file", () => {
    const payload = parse(file("### 1 — question · a · t\n\nbody\n\n> A:\n"));
    expect(payload.entries).toHaveLength(1);
  });
});

describe("answerable", () => {
  test("an entry with a > A: line can be answered", () => {
    expect(only(file("### 1 — question · a · t\n\nbody\n\n> A:\n")).answerable).toBe(true);
  });

  test("an entry written without one cannot", () => {
    // the writer rewrites that line, it does not invent it - so the UI must not offer
    // a box that could never be submitted (review R1-F5/F9)
    const e = only(file("### 1 — question · a · t\n\nbody with no answer line\n"));
    expect(e.answerable).toBe(false);
    expect(e.answer).toBeNull();
  });
});
