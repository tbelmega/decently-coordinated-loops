# Permanent worktree slots

Loaded from loops-pickup when the project's `PROJECTS.md` entry or `HOUSE-RULES.md`
documents permanent slots, before you touch branch state. Where house rules forbid stacking
items in a slot, they win: follow them instead of the stacking below.

## Acquire the slot

Run the integration-status check (`bun run check-integration-status`) before changing
branch state. Branch position by itself is never the cleanup proof.

- Delete a local named stack branch only after its exact `base-sha..head-sha` range
  reports LANDED and that integration is recorded on the board. Switch away from the
  branch first. A rebase-shaped integration may require `git branch -D`; use it only with
  both the exact LANDED result and the board record. Keep remote branches unless project
  policy says they are disposable.
- When the whole stack is integrated, return the worktree to its persistent base branch
  and bring that branch level with the integration branch.

## Place the item in the slot

Resolve the worktree's persistent base branch and its active board items.

- **No unmerged item:** work on the persistent branch and save its starting commit as
  `base-sha`.
- **One or two unmerged items:** create `<base-branch>--<item-slug>` from the current stack
  tip, record the tip item as `stack-parent`, and save that parent's `head-sha` as the new
  `base-sha`.
- **Three unmerged items:** the slot is full; choose another slot or project.
- Unrecorded commits ahead of the integration branch make the slot occupied until they are
  identified or parked.
