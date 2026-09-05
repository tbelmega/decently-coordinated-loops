# Review ledger invariant inventory

This note records the step-back analysis for the review ledger's causal disposition and
round-coordinate mechanisms. `tools/review/review-ledger.ts` is the enforcement unit.

## Full invariant list

### Causal findings and dispositions

- New reviewer findings carry one causality: `introduced`, `worsened`,
  `unmet-obligation`, `pre-existing`, or `unknown`.
- Legacy findings without causality remain readable, but their ownership is unresolved.
- New ledgers carry an explicit causal-scope version marker. Its absence identifies
  legacy version 1 evidence without weakening validation for newly written ledgers.
- A known finding causality cannot be overridden. An `unknown` or absent legacy
  causality may be resolved by a disposition.
- `introduced`, `worsened`, and `unmet-obligation` findings cannot use
  `tracked-elsewhere` or `delegated-follow-up`.
- `accepted` requires resolved current-workstream causality. It cannot turn an unknown,
  absent legacy, or pre-existing cause into a remediation obligation.
- `delegated-follow-up` requires effective `pre-existing` causality, a separate active
  committed board item, urgency, and escalation evidence when urgent.
- The status gate revalidates every persisted, decision-bearing delegated follow-up
  against the current policy authority, including its active state and complete
  source-finding context. Base supersession does not retire that durable handoff.
- `waived-by-policy`, `tracked-elsewhere`, `accepted-as-limitation`, and
  `delegated-follow-up` cannot clear the gate until causality is resolved.
- Legacy terminal decisions without resolved causality remain readable but block status
  across every review epoch.
- An accepted `pre-existing` finding cannot create current-workstream remediation.
- A remediation-created regression remains current-workstream owned regardless of
  related pre-existing debt.
- Every persisted decision must satisfy the same causal constraints enforced when it is
  recorded.
- Carried dispositions preserve the prior causal decision and remain subject to the same
  status gate.
- A disposition carries only when the repeated finding has the same causality. A carried
  delegation retains its original source-finding identity for board-item revalidation.

### Review epochs, rounds, and attempts

- Completed rounds have a unique append-only sequence number plus an epoch and logical
  round derived from supersession boundaries.
- A supersession starts the next epoch at logical round 1 without deleting prior rounds,
  findings, decisions, obligations, or attempts.
- Finding and round identifiers include epoch and logical round, including epoch 1.
- The configured round cap counts completed rounds in the active epoch only.
- Failed attempts attach to the pending logical round and do not consume the round cap.
- Attempt suffixes are lowercase alphabetic sequences allocated within one epoch and
  logical round.
- Legacy failures derive their historical epoch and pending logical round from their
  timestamp relative to supersessions and completed rounds, not from a matching HEAD.
- A completed same-HEAD round before a failure advances that failure to the next pending
  logical round; a completed same-HEAD round after a failure does not.
- Persisted explicit coordinates remain authoritative after validation; derived legacy
  coordinates remain stable when later epochs are added.
- Persisted supersession boundaries are nondecreasing. Explicit attempt coordinates must
  equal the epoch, pending round, and suffix derived from the ledger chronology.
- Step-back evidence names epoch-qualified trigger rounds and remains bound to the exact
  historical reviewed trees.
- Status reports active epoch and active completed-round count separately from lifetime
  completed rounds.

### Test-backed cap completion

- Test-backed exits are optional append-only evidence, not independent review rounds.
- The current governing authority must enable the exit, and its effective cap must be reached.
- Only P1-P3 remediation obligations qualify; every open obligation must be covered.
- Missing decisions, deferred findings, unresolved causality, invalid waivers/delegations,
  documentation obligations, and P0 remediation remain blockers.
- Evidence binds exact HEAD, reviewed HEAD, base, and every decision-bearing ledger field.
  Code, review-state, or base changes cannot inherit a test-backed pass.
- The CLI executes recorded commands and checks complete delta/obligation coverage and
  changed regular test files. Semantic coverage, red evidence, and risk remain identified
  implementer assessments, never an independent or mechanically proven judgment.
- A pending attempt is durable before evidence is read; malformed/unreadable evidence,
  interruption, failed checks, or newly
  identified material uncertainty cannot leave an older test pass current.
- Gate output and statistics distinguish test-backed completion from independent review.

## Decision

Continue patching this unit. Removing causal dispositions would discard the workstream
scope control this change exists to provide. Rewriting the ledger would enlarge migration
risk for persisted version 1 evidence without reducing the invariant space. The remaining
defects were narrow boundary omissions in centralized mechanisms:
`dispositionRequiresResolvedCausality` now defines every disposition that needs a resolved
cause, legacy and explicit attempt coordinates are checked against chronology within an
epoch, supersession boundaries are ordered, and the status gate revalidates delegated board
items. Focused tests cover each named boundary, while the full gate covers the surrounding
parser, renderer, status, CLI, and supersession behavior.

## Covered open obligations

- `E1-R3-F1` and `E1-R3-F2`: absent legacy causality cannot escape through
  `tracked-elsewhere`.
- `E1-R3-F3`: a legacy same-HEAD failure after a completed round belongs to the next
  pending logical round.
- `E1-R3-F4`: unknown causality cannot escape through waiver, limitation, tracking, or
  delegation.
- `E1-R4-F1` and `E1-R4-F3`: persisted attempt coordinates and supersession boundaries
  must agree with the ledger chronology.
- `E1-R4-F2`: accepted remediation requires resolved current-workstream causality.
- `E1-R4-F4`: delegated follow-ups remain valid only while their committed board item is
  active and preserves the source finding context.
- `E1-R5-F1` and `E1-R5-F3`: carried delegated follow-ups retain their original source
  identity during status revalidation.
- `E1-R5-F2`: changed causality prevents automatic disposition carry-forward.
- `E1-R5-F4`: an explicit causal-scope marker separates strict new evidence from readable,
  status-blocking legacy dispositions.
- `E1-R6-F1`, `E1-R6-F2`, and `E1-R6-F3`: base supersession resets active review
  mechanics without dropping full-ledger causality and delegated-follow-up status gates.
