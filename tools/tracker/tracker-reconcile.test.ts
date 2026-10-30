import { describe, expect, test } from "bun:test";
import { mismatchNotes, planReconcile } from "./tracker-reconcile.ts";
import type { TicketRecord } from "./tracker-adapter.ts";
import type { PlannerItem } from "./tracker-plan.ts";
import type { TrackerConfig } from "./tracker-config.ts";

const trackers: Record<string, TrackerConfig> = {
  acme: {
    kind: "github-projects",
    workspace: "Acme/workboard",
    team: "8",
    statusMap: { "spec-filed": "Ready", "in-progress": "In progress", merged: "In review", delivered: "Shipped", accepted: "Accepted" },
  },
};

function item(slug: string, state: string, ids = ["#7"]): PlannerItem {
  return { slug, state, tickets: ids.map((id) => ({ tracker: "acme", id })) };
}

function record(status: string, open = true, id = "#7"): TicketRecord {
  return { ref: { tracker: "acme", id }, externalId: `issue-${id}`, status, description: "", open };
}

describe("planReconcile", () => {
  test("a ticket ahead of the board is one mismatch with both directions offered", () => {
    const [mismatch] = planReconcile([item("workboard-export", "merged")], [record("Accepted")], trackers);
    expect(mismatch).toMatchObject({ kind: "ticket-ahead", ticket: { id: "#7" }, items: ["workboard-export"] });
    expect(mismatch!.recommendation).toContain("move workboard-export to accepted");
    expect(mismatch!.recommendation).toContain("move the ticket back to In review");
  });

  test("a status outside the map asks to map it or move the ticket", () => {
    const [mismatch] = planReconcile([item("workboard-export", "merged")], [record("Needs triage")], trackers);
    expect(mismatch!.kind).toBe("unranked-status");
    expect(mismatch!.recommendation).toContain('add "Needs triage" to the statusMap');
  });

  test("a closed ticket while work is still open", () => {
    const mismatches = planReconcile([item("workboard-export", "in-progress")], [record("In progress", false)], trackers);
    expect(mismatches.map((m) => m.kind)).toEqual(["closed-while-active"]);
    expect(mismatches[0]!.recommendation).toContain("reopen the ticket");
  });

  test("an open ticket whose every item is finished", () => {
    const mismatches = planReconcile(
      [item("workboard-a", "accepted"), item("workboard-b", "dropped")],
      [record("Accepted", true)],
      trackers,
    );
    expect(mismatches.map((m) => m.kind)).toEqual(["open-while-finished"]);
    expect(mismatches[0]!.recommendation).toContain("close the ticket");
  });

  test("a linked ticket missing from the board", () => {
    const mismatches = planReconcile([item("workboard-export", "merged")], [], trackers);
    expect(mismatches.map((m) => m.kind)).toEqual(["missing"]);
  });

  test("a ticket in step, or one the push will advance by itself, is no mismatch", () => {
    expect(planReconcile([item("workboard-export", "merged")], [record("In review")], trackers)).toEqual([]);
    expect(planReconcile([item("workboard-export", "merged")], [record("Ready")], trackers)).toEqual([]);
  });

  test("a tracker without open/closed state never reports the open/closed classes", () => {
    const { open: _open, ...stateless } = record("Accepted");
    expect(planReconcile([item("workboard-export", "accepted")], [stateless], trackers)).toEqual([]);
  });

  test("a ticket both ahead and closed is one mismatch, so the interview asks once", () => {
    const mismatches = planReconcile([item("workboard-export", "merged")], [record("Accepted", false)], trackers);
    expect(mismatches.map((m) => m.kind)).toEqual(["ticket-ahead"]);
    expect(mismatches[0]!.detail).toContain("Accepted and closed");
  });

  test("an advanced ticket linked to a freshly pulled idea is a mismatch, despite the push holding it", () => {
    const mismatches = planReconcile([item("workboard-pulled", "idea")], [record("In progress")], trackers);
    expect(mismatches.map((m) => m.kind)).toEqual(["ticket-ahead"]);
    expect(mismatches[0]!.recommendation).toContain("move workboard-pulled to in-progress");
  });

  test("a ticket still in an unstarted status is no mismatch for an idea", () => {
    const withFloor = { acme: { ...trackers.acme!, pull: { unstartedStatuses: ["Backlog", "Ready"] } } };
    expect(planReconcile([item("workboard-pulled", "idea")], [record("Ready")], withFloor)).toEqual([]);
    expect(planReconcile([item("workboard-pulled", "idea")], [record("Backlog")], withFloor)).toEqual([]);
    expect(planReconcile([item("workboard-pulled", "idea")], [record("Shipped")], withFloor).map((m) => m.kind)).toEqual(["ticket-ahead"]);
  });

  test("the floor recommendation names the first unstarted status", () => {
    const withFloor = { acme: { ...trackers.acme!, pull: { unstartedStatuses: ["Backlog", "Ready"] } } };
    const [mismatch] = planReconcile([item("workboard-pulled", "idea")], [record("In progress")], withFloor);
    expect(mismatch!.recommendation).toContain("move the ticket back to Backlog");
  });
});

describe("mismatchNotes", () => {
  test("one note per linked item, skipping what the status push already notes", () => {
    const mismatches = planReconcile(
      [item("workboard-a", "in-progress", ["#7"]), item("workboard-b", "merged", ["#8"])],
      [record("In progress", false, "#7"), record("Accepted", true, "#8")],
      trackers,
    );
    const notes = mismatchNotes(mismatches);
    expect(notes.map((n) => n.slug)).toEqual(["workboard-a"]);
    expect(notes[0]!.text).toContain("ticket #7 [closed-while-active]");
    expect(notes[0]!.text).toContain("options: ");
  });
});

describe("planReconcile on shared tickets held by an idea", () => {
  test("a started ticket shared by an idea and an in-progress item is reported for the idea", () => {
    const mismatches = planReconcile(
      [item("workboard-pulled", "idea"), item("workboard-build", "in-progress")],
      [record("In progress")],
      trackers,
    );
    expect(mismatches.map((m) => [m.kind, m.items])).toEqual([["ticket-ahead", ["workboard-build", "workboard-pulled"]]]);
    expect(mismatches[0]!.recommendation).toContain("move workboard-pulled to in-progress");
    expect(mismatches[0]!.recommendation).toContain("unlink");
  });

  test("a blocked sibling alone is a hold, not a mismatch", () => {
    expect(planReconcile([item("workboard-a", "blocked"), item("workboard-b", "in-progress")], [record("In progress")], trackers)).toEqual([]);
  });
});

