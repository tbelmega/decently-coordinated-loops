// The commit reference an item's tickets earn. Pure - the CLI around it only reads the
// board.
import { commitTemplates, type TrackerConfig } from "./tracker-config.ts";

export interface CommitReference {
  /** Appended to the commit subject, which still has to describe the change on its own
   * terms - the id says which work-stream a commit belongs to, not what it did. */
  subject: string;
  /** Lines for the commit body, before any trailers. Empty where the tracker
   * cross-references on the id alone. */
  body: string[];
}

function render(template: string, id: string): string {
  return template.replaceAll("{id}", id);
}

/** Pure: how `ids` are referenced in a commit for this tracker. Several tickets name
 * themselves individually; a tracker whose Git integration links on the bare id gets no
 * body line. */
export function commitReference(ids: string[], tracker: TrackerConfig): CommitReference {
  const templates = commitTemplates(tracker);
  return {
    subject: ids.map((id) => render(templates.subject!, id)).join(" "),
    body: templates.body === undefined ? [] : ids.map((id) => render(templates.body!, id)),
  };
}
