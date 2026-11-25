# Central dispatch invariant inventory

This note records the step-back analysis for central dispatch's run serialization and board
writes. `tools/dispatch-run.ts`, `tools/dispatch-git.ts`, `tools/dispatch-plan.ts` and
`tools/lock.ts` are the enforcement units.

## Why the lock fixes kept recurring

All remediation findings in rounds 2 and 3 trace to one root cause: the first design
serialized dispatch runs with the existing data repo lock file (`.loops-sync.lock`),
whose rules were built for short sync runs (age-based staleness, exclusive create
followed by a separate write, unlink-by-path takeover). Each round patched one property
of that file lock (renewal, live-holder rule, ownership checks) and the next round found
the next property. The other remediation findings (claim re-plan per attempt, saving
before push, the ended marker, inline execution blocks, mode "auto" only, the delivered
work check) were each closed and confirmed in round 3.

## Decision: one ownership-safe protocol for the shared lock

A first rewrite serialized dispatch runs with a kernel lock (flock) and kept the file lock
only for sync. That left sync and dispatch able to overlap through the file lock's stale
takeover, and the kernel lock needed a Bun-only import in a module that Node-run tools
load. The final design drops the kernel lock and makes the one shared file lock
ownership-safe for every participant (`tools/lock.ts`):

- A lock file only ever appears complete (written privately, hard-linked into place).
- A lock is held for as long as its holder process lives; it is stale only once that
  process is gone or its pid belongs to a different process (process start time).
- A stale lock is taken over only by the one contender that creates the takeover marker
  named after that exact stale record, after reading the record again unchanged; the new
  record replaces it in one rename. A stale record cannot change underneath the winner,
  because its owner is gone and every other contender loses the marker.
- Since no live holder is ever taken over, renewing or releasing one's own lock cannot
  race a replacement. An interrupted takeover leaves its marker and fails closed.

Sync, `landed --apply`, the tracker and dispatch all take this one lock, so a tick or
pause excludes every other writer of the checkout.

## Invariants (full list)

1. At most one writer of the data repo checkout (sync, landed, tracker, tick, pause) holds
   the shared lock at a time; a tick or pause holds it from before the state is read
   until after the last write.
2. The state file is read and written only under that lock; writes are atomic
   (temp file plus rename).
3. A board write is one commit built on the fetched upstream with a private index,
   containing only its own paths, pushed as exactly that commit; a rejection means
   fetch and decide again, never reset, rebase, skip or force.
4. Decisions read the upstream tree through git; every written path is a safe relative
   path to a regular file or an absent one.
5. A claim is re-planned inside every write attempt from the fresh upstream state,
   including config, controls, dependencies, quiet period, limits and lane.
6. The values a claim replaces are saved to the state before the claim is pushed.
7. Work and continue messages are sent only while the claim is active (newest dispatch
   token, not ended, claimed state, agent's turn) and the thread reports mode "auto".
8. A thread that logged anything under its token never gets the work again.
9. Cleanup (release, park) never overwrites an item that changed since the claim or
   that another claim took over; release and park lines end the claim with the ended
   marker.
10. T3 Code being unreachable keeps every claim and starts nothing; the tick exits 1.
11. Every subprocess (git, t3) is time-bounded.
12. A run that finds it no longer holds the data repo lock stops without writing more.
13. Config is reloaded after each fetch; a pulled disable or host change stops starts.
14. plan and status write nothing (no state, no board, no objects in project repos).

## Covered obligations

- E1-R1-F1, E1-R1-F18, E1-R2-F1, E1-R3-F1, E1-R4-F1 (lock): invariants 1, 2, 12, rewritten as above.
- E1-R4-F2 (Node compatibility): the lock module uses only `node:` imports.
- E1-R1-F5, E1-R1-F23, E1-R1-F24, E1-R2-F3: invariant 5.
- E1-R1-F7: invariant 13.
- E1-R1-F10: invariants 7 and 8.
- E1-R1-F11, E1-R2-F6: item writer (owner migration, quoting, inline execution blocks).
- E1-R1-F13, E1-R2-F4: invariant 6 and release restoring matching values.
- E1-R1-F16: trust boundary decision (t3.bin is a command name or absolute path outside
  the data repo; confirmed as fixed in round 3).
- E1-R2-F5: invariant 9 (ended marker).
- E1-R2-F7: invariant 7 (mode "auto" only).
