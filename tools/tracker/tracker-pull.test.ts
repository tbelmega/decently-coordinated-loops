import { describe, expect, test } from "bun:test";
import { itemSlugForTicket, planPull, renderPulledItem, setItemTickets } from "./tracker-pull.ts";
import type { TicketRecord } from "./tracker-adapter.ts";
import type { LoopsConfig } from "../config.ts";
import type { ItemFile } from "../types.ts";

const config: LoopsConfig = {
  owner: "Alice",
  priorityProjects: [],
  integrationBranch: "master",
  landedAdapter: "git",
  githubTokens: {},
  trackers: {
    acme: { kind: "github-projects", workspace: "Acme/workboard", team: "8", statusMap: { "in-progress": "In progress" } },
  },
  projects: { workboard: { tracker: "acme" }, daybook: {} },
  review: {},
} as unknown as LoopsConfig;

function item(slug: string, overrides: Partial<ItemFile> = {}): ItemFile {
  return {
    slug,
    path: `items/${slug}.md`,
    title: slug,
    project: "workboard",
    state: "idea",
    assignee: "-",
    autonomy: "supervised",
    nextActor: "agent",
    dependsOn: [],
    nextStep: "-",
    updated: "2026-09-18",
    links: {},
    ...overrides,
  };
}

function ticket(number: number, overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    ref: { tracker: "acme", id: `#${number}` },
    externalId: `issue-${number}`,
    status: "Needs Planning",
    description: "It breaks.",
    title: `Ticket ${number}`,
    url: `https://github.com/Acme/workboard/issues/${number}`,
    open: true,
    ...overrides,
  };
}

function plan(items: ItemFile[], open: TicketRecord[], rawText: Record<string, string> = {}) {
  return planPull({
    tracker: "acme",
    project: "workboard",
    config,
    items,
    rawText: new Map(items.map((i) => [i.path, rawText[i.slug] ?? "---\n---\nContext.\n"])),
    open,
  });
}

