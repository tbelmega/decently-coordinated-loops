# Contributing to decently-coordinated-loops (agent guide)

This file governs work **on this repo itself**. (If you're looking for how to *use*
the workflow, that's the skills under `skills/`.)

## Layout

- `skills/loops-*/SKILL.md` - the workflow contracts. The single source of
  normative text: seeded data-repo files only carry pointers here.
- `tools/` - the board CLIs (`cli-check`, `cli-sync`, `cli-landed`) and their
  library modules. Pure logic is separated from IO boundaries; keep it that way.
- `tools/review/` - the optional local review mechanism: the model-agnostic core
  (ledger, current-HEAD status, lock, atomic write) plus `reviewers.ts`, where each
  reviewer CLI (Codex/Claude/Cursor) is one adapter. Adding a reviewer = one adapter
  + its output-parse tests; the core never names a specific tool.
- `setup/` - `seed.ts`, the config-block writer, and `templates/` for seeded data
  repos.
- `install.sh` - machine wiring (skill symlinks, seed chaining). Bash only.

## Rules

- **Quality gate:** `bun run check` (typecheck + all tests) must be green before
  any commit. New tool logic is written test-first.
- **Runtime compatibility:** production code uses only `node:` imports, with no
  Bun-only APIs (tests may use them; they run under `bun test`).
- **Nothing user-specific, ever.** No personal names, private repo names, tokens,
  or machine paths in code, comments, fixtures, templates, or commit messages.
  Test fixtures use neutral placeholder names. `docs/specs/` is gitignored by
  design; design documents for this repo live in its users' private trackers.

### Test data

Use the shared synthetic identities in `tools/test-identities.ts` instead of copying
names or examples from a real installation. The fictitious owner is `Alice`; projects
are `daybook`, `workboard`, `relay`, and `household-app`; the host is
`workstation-one`; and the representative item slug is
`household-app-slideshow-photo-management`. Keep new fixtures realistic by composing
these identities into the same structural shapes as real entries, never by importing
real operational content.

- **The data contract has readers outside this repo.** `tools/types.ts`, `parse.ts`,
  `validate.ts`, `config.ts`, `preflight.ts` and `outbox.ts` are what a separate tool
  imports to read a data repo without re-implementing the format. Treat their exported
  types and signatures as a public API: adding is cheap, renaming or reshaping is
  breaking and belongs in a tagged release rather than a drive-by edit.
- **Contract changes ripple:** a change to the item schema, states, or file
  formats must update, together: the validator (`tools/validate.ts`), the
  templates (`setup/templates/`), the affected skills, and the tests. The
  `loops-board` skill's States section is the single source of truth for state
  values.
- **Templates match the tools:** `setup/templates/BOARD.md` must be exactly what
  `renderBoardMd` produces for an empty board with default config; the seed e2e
  test relies on it.
- Keep skills tight. Mechanism rules belong in skills; owner-specific policy
  belongs in the seeded `HOUSE-RULES.md` extension points, not hardcoded.
- **Branches in this repository are managed by hand, not by agents.** Commit on the
  branch the worktree you were given is already on, and never create, switch, or
  delete a branch here; that includes the per-item branches the `loops-pickup`
  skill describes for other projects, which this repository does not use. Its
  branches change rarely and never in parallel, so the repository owner does that
  work manually; an agent that adds one leaves cleanup nobody asked for. The
  immutable `base-sha`/`head-sha` range on the tracked item is what separates one
  item's work from the next here.
