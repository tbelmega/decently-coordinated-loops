# Lifecycle tails

Read this when declaring or changing a project's `lifecycle` in `loops.json`, or when
reopening an archived item. The body of loops-board states the rules every board user
needs; this file holds the configuration and the procedures.

## Declaring a tail

```jsonc
"projects": {
  "atlas": { "repo": "acme-org/atlas" },                      // deploy (the default)
  "docs":  { "repo": "acme-org/docs", "lifecycle": "no-deploy" }
}
```

| `lifecycle` | Tail | `tested` routes to |
| --- | --- | --- |
| `deploy` (default, omit the field) | `tested → delivered → accepted` | `for-delivery/` |
| `no-deploy` | ends at `tested` | `archive/`, with an `ARCHIVE.md` row |

Use `no-deploy` for a project with no release event: a skills repo, a docs repo, an ops
repo, anything whose artifact reaches its users through a clone or a merge. Under the
`deploy` tail its items would park in `for-delivery/` until the owner certified a
delivery that never happens.

An unregistered project, or one that declares no `lifecycle`, keeps the `deploy` tail:
the fallback costs a manual advance, where guessing the other way would archive verified
work behind the owner's back. Any other value fails config loading.

## A terminal `tested`

Under `no-deploy`, `tested` **is** the terminal state and the item archives as `tested`;
nothing rewrites it to `accepted`. The flip to `tested` writes `next-actor: agent` and no
`awaiting`; `bun run check` fails a terminal `tested` that still routes to the owner. By
the convention every finished item follows, its `next-step` reads "None - ..."; that
wording is not validated, exactly as for `accepted` and `dropped`.

## Reopening an archived item

`delivered` and `accepted` stay valid under either tail (the state vocabulary is global
and closed); set on an item in `items/` or `for-delivery/`, they route as the States table
says. Once a file is in `archive/`, though, `bun run sync` never moves it out: its move
planner reads only `items/` and `for-delivery/`. To reopen, change the state **and** move
the file yourself. `bun run check` names any file left in `archive/` whose state belongs
elsewhere.

## Changing a project's tail

The files need no migration: the next `bun run sync` after the config change moves items
already parked in `for-delivery/` to `archive/` and names each one in its report.

Their frontmatter does need one edit each, because sync moves files without rewriting
item state and parked items still carry `next-actor: owner` / `awaiting: deliver` from the
old tail. **Normalize them (`next-actor: agent`, no `awaiting`, terminal `next-step`) in
the same change that declares the new tail, before the first sync.** The move is not
gated on it, so an unnormalized item is archived carrying a delivery nobody can perform.
`bun run check` names every such item, before and after the move, until it is edited.
