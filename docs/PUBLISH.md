# Publishing this repository

DCL is written to be publishable at any time: the working rule is that nothing
user-specific ever enters a tracked file (see AGENTS.md). This checklist is what to do
when a repository that has been developed privately is made public for the first time.
It is a human's checklist, not an agent's - the push itself is always the owner's.

## Prefer a fresh repository over a scrubbed one

Publishing a fresh repository, with the current tree as its first commit, resolves in a
single move everything that history rewriting would otherwise have to chase:

- **Author identity in old commits.** Every commit carries the email configured at the
  time. A fresh repository starts with whatever identity you choose now.
- **Commit messages written for a private audience.** Early messages may name private
  repositories, machines, or people.
- **Local tags and branches.** `review-base/*` tags from the bundled reviewer, and any
  `pickup/*` branches, are working state that no reader needs.

`git filter-repo` is the alternative if the history itself is worth keeping. It is
strictly more work and strictly easier to get wrong: every reachable commit from every
ref has to be rewritten, and anything missed stays published.

## The fresh-repository route

Export the tracked tree of one reviewed commit, and prove that is what you got.
`git archive` writes exactly the tracked files at that commit: no `.git`, no ignored
research or review artifacts, no editor state, no untracked leftovers from the private
checkout. Copying a directory gives none of those guarantees.

```bash
REVIEWED=$(git -C <private> rev-parse HEAD)
mkdir ../public && git -C <private> archive "$REVIEWED" | tar -x -C ../public

cd ../public && git init -q && git add -A

# The equality gate, and it must stop you. The staged tree has to be the reviewed tree
# exactly — same paths, same contents, same modes — so a difference means something
# entered or left the export and nothing should be committed.
test "$(git write-tree)" = "$(git -C <private> rev-parse "$REVIEWED^{tree}")" || {
  echo "tree mismatch: refusing to publish" >&2
  exit 1
}
git commit -qm "Initial public release"
```

Then assert the ref set, and push only what you named:

```bash
BRANCH=$(git symbolic-ref --short HEAD)     # whatever git initialised, not an assumed name

# Exactly one branch, no tags, no refs/replace. Anything else is a ref no reader asked
# for; stop and find out why it exists before pushing.
test "$(git for-each-ref --format='%(refname)')" = "refs/heads/$BRANCH" || {
  echo "unexpected refs present: refusing to publish" >&2
  exit 1
}

# Explicit refspec. Never --all or --mirror: they publish whatever refs exist.
git push origin "refs/heads/$BRANCH:refs/heads/$BRANCH"
```

## Keeping the history instead

This guide does not document a privacy audit for that route, and the omission is
deliberate. A rigorous one has to disable replacement refs, walk every object reachable
from every ref, dispatch each by type to inspect blob bytes and commit and tag metadata,
cover tree path names, notes, stashes and reflogs, and assert an allowed ref set - and
even then it is only as good as the patterns you thought to write. A checklist that
looks thorough but misses one of those is worse than no checklist, because it is trusted.

If you need the history, use `git filter-repo`, and treat auditing the result as its own
piece of work with its own review rather than as a step in a publish checklist. The
fresh-repository route above exists precisely so that this is not the normal path: it
replaces the audit with an equality gate, which is a proof rather than a search.

## Before either push

1. **Check the working tree.** `grep -rniE '<pattern>' . --exclude-dir=.git`
   over personal names, employer names, private repository names, home directory paths
   and hostnames. `docs/specs/` is gitignored by design: design documents with personal
   context live in the owner's private tracker, not here.

2. **Confirm the LICENSE attribution.** `LICENSE` carries MIT plus a copyright line. It
   is deliberate, and it is the one place a personal name legitimately appears - confirm
   it says what you want it to say to a work or public audience before it becomes
   permanent.

3. **Read the README end to end as a stranger.** It is the only document most readers
   will see. Check specifically that the requirements, the supported platforms and the
   list of wired harnesses still match `setup/harnesses.ts`.

4. **Run the gate.** `bun run check` green, and `./install.sh` exercised against a
   throwaway `HOME` if the installer changed.

## After the push

- Consider adding the clone URL to the README's Quickstart. It is left out on purpose
  while the repository is private, because a URL is the one piece of identity a README
  cannot carry generically.
- Point existing machines at the new remote (`git remote set-url origin ...`) and re-run
  `./install.sh` so their skill symlinks still resolve.
