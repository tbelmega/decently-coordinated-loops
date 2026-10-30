import { describe, expect, test } from "bun:test";
import {
  GithubProjectsAdapter,
  boardQuery,
  parseComments,
  parseProjectBoard,
  projectNumber,
  projectOrg,
  statusOptionId,
  toRecord,
} from "./tracker-github.ts";
import type { TrackerConfig } from "./tracker-config.ts";

const tracker: TrackerConfig = { kind: "github-projects", workspace: "Acme/workboard", team: "8", statusMap: {} };

function page(nodes: unknown[], pageInfo = { hasNextPage: false, endCursor: null as string | null }) {
  return {
    organization: {
      projectV2: {
        id: "project-1",
        field: { id: "field-1", options: [{ id: "opt-1", name: "Todo" }, { id: "opt-2", name: "Done" }] },
        items: { pageInfo, nodes },
      },
    },
  };
}

const ISSUE = {
  id: "item-1",
  fieldValueByName: { name: "Todo" },
  content: {
    __typename: "Issue",
    id: "issue-1",
    number: 12,
    title: "Weekly report export",
    body: "Body.",
    url: "https://github.com/Acme/workboard/issues/12",
    assignees: { nodes: [{ login: "alice" }] },
  },
};

describe("board coordinates", () => {
  test("the org comes from the workspace and the number from the team field", () => {
    expect(projectOrg(tracker)).toBe("Acme");
    expect(projectNumber(tracker)).toBe(8);
  });

  test("a team that is not a project number fails rather than querying project NaN", () => {
    expect(() => projectNumber({ ...tracker, team: "ACM" })).toThrow(/must be the project number/);
  });
});

describe("parseProjectBoard", () => {
  test("reads the issues, their status and their assignee", () => {
    const board = parseProjectBoard(page([ISSUE]));
    expect(board.projectId).toBe("project-1");
    expect(board.items).toEqual([
      {
        itemId: "item-1",
        contentId: "issue-1",
        type: "Issue",
        number: 12,
        title: "Weekly report export",
        body: "Body.",
        url: "https://github.com/Acme/workboard/issues/12",
        assignee: "alice",
        status: "Todo",
      },
    ]);
  });

  test("counts pull requests and drafts instead of silently dropping them", () => {
    const board = parseProjectBoard(
      page([ISSUE, { id: "i2", content: { __typename: "PullRequest", id: "pr-1", number: 3 } }, { id: "i3", content: null }]),
    );
    expect(board.items).toHaveLength(1);
    expect(board.skipped).toEqual({ pullRequests: 1, drafts: 1 });
  });

  test("fails on a project that has no Status field to map onto", () => {
    const data = page([]);
    (data.organization.projectV2 as { field: unknown }).field = null;
    expect(() => parseProjectBoard(data)).toThrow(/no single-select Status field/);
  });

  test("fails on a board that does not exist", () => {
    expect(() => parseProjectBoard({ organization: { projectV2: null } })).toThrow(/no such GitHub project/);
  });
});

describe("statusOptionId", () => {
  test("resolves a configured status to its column", () => {
    expect(statusOptionId(parseProjectBoard(page([])), "Done")).toBe("opt-2");
  });

  test("fails loudly on a renamed column, listing the board's own", () => {
    expect(() => statusOptionId(parseProjectBoard(page([])), "Shipped")).toThrow(/no Status option "Shipped" \(it has Todo, Done\)/);
  });
});

describe("toRecord", () => {
  test("a github ticket id is the issue number with a hash", () => {
    expect(toRecord(parseProjectBoard(page([ISSUE])).items[0]!, "acme").ref).toEqual({ tracker: "acme", id: "#12" });
  });
});

