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

- Bundled option: DCL ships a local, forge-independent reviewer (an independent
  model — Codex/Claude/Cursor — reviews the branch read-only). Activate it by setting
  `review.reviewer` in `loops.json` (`bun run setup` offers this); agents then drive
  it automatically for the final handoff of attended and unattended tracked items per
  the loops-review skill after all internal tasks and final verification are complete.
  A logical round defaults to validated diff, integration, and adversarial passes.
  The terminal signal is a review round covering the current HEAD that owes nothing -
  clean, or every finding carrying a non-blocking disposition - or a descendant whose
  intervening commits touch only configured `review.metadataPaths`. Optionally set the
  positive integer `review.maxRounds` (public default 3), a non-empty
  `review.auditPasses` subset, safe repo-relative landing metadata patterns,
  `review.classes` that waive findings on record-keeping surfaces (drawn by function,
  never by file extension), and `review.confirmation: "scoped"` to narrow a qualifying
  confirmation round to the fix delta. Every key can be overridden per project under
  `projects.<name>.review`.
- An item that wants a deliberate rule change read as the proposed rule rather than
  judged against the rule it replaces declares exactly those paths in its front-matter
  `review.rewrites` and carries `links.spec` for them. The declaration is opt-in: an
  undeclared edit to a rule file (AGENTS.md, CLAUDE.md, `skills/*/SKILL.md`,
  `.cursor/rules/*`) is simply reviewed with that file still standing as authority,
  which is the stricter path and needs no spec. The procedure is in the loops-review
  skill.
- An agent that concludes the review *mechanism* rather than its own change is what
  keeps a round from going clean escalates instead of grinding to the round cap: a
  written diagnosis, a tracked item for the suspected defect, and the work left
  `blocked` for the owner to rule on - the exit is never an unreviewed landing. The
  loops-review skill carries the protocol.
- TODO: keep the bundled reviewer, or define your own mechanism here.

## Merge policy

- Default: the owner lands agent branches on the integration branch (rebase);
  agents never merge or deploy unattended.

<!-- To delegate landing to agents, replace the default with exact conditions. Require
     a pre-review rebase + full gate, a clean current-HEAD review, and an exact
     expected-old-SHA compare-and-swap only while integration still equals the
     reviewed base. Require proof that the reviewed base is an ancestor of the
     reviewed head before using the narrowly scoped force-with-lease. If integration
     moved, require rebase + gate + fresh review. State whether an integration push
     may trigger an authorized development deployment; keep release/prod boundaries
     explicit. -->

## Worktree and branch policy

- TODO: For each project, choose either isolated item branches/worktrees or permanent
  worktree slots and record the choice in `PROJECTS.md`.
- Permanent slots use one persistent base branch per worktree. They may carry at most
  three unlanded items in an ancestry chain; later items branch from the current tip
  as `<base-branch>--<item-slug>` and record immutable handoff ranges. Acquire and
  clean slots per loops-pickup. Owner-only landing remains in force unless the merge
  policy above explicitly delegates it.

## Guardrails (additions)

<!-- Extra never-do rules for this instance, on top of the loops-pickup defaults
     (no undelegated merging, no undelegated deploys, no secrets/credential changes,
     no new external services, no force-pushes to shared branches except the exact
     ancestry-checked expected-SHA lease delegated by the merge policy). -->

- TODO: add instance-specific boundaries, or remove this placeholder.

## Cross-cutting obligations (gate exemptions)

<!-- Obligations that follow an action, not a directory: they apply regardless of
     which repo you're in, so they are exempt from the project-participation gate
     (loops-board → Project participation). Example: "after refreshing the design
     export archive, file board items for newly-buildable work — even when invoked
     from another repo." List them here, or leave empty. -->

- TODO: none, or list cwd-independent obligations.

## Dispatch

<!-- Unattended-pickup cadence and tuning, if periodic dispatch is used:
     schedule, usage-limit handling, stagger offsets across sessions. -->

- TODO: define, or leave empty until you automate pickup.
