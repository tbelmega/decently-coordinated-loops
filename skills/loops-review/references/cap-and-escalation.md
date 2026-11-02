# Round cap, tripwire, and escalation

Loaded from loops-review when `start` refuses with `review round limit of <n> reached` or
a remediation-churn tripwire, when `status` reports the cap or `cap_exit`, before asking
the owner for anything at a cap, or when you suspect the review mechanism, not your
change, keeps a round from going clean.

## Remediation-churn tripwire

A completed round is *remediation-dominated* when it has findings and strictly more than
half have `origin: remediation`. After two such rounds in a row, `start` refuses until you
pass `--step-back <repo-relative-path>`: a tracked file at HEAD, changed since the newer
triggering round (the CLI checks freshness and names the required contents). The note
contains:

1. The unit's full invariant list, not only invariants findings already named.
2. A reasoned choice: **remove** the invariant family with a different design or
   primitive, **rewrite** the unit with all open obligations as its specification, or
   **continue patching** with justification. Consider removal first: a smaller invariant
   space costs less to review. The loops-pickup spec gate applies the same principle at
   design time to hand-rolled concurrency or filesystem protocols.
3. The open remediation obligations the decision covers.

Keep it in the unit's doc comment or a design note it references, not in the ledger.

## Cap exit

With `review.capExit`, `status` may pass at the reviewed HEAD at the cap with only P2/P3
residual obligations, printing `cap_exit=true residual_obligations=n`. That is a real pass:
disclose the residual obligations in prose instead of escalating. Undecided findings, open
P0/P1 obligations, unconfirmed P0/P1 rejections, and deferred findings still block, and a
changed implementation HEAD still needs review.

## Test-backed cap exit

With `review.testBackedCapExit: true` (global, profile, or project; off by default),
P1-P3 remediation may satisfy the process at the cap without independent re-review.
Reviewer priorities stay unchanged. P0 findings, deferred decisions, unresolved finding
ownership, and documentation obligations do not qualify.

Use it only when relevant fixes and meaningful regression coverage are committed, the
project's mechanical quality gate passes, and no concrete material uncertainty warrants
more review. Match coverage to the defect: a concurrency fix needs interaction evidence,
not a happy-path test. Explain exposure and recovery; generic uncertainty inherent in all
code is not by itself a reason to block.

Record each open obligation, every changed path since the last reviewed HEAD, the new or
changed regression tests, commands, and your assessment of coverage and risk. Original
failing-test evidence must demonstrate the defect where practical; otherwise state why it
was not. Example `.reviews/test-exit.json`:

```json
{
  "fixes": [{
    "obligationId": "E1-R2-F1",
    "summary": "Preserve keyboard focus when closing the dialog",
    "paths": ["src/dialog.ts", "tests/dialog.test.ts"],
    "tests": ["tests/dialog.test.ts"],
    "command": ["bun", "test", "tests/dialog.test.ts"],
    "redEvidence": {
      "kind": "observed-failure",
      "detail": "The new focus-restoration assertion failed before the fix and passes after it."
    },
    "coverage": "Exercises dismissal and verifies focus returns to the invoking control."
  }],
  "qualityCommand": ["bun", "run", "check"],
  "changeSummary": "Only focus restoration and its regression test changed.",
  "risk": {
    "remaining": "No material untested behavior identified; presentation regression remains possible.",
    "exposure": "Dialog users; no persistence or authorization changes.",
    "recovery": "Revert this commit.",
    "materialUncertainty": false
  }
}
```

```bash
bun "$DCL_HOME/tools/review/cli-review.ts" test-cap-exit --item <item-slug> \
  --data-repo <data-repo> --evidence .reviews/test-exit.json
```

Commands are argument arrays run without a shell. Supply the project's real, full
mechanical quality gate, never a substitute chosen to pass. The CLI runs every command,
binds the evidence to the exact HEAD and review state, and refuses incomplete path or
obligation coverage, unchanged or untracked test files, and failed commands.

