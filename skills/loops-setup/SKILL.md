---
name: loops-setup
description: Use when the user asks to set up decently-coordinated-loops (DCL), stand up a work-stream board / data repo, or wire a new machine into an existing one
---

# Setting up decently-coordinated-loops

DCL is two layers: the DCL clone (skills + tools + templates, shared) and a private
**data repo** per user (board, queues, registries, house rules). Setup = wire this
machine's harnesses to the DCL clone, then create or join a data repo.

## 1. Ask which case this is

- **New**: no data repo exists yet → seed a fresh one.
- **Join**: a data repo already exists (e.g. this is the user's second computer) →
  clone it from its git remote if not present, then wire this machine to it.
  Join touches no data — it only fills in `package.json` / `.loops-version` if
  missing and installs this machine's agent-config block.

## 2. Run the setup

From the DCL clone root (`bun` required; install from bun.sh if missing):

```bash
# harness wiring (skill symlinks) + seed in one go:
./install.sh --seed <data-repo-dir> --owner <NAME> --branch <integration-branch> \
  [--projects name=path,name=path] [--join]
```

Gather `--owner` (how agents should address the user), `--branch` (default
integration branch, default `master`), and optionally the initial projects
(name=repo-path pairs) from the user before running — the script prompts
interactively otherwise, which an agent can't answer.

The seeding installs a markered `LOOPS:START/END` block into each detected harness
global config (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) carrying the data-repo
path and owner name. Existing files are never overwritten; re-running is safe.

## 3. After seeding

1. Verify: `cd <data-repo> && bun run check` (expect a green preflight).
2. Offer to fill in the seeded TODOs interactively — this is where the instance
   becomes real:
   - `HOUSE-RULES.md`: harness/model roster, review mechanism, merge policy,
     guardrail additions.
   - `PROJECTS.md`: each project's quality gate, verify gate, tracker locations
     (and matching `loops.json` entries: repo path, integration branch, landed
     adapter).
3. For a new repo: have the user add a git remote and push — origin is the source
   of truth across machines.
4. Point the user at the other skills: loops-board (contract), loops-queues
   (inbox/outbox), loops-pickup (unattended work).

## Updating an instance

`git pull` in the DCL clone, re-run `./install.sh`. If the DCL clone moved, also
re-run `setup/seed.ts <data-repo> --join` (or set `DCL_HOME` in the environment to
override the path baked into the data repo's `package.json`).
