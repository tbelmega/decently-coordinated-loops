import { describe, expect, test } from "bun:test";
import { appendItemNote, itemBranchRef, planBacklinks, planFieldBacklinks, runStatusPhase } from "./tracker-status.ts";
import type { TicketRecord, TrackerAdapter } from "./tracker-adapter.ts";
import type { ItemFile } from "../types.ts";

const ITEM = `---
title: Export
project: workboard
state: merged
updated: 2026-09-18
---

Context.

## Log
- 2026-09-18: Filed.
`;

describe("appendItemNote", () => {
  test("appends a dated line to the log", () => {
    const next = appendItemNote(ITEM, "ticket ACM-7 is at Done while this item is merged", "2026-09-20")!;
    expect(next).toContain("- 2026-09-20: ticket ACM-7 is at Done while this item is merged");
    expect(next).toContain("- 2026-09-18: Filed.");
  });

  test("a second run over unchanged state adds nothing, whatever the date", () => {
    const once = appendItemNote(ITEM, "ticket ACM-7 is at Done while this item is merged", "2026-09-20")!;
    expect(appendItemNote(once, "ticket ACM-7 is at Done while this item is merged", "2026-09-21")).toBeUndefined();
  });

  test("an item without a log section gets one", () => {
    const next = appendItemNote("---\ntitle: X\n---\n\nContext.\n", "ticket ACM-7 is at Done", "2026-09-20")!;
    expect(next).toContain("## Log\n- 2026-09-20: ticket ACM-7 is at Done");
  });
});

describe("planBacklinks", () => {
  function record(id: string, description: string): TicketRecord {
    return { ref: { tracker: "acme", id }, status: "Todo", description, externalId: `uuid-${id}` };
  }

  test("plans the slug line for a ticket that lacks it", () => {
    const plan = planBacklinks([record("ACM-7", "Body.")], new Map([["acme/ACM-7", ["workboard-export"]]]));
    expect(plan).toEqual([{ ticket: { tracker: "acme", id: "ACM-7" }, externalId: "uuid-ACM-7", description: "Body.\n\nDCL: workboard-export" }]);
  });

  test("plans nothing for a ticket that already carries exactly its slugs", () => {
    const plan = planBacklinks([record("ACM-7", "Body.\n\nDCL: workboard-export")], new Map([["acme/ACM-7", ["workboard-export"]]]));
    expect(plan).toEqual([]);
  });

  test("ignores a ticket no item links, so an unrelated description is never touched", () => {
    expect(planBacklinks([record("ACM-7", "Body.")], new Map())).toEqual([]);
  });
});

describe("planBacklinks with branches", () => {
  function record(id: string, description: string): TicketRecord {
    return { ref: { tracker: "acme", id }, status: "Todo", description, externalId: `uuid-${id}` };
  }

  test("adds the branch line for a linked item that has one", () => {
    const plan = planBacklinks([record("ACM-7", "Body.")], new Map([["acme/ACM-7", ["workboard-export"]]]), {
      branchesByTicket: new Map([["acme/ACM-7", ["agents/export"]]]),
    });
    expect(plan[0]!.description).toBe("Body.\n\nDCL: workboard-export\nDCL branch: agents/export");
  });

  test("with a slug field configured, the description keeps only the branch line managed", () => {
    const plan = planBacklinks([record("ACM-7", "Body.")], new Map([["acme/ACM-7", ["workboard-export"]]]), {
      branchesByTicket: new Map([["acme/ACM-7", ["agents/export"]]]),
      backlinkByTracker: { acme: { slugField: "Slug" } },
    });
    expect(plan[0]!.description).toBe("Body.\n\nDCL branch: agents/export");
  });

  test("with both fields configured, the description is never written", () => {
    const plan = planBacklinks([record("ACM-7", "Body.")], new Map([["acme/ACM-7", ["workboard-export"]]]), {
      branchesByTicket: new Map([["acme/ACM-7", ["agents/export"]]]),
      backlinkByTracker: { acme: { slugField: "Slug", branchField: "Branch" } },
    });
    expect(plan).toEqual([]);
  });
});

