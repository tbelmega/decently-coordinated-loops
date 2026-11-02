# Refinement and cleanup

Loaded from loops-pickup when no implementation item is eligible, or when an item failed
the spec gate and its pickup converts to spec drafting. Claim the item first (loops-pickup
step 3; create the board item if none exists).

## Refinement

Refinement turns vague items into implementable ones. It writes only to the data repo, so
it is safe unattended.

**Candidates:** board items in `idea` or `blocked` state, and the priority project's own
follow-up and debt trackers (locations from `PROJECTS.md`, never from memory). A follow-up
that exists only in a project tracker first gets a new board item (state `idea`) linking
back to its source.

- **Purpose clear:** research the codebase (current behavior, affected files, conventions)
  and write a `## Refinement` section into the item file: findings, a proposed approach or
  draft spec, effort and risk notes, and every remaining product decision as an explicit
  question. Never commit specs or ADRs to the project repo unattended; draft design lives
  on the board until the owner approves it (loops-board → Specs vs. items).
  - When the draft is ready for finalization (open questions answered or explicitly
    deferrable), request finalization asynchronously: one outbox entry (type `question`),
    `next-actor: owner`, `awaiting: decide`, next-step "owner: request finalization or
    continue drafting". Do not start draft review while still exploring the design.
  - On the owner's finalization request, follow loops-review's draft procedure
    (`references/draft-finalization.md` there): one independent round plus relevant
    fixes, with changes to agreed intent returned as questions. Then request explicit
    approval (outbox type `approval`, `awaiting: approve`); finalization is not approval.
  - On approval, promotion is agent work: commit the approved content to the project's
    specs location (`PROJECTS.md`) on an agent branch pushed to the project remote, record
    `links.spec`, `links.spec-branch`, and `links.spec-sha`, annotate `## Refinement` as
    promoted, and flip the state to `spec-filed`. The item is then implementable under the
    spec gate, based on that recorded branch and commit.
- **Purpose vague:** do not research speculatively. Write a `## Questions for the owner`
  section with the specific questions that would unblock refinement, set `next-step` to
  "owner: answer questions in item file", mirror the top question to the outbox, and move
  on.

Refine at most one or two items per session; depth over breadth. Commit and push after
each.

## Cleanup

With no refinement candidate either, keep the knowledge base trustworthy; stale docs
mislead every later session. Locations from `PROJECTS.md`. In order of value:

1. **Verify specs and design docs against the codebase:** decide implemented, partial,
   superseded, or stale, and record a dated status annotation at the top of the doc with
   evidence a human can check (file paths, commit hashes, review links).
2. **Verify follow-ups and research notes the same way.**
3. **Groom the board:** reconcile item states with reality, fix stale rows and next-steps.

Annotate project docs; never delete or merge them unattended (consolidation is a
proposal, not an action). Doc annotations go in a docs-only commit and review, never into a
feature branch. Timebox to one project and a handful of docs, and log what was covered on a
board item so the next session continues instead of restarting.
