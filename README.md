# decently-coordinated-loops

A coordination workflow for humans who steer a fleet of coding agents (across
projects, agent harnesses, and optionally across machines) built on markdown files, git, and agent
skills. No server, no SaaS: your tracker is a private git repo your agents read and
write, and git push atomicity is the coordination primitive.

## The loop

1. **You dump thoughts** into an inbox file, from your editor or your phone.
2. **Agents turn them into board items**: one file per work-stream with a state
   machine (`idea → spec-filed → in-progress → implemented → merged → tested →
   delivered → accepted`), dependencies, and an append-only log.
3. **Agents pick up eligible work unattended:** implement on agent branches,
   request review through whatever mechanism you configure (a forge PR with a
   review bot, another agent, a script), and iterate on feedback.
4. **Branches land on the integration branch:** by you by default, or by agents
   only under the exact review and fast-forward conditions you delegate in house
   rules. Agents detect landings and verify them against your project's gates.
5. **Questions flow back to you** through an outbox file, answerable one line at a
   time, whenever you have a minute.

Everything the fleet needs from you is batched in two files; everything you need
from the fleet is one board. Both trend toward empty.

## Why? - Human attention is the bottleneck

While models and harnesses are becoming better at software engineering work, 
and your own rules and steering files enable your agents to complete larger chunks
of work successfully without your oversight, you're tempted to start more agents
to work in parallel sessions. 
Naturally, the new challenge becomes: How do you keep track of which agent session
is working on what, when are they done and need your input again?
And once you get back to a session that waits on your input, how do you remember 
the context of that workstream so you can unblock the agent with an informed decision
and send it back on its way?

Decently coordinated loops inverts the flow of control. Instead of you bearing the responsibility
for starting parallel agent sessions, assign them work and keep track of their progress,
a central ledger keeps track of all workstreams.

Work can get done multiple ways:
1. You start a new agent session and tell it "pick up workstream x-y-z from the board" - the old fashioned way, you control what the agent is working on.
2. You start a new agent session and tell it "pick up the next item" - you control when work is being done, but you leave it to the agent to pick the workstream.
3. You set up the built-in dispatch schedule - every x hours the agent session will wake up, pick up the next eligible item and work on it until it hits a blocker that needs you attention. It updates the state on the board and goes back to sleep.

In conclusion, you don't write the trivial prompts any more. Your main job is to look at blocked workstreams, make the high-value decisions to unblock the workstream, and let the agents prompt themselves to do the trivial work.


## Where is the documentation?

There is none. You don't need any.
- Start your coding agent of choice in this project
- Ask it
    - "What is this project?"
    - "Install and configure it for me"
    - "How do I start the UI?"
- Your agent will figure it out.


## Two layers

- **This repo (shared, public):** the workflow contract as six agent skills
  (`loops-board`, `loops-queues`, `loops-pickup`, `loops-dispatch`, `loops-review`,
  `loops-setup`), the board tools,
  seed templates, and the installer. Update with `git pull` + `./install.sh`.
- **Your data repo (private, one per user):** the board, items, queues, project
  registry, and your local policy in `HOUSE-RULES.md` (model roster, review
  mechanism, merge policy, extra guardrails), which the generic skills defer to at
  every owner-specific point.

The data repo is plain markdown and JSON, so anything can read it. **decently-tidy-ledger**
is an optional local web UI for browsing one: the board, item detail, and the outbox in a
browser instead of a text editor. It runs on your own machine against a checkout you already
have, and the workflow never requires it.

## Quickstart

Requirements: git, [bun](https://bun.sh) (tools also run under recent node, see
below), and at least one skills-aware agent harness. DCL wires Claude Code, Codex and
Cursor by name, plus the vendor-neutral `~/.agents/skills` tree that other skill-aware
harnesses read; adding another is one entry in `setup/harnesses.ts`.

Linux and macOS are the supported platforms: `install.sh` is bash and resolves paths with
the shell alone, so it needs no GNU coreutils. Windows works under WSL.

Clone this repository, then from its root:

