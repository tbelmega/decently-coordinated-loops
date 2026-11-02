# Verifying an integrated item

Loaded from loops-pickup when the chosen item is `merged`. Such items are agent-owned and
pre-approved for unattended verification; a full pass flips the item to `tested` and moves
it out of the owner's working set.

**Single verifier, batched.** Never run two verifiers in parallel. Claim all eligible
`merged` items at once (one claim), build the integration branch once for the batch, then
exercise each item's functional checks in sequence. Verification exercises the integration
branch head, not each integration in isolation; later integrated changes being present is
fine.

Concrete commands and checks come from the project's `PROJECTS.md` verify-gate entry,
decomposed by environment dependency:

1. **Immediately on pickup:** the project's hermetic verification, starting with its
   mechanical quality gate (build plus unit and integration suites: no credentials,
   nothing deployed). This is the bulk of the confidence. Record the result on the item.
2. **Environment-dependent checks** (a deployed dev or staging environment, a live probe):
   run them only when that environment actually has the change. If it does not yet, record
   "hermetic verification passed: functional check pending next deploy" and **hold the
   item at `merged`**; the next verification pickup re-checks. Items with no
   environment-dependent check complete immediately.
3. Only when every applicable check passes, flip `merged → tested` (the next `bun run sync`
   moves the file). You never deploy. Where the project declares `lifecycle: "no-deploy"`
   (loops-board → States), `tested` is terminal: write `next-actor: agent`, no `awaiting`,
   and a terminal `next-step`; sync archives it.

**Evidence and honest failure.** Flipping to `tested` needs evidence in the item's
`## Log`: a one-line gate summary (what ran, counts) and what was functionally exercised.
A failed check never yields `tested`: set the item `blocked` (or file a fix follow-up
item) with the failure captured. Never weaken a check to get to green.
