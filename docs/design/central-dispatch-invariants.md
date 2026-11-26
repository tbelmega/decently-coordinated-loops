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
   including config, controls, dependencies, quiet period, and the chosen worker, its
   route and slot.
6. The values a claim replaces are saved to the state before the claim is pushed.
7. Work and continue messages are sent only while the claim is active (newest dispatch
   token, not ended, claimed state, agent's turn) and, for a T3 thread, the thread
   reports mode "auto". A Codex job gets its work message as its prompt at start.
8. A thread that logged anything under its token never gets the work again.
9. Cleanup (release, park) never overwrites an item that changed since the claim or
   that another claim took over; release and park lines end the claim with the ended
   marker.
10. A worker that does not answer (SSH, or T3 Code there for threads) keeps every entry
    and claim it holds and gets nothing new in that tick (no T3 start where only T3 is
    down); the tick still exits 0 and prints the worker as unreachable.
11. Every subprocess (git, ssh, t3, the job launcher) is time-bounded; SSH runs with
    `BatchMode=yes` and a connect timeout, and the probe answers reachability and
    repositories without T3, so a hung T3 server hides nothing else.
12. A run that finds it no longer holds the data repo lock stops without writing more.
13. Config is reloaded after each fetch; a pulled disable or host change stops starts.
14. plan and status write nothing (no state, no board, no objects in project repos, no
    job on any worker); the worker slot report runs with the read-only git environment.
15. Jobs run only on configured workers; the control host runs none unless listed as a
    worker. An entry without a worker (from before workers) is observed and parked
    wherever it would get work or a continue.
16. An entry is saved with its worker, executor and route before its claim is pushed and
    holds a slot of that worker from then on, `starting` included. A start whose answer
    is lost is found by its claim token next tick (thread title, or the job status file)
    and adopted, never started twice. For a Codex job, "no such job" counts only from
    `fence`, which records the token as never to start, so a request still on its way
    refuses when it arrives. A T3 thread found later than its release is harmless: it got
    only the handshake, and work is sent only by the program.
17. Observation uses the route stored on the entry, so editing or removing a worker in
    config never redirects a live entry.
18. Before acting on a stopped thread or job (continue, resume, park) the clone is fetched
    again and the item re-read; a line under the claim token ends the entry whatever the
    process state.
19. The job launcher writes the status file before spawning anything and is the process
    that spawns and records Codex, so no launcher-started Codex job runs without a status
    file. The supervisor leads its own process group and records it before spawning Codex
    into it, so a job is alive while any process of that group lives, even if the
    supervisor was killed before it named the child; a record from before the host's last
    boot is never alive. A stop request is passed to Codex and the
    exit recorded only once Codex ended. A stopped job without a session id parks; with
    one it is resumed once, a limit the worker enforces itself so a lost reply cannot grant
    a second resume. Prompts, status files and logs are owner-only; the prompt is deleted
    once Codex holds it.
20. Configured executables are command names or absolute or `~/` paths. The host that runs
    a command resolves the shell (the configured one or `$SHELL`), `t3`, `codex` and DCL
    clone on its own filesystem first and refuses (exit 97) any that lands inside a
    project repository the configuration names, a Git work tree holding a `BOARD.md`, or a
    root in the host's own `~/.config/dcl/guard-roots`, which no board edit can change. That
    file must name at least one root, and `realpath` must be installed, or the host refuses
    every command; a path that exists but `realpath` cannot resolve is refused. A refusal reads
    as no answer, so nothing is started or released.
21. A merge runs only on the worker in `execution.host`, in a checkout Git confirms there.
22. The work of a start goes out only after the claim is pushed and the clone has it with
    the configuration fetched alongside; before acting on a stopped thread or job (including
    the pause a mode mismatch causes) the board and configuration are fetched again.
23. A refused dispatch section stops only the dispatch program; a tick first fetches its
    dedicated clone, so a configuration already fixed upstream is used.

## Covered obligations

- E1-R1-F1, E1-R1-F18, E1-R2-F1, E1-R3-F1, E1-R4-F1 (lock): invariants 1, 2, 12, rewritten as above.
- E1-R4-F2 (Node compatibility): the lock module uses only `node:` imports.
- E1-R1-F5, E1-R1-F23, E1-R1-F24, E1-R2-F3: invariant 5.
- E1-R1-F7: invariant 13.
- E1-R1-F10: invariants 7 and 8.
- E1-R1-F11, E1-R2-F6: item writer (owner migration, quoting, inline execution blocks).
- E1-R1-F13, E1-R2-F4: invariant 6 and release restoring matching values.
- E1-R1-F16: trust boundary decision (t3.bin is a command name or absolute path outside
  the data repo; confirmed as fixed in round 3), extended to every worker executable by
  invariant 20.
- E1-R2-F5: invariant 9 (ended marker).
- E1-R2-F7: invariant 7 (mode "auto" only).

## Remote workers: why the trust-boundary and plan-reason fixes recurred

Rounds 2 and 3 of the remote-workers review were remediation-dominated. Two chains account
for every remediation finding; process liveness (E1-R1-F1, E1-R1-F15, E1-R2-F1) and the
checkout check (E1-R1-F6, E1-R2-F3) converged and round 3 confirmed them fixed.

**Executable trust boundary** (E1-R1-F3, E1-R1-F13, E1-R2-F2, E1-R3-F1). Root cause: each
fix drew the boundary from the controller's configuration (project repos, the data repo
path), which is the very board a hostile edit controls, so each round found one more way to
move a root away from a checkout. The invariant is invariant 20: no command a worker runs
for dispatch (its shell, `t3`, `codex`, the DCL clone) may resolve into code the board can
steer. Only state the worker owns can enforce that. Decision: continue patching to a closed
boundary rather than rewrite, because the boundary is now worker-owned and fails closed:
the host resolves every path itself, refuses anything under a root in its own required
`guard-roots` file or in a work tree holding `BOARD.md`, and refuses every command when that
file is missing or empty. Considered and rejected: refusing any executable inside any Git
work tree, without a roots file. On Apple Silicon `/opt/homebrew` is a Git work tree, so
Homebrew-installed `codex` or `bun` would be refused, and the DCL clone is itself a work
tree. An allowlist of trusted executable directories per worker would be stricter but adds
a second file to provision on every worker for no case the required roots file misses,
since every board-steerable checkout lives under a directory the worker keeps checkouts in.

**Plan reasons** (E1-R1-F12, E1-R2-F4, E1-R3-F2). Root cause: the planner short-circuited
after choosing a worker, so reasons for the rest were synthesized instead of checked. The
invariant: a start row's `passed` list holds, for every configured worker other than the
chosen one, the result of the same checks the chosen one passed (or "not the checkout host"
for a merge, or "ready, ranked after" when it passed them). Decision: rewritten, not
patched: one readiness function runs for every candidate, before and after the choice.

Covered obligations: E1-R1-F3, E1-R1-F13, E1-R2-F2, E1-R3-F1, E1-R4-F1 (invariant 20, the
required `guard-roots` file and `realpath`); E1-R1-F12, E1-R2-F4, E1-R3-F2 (the readiness function in
`planDispatch`); E1-R1-F1, E1-R1-F15, E1-R2-F1 (invariant 19); E1-R1-F6, E1-R2-F3
(invariant 21 and `gitWorkTree`).
