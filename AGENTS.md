# Contributing to decently-coordinated-loops (agent guide)

This file governs work **on this repo itself**. (If you're looking for how to *use*
the workflow, that's the skills under `skills/`.)

## Layout

- `skills/loops-*/SKILL.md` — the workflow contracts. The single source of
  normative text: seeded data-repo files only carry pointers here.
- `tools/` — the board CLIs (`cli-check`, `cli-sync`, `cli-landed`) and their
  library modules. Pure logic is separated from IO boundaries; keep it that way.
- `tools/review/` — the optional local review mechanism: the model-agnostic core
  (ledger, lock, atomic write) plus `reviewers.ts`, where each reviewer CLI (Codex/
  Claude/Cursor) is one adapter. Adding a reviewer = one adapter + its output-parse
  tests; the core never names a specific tool.
- `setup/` — `seed.ts`, the config-block writer, and `templates/` for seeded data
  repos.
- `install.sh` — machine wiring (skill symlinks, seed chaining). Bash only.

## Rules

- **Quality gate:** `bun run check` (typecheck + all tests) must be green before
  any commit. New tool logic is written test-first.
- **Runtime compatibility:** production code uses only `node:` imports — no
  Bun-only APIs (tests may use them; they run under `bun test`).
- **Nothing user-specific, ever.** No personal names, private repo names, tokens,
  or machine paths in code, comments, fixtures, templates, or commit messages.
  Test fixtures use neutral placeholder names. `docs/specs/` is gitignored by
  design — design documents for this repo live in its users' private trackers.
- **Contract changes ripple:** a change to the item schema, states, or file
  formats must update, together: the validator (`tools/validate.ts`), the
  templates (`setup/templates/`), the affected skills, and the tests. The
  `loops-board` skill's States section is the single source of truth for state
  values.
- **Templates match the tools:** `setup/templates/BOARD.md` must be exactly what
  `renderBoardMd` produces for an empty board with default config — the seed e2e
  test relies on it.
- Keep skills tight. Mechanism rules belong in skills; owner-specific policy
  belongs in the seeded `HOUSE-RULES.md` extension points, not hardcoded.
