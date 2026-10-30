// The return half of the two-way mapping: the board references recorded on a ticket, so
// anyone holding the ticket can find the work-stream and, once work has started, its
// branch or review. This module owns the description form; a tracker that names board
// fields for them carries the same values there instead. Pure.
//
// A description line rather than a label: labels are workspace-global in both trackers,
// so one per work-stream would litter a list the collaborators use for their own work.

/** The managed line for one slug. */
export function backlinkLine(slug: string): string {
  return `DCL: ${slug}`;
}

/** The managed line for one branch or review URL. */
export function branchLine(ref: string): string {
  return `DCL branch: ${ref}`;
}

const SLUG_PATTERN = /^DCL: (\S+)$/;
const BRANCH_PATTERN = /^DCL branch: \S+$/;

/** The slugs a description already names, in the order it names them. */
export function readBacklinkSlugs(description: string): string[] {
  const slugs: string[] = [];
  for (const line of description.split("\n")) {
    const match = SLUG_PATTERN.exec(line.trim());
    if (match) slugs.push(match[1]!);
  }
  return slugs;
}

/** Which managed lines a description should carry. An absent kind is not managed here -
 * its lines, if any, are left exactly where they are, which is what a tracker storing
 * that kind in a field needs. */
export interface ManagedLines {
  slugs?: string[];
  branches?: string[];
}

/** The description this ticket should carry, or undefined when it already carries
 * exactly the wanted lines. Every managed line is rewritten as one block at the end;
 * every other line of the description - which is the collaborators' text, not ours - is
 * left exactly where it was. */
export function applyManagedLines(description: string, wanted: ManagedLines): string | undefined {
  const patterns = [
    ...(wanted.slugs ? [SLUG_PATTERN] : []),
    ...(wanted.branches ? [BRANCH_PATTERN] : []),
  ];
  const managed = (line: string) => patterns.some((pattern) => pattern.test(line.trim()));
  const block = [
    ...[...new Set(wanted.slugs ?? [])].sort().map(backlinkLine),
    ...[...new Set(wanted.branches ?? [])].sort().map(branchLine),
  ];
  const lines = description.split("\n");
  const present = lines.filter(managed).map((line) => line.trim());
  if (present.length === block.length && present.every((line, index) => line === block[index])) return undefined;
  const kept = lines.filter((line) => !managed(line));
  // Removing a line that sat between paragraphs would otherwise leave a widening gap
  // every time the slug changed.
  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  if (block.length === 0) return body;
  return body === "" ? block.join("\n") : `${body}\n\n${block.join("\n")}`;
}

/** The slug-only form, for a ticket whose branch is not managed in its description. */
export function applyBacklinks(description: string, slugs: string[]): string | undefined {
  return applyManagedLines(description, { slugs });
}
