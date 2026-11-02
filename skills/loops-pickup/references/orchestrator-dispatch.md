# Orchestrator dispatch

Loaded from loops-pickup when your harness can spawn subagents with a model override and
you are about to dispatch an implementation leg to a worker.

- Claim on behalf of the roster: an item is in reach if any seat in
  `HOUSE-RULES.md → Harnesses & model roster` fits it. Keep choosing, claiming, and board
  work in your own session; dispatch only the implementation leg, routed per the roster.
- Unattended legs get no review between dispatch and the review request, so route them one
  step more capable (a stronger seat or a higher effort) than attended work would need.
- Workers start cold. The dispatch prompt must carry the guardrails: never merge or deploy,
  the outbox contract, blocked means stop, and the target project's branch rules.
- Log every dispatch on the item: worker model, effort, and outcome.
