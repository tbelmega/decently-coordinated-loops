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

## Before the push

1. **Audit objects, not commit messages.** A message-only scan misses most of what a
   repository publishes. Committer identities differ from author identities, historical
   file *content* and *path names* travel with the trees, notes and annotated tags carry
   their own text, and `refs/replace/*` can substitute a sanitised commit for the raw one
   an audit would otherwise read. So: disable replacement, walk every object reachable
   from every ref, and check each by type.

   ```bash
   # Identities, from every commit, with replacement disabled.
   git --no-replace-objects log --all --format='%an <%ae>%n%cn <%ce>' | sort -u

   # Every reachable object, by type — blobs (file content) and trees (path names) included.
   git --no-replace-objects rev-list --all --objects |
     while read -r sha path; do
       printf '%s %s %s\n' "$(git cat-file -t "$sha")" "$sha" "$path"
     done

   # Content and path search across all of it.
   git --no-replace-objects grep -niE '<pattern>' $(git rev-list --all)
   git --no-replace-objects rev-list --all --objects | grep -niE '<pattern>'

   # The ref set itself, raw, plus the things that are not branches or tags.
   git for-each-ref --format='%(refname) %(objecttype) %(*objectname)'
   git notes list 2>/dev/null; git stash list; git reflog --all | head
   ```

   Validate the ref set explicitly rather than eyeballing `git branch -a`: anything
   outside `refs/heads/<the branches you mean>` and `refs/tags/<the tags you mean>` is
   something a reader was never meant to receive - `refs/replace/*` above all, since its
   presence means the history you just audited is not the history you would push.

   Whatever the scan turns up decides whether a fresh repository is required or merely
   preferable. **A fresh repository makes this entire step moot**, which is the strongest
   argument for it: one commit, one tree, nothing behind it.

2. **Check the working tree the same way.** `grep -rniE '<pattern>' . --exclude-dir=.git`
   over personal names, employer names, private repository names, home directory paths
   and hostnames. `docs/specs/` is gitignored by design: design documents with personal
   context live in the owner's private tracker, not here.

3. **Confirm the LICENSE attribution.** `LICENSE` carries MIT plus a copyright line. It
   is deliberate, and it is the one place a personal name legitimately appears - confirm
   it says what you want it to say to a work or public audience before it becomes
   permanent.

4. **Read the README end to end as a stranger.** It is the only document most readers
   will see. Check specifically that the requirements, the supported platforms and the
   list of wired harnesses still match `setup/harnesses.ts`.

5. **Run the gate.** `bun run check` green, and `./install.sh` exercised against a
   throwaway `HOME` if the installer changed.

## After the push

- Consider adding the clone URL to the README's Quickstart. It is left out on purpose
  while the repository is private, because a URL is the one piece of identity a README
  cannot carry generically.
- Point existing machines at the new remote (`git remote set-url origin ...`) and re-run
  `./install.sh` so their skill symlinks still resolve.
