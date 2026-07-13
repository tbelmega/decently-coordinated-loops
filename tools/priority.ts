import type { ItemFile } from "./types.ts";

/** Builds the comparator used to sort board rows: ranked by each item's project's
 * position in `priorityProjects` (a project not listed ranks after every listed
 * one), then by most recently `updated` first, then by slug for a fully
 * deterministic order regardless of input ordering. */
export function makePriorityCompare(
  priorityProjects: string[],
): (a: ItemFile, b: ItemFile) => number {
  const rank = (project: string): number => {
    const i = priorityProjects.indexOf(project);
    return i === -1 ? priorityProjects.length : i;
  };

  return (a, b) => {
    const rankA = rank(a.project);
    const rankB = rank(b.project);
    if (rankA !== rankB) return rankA - rankB;

    const byUpdated = b.updated.localeCompare(a.updated); // most recent first
    if (byUpdated !== 0) return byUpdated;

    return a.slug.localeCompare(b.slug);
  };
}
