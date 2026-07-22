# decently-coordinated-loops

A coordination workflow for humans who steer a fleet of coding agents — across
projects, agent harnesses, and machines — built on markdown files, git, and agent
skills. No server, no SaaS: your tracker is a private git repo your agents read and
write, and git push atomicity is the coordination primitive.

## The loop

1. **You dump thoughts** into an inbox file — from your editor or your phone.
2. **Agents turn them into board items**: one file per work-stream with a state
   machine (`idea → spec-filed → in-progress → implemented → merged → tested →
   delivered → accepted`), dependencies, and an append-only log.
3. **Agents pick up eligible work unattended** — implement on agent branches,
   request review through whatever mechanism you configure (a forge PR with a
   review bot, another agent, a script), and iterate on feedback.
4. **Branches land on the integration branch** — by you by default, or by agents
   only under the exact review and fast-forward conditions you delegate in house
   rules. Agents detect landings and verify them against your project's gates.
5. **Questions flow back to you** through an outbox file, answerable one line at a
   time, whenever you have a minute.

Everything the fleet needs from you is batched in two files; everything you need
from the fleet is one board. Both trend toward empty.

## Two layers

- **This repo (shared, public):** the workflow contract as six agent skills
  (`loops-board`, `loops-queues`, `loops-pickup`, `loops-dispatch`, `loops-review`,
  `loops-setup`), the board tools,
  seed templates, and the installer. Update with `git pull` + `./install.sh`.
- **Your data repo (private, one per user):** the board, items, queues, project
  registry — and your local policy in `HOUSE-RULES.md` (model roster, review
  mechanism, merge policy, extra guardrails), which the generic skills defer to at
  every owner-specific point.

## Quickstart

Requirements: git, [bun](https://bun.sh) (tools also run under recent node — see
below), and at least one skills-aware agent harness.

```bash
git clone <this repo> && cd decently-coordinated-loops
./install.sh --seed ~/workspace/my-loops --owner Ada --branch main \
  --projects myapp=~/workspace/myapp
```

This links the skills into `~/.claude/skills/` and `~/.agents/skills/`, seeds the
data repo (board, inbox, outbox, registries, house rules), and installs a small
awareness block into your harness's global config so every session knows where the
board lives. Then:

1. Fill in the seeded `HOUSE-RULES.md` TODOs (roster, review mechanism) and your
   projects' gates in `PROJECTS.md` — or ask an agent to interview you for it.
2. Push the data repo to a private remote — origin is the source of truth across
   machines. On a second machine: clone it, then
   `./install.sh --seed <path> --join`.
3. Try it: dump a thought into `INBOX.md`, tell an agent "process the inbox", then
   "pick up the next available piece of work".

## Tools

Run from the data-repo root:

| Command | What it does |
| --- | --- |
| `bun run check` | Report-only integrity check: board vs item files, closed-set validation, version-stamp drift. |
| `bun run sync` | Regenerate `BOARD.md` from the item files, move items between `items/`/`for-delivery/`/`archive/` per state. Lock-guarded and idempotent — safe for agents to run. |
| `bun run landed [--apply]` | Detect which items' work has landed on the integration branch — via the forge API (`github` adapter) or pure git patch-id comparison (`git` adapter). Recorded `base-sha..head-sha` ranges keep stacked items independent as their branch advances. `--apply` records the landings. |

If the bundled local reviewer is active, run it once from the target project at the
final handoff of a tracked item. `cli-review.ts status --item <item-slug>` verifies that a clean review
covers the current HEAD and prints the one-line
evidence agents place in their completion receipt.

`BOARD.md` is a derived projection: never hand-resolve its merge conflicts — take
either side and re-run `bun run sync`.

## Design notes

- **Item files are the source of truth**; the board index and folder placement are
  derived. That makes most concurrency races self-healing.
- **Origin is the distributed lock**: a claim or state change is only real once
  pushed; a rejected push means re-read and re-decide. Within one checkout, sync is
  serialized by a lock file.
- **Git primitives, not forge assumptions**: the workflow is defined over agent
  branches, a review mechanism you plug in, and rebase landings. GitHub PRs are one
  configuration, not a dependency.
- **Contracts live in skills, not in your data files** — so `git pull` here
  upgrades every instance on the machine, and your data repo stays pure data plus
  local policy.

## Node instead of bun

The tools use only `node:` APIs. With Node ≥ 22.6 you can run them via
`node --experimental-strip-types <dcl>/tools/cli-check.ts` (Node ≥ 23 needs no
flag); adjust your data repo's `package.json` scripts accordingly. `bun` remains
the tested default.

## License

MIT — see [LICENSE](LICENSE).
