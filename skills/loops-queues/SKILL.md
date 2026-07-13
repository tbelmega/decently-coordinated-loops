---
name: loops-queues
description: Use when processing the inbox ("process the inbox"), writing to or processing the outbox ("process the outbox"), or when the owner says "interview me" — the contracts for both queues and interview mode
---

# The queues: inbox and outbox

Two files in the data repo connect the owner and the agent fleet asynchronously.
Both trend toward empty: agents drain the inbox, the owner drains the outbox.
"The owner" is the human named in `HOUSE-RULES.md → Owner`.

## Inbox — `INBOX.md`

The owner's dump zone: raw thoughts in, board items out. The owner writes anything
below the marker line — bullets, half sentences, any language, zero format — locally
or from a phone via the git host's editor.

**Processing contract:**

- Process when told ("process the inbox") and at the start of every unattended
  pickup. `git pull --rebase` first — entries may have been committed from the
  phone.
- For each entry below the marker: create a board item (state `idea` unless it is
  clearly further along) or append to an existing item if it obviously belongs
  there. Quote the original dump verbatim in the item file, then interpret — don't
  paraphrase it away.
- **Remove each processed entry.** Below the marker trends toward empty; the board
  item is the durable home. An unprocessed inbox entry and its board item must
  never coexist.
- Entry too cryptic to place? Leave it in place, add `> Q:` line(s) beneath it with
  the specific questions that would unblock it, and move on. Don't guess, don't
  delete, don't ask the same question twice.
- Never edit anything above the marker line.

## Outbox — `OUTBOX.md`

The mirror: everything the fleet needs FROM the owner — questions, proposals,
approval requests — aggregated in one place, answerable in one line each. The owner
answers on `> A:` lines, in any order; partial answers and "later" are valid.

**Entry contract:**

- Append entries under `## Open` with a sequential ID. One decision per entry, ≤6
  lines: type (`question` | `proposal` | `approval`), project, source link (item
  file, spec), the ask itself, options where the answer space is known, and an
  empty `> A:` line.
- Every question only the owner can answer that you write into an item file gets
  mirrored here — the item file holds the context, the outbox is where the owner
  finds it.
- Dedup before appending; don't re-ask what an existing entry covers.
- **Cap: at most 3 new entries per unattended session.** Rank by what unblocks the
  most work; hold the rest in item files until slots free up.
- Processing answers ("process the outbox", and at every unattended pickup): route
  each answer back into its source (item state, next-step, spec, autonomy flag,
  ...), log the routing on the item, then delete the entry. An answered entry that
  is also routed must not linger.

## Interview mode

When the owner says "interview me" (optionally with a time budget): pull the board
and the outbox, then interview live, one question at a time, highest-leverage first:

1. blockers on in-progress work,
2. open outbox entries,
3. autonomy approvals for near-eligible items,
4. probing vague `idea` items toward spec-readiness.

Use structured multiple-choice prompts where the harness supports them. Route every
answer immediately — an interview ends with the board updated and the outbox
shorter, not with notes to file later.
