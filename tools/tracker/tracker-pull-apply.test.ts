import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPullPlan } from "./tracker-pull-apply.ts";
import { planPull } from "./tracker-pull.ts";
import type { TicketComment, TicketRecord, TrackerAdapter } from "./tracker-adapter.ts";
import type { LoopsConfig } from "../config.ts";
import type { ItemFile } from "../types.ts";

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

const config = {
  owner: "Alice",
  priorityProjects: [],
  integrationBranch: "master",
  landedAdapter: "git",
  githubTokens: {},
  trackers: { acme: { kind: "github-projects", workspace: "Acme/workboard", team: "8", statusMap: {} } },
  projects: { workboard: { tracker: "acme" } },
  review: {},
} as unknown as LoopsConfig;

const REPORT = "---\ntitle: Report\nproject: workboard\nstate: idea\nnext-step: go\n---\nSee https://github.com/Acme/workboard/issues/13.\n";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "dcl-pull-apply-"));
  created.push(root);
  mkdirSync(join(root, "items"));
  writeFileSync(join(root, "items", "workboard-report.md"), REPORT);
  return root;
}

function reportItem(): ItemFile {
  return {
    slug: "workboard-report", path: "items/workboard-report.md", title: "Report", project: "workboard", state: "idea",
    assignee: "-", autonomy: "supervised", nextActor: "agent", dependsOn: [], nextStep: "go", updated: "2026-09-18", links: {},
  };
}

function ticket(number: number, description = "It breaks."): TicketRecord {
  return {
    ref: { tracker: "acme", id: `#${number}` },
    externalId: `issue-${number}`,
    status: "Needs Planning",
    description,
    title: `Ticket ${number}`,
    url: `https://github.com/Acme/workboard/issues/${number}`,
    open: true,
  };
}

class StubAdapter implements TrackerAdapter {
  descriptions = new Map<string, string>();
  writes: { id: string; description: string }[] = [];
  onComments?: (ticket: TicketRecord) => void;
  constructor(readonly open: TicketRecord[]) {
    for (const record of open) this.descriptions.set(record.externalId, record.description);
  }
  async fetchTickets(ids: string[]) {
    return this.open.filter((record) => ids.includes(record.ref.id));
  }
  async setStatus() {}
  async setDescription(externalId: string, description: string) {
    this.writes.push({ id: externalId, description });
  }
  async listOpenTickets() {
    return this.open;
  }
  async fetchDescription(record: TicketRecord) {
    return this.descriptions.get(record.externalId)!;
  }
  async fetchComments(record: TicketRecord): Promise<TicketComment[]> {
    this.onComments?.(record);
    return [{ author: "bob", createdAt: "2026-09-02T10:00:00Z", body: "Same here." }];
  }
}

async function run(root: string, adapter: StubAdapter) {
  const items = [reportItem()];
  const rawText = new Map([["items/workboard-report.md", readFileSync(join(root, "items", "workboard-report.md"), "utf8")]]);
  const plan = planPull({ tracker: "acme", project: "workboard", config, items, rawText, open: adapter.open });
  return applyPullPlan({ root, tracker: "acme", project: "workboard", adapter, plan, config, items, today: "2026-10-28" });
}

