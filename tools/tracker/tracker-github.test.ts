import { describe, expect, test } from "bun:test";
import {
  GithubProjectsAdapter,
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
});
