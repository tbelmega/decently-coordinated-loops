# Carry-over, changed review base, and landing metadata

Loaded from loops-review when HEAD moved after a passed review, when the integration
branch moved under the item, or before committing `review.metadataPaths` files.

## Carry-over

When HEAD moved past a passed review without changing reviewed behavior, record that
judgment instead of reporting a green review as blocked:

```bash
bun "$DCL_HOME/tools/review/cli-review.ts" carry-over --item <item-slug> \
  --data-repo <data-repo> --reason "<why the move changes no reviewed behavior>"
```

It qualifies for a rebase onto a moved integration branch, an ignore file, metadata,
comments, and formatting. A behavior change, a test change, or a fix for a finding needs a
real round. The CLI cannot tell a behavior change from a trivial one: that judgment, and
the honesty of `--reason`, are yours.

The CLI refuses unless the tree is clean, the latest round's HEAD still passes, and no
review attempt failed since that round. It computes the delta files itself (files whose net
patch differs from the reviewed one, so a pure rebase records none). `status` then passes
with `carried_from=<reviewed-sha> carried_files=<n> independently_reviewed=false`. Each
carry-over is measured against the reviewed HEAD, so a later commit needs a new carry-over
that replaces the previous one; a newer round supersedes them, and a failed attempt since
the round voids them until the next round. Report `REVIEW: PASSED (carried over from <sha>;
<the delta in plain words>; not re-reviewed)`.

## Changed review base

After rebasing onto a moved integration branch, rerun the mechanical quality gate and
`start` with the same symbolic `--base` (it must be an ancestor of HEAD). When the review
had already passed, a rebase does not reopen it: record a carry-over instead, unless
resolving a conflict changed reviewed code. When a round is needed, the CLI picks the kind:

- **Patch-equivalent rebase:** the ledger is kept, and integration and adversarial passes
  cover the new-base delta and its intersections with reviewed files. Refused at the cap.
- **Changed patch series:** prior evidence is snapshotted and the base superseded: coverage,
  manifests, and findings reset for rediscovery, while every decision, typed obligation,
  and tripwire state is kept. A new epoch starts at round 1; earlier epochs stay history
  and do not consume its cap. Refused while any finding is undecided or deferred, or an
  accepted finding awaits confirmation at the same HEAD.

## Landing metadata

Finish code review before committing `review.metadataPaths` files. `status` keeps a pass
through later commits that touch only those paths (it checks ancestry and the persisted
patterns itself). Any other change stales review unless carried over. These paths are for
bookkeeping such as landing pointers, never implementation.
