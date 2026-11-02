# Limitation, tracked-elsewhere, and delegated decisions; carried decisions

Loaded from loops-review before you record `accepted-as-limitation`, `tracked-elsewhere`,
or `delegated-follow-up`, or override a carried decision. The CLI refuses a malformed
decision (missing `--doc`, `--tracks`, `--urgency`, or `--owner` where required; a
causality that does not fit the kind; a follow-up item that is missing, uncommitted,
inactive, invalid, or lacks the context lines below). Fix the cause and rerun.

## Delegated follow-up

Only for confirmed `pre-existing` findings. First create or reuse a dedicated active item
under loops-board and commit it, preserving the context in this exact shape:

```text
Review source: `<source-item>#<finding-id>`
Review finding: <finding title>
Review location: `<file>:<line>`
Review evidence: <reviewer evidence>
Review impact: <reviewer impact>
Review direction: <reviewer direction>
```

Use `Review location: Not anchored` without a file location. Then record:

```bash
bun "$DCL_HOME/tools/review/cli-review.ts" disposition --item <source-item> \
  --finding <finding-id> --status delegated-follow-up --causality pre-existing \
  --tracks <follow-up-item> --urgency normal --reason "<brief causal reason>" \
  --data-repo <data-repo>
```

For urgent owner attention, use `--urgency urgent --escalation "<chat/outbox evidence>"`.
Urgency changes escalation, not the current work-stream's review gate. The committed item
is the durable handoff, not a demand for extra proof.

## Accepted limitations

Use when the fix's cost or complexity exceeds the component's documented assurance bar.
The reason must cite that contract. `--doc <repo-relative-path>` names where the
limitation is or will be documented (the component's doc comment or spec); before the
next round it must be a tracked regular file at HEAD. Confirmation checks that its content
honestly covers the finding, not that the defect is fixed. A later round may challenge the
decision if the impact exceeds what the cited contract admits.

P0/P1 limitations need `--owner` and a reason citing the owner's ruling (see loops-review
→ Owner-only authorizations). For unattended P2/P3 limitations, mirror each decision to
an OUTBOX `decision` entry for retroactive ruling under the provisional-decisions house
pattern.

The owner may reverse a limitation with an `accepted` decision, `--owner`, and a reason
citing the ruling. Both decisions stay recorded; the documentation obligation retires and
a fresh remediation obligation replaces it, which earlier `documented` results cannot
satisfy.

## Tracked elsewhere

Use when a correct finding's counterpart fix merges separately, outside this repository's
reviewed range. `--tracks <pointer>` names where: a board item slug, `repo#branch`, or a
path. Never for `introduced`, `worsened`, or `unmet-obligation` findings; those stay this
work-stream's responsibility. It concedes the defect and points at its fix; the decision
stays reviewer context so the finding is not blindly re-raised. When either repository may
merge first, use a runtime precondition: check for the cross-repository counterpart and
hold when it is absent, instead of assuming it exists.

## Carried and changed decisions

An exact repeat of a finding inherits its latest `rejected`, `accepted-as-limitation`,
`waived-by-policy`, `tracked-elsewhere`, or `delegated-follow-up` decision automatically
(`carriedFrom: <prior finding id>`), with that kind's effect and no new obligation.
`accepted` never carries (a re-raise signals regression); `deferred-to-human` never
carries (only the owner closes it).

Override a carried decision with a fresh reasoned decision. Of non-carried decisions, only
`deferred-to-human` (cite the owner's decision) and `accepted-as-limitation` (only the
owner-attributed reversal to `accepted` above) may be superseded. History keeps both.
