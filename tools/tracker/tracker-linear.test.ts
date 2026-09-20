import { describe, expect, test } from "bun:test";
import { graphQlData, issueNumber, LinearAdapter, parseIssues, stateId } from "./tracker-linear.ts";
import type { TrackerConfig } from "./tracker-config.ts";

const tracker: TrackerConfig = { kind: "linear", workspace: "acme", team: "ACM", statusMap: {} };

const ISSUES = {
  issues: {
    nodes: [
      {
        id: "uuid-1",
        identifier: "ACM-12",
        title: "Weekly report export",
        description: "Body.",
        url: "https://linear.app/acme/issue/ACM-12",
        state: { name: "In Progress" },
        assignee: { displayName: "Alice" },
      },
      { id: "uuid-2", identifier: "ACM-13", description: null, state: { name: "Todo" }, assignee: null },
    ],
  },
};

describe("issueNumber", () => {
  test("reads the number out of the team's own identifier", () => {
    expect(issueNumber("ACM", "ACM-12")).toBe(12);
  });

  test("refuses a key belonging to another team", () => {
    expect(() => issueNumber("ACM", "BET-12")).toThrow(/does not belong to Linear team ACM/);
  });
});

describe("graphQlData", () => {
  test("turns an API error into a named failure instead of an empty result", () => {
    expect(() => graphQlData({ errors: [{ message: "Authentication required" }] }, "issue query")).toThrow(
      /issue query: Authentication required/,
    );
  });

  test("treats a data-less response as a failure", () => {
    expect(() => graphQlData({}, "issue query")).toThrow(/no data/);
  });
});

describe("parseIssues", () => {
  test("qualifies each issue with the tracker it came from", () => {
    const records = parseIssues(ISSUES, "acme");
    expect(records[0]).toEqual({
      ref: { tracker: "acme", id: "ACM-12" },
      externalId: "uuid-1",
      status: "In Progress",
      description: "Body.",
      title: "Weekly report export",
      url: "https://linear.app/acme/issue/ACM-12",
      assignee: "Alice",
    });
  });

  test("an unassigned issue without a description names neither", () => {
    const record = parseIssues(ISSUES, "acme")[1]!;
    expect(record.description).toBe("");
    expect(record.assignee).toBeUndefined();
  });
});

describe("stateId", () => {
  const states = { teams: { nodes: [{ id: "team-1", key: "ACM", states: { nodes: [{ id: "s1", name: "Todo" }, { id: "s2", name: "Done" }] } }] } };

  test("resolves a configured status to its workflow state", () => {
    expect(stateId(states, "ACM", "Done")).toBe("s2");
  });

  test("fails loudly on a renamed status, listing what the team has", () => {
    expect(() => stateId(states, "ACM", "Shipped")).toThrow(/has no workflow state "Shipped" \(it has Todo, Done\)/);
  });
});

describe("LinearAdapter", () => {
  function recording(responses: Record<string, unknown>) {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const request = async (query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables });
      const key = query.startsWith("query Issues") ? "issues" : query.startsWith("query TeamStates") ? "states" : "update";
      return { data: responses[key] } as { data: unknown };
    };
    return { calls, request };
  }

  test("asks for exactly the numbers it was given, under the tracker's team", async () => {
    const { calls, request } = recording({ issues: ISSUES });
    const records = await new LinearAdapter("acme", tracker, request).fetchTickets(["ACM-12", "ACM-13"]);
    expect(calls[0]!.variables).toEqual({ team: "ACM", numbers: [12, 13] });
    expect(records.map((r) => r.ref.id)).toEqual(["ACM-12", "ACM-13"]);
  });

  test("fetches nothing when the board names no ticket", async () => {
    const { calls, request } = recording({});
    expect(await new LinearAdapter("acme", tracker, request).fetchTickets([])).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("moves an issue by resolving the status name first", async () => {
    const { calls, request } = recording({
      states: { teams: { nodes: [{ id: "t", key: "ACM", states: { nodes: [{ id: "s2", name: "Done" }] } }] } },
      update: { issueUpdate: { success: true } },
    });
    const record = { ref: { tracker: "acme", id: "ACM-12" }, externalId: "uuid-1", status: "Todo", description: "" };
    await new LinearAdapter("acme", tracker, request).setStatus(record, "Done");
    expect(calls[1]!.variables).toEqual({ id: "uuid-1", input: { stateId: "s2" } });
  });

  test("writes a description without touching anything else on the issue", async () => {
    const { calls, request } = recording({ update: { issueUpdate: { success: true } } });
    await new LinearAdapter("acme", tracker, request).setDescription("uuid-1", "Body.\n\nDCL: workboard-export");
    expect(calls[0]!.variables).toEqual({ id: "uuid-1", input: { description: "Body.\n\nDCL: workboard-export" } });
  });
});