describe("planFieldBacklinks", () => {
  function record(id: string, fields: Record<string, string> = {}): TicketRecord {
    return { ref: { tracker: "acme", id }, status: "Todo", description: "Body.", externalId: `uuid-${id}`, fields };
  }

  test("writes the slug and branch fields that differ from what the board wants", () => {
    const plan = planFieldBacklinks(
      [record("#7", { Slug: "old-slug" })],
      new Map([["acme/#7", ["workboard-b", "workboard-a"]]]),
      new Map([["acme/#7", ["agents/a"]]]),
      { acme: { slugField: "Slug", branchField: "Branch" } },
    );
    expect(plan).toEqual([
      { ticket: { tracker: "acme", id: "#7" }, externalId: "uuid-#7", field: "Slug", value: "workboard-a, workboard-b" },
      { ticket: { tracker: "acme", id: "#7" }, externalId: "uuid-#7", field: "Branch", value: "agents/a" },
    ]);
  });

  test("clears a branch field once no linked item has a branch", () => {
    const plan = planFieldBacklinks(
      [record("#7", { Slug: "workboard-a", Branch: "agents/a" })],
      new Map([["acme/#7", ["workboard-a"]]]),
      new Map(),
      { acme: { slugField: "Slug", branchField: "Branch" } },
    );
    expect(plan).toEqual([{ ticket: { tracker: "acme", id: "#7" }, externalId: "uuid-#7", field: "Branch", value: "" }]);
  });

  test("plans nothing for a tracker without fields, or a ticket already in step", () => {
    const slugs = new Map([["acme/#7", ["workboard-a"]]]);
    expect(planFieldBacklinks([record("#7")], slugs, new Map(), {})).toEqual([]);
    expect(planFieldBacklinks([record("#7", { Slug: "workboard-a" })], slugs, new Map(), { acme: { slugField: "Slug" } })).toEqual([]);
  });
});

describe("itemBranchRef", () => {
  function item(state: string, links: Record<string, string>): ItemFile {
    return {
      slug: "s", path: "items/s.md", title: "s", project: "workboard", state, assignee: "-", autonomy: "auto",
      nextActor: "agent", dependsOn: [], nextStep: "-", updated: "2026-09-18", links,
    };
  }

  test("prefers the review URL over the branch once work has started", () => {
    expect(itemBranchRef(item("implemented", { branch: "agents/a", pr: "https://example.test/pull/4" }))).toBe("https://example.test/pull/4");
    expect(itemBranchRef(item("in-progress", { branch: "agents/a" }))).toBe("agents/a");
    expect(itemBranchRef(item("blocked", { branch: "agents/a" }))).toBe("agents/a");
  });

  test("names nothing before work starts, after a drop, or without a link", () => {
    expect(itemBranchRef(item("spec-filed", { branch: "agents/a" }))).toBeUndefined();
    expect(itemBranchRef(item("idea", { branch: "agents/a" }))).toBeUndefined();
    expect(itemBranchRef(item("dropped", { branch: "agents/a" }))).toBeUndefined();
    expect(itemBranchRef(item("merged", {}))).toBeUndefined();
  });
});

