# Tracker sync

Read this when the owner asks to sync a tracker ("sync the tracker"), when inbox
processing pulls a tracker, or before any `tracker-sync` subcommand other than `status`.
The shared-state rules in loops-board → External trackers (never create or split a
ticket on your own initiative, never reverse a human's move without the owner's direct
prompt, link on content only by proposal) apply throughout.

## The model

One tracker definition (`loops.json → trackers.<name>`) is shared by every project that
names it, so two projects cannot disagree about its lifecycle map. A small work-stream is
often not worth a collaborator's attention (`tickets: local`), a medium one maps to a
ticket, a large one to several, and one ticket may serve several items.

**Status push.** `bun run tracker-sync status` only ever moves a ticket forward, leaves a
ticket in a status the map does not name exactly where it is, and records what it did not
do as a line on the item. A credential that is present but rejected, or an unreachable
API, fails that tracker's run, leaves the board untouched, and files one outbox entry;
nothing syncs until it is fixed. A host that holds no credential for the tracker at all
(token file absent, `gh` not authenticated) skips it quietly in every phase.

**Backlinks.** Each linked ticket carries its references back: the board slug and, once
the item is `in-progress` or later (or `blocked`) with `links.branch` or `links.pr`, the
review URL or branch, never a worktree path or host. They live in the board text fields a
GitHub tracker names under `backlink` (`slugField`, `branchField`), else as `DCL: <slug>`
and `DCL branch: <ref>` lines at the end of the ticket description. Both follow board
state, so the status push keeps them current. A description write replaces the whole body
and GitHub cannot make it conditional, so a collaborator's edit saved in the same moment
is overwritten (it stays in the issue's edit history); configure both backlink fields to
avoid that.

**Agents without tracker access** advance work-streams on the board as usual and record
nothing extra: every tracker write is derived from board state, and the next sync by any
host with access applies the backlog in bulk. There is no separate queue of tracker
updates.

## Sync ("sync the tracker")

Run the phases in order, each first as a dry run, from the data repo:

1. **Status push** - `bun run tracker-sync status --apply`, as above.
2. **Pull** - `bun run tracker-sync pull` lists every open ticket on the board that no item
   in any folder names and whose backlink names no item. A ticket whose URL an item quotes,
   or whose backlink names an item, is linked to it mechanically; every other one is filed
   as a `supervised` `idea` carrying the ticket's description and comments verbatim. Before
   `--apply`, look for existing items that plausibly cover each ticket to be filed (the
   output flags items that mention the bare number; also judge titles and content). A
   content match is never linked on judgment: attended, put it to the owner in the
   interview below and, on a yes, `bun run tracker-sync link <item-slug> <ticket-id>`
   before applying; unattended, let the pull file the idea and add one outbox `proposal`
   naming the candidate item. Then `bun run tracker-sync pull --apply` and `bun run sync`.
   The pull's only tracker write is the backlink, which is what stops a re-pull.
3. **Reconcile** - `bun run tracker-sync reconcile` lists every ticket whose status,
   open/closed state or presence disagrees with its items in a way the forward-only push
   will not settle, each with a recommendation for both sides. Attended, interview the
   owner one ticket at a time (loops-queues interview format: the ticket and item side by
   side, then the recommendation) and apply each answer in the same run: board changes on
   the item, tracker changes with `bun run tracker-sync set <tracker>/<id> --status <name>`
   (or `--close` / `--reopen`) `--apply`. The owner's answer is the direct prompt that
   permits moving a ticket against the push. Unattended runs never interview: they run
   `bun run tracker-sync reconcile --record`, which writes each mismatch the status push
   does not already note as a dated line on its items (idempotent, no outbox entry, no
   tracker change), and the next attended sync collects those lines.

## Commands

- `bun run tracker-sync status [--tracker <name>] [--apply]` - project board state onto
  the tickets its items name: forward-only transitions, plus the slug and branch
  references on each ticket. Prints a plan and writes nothing without `--apply`.
- `bun run tracker-sync pull [--tracker <name>] [--project <project>] [--apply]` - file
  every open, unlinked ticket as an `idea` item (phase 2).
- `bun run tracker-sync reconcile [--tracker <name>] [--record]` - list mismatches
  between linked tickets and their items, with recommendations; `--record` notes each on
  its items instead (unattended runs).
- `bun run tracker-sync set <tracker>/<id> (--status <name> | --close | --reopen)
  [--apply]` - one ticket change, only on the owner's direct answer.
- `bun run tracker-sync link <item-slug> <ticket-id>` - add a ticket to an item's
  `tickets` (board side only; the next status push writes the backlink).
- `bun run tickets <item-slug>` - the commit reference for that item's tickets: the
  subject suffix and, where the tracker needs one, the body line that links the commit
  without moving the ticket. Copy it rather than composing it.
