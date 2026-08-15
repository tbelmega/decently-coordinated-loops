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

**Entry shape.** One decision per entry, ≤6 lines of body, appended under `## Open`
with a sequential ID:

````markdown
### 42 — question · myapp · Which backend for the session store?

- item: myapp-session-store

Source: [the item](items/myapp-session-store.md). Redis needs an ops call I can't make.
Options: (a) Redis, (b) a Postgres table, (c) in-memory until it hurts.

> A:
````

The heading line is structural, not decoration: `### <id> — <type> · <project> ·
<title>`, with an em dash after the id and middle dots between the fields. Only the
first three separators are read as separators, so a title may contain both. IDs are
sequential at append time but sparse over the file's life, because routed entries are
deleted; never renumber to close a gap, since answered entries are cited by ID.

- **`- item: <slug>`** is optional and authoritative when present: it joins the entry
  to its board item. Write it whenever the entry has one. Without it a reader guesses
  from prose links, which goes wrong exactly when an entry cites a second item (the
  one a finding was raised on, say) alongside the one it is about.
- The body carries the source link (item file, spec), the ask itself, and the options
  where the answer space is known. It ends with an empty `> A:` line: an entry with no
  `> A:` line cannot be answered in place.
- Every question only the owner can answer that you write into an item file gets
  mirrored here — the item file holds the context, the outbox is where the owner
  finds it.

**Types.** The vocabulary is closed: `question`, `proposal`, `approval`, `decision`.

- `decision` is a **notice**: the agent made a reversible call under the loops-pickup
  provisional-decision band, acted on it, and kept working. It records what was
  decided, why, and "object to reverse". Notices don't block the item, but they count
  against the cap and are routed like any answer, and an objection reopens the
  decision on the item. (Provisional rule, adopted 2026-07-20, to be reviewed after
  real-world use.)
- Every other type is a **stopped ask**: the work is waiting on the answer.
- `decide` is retired as an entry type. Write `question` instead, and re-type any
  surviving `decide` entry when you next route it. This retirement does not touch the
  item field `awaiting: decide`, which is a different field with its own vocabulary
  (loops-board) and is unaffected.

**Handling:**

- Dedup before appending; don't re-ask what an existing entry covers.
- **Cap: at most 3 new entries per unattended session.** Rank by what unblocks the
  most work; hold the rest in item files until slots free up.
- Processing answers ("process the outbox", and at every unattended pickup): route
  each answer back into its source (item state, next-step, spec, autonomy flag,
  ...), log the routing on the item, then delete the entry. An answered entry that
  is also routed must not linger.

**End-of-turn surfacing.** Filing is unconditional and unchanged: write the entry,
keep working, never wait for an answer. But an entry that only reaches `OUTBOX.md` is
a question the owner has to go and find, so at the end of every turn in which you
appended entries - however long the turn ran - raise exactly those entries with him
directly, as the turn's last action before the closing message, so that message and
its completion receipt already reflect whatever came back:

- **Ask, don't merely report.** Use the harness's structured ask-the-user tool where
  it has one, otherwise a numbered list in the closing message. One prompt per entry,
  carrying the options the entry itself offers plus a final **"skip - answer via the
  outbox later"**. Where the harness's prompt takes a limited number of questions at
  once, ask the highest-leverage ones that fit and name the rest.
- **Never condition this on whether you think anyone is watching.** A turn end may be
  a prompt the owner is waiting on, or one of a dozen parallel sessions he is not
  looking at while sitting at that very computer, and from the inside the two are
  indistinguishable. So ask either way, and treat no answer as an ordinary outcome
  rather than a failure: every durable update is committed and pushed *before* you
  ask, so an unseen, skipped, or abandoned prompt costs nothing and leaves
  `OUTBOX.md` doing its job - the ledger that points the owner at what needs him.
- **An answer given here is an answer.** Route it into its source, log the routing on
  the item, and delete the entry - the same processing a `> A:` line gets, and its ID
  stays retired like any routed entry's. An entry left unanswered stays exactly as
  filed, and its item keeps the `next-actor`/`awaiting` it already had.
- **`decision` notices are raised too**, as "leave it" or "reverse it": a retroactive
  ruling is worth least when it arrives late, and a reversal is cheapest while the
  work is still fresh. Either ruling is an answer and retracts the entry, recorded on
  the item as ruled; "reverse it" also reopens the decision there.

Surfacing covers the asks *you* wrote. An entry a tool filed on your behalf - `bun run
sync` routing an orphan board row - is not yours to retract: that routing needs a later
sync run to observe the entry in `## Open`, and deleting it early strands the row.

Surfacing is a delivery mechanism, not a licence to ask more. What deserves an entry
at all is unchanged, including resolving first everything you can resolve yourself.

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
