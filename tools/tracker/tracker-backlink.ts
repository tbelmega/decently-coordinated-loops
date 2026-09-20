// The return half of the two-way mapping: the board slug recorded in a ticket's
// description, so anyone holding the ticket can find the work-stream. Pure.
//
// A description line rather than a label: labels are workspace-global in both trackers,
// so one per work-stream would litter a list the collaborators use for their own work.

/** The managed line for one slug. */
export function backlinkLine(slug: string): string {
  return `DCL: ${slug}`;
}

const BACKLINK_PATTERN = /^DCL: \S+$/;

/** The description this ticket should carry, or undefined when it already carries
 * exactly these slugs. Every managed line is rewritten as one block at the end; every
 * other line of the description - which is the collaborators' text, not ours - is left
 * exactly where it was. */
export function applyBacklinks(description: string, slugs: string[]): string | undefined {
  const wanted = [...new Set(slugs)].sort();
  const lines = description.split("\n");
  const present = lines.filter((line) => BACKLINK_PATTERN.test(line.trim())).map((line) => line.trim());
  if (present.length === wanted.length && present.every((line, index) => line === backlinkLine(wanted[index]!))) {
    return undefined;
  }
  const kept = lines.filter((line) => !BACKLINK_PATTERN.test(line.trim()));
  // Removing a line that sat between paragraphs would otherwise leave a widening gap
  // every time the slug changed.
  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  const block = wanted.map(backlinkLine).join("\n");
  return body === "" ? block : `${body}\n\n${block}`;
}