describe("applyPullPlan", () => {
  test("files new tickets, links quoted ones, and backlinks both", async () => {
    const root = repo();
    const adapter = new StubAdapter([ticket(12), ticket(13)]);
    const result = await run(root, adapter);
    expect(result.filed).toEqual(["items/workboard-ticket-12.md"]);
    expect(result.linked).toEqual(["items/workboard-report.md"]);
    expect(readFileSync(join(root, "items", "workboard-ticket-12.md"), "utf8")).toContain("> Same here.");
    expect(readFileSync(join(root, "items", "workboard-report.md"), "utf8")).toContain('tickets: ["#13"]');
    expect(adapter.writes.map((w) => w.description)).toEqual(["It breaks.\n\nDCL: workboard-ticket-12", "It breaks.\n\nDCL: workboard-report"]);
  });

  test("a description edited during the pull keeps the edit under the backlink", async () => {
    const root = repo();
    const adapter = new StubAdapter([ticket(12)]);
    adapter.onComments = (record) => adapter.descriptions.set(record.externalId, "It breaks, and here is more detail.");
    await run(root, adapter);
    expect(adapter.writes).toEqual([{ id: "issue-12", description: "It breaks, and here is more detail.\n\nDCL: workboard-ticket-12" }]);
  });

  test("a file another session created meanwhile is not overwritten and gets no backlink", async () => {
    const root = repo();
    const adapter = new StubAdapter([ticket(12)]);
    adapter.onComments = () => writeFileSync(join(root, "items", "workboard-ticket-12.md"), "theirs\n");
    const result = await run(root, adapter);
    expect(readFileSync(join(root, "items", "workboard-ticket-12.md"), "utf8")).toBe("theirs\n");
    expect(result.skipped).toEqual([{ path: "items/workboard-ticket-12.md", reason: "a file appeared at this path during the pull" }]);
    expect(adapter.writes).toEqual([]);
  });

  test("an item edited during the pull keeps the edit and gains the ticket", async () => {
    const root = repo();
    const adapter = new StubAdapter([ticket(13)]);
    const path = join(root, "items", "workboard-report.md");
    const fetch = adapter.fetchTickets.bind(adapter);
    adapter.fetchTickets = async (ids: string[]) => {
      writeFileSync(path, REPORT.replace("state: idea", "state: spec-filed"));
      return fetch(ids);
    };
    await run(root, adapter);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("state: spec-filed");
    expect(text).toContain('tickets: ["#13"]');
  });

  test("a symlink at a linked item's path is refused", async () => {
    const root = repo();
    const outside = join(root, "elsewhere.md");
    writeFileSync(outside, REPORT);
    rmSync(join(root, "items", "workboard-report.md"));
    symlinkSync(outside, join(root, "items", "workboard-report.md"));
    const adapter = new StubAdapter([ticket(13)]);
    const result = await run(root, adapter);
    expect(result.skipped).toEqual([{ path: "items/workboard-report.md", reason: "the item is a symlink" }]);
    expect(readFileSync(outside, "utf8")).toBe(REPORT);
    expect(adapter.writes).toEqual([]);
  });

  test("an item moved to another project during the pull is neither linked nor backlinked", async () => {
    const root = repo();
    const adapter = new StubAdapter([ticket(13)]);
    const path = join(root, "items", "workboard-report.md");
    const fetch = adapter.fetchTickets.bind(adapter);
    adapter.fetchTickets = async (ids: string[]) => {
      writeFileSync(path, REPORT.replace("project: workboard", "project: daybook"));
      return fetch(ids);
    };
    const result = await run(root, adapter);
    expect(readFileSync(path, "utf8")).not.toContain("tickets:");
    expect(result.skipped).toEqual([{ path: "items/workboard-report.md", reason: "the item no longer belongs to a project on this tracker" }]);
    expect(adapter.writes).toEqual([]);
  });

  test("the published branch comes from the item as it reads now", async () => {
    const root = repo();
    const adapter = new StubAdapter([ticket(13)]);
    const path = join(root, "items", "workboard-report.md");
    const fetch = adapter.fetchTickets.bind(adapter);
    adapter.fetchTickets = async (ids: string[]) => {
      writeFileSync(path, REPORT.replace("state: idea", "state: in-progress\nlinks:\n  branch: agents/report"));
      return fetch(ids);
    };
    await run(root, adapter);
    expect(adapter.writes[0]!.description).toContain("DCL branch: agents/report");
  });

  test("an item that stopped quoting the ticket during the pull is not linked", async () => {
    const root = repo();
    const adapter = new StubAdapter([ticket(13)]);
    const path = join(root, "items", "workboard-report.md");
    const fetch = adapter.fetchTickets.bind(adapter);
    adapter.fetchTickets = async (ids: string[]) => {
      writeFileSync(path, REPORT.replace("See https://github.com/Acme/workboard/issues/13.", "Unrelated after all."));
      return fetch(ids);
    };
    const result = await run(root, adapter);
    expect(readFileSync(path, "utf8")).not.toContain("tickets:");
    expect(result.skipped).toEqual([{ path: "items/workboard-report.md", reason: "the item no longer justifies the link to #13" }]);
    expect(adapter.writes).toEqual([]);
  });
});

