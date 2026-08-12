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

1. **Scan every commit reachable from all refs, not a fixed number of recent ones.**
   The count of commits needing attention is not knowable in advance, so scan the set:

   ```bash
   git log --all --format='%an <%ae>' | sort -u          # identities
   git log --all --format='%H %s%n%b' | grep -niE '<pattern>'   # private names, paths, hosts
   git tag -l; git branch -a                             # working refs that should not ship
   ```

   Whatever the scan turns up decides whether a fresh repository is required or merely
   preferable.

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
