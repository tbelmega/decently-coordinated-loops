// Pure logic for the project-participation gate. Board participation is scoped to
// registered projects: an agent working in some unrelated checkout must not read or
// update the board. The IO boundary (git, filesystem) lives in cli-registered.ts;
// everything here is a pure function of its inputs so it can be unit-tested without a
// real repo.

export type Canonicalize = (path: string) => string;

/** Expands a leading `~` to `home`. Leaves every other path untouched. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

/**
 * Returns the name of the registered project whose `repo` path matches any of the
 * candidate roots, or null if none match. `candidateRoots` are the checkout roots to
 * test (a worktree resolves to two: its own root and its main checkout root — see
 * cli-registered.ts); passing both is what makes a linked worktree of a registered
 * repo count as registered. Both sides are run through `canonicalize` so the
 * comparison is symmetric (tilde-expansion, symlink resolution) regardless of how the
 * path was written in loops.json.
 */
export function matchProject(
  projects: Record<string, { repo?: string }>,
  candidateRoots: string[],
  canonicalize: Canonicalize,
): string | null {
  const roots = candidateRoots.map(canonicalize);
  for (const [name, project] of Object.entries(projects)) {
    if (!project.repo) continue;
    if (roots.includes(canonicalize(project.repo))) return name;
  }
  return null;
}
