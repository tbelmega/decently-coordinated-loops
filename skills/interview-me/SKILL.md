---
name: interview-me
description: Use when the user says "interview me", "interview me on <topic>", "interview me on that" (often about the options or questions your previous turn raised), or "ask me one by one", or when you hold several open questions or decisions only the user can settle; settles them one self-contained question at a time
---

# Interview me

An interview settles a set of open points with the user, one at a time, so that each answer is
quick and well informed. Assume the user reads every question cold: they may have lost the
thread since the point came up, or never read the material behind it.

## What to cover

- A named topic: the open points on that topic.
- "On that", or a bare "interview me" right after your turn offered options or raised
  questions: exactly those points.
- A bare "interview me" with nothing open in the conversation: ask in one question what to
  cover. Where a work-stream board is set up, offer what waits for the user there as one
  option (loops-queues).

## Before the first question

- Collect the open points from the conversation, the files and the tracking item. Drop those
  the code, the docs or the user's recorded decisions already answer, and decide those your
  rules let you decide; list what you decided so the user can object.
- Order the rest by leverage: first the ones whose answers change or remove other questions.
- Tell the user how many questions there are, and update the count when answers add or remove
  some.

## Each question

- One question per message or structured prompt.
- It stands on its own. In a few plain sentences: what the point is, where it came from, and why
  it needs their call. Define any term the user did not introduce.
- Never refer to something they would have to look up: no finding or ticket IDs, no "option B
  above", no "the split we discussed". Restate what they need in the question itself; a file
  path is optional evidence, never required reading.
- Offer the real options with what each one causes, and lead with your recommendation and why.
- In a multiple-choice dialog, the question and option texts carry all of this; the dialog may
  hide everything printed before it.

## Each answer

- Record it where it belongs (spec, item, code, memory) before asking the next question, so a
  crash or compaction loses nothing.
- If the answer is unclear or raises a new question, follow up before moving on. If it changes
  later questions, rewrite or drop them.
- For a free-form answer, act on its intent and say briefly how you read it.

## Ending

Stop when every point is settled or the user ends it. Close with a short list: each point, the
decision, and where it was recorded; name any point still open.
