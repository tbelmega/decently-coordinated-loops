# Slot selection and claims: invariants and the no-lock decision

Background for maintainers of `skills/loops-board/references/worktree-slots.md` and
`tools/slots.ts`. Agents follow the reference; this note records why it looks the way it
does.

## Invariants

1. **Candidates are exact slots of this host.** A slot is a linked worktree at
   `<repo>/.worktrees/<host>-<tool>-<n>` on branch `agents/<host>-<tool>-<n>`, with a
   hyphenless tool and a numeric `n`. Purpose worktrees, legacy `<slot>--<item>` stack
   branches, worktrees outside `.worktrees/` and other hosts' lanes are never candidates.
2. **Idle means reusable without loss:** a clean working tree, no active board item
   (`in-progress`, `implemented`, `blocked`) recording the slot as `execution.worktree`
   (paths compared canonically), and content already on the integration ref, squash
   merges included.
3. **No mutation before the verdict.** Syncing decides first; only an idle slot is reset to
   the integration ref. Anything else stops with the branch untouched.
4. **Claim before touching.** The slot is recorded on the board item and pushed before any
   sync or edit, so the next session sees it.
5. **Claims are checked against fresh board state.** The session pulls, re-checks with
   `cli-slots.ts --item <slug>`, then commits and pushes; a rejected push repeats the check.
6. **Exclusivity is best effort, not guaranteed.** There is no lock.
7. **Unattended sessions never create slots;** they file an outbox `proposal`.
8. **Only the owning host writes to a slot.**

## Decision: remove the guarantee rather than keep patching it

Review rounds 1-3 each found a narrower interleaving in which two sessions could claim the
same slot (no claim step; a successful push after pulling the other claim; two commits in
one shared data-repo checkout published by one push). Closing the last one needs mutual
exclusion inside a checkout, and the attempted lock reintroduced its own failure mode: a
lock left by an abandoned session blocks its slot until someone notices.

The owner ruled (2026-11-17) to drop guaranteed exclusivity instead (invariant 6). One
operator starts sessions minutes apart, never two claims in the same second, and
dispatchers on one host fire staggered. A session that claimed a slot minutes earlier shows
there as a board claim, commits or uncommitted changes, any of which makes the slot not
idle (invariant 2). That removes the invariant family the patches were chasing: the
reference no longer promises an exclusive claim, so there is no protocol left to race.
The remaining window, two claims within the same moment, is an accepted limitation.

## Obligations this covers

- E1-R1-F4 (no exclusive slot acquisition): claim before touching (4), fresh-state check (5).
- E1-R2-F1 (check against the exact pulled state): invariant 5.
- E1-R3-F1 (claims racing inside one shared checkout): resolved by the owner's ruling,
  invariant 6, documented in the reference and in the spec.
