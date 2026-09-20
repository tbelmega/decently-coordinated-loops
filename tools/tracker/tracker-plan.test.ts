import { describe, expect, test } from "bun:test";
import type { TrackerConfig } from "./tracker-config.ts";
import { planStatusSync, ticketKey, type PlannerItem, type TicketSnapshot } from "./tracker-plan.ts";

const linear: TrackerConfig = {
  kind: "linear",
  workspace: "acme",
  team: "ACM",
  statusMap: {
    "spec-filed": "Todo",
    "in-progress": "In Progress",
    implemented: "In Review",
    merged: "In Review",
    tested: "In Review",
    delivered: "Done",
    accepted: "Done",
    dropped: "Canceled",
  },
};

const trackers = { acme: linear };

function item(slug: string, state: string, ids: string[]): PlannerItem {
  return { slug, state, tickets: ids.map((id) => ({ tracker: "acme", id })) };
}

function snapshot(id: string, status: string): TicketSnapshot {
  return { ref: { tracker: "acme", id }, status };
}

describe("planStatusSync", () => {
  test("advances a one-to-one ticket to the item's mapped status", () => {
    const plan = planStatusSync([item("workboard-export", "in-progress", ["ACM-1"])], [snapshot("ACM-1", "Todo")], trackers);
    expect(plan.transitions).toEqual([
      { ticket: { tracker: "acme", id: "ACM-1" }, from: "Todo", to: "In Progress", items: ["workboard-export"], reason: "advance" },
    ]);
    expect(plan.notes).toEqual([]);
  });

  test("plans every ticket of an item that carries several", () => {
    const plan = planStatusSync(
      [item("workboard-export", "merged", ["ACM-1", "ACM-2"])],
      [snapshot("ACM-1", "Todo"), snapshot("ACM-2", "In Progress")],
      trackers,
    );
    expect(plan.transitions.map((t) => [t.ticket.id, t.to])).toEqual([
      ["ACM-1", "In Review"],
      ["ACM-2", "In Review"],
    ]);
  });

  test("a shared ticket follows its least advanced item", () => {
    const plan = planStatusSync(
      [item("household-app-slideshow-photo-management", "delivered", ["ACM-7"]), item("workboard-export", "in-progress", ["ACM-7"])],
      [snapshot("ACM-7", "Todo")],
      trackers,
    );
    expect(plan.transitions).toEqual([
      {
        ticket: { tracker: "acme", id: "ACM-7" },
        from: "Todo",
        to: "In Progress",
        items: ["household-app-slideshow-photo-management", "workboard-export"],
        reason: "advance",
      },
    ]);
  });

  test("states sharing one tracker status collapse into one rank, so neither moves the ticket back", () => {
    const plan = planStatusSync(
      [item("a", "implemented", ["ACM-7"]), item("b", "tested", ["ACM-7"])],
      [snapshot("ACM-7", "In Review")],
      trackers,
    );
    expect(plan.transitions).toEqual([]);
    expect(plan.notes).toEqual([]);
  });

  test("a linked item in an unmapped state holds the ticket where it is", () => {
    const plan = planStatusSync(
      [item("a", "delivered", ["ACM-7"]), item("b", "blocked", ["ACM-7"])],
      [snapshot("ACM-7", "In Progress")],
      trackers,
    );
    expect(plan.transitions).toEqual([]);
    expect(plan.notes).toEqual([]);
    expect(plan.holds).toEqual([{ ticket: { tracker: "acme", id: "ACM-7" }, items: ["a", "b"], heldBy: ["b"] }]);
  });

  test("a ticket reaches the cancelled status only when every linked item is dropped", () => {
    const live = planStatusSync(
      [item("a", "dropped", ["ACM-7"]), item("b", "in-progress", ["ACM-7"])],
      [snapshot("ACM-7", "In Progress")],
      trackers,
    );
    expect(live.transitions).toEqual([]);

    const allDropped = planStatusSync(
      [item("a", "dropped", ["ACM-7"]), item("b", "dropped", ["ACM-7"])],
      [snapshot("ACM-7", "In Progress")],
      trackers,
    );
    expect(allDropped.transitions).toEqual([
      { ticket: { tracker: "acme", id: "ACM-7" }, from: "In Progress", to: "Canceled", items: ["a", "b"], reason: "cancel" },
    ]);
  });

  test("the cancelled status is never left automatically", () => {
    const plan = planStatusSync([item("a", "in-progress", ["ACM-7"])], [snapshot("ACM-7", "Canceled")], trackers);
    expect(plan.transitions).toEqual([]);
    expect(plan.notes).toEqual([
      {
        slug: "a",
        ticket: { tracker: "acme", id: "ACM-7" },
        kind: "unranked-status",
        text: 'ticket ACM-7 is at Canceled, which no board state ranks - leaving it alone',
      },
    ]);
  });

  test("a ticket ahead of the board is noted on the item and never moved back", () => {
    const plan = planStatusSync([item("a", "merged", ["ACM-7"])], [snapshot("ACM-7", "Done")], trackers);
    expect(plan.transitions).toEqual([]);
    expect(plan.notes).toEqual([
      {
        slug: "a",
        ticket: { tracker: "acme", id: "ACM-7" },
        kind: "ticket-ahead",
        text: "ticket ACM-7 is at Done while this item is merged",
      },
    ]);
  });

  test("a ticket in a status outside the map is left alone with a note", () => {
    const plan = planStatusSync([item("a", "merged", ["ACM-7"])], [snapshot("ACM-7", "Triage")], trackers);
    expect(plan.transitions).toEqual([]);
    expect(plan.notes).toEqual([
      {
        slug: "a",
        ticket: { tracker: "acme", id: "ACM-7" },
        kind: "unranked-status",
        text: "ticket ACM-7 is at Triage, which no board state ranks - leaving it alone",
      },
    ]);
  });

  test("note text carries no date, so a second run over unchanged state repeats itself exactly", () => {
    const run = () => planStatusSync([item("a", "merged", ["ACM-7"])], [snapshot("ACM-7", "Done")], trackers);
    expect(run().notes).toEqual(run().notes);
    expect(run().notes[0]!.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test("an item without tickets yields no transition, note or ticket reference", () => {
    const plan = planStatusSync([item("a", "merged", [])], [snapshot("ACM-7", "Todo")], trackers);
    expect(plan).toEqual({ transitions: [], notes: [], holds: [], unresolved: [] });
  });

  test("a referenced ticket missing from the snapshot is reported, not guessed at", () => {
    const plan = planStatusSync([item("a", "merged", ["ACM-9"])], [], trackers);
    expect(plan.transitions).toEqual([]);
    expect(plan.unresolved).toEqual([
      { ticket: { tracker: "acme", id: "ACM-9" }, items: ["a"], reason: "not-in-snapshot" },
    ]);
  });

  test("a ticket naming an unconfigured tracker is reported, not planned", () => {
    const plan = planStatusSync(
      [{ slug: "a", state: "merged", tickets: [{ tracker: "other", id: "ACM-9" }] }],
      [{ ref: { tracker: "other", id: "ACM-9" }, status: "Todo" }],
      trackers,
    );
    expect(plan.unresolved).toEqual([
      { ticket: { tracker: "other", id: "ACM-9" }, items: ["a"], reason: "unknown-tracker" },
    ]);
  });

  test("the same id under two trackers is two different tickets", () => {
    const beta: TrackerConfig = { ...linear, workspace: "beta", team: "BET" };
    const plan = planStatusSync(
      [
        { slug: "a", state: "in-progress", tickets: [{ tracker: "acme", id: "#12" }] },
        { slug: "b", state: "delivered", tickets: [{ tracker: "beta", id: "#12" }] },
      ],
      [
        { ref: { tracker: "acme", id: "#12" }, status: "Todo" },
        { ref: { tracker: "beta", id: "#12" }, status: "Todo" },
      ],
      { acme: linear, beta },
    );
    expect(plan.transitions.map((t) => [ticketKey(t.ticket), t.to])).toEqual([
      ["acme/#12", "In Progress"],
      ["beta/#12", "Done"],
    ]);
  });

  test("a project whose tracker maps no terminal cancel leaves a dropped item's ticket alone", () => {
    const noCancel: TrackerConfig = { ...linear, statusMap: { "in-progress": "In Progress" } };
    const plan = planStatusSync([item("a", "dropped", ["ACM-7"])], [snapshot("ACM-7", "In Progress")], { acme: noCancel });
    expect(plan.transitions).toEqual([]);
    expect(plan.notes).toEqual([]);
  });
});