describe("GithubProjectsAdapter", () => {
  function recording(pages: unknown[]) {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    let index = 0;
    const request = async (query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables });
      return query.startsWith("query Board") ? pages[index++] : { ok: true };
    };
    return { calls, request };
  }

  test("returns only the tickets the board items name", async () => {
    const { request } = recording([page([ISSUE])]);
    const records = await new GithubProjectsAdapter("acme", tracker, request).fetchTickets(["#12", "#99"]);
    expect(records.map((r) => r.ref.id)).toEqual(["#12"]);
  });

  test("pages through a board larger than one request", async () => {
    const second = { ...ISSUE, id: "item-2", content: { ...ISSUE.content, id: "issue-2", number: 13 } };
    const { calls, request } = recording([
      page([ISSUE], { hasNextPage: true, endCursor: "cursor-1" }),
      page([second]),
    ]);
    const records = await new GithubProjectsAdapter("acme", tracker, request).fetchTickets(["#12", "#13"]);
    expect(records.map((r) => r.ref.id)).toEqual(["#12", "#13"]);
    expect(calls[1]!.variables.cursor).toBe("cursor-1");
  });

  test("a status write addresses the project item, not the issue", async () => {
    const { calls, request } = recording([page([ISSUE])]);
    const adapter = new GithubProjectsAdapter("acme", tracker, request);
    const record = toRecord(parseProjectBoard(page([ISSUE])).items[0]!, "acme");
    await adapter.setStatus(record, "Done");
    expect(calls[1]!.variables).toEqual({ project: "project-1", item: "item-1", field: "field-1", option: "opt-2" });
  });

  test("a ticket that is not on the board is refused rather than created", async () => {
    const { request } = recording([page([])]);
    const record = toRecord(parseProjectBoard(page([ISSUE])).items[0]!, "acme");
    await expect(new GithubProjectsAdapter("acme", tracker, request).setStatus(record, "Done")).rejects.toThrow(
      /not on the configured GitHub project board/,
    );
  });

  test("reads the board once per run, however many tickets it is asked about", async () => {
    const { calls, request } = recording([page([ISSUE])]);
    const adapter = new GithubProjectsAdapter("acme", tracker, request);
    await adapter.fetchTickets(["#12"]);
    await adapter.fetchTickets(["#12"]);
    expect(calls.filter((call) => call.query.startsWith("query Board"))).toHaveLength(1);
  });

  const fielded: TrackerConfig = { ...tracker, backlink: { slugField: "Slug", branchField: "Branch" } };

  function fieldedPage(nodes: unknown[]) {
    const base = page(nodes);
    return {
      organization: {
        projectV2: { ...base.organization.projectV2, slugField: { id: "slug-field" }, branchField: { id: "branch-field" } },
      },
    };
  }

  test("a text field write addresses the project item and the configured field", async () => {
    const { calls, request } = recording([fieldedPage([ISSUE])]);
    const adapter = new GithubProjectsAdapter("acme", fielded, request);
    const [record] = await adapter.fetchTickets(["#12"]);
    await adapter.setTextField(record!, "Slug", "workboard-export");
    expect(calls[1]!.query).toStartWith("mutation SetText");
    expect(calls[1]!.variables).toEqual({ project: "project-1", item: "item-1", field: "slug-field", text: "workboard-export" });
  });

  test("an empty value clears the field instead of writing an empty string", async () => {
    const { calls, request } = recording([fieldedPage([ISSUE])]);
    const adapter = new GithubProjectsAdapter("acme", fielded, request);
    const [record] = await adapter.fetchTickets(["#12"]);
    await adapter.setTextField(record!, "Branch", "");
    expect(calls[1]!.query).toStartWith("mutation ClearField");
    expect(calls[1]!.variables).toEqual({ project: "project-1", item: "item-1", field: "branch-field" });
  });

  test("a configured field the project lacks fails with the field's name", async () => {
    const { request } = recording([page([ISSUE])]);
    const adapter = new GithubProjectsAdapter("acme", fielded, request);
    const [record] = await adapter.fetchTickets(["#12"]);
    await expect(adapter.setTextField(record!, "Slug", "x")).rejects.toThrow(/no text field "Slug"/);
  });

  test("lists only open issues for the pull", async () => {
    const closed = { ...ISSUE, id: "item-2", content: { ...ISSUE.content, id: "issue-2", number: 13, state: "CLOSED" } };
    const open = { ...ISSUE, content: { ...ISSUE.content, state: "OPEN" } };
    const { request } = recording([page([open, closed])]);
    const records = await new GithubProjectsAdapter("acme", tracker, request).listOpenTickets();
    expect(records.map((r) => [r.ref.id, r.open])).toEqual([["#12", true]]);
  });

  test("closing and reopening address the issue", async () => {
    const { calls, request } = recording([page([ISSUE])]);
    const adapter = new GithubProjectsAdapter("acme", tracker, request);
    const [record] = await adapter.fetchTickets(["#12"]);
    await adapter.setOpen(record!, false);
    await adapter.setOpen(record!, true);
    expect(calls[1]!.query).toStartWith("mutation CloseIssue");
    expect(calls[2]!.query).toStartWith("mutation ReopenIssue");
    expect(calls[2]!.variables).toEqual({ id: "issue-1" });
  });
});

