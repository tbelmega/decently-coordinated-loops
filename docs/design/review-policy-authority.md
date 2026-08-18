# Which configuration may govern a review

Design note for the policy-authority path in `tools/review/cli-review.ts` and the
`tracked-elsewhere` pointer grammar in `tools/review/review-ledger.ts`. Written as the
step-back note the remediation-churn tripwire demanded after rounds 3 and 4 of
`dcl-review-change-classes` came back remediation-dominated: four consecutive rounds each
found one more hole in the same two units, and each was closed with one more guard.
That is the pattern the tripwire exists to interrupt.

## Why this exists at all

Every other review disposition is a judgment an agent argues for in prose, which the next
round re-reads. Two are not. A `waived-by-policy` disposition is granted by
**configuration**: the agent applies it, and the terminal predicate honors it, because
`loops.json` said that class of finding may be waived at that priority. An `exempt` class
goes further and records a passing round with **no reviewer run at all**.

So the configuration is the authority, and the question "which configuration?" is the
whole control. Get it wrong and an agent authorizes its own waiver, or skips review
entirely, out of a file it chose.

## The invariant list

The unit is: *resolve the review policy that governs an existing ledger.* Its full
invariant list, not only the parts findings have named so far:

1. **Recorded once.** The authority is written when the ledger is created and never
   rewritten, re-pointed, or backfilled. A binding a later run can supply is not a
   binding.
2. **Same data repository.** The `loops.json` consulted later must be the one the review
   started under, compared canonically (tilde-expanded, resolved, symlink-free).
3. **Same project block.** Within that repository, the project whose `review` block was
   resolved at the start is the one that governs. Not the block a fresh match would pick.
4. **The project must still be the reviewed checkout's project.** A registered name is
   not an identity: `projects.<name>.repo` can be repointed at a different checkout while
   keeping the name, which would hand this review a policy belonging to something else.
5. **Absence fails closed, in every direction.** No recorded authority, no resolvable
   data repo, a different data repo, a project that has left the config, or a project
   that no longer maps to this checkout: no classes, so waivers block and nothing is
   exempt. Never a fallthrough to the global block, which is the broader policy.
6. **Every class consumer obeys all of the above.** Not just the waiver gate. The class
   list drives three things - waiver authorization at `disposition`, waiver
   re-authorization at `status`, and the exempt short-circuit plus reviewer guidance at
   `start`. A consumer resolved outside this path is a hole regardless of how well the
   others are guarded.
7. **The recorded authority is visible to the owner** in the rendered ledger, so the
   configuration a waiver rested on can be audited without reading JSON.

## The decision: rewrite, not another guard

Rounds 1-4 added, in order: `--data-repo` on `status`; the data-repo root binding; the
project name; the project-still-registered check. Each was correct and each left the next
hole, because the guards were bolted onto two independent resolution sites while a third
(the exempt short-circuit) was never bound at all. Adding a fifth guard would have been
the third consecutive round of the same move.

**Rewrite from the list above.** One resolver answers "what policy governs this ledger",
returning either the resolved config or the reason it refuses, and every class consumer
calls it. The recorded authority carries the identity the list requires - data-repo root,
project name, and the project's canonical repo root - so invariant 4 is checkable rather
than assumed. Invariant 6 stops being something to remember and becomes something the
code shape enforces: there is one place to get it right.

## What is deliberately not pinned

`auditPasses`, `metadataPaths` and `confirmation` stay resolved per run. They set review
scope and cost, not authorization, and every one of them leaves its trace in the round
record: the manifest persists `metadataPaths` and the covered files, the audit persists
its passes and its `scope`. A dial changed mid-review is therefore visible in the
evidence. A waiver's authorization is not like that - it is a live check with nothing in
the round record to re-derive it from - which is why classes are the thing that gets
pinned.

## The pointer grammar: remove the invariant family

`tracked-elsewhere`'s `repo#branch` pointer was validated by a blacklist that tried to
reproduce what `git check-ref-format` rejects. Rounds 2, 3 and 4 each found another thing
it did not reject: `***`, then the ASCII control range and DEL, then `.lock` on a
non-final ref component. A blacklist of another program's rules has an unbounded tail,
and every round of it costs a round.

**Remove the family.** The property that has to hold is *anything we accept, git accepts*
- not *we reject everything git rejects*. A whitelist gives the first property by
construction: each slash-separated component matches `[A-Za-z0-9_][A-Za-z0-9._-]*` and no
component ends in `.lock`. That is strictly narrower than git's grammar, so there is no
tail left to discover. It rejects some branch names git would allow, which is the correct
trade for a pointer field: a destination that cannot be written in a conservative subset
can be given as a path or a board-item slug instead.

## Obligations this covers

- R4-F1 (exempt short-circuit not bound to the recorded authority) - invariant 6.
- R4-F3, R4-F5 (recorded project not verified against the reviewed checkout) - invariant 4.
- R4-F4, R4-F6 (`.lock` accepted in a non-final ref component) - the whitelist rewrite.
- Retrospectively, the closed obligations R2-F2, R3-F2 and R3-F6 are all instances of
  invariants 1-4 being enforced at one site instead of all of them.
