# Project registry

The indirection layer for per-project locations: agents resolve "where is this
project's repo / specs / follow-ups?" here instead of hardcoding paths. When a
project's tracking moves, update its entry and nothing else has to change.

Machine-read fields (repo path, integration branch, landed adapter, token files)
additionally live in `loops.json` — keep the two in step. The contract for how
agents use this registry is the loops-board skill.

Entry template — copy for each new project:

```markdown
## <project-name>

- repo: `~/path/to/repo`
- integration branch: `master`
- quality gate: `<command(s) agents run before requesting review>`
- verify gate: `<how a merged item is verified — hermetic commands, then functional checks>`
- specs / follow-ups: `<where design docs and follow-up trackers live>`
- review mechanism: `<per-project override of HOUSE-RULES.md's review mechanism, if any>`
- worktrees / branches: `<isolated per item, or permanent slot paths and their persistent base branches>`
- notes: `<credentials and anything else agents must know>`
```

Projects not listed here: register them (repo path + tracker locations) before doing
unattended refinement or cleanup work in them.
