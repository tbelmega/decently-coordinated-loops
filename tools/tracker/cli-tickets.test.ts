// CLI-level cover for the commit-reference helper: agents copy what it prints into a
// commit, so its wording for "nothing to append" matters as much as the suffix itself.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TICKETS = join(resolve(import.meta.dirname, "..", ".."), "tools", "tracker", "cli-tickets.ts");
const created: string[] = [];

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function dataRepo(tickets: string | null, project = "workboard"): string {
  const root = mkdtempSync(join(tmpdir(), "dcl-tickets-"));
  created.push(root);
  mkdirSync(join(root, "items"));
  writeFileSync(join(root, "BOARD.md"), "# Board\n");
  writeFileSync(
    join(root, "loops.json"),
    JSON.stringify({
      owner: "Alice",
      trackers: { acme: { kind: "linear", workspace: "acme", team: "ACM", statusMap: { merged: "In Review" } } },
      projects: { workboard: { tracker: "acme" }, daybook: {} },
    }),
  );
  writeFileSync(
    join(root, "items", "workboard-export.md"),
    [
      "---",
      "title: Export",
      `project: ${project}`,
      "state: in-progress",
      'assignee: "-"',
      "autonomy: auto",
      "next-actor: agent",
      ...(tickets === null ? [] : [`tickets: ${tickets}`]),
      "next-step: build it",
      "updated: 2026-09-20",
      "---",
      "Context.",
    ].join("\n"),
  );
  return root;
}

function run(root: string, slug = "workboard-export") {
  return spawnSync("bun", [TICKETS, slug], { cwd: root, encoding: "utf8" });
}

describe("cli-tickets", () => {
  test("prints the subject suffix and the relation lines for a linear item", () => {
    const result = run(dataRepo("[ACM-12, ACM-15]"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[ACM-12] [ACM-15]");
    expect(result.stdout).toContain("Related to ACM-12");
    expect(result.stdout).toContain("Related to ACM-15");
  });

  test("says plainly that a local item's commits carry no reference", () => {
    const result = run(dataRepo("local"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no ticket reference");
  });

  test("points an undecided item at the decision rather than printing an empty suffix", () => {
    const result = run(dataRepo(null));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("tickets: local");
    expect(result.stdout).not.toContain("Subject suffix");
  });

  test("a project without a tracker gets no reference", () => {
    const result = run(dataRepo(null, "daybook"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("declares no tracker");
  });

  test("an unknown slug fails rather than printing nothing", () => {
    const result = run(dataRepo("[ACM-12]"), "no-such-item");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no item file");
  });
});
