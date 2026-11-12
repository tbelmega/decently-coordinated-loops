---
name: loops-voice
description: Use when a message starts with the line "[hands-free]", or the owner says they are hands-free, driving, on a voice call, or cannot look at a screen; how a working session shapes its replies and decisions for an owner who only hears them read aloud
---

# Serving a hands-free owner

The owner is reachable, but only by ear: a voice relay reads your reply aloud and sends
back what the owner said. They can decide, as long as the context fits in a few spoken
sentences. They cannot see a diff, a table, a link, a screenshot or a long text, and they
may be driving, so brevity is a safety matter and not a style preference.

This sits between attended and unattended work: small decisions are asked live, everything
else is handled as if unattended.

## When the mode applies

- **Per message, never per session.** A message whose first line is `[hands-free]`, or in
  which the owner says they are hands-free, is a hands-free turn. A later message without
  the marker is an ordinary attended turn: reply normally again.
- The words after the marker are the owner's speech passed through speech-to-text and
  possibly a relay model. Expect mangled names and missing punctuation; read them for
  intent, using the project's glossary where it has one.

## Shape of every hands-free reply

1. **Start with a line reading `SPOKEN:` followed by one paragraph of at most five short
   sentences.** The relay reads this paragraph and nothing else, so it must stand alone.
2. In that paragraph: what happened or where things stand first, then **at most one ask**.
   Give your recommendation first and at most three options, named by plain words ("the
   first", "the cheaper one"), never by letter, slug or ID.
3. Write for the ear: plain sentences, no markdown, no lists, no code, no paths, no commit
   hashes, no URLs, no item slugs. Name a work-stream by its title. Round numbers. Say
   "the login spec", not its filename.
4. If nothing is needed from the owner, say so in the paragraph ("nothing needed from
   you") so the relay can move on.
5. Everything a desk reader would want (evidence, commands, the completion receipt where
   one is owed) follows below a line reading `DESK:`. Rules about what a handoff must
   contain are unchanged; this only decides what is read aloud.
6. No structured ask-the-user prompt and no visual output in a hands-free turn: a dialog
   or a rendered page is invisible to a listener and can stall the session. The ask
   belongs in the spoken paragraph.

## Deciding what to ask live

- **Fits in the spoken paragraph, and the owner can judge it from that alone:** ask it,
  then end the turn.
- **Needs eyes** (a diff, a design, a long draft, more than three options, a comparison of
  numbers): do not ask it and do not wait. Handle it as unattended work does: file it in
  the outbox per loops-queues, mention in the spoken paragraph that one question is parked
  for the desk, and continue with whatever does not depend on it.
- **Resolve first what you may resolve yourself.** A hands-free owner is the most
  expensive reader there is; the bar for interrupting them is higher than at a desk.
- One ask per turn. Further asks wait for the next turn, highest leverage first.

## Taking a spoken answer

- **A spoken yes approves only what was spoken.** If the owner heard a three-sentence
  summary, they approved that summary's direction, not the document behind it. Approval of
  a spec, a contract change or any long text stays a desk action: record the spoken
  direction, keep the formal approval open.
- **Irreversible or outward-facing actions get a read-back.** Before a merge, a deletion,
  a message to a third party, a spend or anything house rules guard, say in one sentence
  what you are about to do and wait for a confirming turn. Guardrails that forbid an
  action unattended are not lifted by a voice yes.
- **Ambiguous transcript:** if the words fit more than one option, ask once which was
  meant, restating the options. Never guess between options on a decision that matters.
- **Record provenance.** Wherever the answer is written down (item log, outbox answer
  line, spec decision), mark it as given by voice with the date, and quote the words as
  received next to your interpretation, so a mishearing can be traced later.

## What a hands-free turn never does

- Ask the owner to open, look at, read or click anything.
- Spell out an identifier, a path or a command.
- Stack several questions, or end with an open "what would you like to do next?" when a
  recommendation is possible.
- Wait on a permission prompt: the relay cannot approve one. If a step needs an approval
  only a screen can give, skip that step, say in the spoken paragraph that it is parked
  for the desk, and carry on.
