// Applying a pull plan: the local item writes and the backlinks that make each ticket
// name its work-stream. The CLI owns argument handling; this module owns the ordering
// that keeps a pull from destroying anyone else's work. Invariants:
//
// 1. Every tracker read the writes depend on (comments, linked tickets) happens before the
//    board lock is taken, and nothing planned before those reads is written blindly.
// 2. A new item file is created exclusively: a file - or a symlink - that appeared at its
//    path in the meantime is left alone and the ticket is reported, not backlinked.
// 3. A linked item is rewritten from its text as read under the lock, so edits made while
//    the pull was talking to the tracker survive; a symlink is refused, never followed.
//    Each planned link is re-justified against that re-read item with the planner's own
//    evidence rule (linkStillJustified): same slug, a project on this tracker, and the URL
//    quote or ticket backlink that justified it. A link that no longer holds is skipped,
//    and the branch published for an item comes from the re-read item only.
// 4. A ticket's backlink is written only after its local file or link was written, and
//    from its description as re-read immediately before the write.
//
// Known limitation (accepted by the owner): GitHub offers no conditional update of an
// issue body, so a collaborator's edit landing between that re-read and the write is
// overwritten. The window is one request wide, the overwritten text stays in the issue's
// edit history, and the status push's description backlink has the same gap. A tracker
// that names `backlink.slugField` and `backlink.branchField` never writes the description
// and so avoids it entirely.
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectTracker, type LoopsConfig } from "../config.ts";
import { parseItemFileText } from "../parse.ts";
import { withLock } from "../lock.ts";
import type { ItemFile } from "../types.ts";
import type { TicketRecord, TrackerAdapter } from "./tracker-adapter.ts";
import { applyManagedLines } from "./tracker-backlink.ts";
import { ticketKey } from "./tracker-plan.ts";
import { linkStillJustified, renderPulledItem, setItemTickets, type PullLink, type PullPlan } from "./tracker-pull.ts";
import { itemBranchRef, planFieldBacklinks } from "./tracker-status.ts";

export interface PullApplyInput {
  root: string;
  tracker: string;
  project: string;
  adapter: TrackerAdapter;
  plan: PullPlan;
  config: LoopsConfig;
  items: ItemFile[];
  today: string;
}

export interface PullApplyResult {
  filed: string[];
  linked: string[];
  skipped: { path: string; reason: string }[];
  backlinks: number;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function applyPullPlan(input: PullApplyInput): Promise<PullApplyResult> {
  const { root, tracker, project, adapter, plan, config, today } = input;
  const result: PullApplyResult = { filed: [], linked: [], skipped: [], backlinks: 0 };

  // Tracker reads first (invariant 1).
  const files: { path: string; slug: string; record: TicketRecord; text: string }[] = [];
  for (const file of plan.file) {
    const comments = adapter.fetchComments ? await adapter.fetchComments(file.record) : [];
    files.push({
      path: file.path,
      slug: file.slug,
      record: file.record,
      text: renderPulledItem({ tracker, project, ticket: file.record, comments, possibleMatches: file.possibleMatches, today }),
    });
  }
  const linkedIds = [...new Set(plan.linkExisting.map((link) => link.ticket.id))].sort();
  const linkedRecords = new Map((await adapter.fetchTickets(linkedIds)).map((record) => [ticketKey(record.ref), record]));

  // Local writes under the lock (invariants 2 and 3).
  const written = new Map<string, { record: TicketRecord; slugs: string[]; branches: string[] }>();
  await withLock(
    root,
    () => {
      for (const file of files) {
        const path = join(root, file.path);
        try {
          // "wx" is O_CREAT | O_EXCL: it fails on any existing entry, a symlink included.
          writeFileSync(path, file.text, { flag: "wx" });
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
          result.skipped.push({ path: file.path, reason: "a file appeared at this path during the pull" });
          continue;
        }
        result.filed.push(file.path);
        written.set(ticketKey(file.record.ref), { record: file.record, slugs: [file.slug], branches: [] });
      }
      const linksByPath = new Map<string, PullLink[]>();
      for (const link of plan.linkExisting) linksByPath.set(link.path, [...(linksByPath.get(link.path) ?? []), link]);
      for (const [relative, links] of linksByPath) {
        const path = join(root, relative);
        if (isSymlink(path)) {
          result.skipped.push({ path: relative, reason: "the item is a symlink" });
          continue;
        }
        const currentText = readFileSync(path, "utf8");
        const current = parseItemFileText(relative, currentText);
        if (resolveProjectTracker(config, current.project)?.name !== tracker) {
          result.skipped.push({ path: relative, reason: "the item no longer belongs to a project on this tracker" });
          continue;
        }
        const justified: PullLink[] = [];
        for (const link of links) {
          const record = linkedRecords.get(ticketKey(link.ticket));
          if (record && linkStillJustified(link, record, current, currentText, config)) justified.push(link);
          else result.skipped.push({ path: relative, reason: `the item no longer justifies the link to ${link.ticket.id}` });
        }
        if (justified.length === 0) continue;
        const next = setItemTickets(currentText, justified.map((link) => link.ticket.id));
        if (next !== undefined) writeFileSync(path, next);
        result.linked.push(relative);
        const branch = itemBranchRef(current);
        for (const link of justified) {
          const key = ticketKey(link.ticket);
          const record = linkedRecords.get(key)!;
          const entry = written.get(key) ?? { record, slugs: [], branches: [] };
          entry.slugs.push(current.slug);
          if (branch) entry.branches.push(branch);
          written.set(key, entry);
        }
      }
    },
    "tracker-sync pull",
  );

  // Backlinks last, from current text (invariant 4).
  const fields = config.trackers[tracker]?.backlink;
  for (const { record, slugs, branches } of written.values()) {
    const current = adapter.fetchDescription ? await adapter.fetchDescription(record) : record.description;
    const description = applyManagedLines(current, {
      ...(fields?.slugField ? {} : { slugs }),
      ...(fields?.branchField ? {} : { branches }),
    });
    if (description !== undefined) {
      await adapter.setDescription(record.externalId, description);
      result.backlinks += 1;
    }
    const key = ticketKey(record.ref);
    for (const write of planFieldBacklinks([record], new Map([[key, slugs]]), new Map([[key, branches]]), { [tracker]: fields })) {
      if (!adapter.setTextField) throw new Error("this tracker has no board fields to write");
      await adapter.setTextField(record, write.field, write.value);
      result.backlinks += 1;
    }
  }
  return result;
}
