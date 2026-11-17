---
name: research
description: Use when exploring how a codebase, external system, process or feature currently works, or when asked to document current behavior in depth. This skill lets you write a standardized persistent summary of your findings, which is convenient for the human to review.
---

# Research

A deep-read workflow for understanding current behavior before planning or implementation.

First check `docs/research/` for notes on the topic or closely related ones. If any exist, read
them, tell the user what they cover and their dates, and verify them against the current code
before relying on them; update them where they have drifted, and research only what they leave
open.

## Requirements

- Clarify the scope if the request is ambiguous.
- Read every relevant file, not just entry points, and callsites, not just definitions.
- Trace data flow end-to-end.
- Read the documentation in the codebase and other accessible sources such as websites; where
  you have the source code, confirm documented claims against it.
- Capture conventions, hidden coupling, surprising behavior, risks, and any bugs found.
- If the goal is bug hunting, keep reading until all likely bugs in scope are documented.

## Artifact

- Write the findings to `docs/research/YYYY-MM-DD-<topic>.md`; the document, not the chat
  summary, is the review surface.
- Include scope, key findings, how the system works, important files, conventions, risks, bugs
  if relevant, and open questions.
- Share its path when it is ready and ask the user to review it before planning.
