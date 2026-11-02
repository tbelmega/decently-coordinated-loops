# Fast-forwarding a reviewed item onto the integration branch

Loaded from loops-pickup when `HOUSE-RULES.md → Merge policy` explicitly delegates
integration to agents and the item's review has passed. Without that delegation, stop with
the owner-owned `review-merge` state; never integrate.

1. **Refresh the integration ref after review.**
2. **Stacked child:** it never carries integration authority for its parent. While
   `links.stack-parent` is not integrated, leave the child at `implemented` and wait. Once
   the parent is integrated, replay only the child's recorded range with
   `git rebase --onto <integration-head> <base-sha> <working-branch>`; never a normal
   rebase, which could replay the parent too. Rerun the mechanical quality gate, carry the
   passed review over (loops-review → Carry-over; a fresh round only when resolving a
   conflict changed reviewed code), and update the recorded `base-sha` and `head-sha`.
3. **Compare integration with the reviewed base.**
   - **Unchanged:** prove the reviewed base is an ancestor of the reviewed head with
     `git merge-base --is-ancestor <base-sha> <head-sha>`, then compare-and-swap the
     remote ref:
     `git push --force-with-lease=refs/heads/<integration>:<base-sha> origin <head-sha>:refs/heads/<integration>`.
     The exact lease rejects deletion, rollback, or concurrent movement without touching
     another worktree; the ancestry check makes the update fast-forward-only. Never use a
     broad lease, `--force`, or a non-fast-forward update. A project may instead require
     an equivalent locked local `git merge --ff-only` followed by a push.
   - **Moved:** rebase onto the new integration head and rerun the mechanical quality
     gate. A rebase does not reopen review: record a carry-over (loops-review →
     Carry-over). Only a conflict resolution that changed reviewed code needs a fresh
     round. Then repeat this comparison.
4. **After a successful fast-forward:** run `bun run check-integration-status --apply`,
   sync, commit, and push the resulting `implemented → merged` board update, then take the
   item straight through loops-pickup → "Verify an integrated item".
