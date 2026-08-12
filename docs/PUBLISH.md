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

# The equality gate. The staged tree must be the reviewed tree, exactly — same paths,
# same contents, same modes. Any difference means something entered or left the export.
test "$(git write-tree)" = "$(git -C <private> rev-parse "$REVIEWED^{tree}")" || echo MISMATCH
```

Then commit, and assert the ref set before pushing:

```bash
git commit -qm "Initial public release"
git for-each-ref --format='%(refname)'   # expect exactly one refs/heads/<branch>

# Explicit refspec. Never --all or --mirror: they publish whatever refs exist.
git push origin refs/heads/main:refs/heads/main
```

## Auditing history, if you keep it

Only needed on the `git filter-repo` route. Set the environment variable rather than
passing a flag, so nested invocations inherit it — a replacement ref substitutes a
sanitised commit for the raw one, which means an audit that honours replacement is
auditing the wrong history.

```bash
export GIT_NO_REPLACE_OBJECTS=1
PATTERN='<your names, hosts, employer, private repo names, home paths>'

# 1. The ref set. refs/replace/* must be empty; anything outside the branches and tags
#    you mean to publish is a ref a reader was never meant to receive.
git for-each-ref --format='%(refname) %(objecttype)'

# 2. Every reachable object, dispatched by type. Blob bytes and tag/commit metadata are
#    where private data actually lives; a listing of object ids proves nothing.
git rev-list --all --objects --no-object-names | sort -u |
  while read -r sha; do
    case "$(git cat-file -t "$sha")" in
      blob)   git cat-file blob "$sha"   | grep -niE "$PATTERN" | sed "s|^|blob $sha: |" ;;
      commit) git cat-file commit "$sha" | grep -niE "$PATTERN" | sed "s|^|commit $sha: |" ;;
      tag)    git cat-file tag "$sha"    | grep -niE "$PATTERN" | sed "s|^|tag $sha: |" ;;
    esac
  done

# 3. Path names, which travel in the trees whether or not any blob matches.
git rev-list --all --objects | grep -iE "$PATTERN"

# 4. Identities, author and committer both.
git log --all --format='%an <%ae>%n%cn <%ce>' | sort -u

# 5. The things that are not commits: notes, stashes, reflogs.
git notes list 2>/dev/null; git stash list; git reflog --all | head
```

A clean run means the patterns found nothing. It does not mean nothing is there: the
audit is only as good as `PATTERN`, which is the honest reason to prefer the fresh
repository above.

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
