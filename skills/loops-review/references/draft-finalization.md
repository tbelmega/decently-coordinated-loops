# Draft specification finalization

Loaded from loops-review when the owner asks to finalize a settled draft spec (or
explicitly requests its review). Not while exploring the design: finalization authorizes
review and relevant editing; it does not approve the spec or authorize implementation.

Run **one independent review round, then relevant fixes**. Give the reviewer the exact
draft and the recorded outcome, scope, decisions, constraints, and open questions; it
checks contradictions, omissions, feasibility, and consistency with that intent. Use the
configured **reviewer CLI**, never a native subagent substitute. Run from the target
project's checkout with an existing board item of that project. Draft and intent paths may
be outside the checkout or uncommitted:

```bash
bun "$DCL_HOME/tools/review/cli-review.ts" draft-start --item <item-slug> \
  --draft <draft-path> --intent <recorded-decisions-path> --data-repo <data-repo> \
  --implementer-harness <harness> --implementer-model <model> \
  --implementer-effort <effort>
bun "$DCL_HOME/tools/review/cli-review.ts" draft-disposition --item <item-slug> \
  --finding D1-F1 --status addressed --reason "<what changed within agreed intent>" \
  --data-repo <data-repo>
bun "$DCL_HOME/tools/review/cli-review.ts" draft-status --item <item-slug> \
  --data-repo <data-repo>
```

Reviewer selection uses the same configuration as implementation review; `--reviewer`,
`--model`, and `--effort` override it for one run. Supply the identity of the model that
produced the draft on each `draft-start` (as in loops-review → The loop); it is recorded
per attempt because the responsible model can change between revisions. All personas of
a round together consume one round. Findings and decisions are recorded in
`.reviews/drafts/<item>.json` with a Markdown companion. Decisions are `addressed`,
`rejected`, or `deferred-to-human`; record reasons, and leave questions about intent
deferred until the owner decides.

Do not commit or promote a draft merely to obtain review. Report an unavailable CLI or a
failed attempt honestly and recover with that CLI; failed attempts consume no round.
`draft-status` distinguishes reviewed, changed, failed, and not-run evidence and always
reports `approved=false`. Edits after review are allowed and disclosed as changed inputs.

**Findings do not authorize changes to intent.** Fix wording, internal inconsistencies,
and technical errors only when the correction preserves agreed behavior and constraints.
Changes to scope, user-visible behavior, cost, or an agreed tradeoff need an owner
decision. When unsure, surface the question and continue unrelated safe fixes. Example:
reconcile two contradictory timeout values when a recorded decision fixes the value; do
not add retries because a reviewer recommends them.

Do not automatically re-review the edits. The default draft cap is one round, independent
of the implementation cap. Another round needs the owner's authorization, justified by a
concrete unresolved issue (not merely the absence of confirmation); record it with
`draft-start --max-rounds <n> --authorization "<owner ruling>"`. The CLI refuses a raised
cap without `--authorization` but cannot check that the string is a real ruling: passing
one the owner did not give fabricates an authorization.

Return the draft with a short account of substantive changes, remaining questions and
risks, and which edits lack re-review. Keep it marked Draft and request the owner's
explicit approval. The owner may resolve questions, approve, request another round,
continue drafting, or stop; no action leaves the draft unapproved.

This is advisory design review, separate from the implementation review gate and its
ledger, round budget, pass status, and test-backed exit. A reviewed draft never yields an
implementation pass and never waives the later implementation review. Only explicit owner
approval permits promotion to an approved spec; follow the project's promotion rules.
