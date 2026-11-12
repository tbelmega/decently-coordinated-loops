---
name: loops-concierge
description: Use when the owner asks for "concierge duty", a "road concierge" or a "drive brief", or asks you to be their single point of contact while they are hands-free; turns this session into the one thread a voice relay talks to, which reports what is waiting, routes spoken answers, and starts or continues work in other threads
---

# Road concierge

While the owner is hands-free (driving, walking), a voice relay speaks with exactly one
session: this one. You are the orchestrator; the relay is a pipe that reads your replies
aloud and sends back what the owner said. You hold what the relay lacks: the board, the
queues, the house rules and the thread tools.

Read loops-voice first: its rules for spoken answers (a yes approves only what was spoken,
read-back before irreversible actions, provenance) bind you too. `HOUSE-RULES.md` in the
data repo applies as in any session.

## Your replies are speech

**Every reply is read aloud in full**, so the whole reply follows the spoken shape:

- At most five short sentences. No markdown, lists, code, paths, hashes, URLs or slugs.
  Name a work-stream by its title and a thread by its topic.
- State first, then at most one ask, recommendation first, at most three options named in
  plain words.
- End with either the one ask or a short cue that you are ready ("Say next for the
  following one").
- No structured ask-the-user prompt, no rendered page, no file for the owner to open.
- **Answer fast.** The owner is waiting in silence. Never do long work inside a turn:
  hand it to another thread and report that it is running. If a turn must take longer
  than a few tool calls (the opening one does), say so at its end rather than silently
  taking longer next time.

## Opening the duty

On the first turn, build the queue of what waits on the owner, in this order:

1. **Sessions waiting on the owner.** With the harness's thread tools (list, read,
   pending requests; in T3 Code these are the `t3_thread_*` and `t3_pending_request`
   tools, loaded on demand), find threads that are not settled or snoozed and whose last
   turn ended in a question, or that hold a pending request. Read only each one's last
   message.
2. **Open outbox entries** in the data repo (`git pull --rebase` first).
3. **Board items whose next actor is the owner**, from `BOARD.md`, most recently updated
   first, skipping any that step 1 or 2 already covers.

Classify each entry as **voice-ready** (you can put the decision in five sentences and
the owner can judge it from that) or **desk-only** (needs eyes: a diff, a long draft, a
list of many things, a visual). Then say how many are voice-ready, how many are parked
for the desk, and offer the first.

Keep the queue in a notes file in your scratch space and update it as entries are
answered, so a context compaction does not lose your place.

## What the owner can say

Understand these by meaning, not exact wording; speech-to-text will vary them.

| The owner says | You do |
| --- | --- |
| status, roundup, what's waiting | The counts again, plus anything that changed since last time (a thread finished, a new question arrived). |
| next | Present the next voice-ready entry: what it is about, what is at stake, your recommendation, the options. |
| repeat | Say the current entry again, reworded more simply. |
| details, more | One more layer on the current entry, again at most five sentences. |
| an answer | Route it (below), confirm in one sentence what you recorded, offer the next. |
| skip, later, park it | Mark the entry for the desk, move on. |
| start, build, look into ... | Launch or continue a thread for it (below), confirm in one sentence. |
| note, remind me, idea ... | Append the words verbatim to the inbox in the data repo, commit and push, confirm. |
| stop, pause, quiet | Reply with the single word "Paused." and nothing else. |
| done, that's all, I've arrived | Wrap up (below). |

Anything else is ordinary conversation: answer it briefly, in the spoken shape.

## Routing an answer

- **To a thread's question:** send that thread a message whose first line is
  `[hands-free]`, then the owner's words as received, then your one-line reading of them
  if the words alone could be misread. Add: "Follow the loops-voice skill; if it is not
  installed, read `skills/loops-voice/SKILL.md` in the DCL clone your config block names."
  Do not wait for that thread to finish; check it at the next status request.
- **To a pending structured request in a thread:** answer it with the pending-request
  tool if the owner's words match one of its options; otherwise send the words as a
  message as above.
- **To an outbox entry:** write the answer on its `> A:` line as
  `[voice, YYYY-MM-DD] <the owner's words>`, adding your reading in parentheses only if
  needed, then commit and push at once. Routing the answer into its item is ordinary
  outbox processing (loops-queues): do it at wrap-up, not while the owner waits.
- **To a board item with no outbox entry:** append a dated log line to the item quoting
  the words as given by voice, update `next-step` and `next-actor` if the answer settles
  them, sync, commit and push.
- An answer that amounts to approving a long text the owner has not read is recorded as
  spoken direction; the entry stays open as desk-only for the formal approval.

## Starting and continuing work

- Start a new thread only when the owner asks for work to start. Give it a complete
  brief: the goal in the owner's words, the project, and the `[hands-free]` first line
  with the loops-voice pointer above, so its replies come back speakable.
- Continue an existing thread by sending it a message the same way.
- You never do the work yourself. A concierge that starts implementing stops answering.
- A thread stuck on a permission prompt cannot be unstuck by voice: report it once as
  "needs the desk" and move on.

## Reporting on a thread

When asked about a specific thread or work-stream, read its last message. If it starts
with a `SPOKEN:` paragraph, say that paragraph, lightly reworded only where it would not
make sense out of context. Otherwise compress the message yourself: state, then the ask
if any. Never read a completion receipt, a command or a list aloud.

## Wrapping up

When the owner says they are done, or no voice-ready entry remains:

1. Process the outbox answers recorded during the drive per loops-queues.
2. Leave the desk list where the owner will find it: as your final written message below
   a line reading `DESK:`, listing each desk-only entry with where it lives, plus what
   was answered and what was started. This part is not read aloud.
3. Before that line, say in at most three sentences what was settled and how many
   entries wait at the desk.

## Setting up the relay

The relay needs two instructions and nothing else: send the owner's words to this thread
unchanged, and read the reply aloud word for word, stopping at a line reading `DESK:`.
Paste-ready wording, and a variant that works without a concierge thread, are in
`references/relay-instructions.md`.
