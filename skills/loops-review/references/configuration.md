# Review configuration, change classes, and scoped confirmation

Loaded from loops-review when you edit `loops.json → review`, or when a CLI message names
configuration, classes, alternatives, personas, profiles, or confirmation scope. Driving
an ordinary review never needs this file. Configuration is validated at load and fails
closed with a named error.

## Schema

Set `loops.json → review` in the data repo:

```json
"review": {
  "reviewer": "claude",
  "model": "<optional model id>",
  "effort": "<optional effort>",
  "alternatives": [
    {"when": {"harness": "codex", "model": "gpt"}, "reviewer": "claude", "model": "opus", "effort": "high",
     "personas": {"confirmation": {"model": "sonnet"}}}
  ],
  "maxRounds": 5,
  "auditPasses": ["diff", "integration", "adversarial"],
  "metadataPaths": ["docs/landing-state.md"],
  "confirmation": "full",
  "classes": [
    {"name": "bookkeeping", "match": [".reviews/**", "BOARD.md"], "waivablePriorities": ["P3"]},
    {"name": "coordination-prose", "match": ["OUTBOX.md"], "waivablePriorities": ["P2", "P3"],
     "guidance": "Report only factual errors, broken references, and contradictions with reviewed behavior; no wording improvements."}
  ]
}
```

| Key | Meaning and default |
| --- | --- |
| `reviewer` | Installed `codex`, `claude`, `cursor`, `grok`, `opencode`, or `kiro` CLI. `bun run setup` detects installed CLIs and offers configuration. |
| `model` | Optional; defaults to the reviewer CLI's model. |
| `effort` | Optional; forwarded by every reviewer but Cursor (OpenCode receives it as `--variant`). Cursor does not support effort in alternative-selected tuples. |
| `alternatives` | Ordered reviewer replacements selected by literal, case-sensitive implementer identity prefixes; no match keeps the default tuple. |
| `maxRounds` | Positive integer; defaults to 3. |
| `auditPasses` | Non-empty subset of the three example passes; defaults to all three. |
| `metadataPaths` | Safe repo-relative exact paths or recursive `directory/**` patterns for landing bookkeeping; omit when none. |
| `classes` | Optional policy waivers (below). |
| `confirmation` | `"full"` by default; `"scoped"` narrows eligible confirmation rounds (below). |
| `severityFloor` | Optional (`"round-2-plus"` or `"all-rounds"`); may produce P2/P3 notes that need no decision or obligation (`residual_notes=n` in `status`). |
| `terminalRejection` | Optional; rejected P2/P3 findings need no clean confirmation round. Rejected P0/P1 still do. |
| `capExit` | Optional; `status` may pass at the cap with only P2/P3 residual obligations (loops-review `references/cap-and-escalation.md`). |
| `testBackedCapExit` | Optional, off by default; permits the test-backed cap exit (same reference). |

Apply configured exceptions only.

The keys above may be overridden under `projects.<name>.review`: fields merge, but lists
replace wholesale (an override of `classes` or `alternatives` supplies its complete set;
`alternatives: []` disables inherited alternatives). The project is resolved by matching
the reviewed checkout to `projects.*.repo`, never by item slug. Profile definitions
(`review.profiles`) are global-only; a project may select one with `review.profile`. The
CLI refuses a mid-review profile change; supersede the base to change it.

Alternatives combine fields inside one `when` with AND, use separate entries for OR, and
stop at the first match. `when` accepts non-empty `harness`, `model`, and `effort`
prefixes. A selected alternative replaces reviewer, model, and effort across every active
persona; omitted model or effort uses the selected adapter's default. Its optional
`personas` map, keyed by pass name (`diff`, `integration`, `adversarial`, `confirmation`),
overrides that tuple for the named pass only, field by field. `--reviewer`, `--model`, and
`--effort` override the final selection field by field for one run.

A retry of a failed attempt reuses that attempt's saved pass tuples, so a configuration
edit does not change its reviewer; explicit reviewer, model, or effort flags still
override and are recorded as intentional changes. A new logical round resolves the
current alternatives again.

## Change classes and policy authority

Classes waive eligible findings, never files or whole review ranges. With no configured
class, every finding needs a decision and every changed file is reviewed.
`waivablePriorities` lists the waivable priorities; optional `guidance` steers the reviewer
but enforces nothing. Priority belongs to the independent reviewer.

**Draw classes by function, never by extension.** Ask: *would an error change what a
person or machine does next?* If yes, the surface takes full review: code, scripts,
machine-read config, and executable prose such as runbooks, specs, skills, and procedures.
Only record-keeping output is waivable: review evidence, derived boards, logs. Never put
`**/*.md` or `docs/**` in a class, and never put a rule file (`AGENTS.md`, `CLAUDE.md`,
`skills/<name>/SKILL.md`) in one: their prose directs action. The configuration validator
does not refuse these, so this rule is yours to keep.

`waived-by-policy` needs `--class <name>`, a file anchor matching that class, and a
priority it permits; when several classes match, every match must waive that priority.
The CLI refuses otherwise. A waiver says this surface does not warrant another round at
this priority; it does not say the finding is wrong.

Pass the same `--data-repo` (or `LOOPS_DATA_REPO`) used at `start`; `waived-by-policy`
and `delegated-follow-up` require it. The first round binds policy authority to the
canonical data-repo root and resolved project, permanently. `disposition` and `status`
refuse waivers from another repo or project, or with missing authority, and revalidate
every waiver against the resolved configuration at every gate: narrowing or removing a
class invalidates earlier waivers. Apply the owner's configured waiver authority; never
invent your own.

## Scoped confirmation

`review.confirmation: "full"` reruns every configured pass over the whole range.
`"scoped"` applies only when the previous round has every finding decided, only
remediation obligations remain, and there is a fix delta; the CLI then runs only the
obligation-classifying pass on that delta, skipping integration and adversarial passes,
and records `scope: "remediation-range"`. It no longer looks for regressions outside the
fix delta: never claim coverage the round did not obtain.