describe("planPull", () => {
  test("files every open ticket no item names", () => {
    const result = plan([], [ticket(12), ticket(13)]);
    expect(result.file.map((f) => [f.ticket.id, f.slug])).toEqual([
      ["#12", "workboard-ticket-12"],
      ["#13", "workboard-ticket-13"],
    ]);
  });

  test("a ticket an item already names, in any folder, is not pulled again", () => {
    const archived = item("workboard-old", { path: "archive/workboard-old.md", state: "dropped", tickets: ["#12"] });
    const result = plan([archived], [ticket(12)]);
    expect(result.file).toEqual([]);
    expect(result.alreadyLinked).toBe(1);
  });

  test("a ticket whose URL an item quotes is linked to that item, not filed", () => {
    const result = plan([item("workboard-report")], [ticket(12)], {
      "workboard-report": "---\n---\nSee https://github.com/Acme/workboard/issues/12 for the report.\n",
    });
    expect(result.file).toEqual([]);
    expect(result.linkExisting).toEqual([
      { ticket: { tracker: "acme", id: "#12" }, slug: "workboard-report", path: "items/workboard-report.md", reason: "url" },
    ]);
  });

  test("a URL match needs the whole number: issue 12 does not match a quote of issue 123", () => {
    const result = plan([item("workboard-report")], [ticket(12)], {
      "workboard-report": "---\n---\nSee https://github.com/Acme/workboard/issues/123.\n",
    });
    expect(result.linkExisting).toEqual([]);
    expect(result.file).toHaveLength(1);
  });

  test("a ticket whose backlink names an existing item is linked to it", () => {
    const result = plan([item("workboard-report")], [ticket(12, { description: "Body.\n\nDCL: workboard-report" })]);
    expect(result.linkExisting.map((l) => [l.slug, l.reason])).toEqual([["workboard-report", "backlink"]]);
  });

  test("a backlink naming another tracker's item is reported, and that item is never touched", () => {
    const foreign = item("daybook-private", { project: "daybook", links: { branch: "agents/private" } });
    const result = plan([foreign], [ticket(12, { description: "Body.\n\nDCL: daybook-private" })]);
    expect(result.linkExisting).toEqual([]);
    expect(result.file).toEqual([]);
    expect(result.staleBacklinks).toEqual([{ ticket: { tracker: "acme", id: "#12" }, slugs: ["daybook-private"] }]);
  });

  test("a description backlink still counts after the tracker moves the slug into a field", () => {
    const fielded = {
      ...config,
      trackers: { acme: { ...config.trackers.acme!, backlink: { slugField: "Slug" } } },
    } as LoopsConfig;
    const result = planPull({
      tracker: "acme",
      project: "workboard",
      config: fielded,
      items: [item("workboard-report")],
      rawText: new Map([["items/workboard-report.md", "---\n---\n"]]),
      open: [ticket(12, { description: "Body.\n\nDCL: workboard-report" }), ticket(13, { description: "Body.\n\nDCL: workboard-gone" })],
    });
    expect(result.linkExisting.map((l) => [l.ticket.id, l.slug])).toEqual([["#12", "workboard-report"]]);
    expect(result.staleBacklinks.map((s) => s.ticket.id)).toEqual(["#13"]);
    expect(result.file).toEqual([]);
  });

  test("a backlink naming no board item is reported, never filed twice", () => {
    const result = plan([], [ticket(12, { description: "Body.\n\nDCL: workboard-gone" })]);
    expect(result.file).toEqual([]);
    expect(result.staleBacklinks).toEqual([{ ticket: { tracker: "acme", id: "#12" }, slugs: ["workboard-gone"] }]);
  });

  test("reads the backlink from the slug field when the tracker keeps it there", () => {
    const fielded = {
      ...config,
      trackers: { acme: { ...config.trackers.acme!, backlink: { slugField: "Slug" } } },
    } as LoopsConfig;
    const result = planPull({
      tracker: "acme",
      project: "workboard",
      config: fielded,
      items: [item("workboard-report")],
      rawText: new Map([["items/workboard-report.md", "---\n---\n"]]),
      open: [ticket(12, { fields: { Slug: "workboard-report" } })],
    });
    expect(result.linkExisting.map((l) => l.slug)).toEqual(["workboard-report"]);
  });

  test("a bare number in an item's prose is only a possible match, still filed", () => {
    const result = plan([item("workboard-report")], [ticket(12)], {
      "workboard-report": "---\n---\nReported as issue #12 by the customer.\n",
    });
    expect(result.file).toHaveLength(1);
    expect(result.file[0]!.possibleMatches).toEqual(["workboard-report"]);
  });

  test("items of a project on another tracker are not searched for matches", () => {
    const other = item("daybook-report", { project: "daybook" });
    const result = plan([other], [ticket(12)], {
      "daybook-report": "---\n---\nhttps://github.com/Acme/workboard/issues/12 and #12\n",
    });
    expect(result.linkExisting).toEqual([]);
    expect(result.file[0]!.possibleMatches).toEqual([]);
  });

  test("closed tickets are never pulled", () => {
    expect(plan([], [ticket(12, { open: false })]).file).toEqual([]);
  });
});