```bash
./install.sh --seed ~/workspace/my-loops --owner Ada --branch main \
  --projects myapp=~/workspace/myapp
```

This links the skills into every destination in `setup/skill-dirs.txt` (today
`~/.claude/skills/` and `~/.agents/skills/`), seeds the
data repo (board, inbox, outbox, registries, house rules), and installs a small
awareness block into your harness's global config so every session knows where the
board lives. Then:

1. Fill in the seeded `HOUSE-RULES.md` TODOs (roster, review mechanism) and your
   projects' gates in `PROJECTS.md`, or ask an agent to interview you for it.
2. Push the data repo to a private remote; origin is the source of truth across
   machines. On a second machine: clone it, then
   `./install.sh --seed <path> --join`.
3. Try it: dump a thought into `INBOX.md`, tell an agent "process the inbox", then
   "pick up the next available piece of work".

## Tools

Run from the data-repo root:

| Command | What it does |
| --- | --- |
| `bun run check` | Report-only integrity check: board vs item files, closed-set validation, version-stamp drift. |
| `bun run sync` | Regenerate `BOARD.md` from the item files, move items between `items/`/`for-delivery/`/`archive/` per state. Lock-guarded and idempotent, so agents can run it freely. |
| `bun run landed [--apply]` | Detect which items' work has landed on the integration branch, via the forge API (`github` adapter) or pure git patch-id comparison (`git` adapter). Recorded `base-sha..head-sha` ranges keep stacked items independent as their branch advances. `--apply` records the landings. |

If the bundled local reviewer is active, run it once from the target project at the
final handoff of a tracked item. `cli-review.ts status --item <item-slug> --data-repo <data-repo>`
verifies that a terminal review round covers the current HEAD, or a descendant whose
intervening commits touch only configured landing-metadata paths, and prints the one-line
evidence agents place in their completion receipt. With opt-in `review.testBackedCapExit`,
`test-cap-exit` can instead verify committed P1-P3 fixes at the cap using regression checks
and the full quality gate, reporting explicitly that the fixes lack independent re-review.
The [loops-review skill](skills/loops-review/SKILL.md) defines evidence and risk requirements.
Pass the same data repo you passed to
`start`: the gate re-resolves the review policy from it to authorize any class waiver, and
a waiver authorized by any other one is refused.

When the owner requests spec finalization, `cli-review.ts draft-start --item <item-slug>
--draft <draft-path> --intent <recorded-decisions-path> --data-repo <data-repo>` uses the
same configured CLI adapters and per-pass model settings on uncommitted snapshots.
JSON findings and a readable report live under `.reviews/drafts/`; `draft-disposition`
records decisions and `draft-status` discloses changed inputs. The default is one round,
and draft review never grants spec approval or an implementation pass.

`BOARD.md` is a derived projection: never hand-resolve its merge conflicts; take
either side and re-run `bun run sync`.

## Design notes

- **Item files are the source of truth**; the board index and folder placement are
  derived. That makes most concurrency races self-healing.
- **Origin is the distributed lock**: a claim or state change is only real once
  pushed; a rejected push means re-read and re-decide. Within one checkout, sync is
  serialized by a lock file.
- **Git primitives, not forge assumptions**: the workflow is defined over agent
  branches, a review mechanism you plug in, and rebase landings. Any git remote works:
  GitHub, Bitbucket, GitLab, AWS CodeCommit, or a bare repository on a machine you own.
  GitHub PRs are one configuration, not a dependency: the default `landedAdapter` is
  `git`, which decides what has landed by patch-id comparison and never calls a forge
  API. The bundled reviewer is forge-free by design.
- **Contracts live in skills, not in your data files**, so `git pull` here
  upgrades every instance on the machine, and your data repo stays pure data plus
  local policy.

## Node instead of bun

The tools use only `node:` APIs. With Node ≥ 22.6 you can run them via
`node --experimental-strip-types <dcl>/tools/cli-check.ts` (Node ≥ 23 needs no
flag); adjust your data repo's `package.json` scripts accordingly. `bun` remains
the tested default.

## License

MIT; see [LICENSE](LICENSE).