describe("boardQuery and field values", () => {
  test("asks for the configured text fields by name", () => {
    const query = boardQuery({ slugField: "Slug", branchField: "Branch" });
    expect(query).toContain('slugValue: fieldValueByName(name: "Slug")');
    expect(query).toContain('branchField: field(name: "Branch")');
    expect(boardQuery()).not.toContain("slugValue");
  });

  test("reads open state, author, creation time and field values", () => {
    const node = {
      ...ISSUE,
      slugValue: { text: "workboard-export" },
      branchValue: null,
      content: { ...ISSUE.content, state: "OPEN", author: { login: "bob" }, createdAt: "2026-09-01T10:00:00Z" },
    };
    const item = parseProjectBoard(page([node]), { slugField: "Slug", branchField: "Branch" }).items[0]!;
    const record = toRecord(item, "acme");
    expect(record.open).toBe(true);
    expect(record.author).toBe("bob");
    expect(record.createdAt).toBe("2026-09-01T10:00:00Z");
    expect(record.fields).toEqual({ Slug: "workboard-export" });
  });
});

describe("parseComments", () => {
  test("reads comments oldest first, with a ghost author for deleted accounts", () => {
    const data = {
      node: {
        comments: {
          nodes: [
            { author: { login: "bob" }, createdAt: "2026-09-02T10:00:00Z", body: "Still happens." },
            { author: null, createdAt: "2026-09-03T10:00:00Z", body: "Me too." },
          ],
        },
      },
    };
    expect(parseComments(data)).toEqual([
      { author: "bob", createdAt: "2026-09-02T10:00:00Z", body: "Still happens." },
      { author: "ghost", createdAt: "2026-09-03T10:00:00Z", body: "Me too." },
    ]);
  });
});

describe("fetchComments", () => {
  test("pages through every comment, oldest first", async () => {
    const pages = [
      { node: { comments: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [{ author: { login: "bob" }, createdAt: "2026-09-02T10:00:00Z", body: "one" }] } } },
      { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ author: { login: "eve" }, createdAt: "2026-09-03T10:00:00Z", body: "two" }] } } },
    ];
    const calls: Record<string, unknown>[] = [];
    let index = 0;
    const request = async (query: string, variables: Record<string, unknown>) => {
      calls.push(variables);
      return pages[index++];
    };
    const adapter = new GithubProjectsAdapter("acme", tracker, request);
    const record = toRecord(parseProjectBoard(page([ISSUE])).items[0]!, "acme");
    const comments = await adapter.fetchComments(record);
    expect(comments.map((c) => c.body)).toEqual(["one", "two"]);
    expect(calls[1]).toEqual({ id: "issue-1", cursor: "c1" });
  });
});

describe("fetchDescription", () => {
  test("reads the current body by issue id, not from the cached board", async () => {
    const calls: Record<string, unknown>[] = [];
    const request = async (query: string, variables: Record<string, unknown>) => {
      calls.push(variables);
      return { node: { body: "Edited since." } };
    };
    const record = toRecord(parseProjectBoard(page([ISSUE])).items[0]!, "acme");
    expect(await new GithubProjectsAdapter("acme", tracker, request).fetchDescription(record)).toBe("Edited since.");
    expect(calls).toEqual([{ id: "issue-1" }]);
  });
});