**Passing checks establish only what they test.** Coverage adequacy, original-failure
evidence, and risk are your assessments; the tool verifies execution and structure, not
semantic correctness. When original-failure verification is impractical, use
`redEvidence.kind: "not-practical"` with a concrete explanation. Never use this exit to
hide unresolved material risk or unassessed unrelated changes.

The exit adds no round and rewrites no decision. Later code, review, or decision changes
void it, as do revoked policy and a raised cap not yet reached; it does not carry through
metadata-only commits or a base change. Report `REVIEW: PASSED (test-backed cap exit;
fixes not independently re-reviewed)` only when `status` prints `test_cap_exit=true`. A
change to DCL's own test-backed-exit code cannot certify itself through this exit; it needs
independent review.

## Escalating an exhausted cap or a deferred finding

Only the owner authorizes rounds past the cap (loops-review → Owner-only authorizations).
Leave the item truthful even if the owner never replies. Offer every applicable exit;
never make more rounds the only option:

| Owner choice | Item state and next action |
| --- | --- |
| Authorize extra rounds | Until authorized: `blocked` / `next-actor: owner` / `awaiting: approve`. Log the approval, then resume with `--max-rounds <n> --authorization "<owner ruling>"`. |
| Decide an outstanding finding | Record `deferred-to-human`; hand over `REVIEW: BLOCKED`, with `blocked` / `owner` / `awaiting: decide`. |
| Waive review and merge as-is | Needs the owner's explicit opt-out. Once given: `implemented` / `owner` / `awaiting: review-merge`, `REVIEW: WAIVED`. |
| Drop the change | `dropped`. |
| Take no action | Keep the accurate blocked state; nothing merges. |

## Cap decision brief

Before asking the owner to extend the cap or waive confirmation, present a short brief in
chat or the outbox; a ledger link alone is not enough:

- **Recommendation and reason.** Is the current work good enough to ship?
- **Unreviewed changes.** Per finding: ID, original priority, defect, implemented fix, and
  affected behavior; plus other changes since the last reviewed HEAD. Separate
  fixed-but-unconfirmed work, unresolved defects, and policy-exempt notes.
- **Verification and remaining risk.** Checks and results and their limits, plausible
  remaining failures, affected users or data, exposure, and recovery. Original severity is
  not automatically the residual risk after a tested fix; keep the priority while
  explaining what uncertainty remains.
- **Value of another round, if recommended.** The specific material question it could
  answer, the evidence still missing, the proposed round budget and scope. Lack of
  re-review alone, or "more review is safer", is not a justification.

Recommend shipping with an explicit waiver when evidence is proportionate to exposure and
no concrete material risk warrants delay but no configured automatic exit applies.
Recommend more review or investigation when a specific consequential uncertainty remains.
Lead with the recommended option; never recommend another round by default. Offer a
smaller scope when a concrete reduction would enable shipping. A waiver is neither a
passed independent review nor deployment authorization.

Example: "Recommend ship with waiver. Focus restoration and label truncation fixes lack
confirming review; both regression checks and the mechanical quality gate pass. Remaining
risk is a presentation regression, with no persistence/auth changes and a practical commit
revert. No identified material question warrants another broad round. Options: ship with
waiver, authorize another round, drop, or leave blocked."

## Suspected mechanism defect

If the review harness misframes the change and further fixes will not resolve that, stop
spending rounds and escalate early. First check whether class waivers (`review.classes`),
governance rewrites (`review.rewrites`), or `tracked-elsewhere` already cover the case.
For a residual mechanism defect, all three apply:

1. Set `blocked` / `next-actor: owner` / `awaiting: decide`. Review stays not-passed and
   nothing merges: suspicion never substitutes for review.
2. Write a diagnosis following the step-back-note pattern, naming concrete harness
   behavior and the supporting rounds and findings. "The reviewer is being difficult" is
   not evidence.
3. File a mechanism-defect board item and an outbox entry. The owner decides whether to
   fix the harness or reject the diagnosis and resume the loop.

For an unexplained rejected attempt, rerun with `LOOPS_REVIEW_DUMP_PROMPT=<directory>` to
capture each pass's exact prompt. Use a directory outside the repo: prompts embed the whole
diff, and a dump inside `.reviews/` would enter the next round's manifest.
