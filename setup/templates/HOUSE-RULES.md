# House rules

Cross-project local policy for this instance — the owner-specific half of every DCL
skill's extension points. Skills defer to the sections below wherever behavior is
owner- or environment-specific; per-project specifics belong in
[PROJECTS.md](PROJECTS.md) instead. Keep entries short and imperative; agents read
this file before any unattended work.

## Owner

- Name: {{OWNER}}. Where the DCL skills say "the owner", they mean this person.

## Harnesses & model roster

<!-- Which agent harnesses / models / subscriptions run in this instance, their
     sweet spots and watch-outs, and standing assignments. The loops-pickup
     capability gate routes work against this section. -->

- TODO: fill in your roster.

## Review mechanism

<!-- How an agent requests an automated code review for a finished change on an
     agent branch, how feedback arrives, and what the terminal "review complete"
     signal is. Examples: open a GitHub PR that a review bot comments on; invoke
     another harness or agent on the branch; run a review script. The loops-pickup
     deliver/iterate steps are written against this section. -->

- TODO: define how reviews are requested and received.

## Merge policy

- Default: the owner lands agent branches on the integration branch (rebase);
  agents never merge or deploy unattended.

<!-- To delegate landing to agents, replace the default with the exact conditions
     (e.g. "after the review mechanism signals complete with no outstanding
     comments, the agent may rebase onto the integration branch and push"). -->

## Guardrails (additions)

<!-- Extra never-do rules for this instance, on top of the loops-pickup defaults
     (no merging, no deploys, no secrets/credential changes, no new external
     services, no force-pushes to shared branches). -->

- TODO: add instance-specific boundaries, or remove this placeholder.

## Dispatch

<!-- Unattended-pickup cadence and tuning, if periodic dispatch is used:
     schedule, usage-limit handling, stagger offsets across sessions. -->

- TODO: define, or leave empty until you automate pickup.