describe("runStatusPhase", () => {
  const config = {
    owner: "Alice",
    priorityProjects: [],
    integrationBranch: "master",
    landedAdapter: "git" as const,
    githubTokens: {},
    trackers: {
      acme: {
        kind: "linear" as const,
        workspace: "acme",
        team: "ACM",
        statusMap: { "in-progress": "In Progress", merged: "In Review", delivered: "Done" },
      },
    },
    projects: { workboard: { tracker: "acme" } },
    review: {},
  };

  function item(slug: string, state: string, tickets?: string[] | "local"): ItemFile {
    return {
      slug,
      path: `items/${slug}.md`,
      title: slug,
      project: "workboard",
      state,
      assignee: "-",
      autonomy: "auto",
      nextActor: "agent",
      dependsOn: [],
      ...(tickets === undefined ? {} : { tickets }),
      nextStep: "-",
      updated: "2026-09-18",
      links: {},
    };
  }

  class StubAdapter implements TrackerAdapter {
    statusWrites: { id: string; status: string }[] = [];
    descriptionWrites: { id: string; description: string }[] = [];
    constructor(private readonly records: TicketRecord[], private readonly failure?: string) {}
    async fetchTickets(ids: string[]): Promise<TicketRecord[]> {
      if (this.failure) throw new Error(this.failure);
      return this.records.filter((record) => ids.includes(record.ref.id));
    }
    async setStatus(ticket: TicketRecord, status: string): Promise<void> {
      this.statusWrites.push({ id: ticket.ref.id, status });
    }
    async setDescription(externalId: string, description: string): Promise<void> {
      this.descriptionWrites.push({ id: externalId, description });
    }
    fieldWrites: { id: string; field: string; value: string }[] = [];
    async setTextField(ticket: TicketRecord, field: string, value: string): Promise<void> {
      this.fieldWrites.push({ id: ticket.ref.id, field, value });
    }
  }

  function record(id: string, status: string, description = "Body."): TicketRecord {
    return { ref: { tracker: "acme", id }, status, description, externalId: `uuid-${id}` };
  }

  function run(options: {
    items: ItemFile[];
    adapter: StubAdapter;
    apply?: boolean;
    rawText?: Map<string, string>;
  }) {
    return runStatusPhase({
      items: options.items,
      config,
      adapters: new Map([["acme", options.adapter]]),
      rawText: options.rawText ?? new Map(options.items.map((i) => [i.path, ITEM])),
      today: "2026-09-20",
      apply: options.apply ?? false,
    });
  }

  test("a dry run plans the transition and writes nothing at all", async () => {
    const adapter = new StubAdapter([record("ACM-7", "In Progress")]);
    const report = await run({ items: [item("workboard-export", "merged", ["ACM-7"])], adapter });
    expect(report.transitions.map((t) => [t.ticket.id, t.to])).toEqual([["ACM-7", "In Review"]]);
    expect(report.backlinks).toHaveLength(1);
    expect(adapter.statusWrites).toEqual([]);
    expect(adapter.descriptionWrites).toEqual([]);
    expect(report.itemWrites).toEqual([]);
  });

  test("applying pushes exactly the planned transitions and the backlink", async () => {
    const adapter = new StubAdapter([record("ACM-7", "In Progress")]);
    const report = await run({ items: [item("workboard-export", "merged", ["ACM-7"])], adapter, apply: true });
    expect(adapter.statusWrites).toEqual([{ id: "ACM-7", status: "In Review" }]);
    expect(adapter.descriptionWrites).toEqual([{ id: "uuid-ACM-7", description: "Body.\n\nDCL: workboard-export" }]);
    expect(report.applied).toBe(true);
  });

  test("a second apply over unchanged state writes no backlink again", async () => {
    const adapter = new StubAdapter([record("ACM-7", "In Review", "Body.\n\nDCL: workboard-export")]);
    await run({ items: [item("workboard-export", "merged", ["ACM-7"])], adapter, apply: true });
    expect(adapter.statusWrites).toEqual([]);
    expect(adapter.descriptionWrites).toEqual([]);
  });

  test("a ticket a human moved ahead earns one item line and no tracker write", async () => {
    const adapter = new StubAdapter([record("ACM-7", "Done")]);
    const report = await run({ items: [item("workboard-export", "merged", ["ACM-7"])], adapter, apply: true });
    expect(adapter.statusWrites).toEqual([]);
    expect(report.itemWrites).toHaveLength(1);
    expect(report.itemWrites[0]!.rawText).toContain("- 2026-09-20: ticket ACM-7 is at Done while this item is merged");

    const second = await run({
      items: [item("workboard-export", "merged", ["ACM-7"])],
      adapter,
      apply: true,
      rawText: new Map([["items/workboard-export.md", report.itemWrites[0]!.rawText]]),
    });
    expect(second.itemWrites).toEqual([]);
  });

  test("an item with no tickets causes no tracker request at all", async () => {
    const adapter = new StubAdapter([record("ACM-7", "Todo")]);
    let asked = false;
    const watched = new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === "fetchTickets") asked = true;
        return Reflect.get(target, property, receiver);
      },
    });
    const report = await run({
      items: [item("workboard-local", "merged", "local"), item("workboard-undecided", "merged")],
      adapter: watched as StubAdapter,
      apply: true,
    });
    expect(asked).toBe(false);
    expect(report.transitions).toEqual([]);
    expect(report.backlinks).toEqual([]);
  });

  test("an unreadable tracker fails alone and leaves the board untouched", async () => {
    const adapter = new StubAdapter([], "no token at ~/.secrets/linear-acme");
    const report = await run({ items: [item("workboard-export", "merged", ["ACM-7"])], adapter, apply: true });
    expect(report.failures).toEqual([{ tracker: "acme", message: "no token at ~/.secrets/linear-acme" }]);
    expect(report.transitions).toEqual([]);
    expect(report.unresolved).toEqual([]);
    expect(report.itemWrites).toEqual([]);
  });

  test("applying writes the branch of an in-progress item onto its ticket", async () => {
    const adapter = new StubAdapter([record("ACM-7", "In Progress", "Body.\n\nDCL: workboard-export")]);
    const linked = { ...item("workboard-export", "in-progress", ["ACM-7"]), links: { branch: "agents/export" } };
    await run({ items: [linked], adapter, apply: true });
    expect(adapter.descriptionWrites).toEqual([
      { id: "uuid-ACM-7", description: "Body.\n\nDCL: workboard-export\nDCL branch: agents/export" },
    ]);
  });
});

