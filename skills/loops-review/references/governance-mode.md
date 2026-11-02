# Governance mode: changing the rules the reviewer enforces

Loaded from loops-review when the change intentionally rewrites an instruction file
(`AGENTS.md`, `CLAUDE.md`, a skill), or when `start` names `review.rewrites`.

Discovered instruction files are a mandatory compliance checklist: `AGENTS.md` and
`CLAUDE.md` at any depth, `skills/<name>/SKILL.md`, `.cursor/rules/*.mdc`,
`.kiro/steering/*.md`, and `.grok/rules/*.md`. Ordinarily a rewrite is judged against its
prior text, so intentional rule changes read as deviations. **Governance mode is the
opt-in exception**, for deliberate rule changes, not typo fixes. Declare it in the
**item front-matter** in the data repo:

```yaml
review:
  rewrites: [AGENTS.md, skills/loops-pickup/SKILL.md]
```

Declared files' new text becomes the proposed rule under review: the reviewer checks
internal coherence, conflicts with unchanged rules, and embedded commands, and deviation
from the prior text is not itself a defect. Undeclared files stay authority. Declaring
nothing is allowed and keeps the stricter review. Declare only the files being rewritten.

Each declared path must be a discovered instruction file and change in the item's range,
and the item must carry `links.spec`; `start` refuses otherwise. The CLI checks only that
`links.spec` exists: that the spec is owner-approved is yours to ensure. Other project
spec gates still apply.

**Rewrites, not removals.** A deleted instruction file cannot be declared (`start` rejects
it as "not an instruction file") and its prior text is not supplied as authority. The
deletion diff is still reviewed; state the rationale in the item and commit.

## Specs and rule files

A linked spec is the acceptance oracle only for the reviewed range; it grants no
authority over unchanged text, and once its rules are incorporated into living text, that
text is the authority. Rule files never cite a specific spec document as authority or
background, since specs get archived or superseded; incorporate a spec's rules into living
text when it is implemented. The reviewer prompt enforces both points for discovered rule
files; for other rule files, such as runbooks, it rests on review judgment. Items link
their spec through `links.spec`, and specs and research may cite other specs.
