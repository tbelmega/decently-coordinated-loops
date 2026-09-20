import { describe, expect, test } from "bun:test";
import { commitTemplates, isTicketId, validateTrackers, type TrackerConfig } from "./tracker-config.ts";

function trackers(overrides: Partial<TrackerConfig> = {}): unknown {
  return {
    acme: {
      kind: "linear",
      workspace: "acme",
      team: "ACM",
      statusMap: { "in-progress": "In Progress", delivered: "Done" },
      ...overrides,
    },
  };
}

describe("validateTrackers", () => {
  test("accepts a full declaration and returns it typed", () => {
    const parsed = validateTrackers(
      trackers({
        url: "https://linear.app/acme/team/ACM/active",
        owner: { account: "viewer" },
        pull: { unstartedStatuses: ["Triage", "Todo"] },
        tokenFile: "~/.secrets/linear-acme",
        commit: { subject: "[{id}]", body: "Related to {id}" },
      }),
    );
    expect(parsed.acme!.kind).toBe("linear");
    expect(parsed.acme!.pull!.unstartedStatuses).toEqual(["Triage", "Todo"]);
  });

  test("an absent block is an empty registry", () => {
    expect(validateTrackers(undefined)).toEqual({});
  });

  test("rejects an unknown kind, because a kind without an adapter cannot be synced", () => {
    expect(() => validateTrackers(trackers({ kind: "jira" as never }))).toThrow(/trackers\.acme\.kind/);
  });

  test("rejects a misspelled key rather than ignoring it", () => {
    expect(() => validateTrackers({ acme: { ...(trackers() as any).acme, statusmap: {} } })).toThrow(
      /trackers\.acme\.statusmap/,
    );
  });

  test("rejects a status map keyed by something that is not a board state", () => {
    expect(() => validateTrackers(trackers({ statusMap: { archived: "Done" } }))).toThrow(
      /trackers\.acme\.statusMap\.archived/,
    );
  });

  test("rejects an empty status name, which would erase a ticket's status", () => {
    expect(() => validateTrackers(trackers({ statusMap: { merged: "  " } }))).toThrow(/trackers\.acme\.statusMap\.merged/);
  });

  test("rejects a commit template without the id placeholder", () => {
    expect(() => validateTrackers(trackers({ commit: { subject: "[ticket]" } }))).toThrow(/\{id\}/);
  });

  test("rejects a commit template carrying a closing keyword of that tracker", () => {
    expect(() => validateTrackers(trackers({ commit: { body: "Fixes {id}" } }))).toThrow(/closing keyword/);
    expect(() =>
      validateTrackers({
        gh: { kind: "github-projects", workspace: "Acme/workboard", team: "8", statusMap: {}, commit: { subject: "closes {id}" } },
      }),
    ).toThrow(/closing keyword/);
  });

  test("rejects an empty unstartedStatuses list, which would make the pull silently find nothing", () => {
    expect(() => validateTrackers(trackers({ pull: { unstartedStatuses: [] } }))).toThrow(/unstartedStatuses/);
  });
});

describe("isTicketId", () => {
  test("a linear key is a team prefix and a number", () => {
    expect(isTicketId("linear", "ACM-123")).toBe(true);
    expect(isTicketId("linear", "#123")).toBe(false);
    expect(isTicketId("linear", "acm-123")).toBe(false);
  });

  test("a github ticket is a hash and a number", () => {
    expect(isTicketId("github-projects", "#123")).toBe(true);
    expect(isTicketId("github-projects", "123")).toBe(false);
    expect(isTicketId("github-projects", "ACM-123")).toBe(false);
  });
});

describe("commitTemplates", () => {
  test("linear links through a relation word, which moves no ticket", () => {
    expect(commitTemplates({ kind: "linear", workspace: "acme", team: "ACM", statusMap: {} })).toEqual({
      subject: "[{id}]",
      body: "Related to {id}",
    });
  });

  test("github cross-references on the bare number, so it needs no body line", () => {
    expect(commitTemplates({ kind: "github-projects", workspace: "Acme/workboard", team: "8", statusMap: {} })).toEqual({
      subject: "[{id}]",
    });
  });

  test("a project override replaces the default", () => {
    expect(
      commitTemplates({ kind: "linear", workspace: "acme", team: "ACM", statusMap: {}, commit: { subject: "({id})" } }),
    ).toEqual({ subject: "({id})", body: "Related to {id}" });
  });
});
