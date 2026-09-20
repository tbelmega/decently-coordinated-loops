import { describe, expect, test } from "bun:test";
import type { LoopsConfig } from "../config.ts";
import type { ItemFile } from "../types.ts";
import { missingTicketDecisions, resolveItemTickets } from "./tracker-items.ts";

const config = {
  owner: "Alice",
  priorityProjects: [],
  integrationBranch: "master",
  landedAdapter: "git",
  githubTokens: {},
  trackers: {
    acme: {
      kind: "linear" as const,
      workspace: "acme",
      team: "ACM",
      statusMap: { "in-progress": "In Progress" },
    },
  },
  projects: {
    workboard: { tracker: "acme" },
    daybook: {},
  },
  review: {},
} satisfies LoopsConfig;

function item(overrides: Partial<ItemFile> & { slug: string }): ItemFile {
  return {
    path: `items/${overrides.slug}.md`,
    title: overrides.slug,
    project: "workboard",
    state: "spec-filed",
    assignee: "-",
    autonomy: "auto",
    nextActor: "agent",
    dependsOn: [],
    nextStep: "-",
    updated: "2026-09-20",
    links: {},
    ...overrides,
  };
}

describe("resolveItemTickets", () => {
  test("qualifies the item's ids with the tracker its project names", () => {
    expect(resolveItemTickets(item({ slug: "a", tickets: ["ACM-1", "ACM-2"] }), config)).toEqual([
      { tracker: "acme", id: "ACM-1" },
      { tracker: "acme", id: "ACM-2" },
    ]);
  });

  test("an item marked local, undecided, or in a project without a tracker names no ticket", () => {
    expect(resolveItemTickets(item({ slug: "a", tickets: "local" }), config)).toEqual([]);
    expect(resolveItemTickets(item({ slug: "a" }), config)).toEqual([]);
    expect(resolveItemTickets(item({ slug: "a", project: "daybook", tickets: ["ACM-1"] }), config)).toEqual([]);
  });
});

describe("missingTicketDecisions", () => {
  test("nudges an item in a tracker project that has decided nothing", () => {
    expect(missingTicketDecisions([item({ slug: "a", state: "spec-filed" })], config)).toEqual(["a"]);
  });

  test("stays silent once the item names tickets or says local", () => {
    expect(missingTicketDecisions([item({ slug: "a", tickets: ["ACM-1"] }), item({ slug: "b", tickets: "local" })], config)).toEqual(
      [],
    );
  });

  test("stays silent before the work is real, and for states off the ladder", () => {
    const early = [item({ slug: "a", state: "idea" }), item({ slug: "b", state: "blocked" }), item({ slug: "c", state: "dropped" })];
    expect(missingTicketDecisions(early, config)).toEqual([]);
  });

  test("nudges every state from spec-filed on", () => {
    const later = ["in-progress", "merged", "accepted"].map((state, index) => item({ slug: `s${index}`, state }));
    expect(missingTicketDecisions(later, config)).toEqual(["s0", "s1", "s2"]);
  });

  test("says nothing about a project with no tracker", () => {
    expect(missingTicketDecisions([item({ slug: "a", project: "daybook" })], config)).toEqual([]);
  });
});
