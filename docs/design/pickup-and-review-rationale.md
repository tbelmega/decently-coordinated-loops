# Why loops-pickup and loops-review say what they say

Background for maintainers of `skills/loops-pickup/` and `skills/loops-review/`. Agents do
not need this file to run either skill; the skills state each rule on its own terms. This
note keeps the reasons and history that used to sit inside the instructions, so a later
edit can tell a load-bearing rule from an accident.

## How the skills are split

Each skill body holds the core loop plus every guard a model is unlikely to apply
unprompted. Situational procedures live in `references/<topic>.md` beside the skill, each
reached by a one-line trigger that names an observable event (a CLI message, an item
state, a house-rules field) rather than a judgment, because a lax model skips "when
relevant" triggers and a literal model handles event triggers correctly. Where the review
CLI already refuses a mistake with a named error, the skill says so in one line instead of
restating the rule.

Reference files are not discovered instruction files for governance-mode review (only
`skills/<name>/SKILL.md` is); a deliberate rule change to a reference is reviewed as
ordinary prose.

## loops-review

- **Classes by function, not extension.** In a cost analysis of past review rounds, a
  pure-Markdown backup spec produced the highest-value round, and an extension-based
  waiver would have missed a P0 in a runbook. Hence "never `**/*.md` or `docs/**`, never a
  rule file". The configuration validator does not refuse those patterns yet, so the rule
  stays in prose.
- **Fix the finding, file the sweep.** Expanding the re-audited surface inside a fix can
  turn one finding into four the next round. The general operating guide says to fix
  confirmed sibling occurrences in the same change; inside DCL's review loop that would
  grow every round's surface, so the skill states its precedence next to the rule.
- **Scoped confirmation** trades coverage for cost: full confirmation has caught
  regressions outside the fix delta that a scoped round would not see.
- **Step-back freshness.** A note written before the tripwire fired cannot analyze the
  rounds that fired it, so the CLI requires the note to differ from the newer triggering
  round's tree.
- **Owner-only authorizations.** `--max-rounds`, `--owner`, and draft `--authorization`
  are recorded but not verified by the CLI. Spreading that rule over several sections let
  it be missed, so it now has one section of its own.
- **Rebase and carry-over.** A rebase onto a moved integration branch does not reopen a
  passed review; it is recorded as a carry-over so `status` can still pass while reporting
  that the delta was not independently reviewed. Re-reviewing after every integration move
  would spend rounds against the cap for no new information.
- **Round evidence internals.** Each round records a deterministic manifest (reviewable
  files, zero-context hunks, instruction files, stable patch identities, the item and
  linked spec), runs the configured passes independently, validates each pass's coverage,
  and unions findings deterministically. Item-scoped ledgers let a persistent branch carry
  successive items. IDs carry epoch and round (`E1-R1-F1`); legacy `R1-F1` IDs and
  version-1 ledgers stay readable. Legacy failed attempts without routing evidence
  initialize routing once from current config and record that fact without consuming a
  round. Invariants of the ledger itself: `docs/review-ledger-invariants.md`.

## loops-pickup

- **Dependency gate.** The most common way to violate it is a documentation item that
  describes code not yet integrated; it looks low-risk and is not.
- **Concurrency and filesystem protocols at the spec gate.** The review loop's cost grows
  with the size of the invariant space, and a review that runs only after implementation
  cannot gate a design commitment. So the spec must say, in writing, whether a different
  primitive removes the invariant family.
- **Orchestrated legs one step more capable.** Unattended implementation legs have no
  checkpoint between dispatch and the review request, so they are routed one step above
  what attended work would need.
- **Provisional-decision band.** Adopted as a provisional rule, to be reviewed after
  real-world use; an instance's house rules record the ruling that grants it. The band
  itself (at most two cheap-to-reverse calls per item, one-way doors excluded) lives only
  in the skill.
- **House rules win.** Instances legitimately narrow generic mechanics (for example,
  forbidding stacked items in a permanent slot); the skill states the priority once rather
  than enumerating each local exception.
