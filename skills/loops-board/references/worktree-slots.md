# Permanent worktree slots

The default branching policy for every registered project. Load this before you touch
branch state for a work-stream, attended or unattended. Where `HOUSE-RULES.md` or the
project's `PROJECTS.md` entry differs, they win.

## The model

- **No per-item branches.** No feature branches, no per-item pickup branches, no ad-hoc
  branches. Work happens in permanent worktrees ("slots"), each on one fixed branch that
  is reused from work-stream to work-stream: worktree `.worktrees/<host>-<tool>-<n>`,
  branch `agents/<host>-<tool>-<n>` (`<tool>` is the harness, such as `claude` or
  `codex`). Purpose worktrees on other branches (deploy checkouts, data-repo lanes) are
  not slots.
- **One work-stream per slot at a time.** Never stack a second unmerged item on a slot.
- **The host in the name owns the slot and is its only writer.** It pushes the branch for
  backup and visibility; other hosts may fetch and inspect it but never commit to,
  rebase, reset, force-push or delete it. Because no one else shares the branch, the
  owner may rebase it onto the integration branch and push it `--force-with-lease`.
- **Opt-out.** A project whose `PROJECTS.md` entry says it works in the main checkout
  has no slots: work there, on the integration branch, and skip the rest of this file.

## Choosing a slot

If the session started inside a slot, that is your slot (work where you were started):
claim and sync it as below. Otherwise, from the data repo root:

    bun <DCL>/tools/cli-slots.ts --project <name> --host <host> --tool <tool> [--item <slug>]

It fetches, lists this host's slots of the project, and prints `FIRST_IDLE=` and
`NEXT_FREE=`. Only exact `<host>-<tool>-<n>` worktrees under `.worktrees/` count. A slot is
idle when its working tree is clean, no active board item records it as
`execution.worktree`, and its content is already on the integration branch (a squash
merge counts). A clean slot can still have a live session in it that has not edited
anything yet, which is why the owner confirms. The tool's verdict is the only evidence of
idleness: never infer it from ahead/behind commit counts (`git status`, `git rev-list`, a
fleet sweep). Being behind is irrelevant, and commits ahead may already be on the
integration branch through a squash; the tool checks content with a dry-run merge that
leaves the slot branch and working tree untouched, so no rebase is needed to find out.

- **An idle slot exists:** tell the owner which worktree and branch you picked and ask
  them to confirm it. On a no, ask which slot to use instead, or offer the next free name.
- **None is idle:** tell the owner the next free name and offer to create that slot. On
  their yes:

      git -C <repo> worktree add <repo>/.worktrees/<name> -b agents/<name> <integration-ref>
      git -C <repo>/.worktrees/<name> push -u origin agents/<name>   # when origin exists

  If the project does not ignore `.worktrees/`, add it to `<repo>/.git/info/exclude`
  rather than changing the project's `.gitignore`.
- **Unattended (no one to confirm):** claiming the item stands in for the confirmation,
  so take the first idle slot. With none idle, create nothing: take the next candidate
  item instead, and file one outbox `proposal` (loops-queues) to create the next free slot
  for that project, unless an open entry already proposes it.

## Claiming the slot

Before syncing or editing anything in it, record the slot on the board; this goes with the
item claim:

1. `git pull --rebase` in the data repo, then rerun `cli-slots.ts` with
   `--item <your-slug>` (so your own claim does not count). If the slot is no longer idle,
   choose again.
2. Record the slot's absolute path as the item's `execution.worktree` (with
   `execution.host`; `links.branch` is the slot branch), commit, and push. On a rejected
   push, go back to step 1.

There is no lock, by design: a lock an abandoned session leaves behind would block its
slot. Exclusivity rests on one operator starting sessions minutes apart, not in the same
second (and dispatchers on one host firing staggered). A session that claimed a slot
minutes earlier shows in it: its board claim, its commits, or its uncommitted changes, any
of which makes the slot not idle for the next session. Claim before you sync, and treat a
slot with fresh uncommitted changes as taken, even when no board item names it.

## Syncing a slot

After claiming it, and at the start of every later session in it, before reading code or
planning. Decide before changing anything:

1. `git fetch origin`.
2. **Uncommitted changes are unfinished work:** never stash, commit or discard them; stop
   and report as in step 4.
3. Run `cli-slots.ts --item <your-slug>`. **The slot is idle:** all of its content is
   already integrated, so rebasing it onto the integration ref comes down to
   `git reset --hard <integration-ref>` (safe: the tree is clean and nothing on the
   branch is missing from the integration ref). Start the new work.
4. **Otherwise, stop and report before building, with the branch untouched.** List each
   commit in `git log <integration-ref>..HEAD` and any uncommitted changes, with the
   work-stream each belongs to where you can tell (a board item whose recorded range or
   ticket matches). Some of those commits may already be integrated through a squash; when
   step 3 ran, the tool's reasons say what keeps the slot busy. Ask the owner whether to build on top, use another slot, or merge it
   first; never choose for them. Unattended, leave the slot alone and choose another.
   Exception: resuming your own item recorded in this slot, continue it; it is rebased
   at its pre-review step like any work-stream.

## After review

When the merge policy lets you integrate, fast-forward the integration branch to the slot
tip (loops-pickup's `references/integration.md`), push it, record the merge, and leave the
slot branch and the integration branch at the same commit. When the owner merges, leave
the slot as it is; the next session's sync finds it merged.
