import { expect, test } from "bun:test";
import { audioEntries, parseOutbox } from "./parse.ts";

export const fixture = `# Outbox
## Open

### 42 - question · daybook · Which store?
- item: daybook-storage
- speak: Choose SQLite or Postgres.
Source: [the item](items/daybook-storage.md).
**The ask:** Choose a session store.
> A:

### 43 \u2014 proposal · workboard · Ship?
- speak: Ship or wait?
> A:
> Wait.

### 44 - approval · relay · Approve?
> A:

### 45 - decision · relay · Reminder
- speak: Any objection?

## Archive
### 46 - question · daybook · Archived
- speak: Ignore this.
> A:
`;

test("extracts only open-section entries and queues unanswered spoken entries", () => {
  const entries = parseOutbox(fixture);
  expect(entries.map(({ id }) => id)).toEqual([42, 43, 44, 45]);
  expect(entries[0]).toMatchObject({
    type: "question", project: "daybook", title: "Which store?",
    source: "[the item](items/daybook-storage.md).",
    ask: "Choose a session store.", speak: "Choose SQLite or Postgres.",
    answered: false,
  });
  expect(entries[1].answered).toBe(true);
  expect(audioEntries(fixture).map(({ id }) => id)).toEqual([42]);
});