describe("itemSlugForTicket", () => {
  test("is the project plus the kebab-cased title, transliterated", () => {
    expect(itemSlugForTicket("workboard", ticket(12, { title: "Kunden können Termine nicht öffnen!" }), new Set())).toBe(
      "workboard-kunden-konnen-termine-nicht-offnen",
    );
  });

  test("cuts a long title at a word boundary", () => {
    const slug = itemSlugForTicket("workboard", ticket(12, { title: "word ".repeat(40) }), new Set());
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("a taken slug gets the ticket number appended", () => {
    expect(itemSlugForTicket("workboard", ticket(12, { title: "Export" }), new Set(["workboard-export"]))).toBe(
      "workboard-export-12",
    );
  });

  test("a title with nothing usable falls back to the ticket number", () => {
    expect(itemSlugForTicket("workboard", ticket(12, { title: "!!!" }), new Set())).toBe("workboard-ticket-12");
  });
});

describe("renderPulledItem", () => {
  const text = renderPulledItem({
    tracker: "acme",
    project: "workboard",
    ticket: ticket(12, {
      title: 'Export "weekly" fails',
      author: "bob",
      createdAt: "2026-09-01T10:00:00Z",
      description: "Steps:\n1. Open it\n![shot](https://github.com/user-attachments/assets/abc)",
    }),
    comments: [{ author: "carol", createdAt: "2026-09-02T09:00:00Z", body: "Same here.\nOn mobile." }],
    possibleMatches: ["workboard-report"],
    today: "2026-10-28",
  });

  test("is an idea item naming the ticket, quoted safely in YAML", () => {
    expect(text).toContain('title: "Export \\"weekly\\" fails"');
    expect(text).toContain("state: idea");
    expect(text).toContain("autonomy: supervised");
    expect(text).toContain('tickets: ["#12"]');
    expect(text).toContain("updated: 2026-10-28");
  });

  test("quotes the description and comments verbatim", () => {
    expect(text).toContain("> Steps:\n> 1. Open it\n");
    expect(text).toContain("- carol, 2026-09-02:\n  > Same here.\n  > On mobile.");
    expect(text).toContain("Reported by bob on 2026-09-01");
  });

  test("says attachments are only linked, and names a possible match", () => {
    expect(text).toContain("Attachments are linked, not copied");
    expect(text).toContain("workboard-report");
  });
});

describe("setItemTickets", () => {
  const raw = "---\ntitle: X\nproject: workboard\nnext-step: go\n---\nBody.\n";

  test("adds a tickets line to an item that has none", () => {
    expect(setItemTickets(raw, ["#12"])).toBe('---\ntitle: X\nproject: workboard\ntickets: ["#12"]\nnext-step: go\n---\nBody.\n');
  });

  test("merges into an existing list and replaces a local marker", () => {
    expect(setItemTickets(raw.replace("next-step", 'tickets: ["#3"]\nnext-step'), ["#12"])).toContain('tickets: ["#3", "#12"]');
    expect(setItemTickets(raw.replace("next-step", "tickets: local\nnext-step"), ["#12"])).toContain('tickets: ["#12"]');
  });

  test("extends a block list without corrupting the frontmatter", () => {
    const block = raw.replace("next-step", 'tickets:\n  - "#3"\n  - "#4" # shared\nnext-step');
    const next = setItemTickets(block, ["#12"])!;
    expect(next).toBe('---\ntitle: X\nproject: workboard\ntickets: ["#3", "#4", "#12"]\nnext-step: go\n---\nBody.\n');
  });

  test("extends a multi-line flow list", () => {
    const flow = raw.replace("next-step", 'tickets: [\n  "#3",\n  "#4",\n]\nnext-step');
    expect(setItemTickets(flow, ["#12"])).toBe('---\ntitle: X\nproject: workboard\ntickets: ["#3", "#4", "#12"]\nnext-step: go\n---\nBody.\n');
  });

  test("a tickets key as the last frontmatter line is replaced in place", () => {
    const last = '---\ntitle: X\ntickets:\n  - "#3"\n---\nBody.\n';
    expect(setItemTickets(last, ["#12"])).toBe('---\ntitle: X\ntickets: ["#3", "#12"]\n---\nBody.\n');
  });

  test("a comment after a one-line flow list goes with the old list", () => {
    const commented = raw.replace("next-step", 'tickets: ["#3"] # from triage\nnext-step');
    expect(setItemTickets(commented, ["#12"])).toContain('tickets: ["#3", "#12"]\nnext-step: go');
  });

  test("returns undefined when the item already names the ticket", () => {
    expect(setItemTickets(raw.replace("next-step", 'tickets: ["#12"]\nnext-step'), ["#12"])).toBeUndefined();
  });
});
