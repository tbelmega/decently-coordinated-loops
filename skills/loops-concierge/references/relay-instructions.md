# Instructions for the voice relay

The relay is whatever speaks with the owner: a voice assistant connected to the harness's
thread tools, or a small speech-to-text and text-to-speech loop. It should carry words,
not make decisions. Two setups follow; both rely on the loops-voice skill being installed
for the working sessions.

## Variant A: one concierge thread

The relay talks to a single thread that runs the loops-concierge skill.

Starting the thread (typed or dictated into the harness before leaving, which gives it
the same permissions as any thread the owner starts by hand):

> Concierge duty. I am hands-free from now on.

Standing instructions for the relay (paste into its custom instructions, or say them at
the start of the call):

> For this call you are a relay, not an assistant. Send everything I say, in my own words
> and without adding or removing anything, as a message to the thread titled with
> "concierge" that was created most recently. Wait for its reply. Read the reply aloud
> word for word, and stop reading at a line that says DESK. Do not summarize, do not
> answer my questions yourself, do not start or message any other thread. If the reply
> has not arrived after a minute, say "still working" and keep waiting.

If the relay has to create the thread itself, add: "First start a new thread in the
tracker project with the message: Concierge duty. I am hands-free from now on."

## Variant B: the relay talks to the working threads directly

No concierge. The relay picks the thread; each working thread shapes its own reply.

> When you send a message to a thread for me, make its first line exactly [hands-free]
> and put my words below it unchanged. When you report on a thread, find the paragraph
> that starts with SPOKEN in its last message and read that paragraph word for word. If
> there is none, summarize the last message in at most four sentences: first where things
> stand, then the one thing it needs from me. Never read out file paths, commit hashes,
> commands or tables. Ask me one question at a time.

## Telling the two apart on the road

Use one variant per trip, so the experience can be compared:

- **Delay:** how long the silence is between the end of a sentence and the start of the
  answer. Variant A adds a hop.
- **Fidelity:** whether what was read matched what the thread wrote, and whether the
  answer recorded matched what was said.
- **Orientation:** whether "what is waiting on me" produced a usable order of business
  without follow-up questions.
- **Stalls:** any moment the call went quiet because something waited on a screen.
