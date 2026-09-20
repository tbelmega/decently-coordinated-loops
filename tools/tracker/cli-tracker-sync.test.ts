// CLI-level cover for the guards around the status phase. The adapters themselves are
// exercised in their own tests; what matters here is that a run without a tracker, a
// wrong phase, or a wrong directory does nothing and says so.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SYNC = join(resolve(import.meta.dirname, "..", ".."), "tools", "tracker", "cli-tracker-sync.ts");
const created: string[] = [];

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function dataRepo(config: unknown = { owner: "Alice" }): string {
  const root = mkdtempSync(join(tmpdir(), "dcl-tracker-"));
  created.push(root);
  mkdirSync(join(root, "items"));
  writeFileSync(join(root, "BOARD.md"), "# Board\n");
  writeFileSync(join(root, "OUTBOX.md"), "# Outbox\n\n## Open\n");
  writeFileSync(join(root, "loops.json"), JSON.stringify(config));
  writeFileSync(
    join(root, "items", "workboard-export.md"),
    [
      "---",
      "title: Export",
      "project: workboard",
      "state: merged",
      'assignee: "-"',
      "autonomy: auto",
      "next-actor: agent",
      "next-step: verify",
      "updated: 2026-09-20",
      "---",
      "Context.",
      "",
      "## Log",
      "- 2026-09-20: Filed.",
    ].join("\n"),
  );
  return root;
}

describe("cli-tracker-sync", () => {
  test("refuses to run outside a data repo", () => {
    const outside = mkdtempSync(join(tmpdir(), "dcl-elsewhere-"));
    created.push(outside);
    const result = spawnSync("bun", [SYNC, "status"], { cwd: outside, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not a loops data repo");
  });

  test("names the phases it has rather than guessing one", () => {
    const result = spawnSync("bun", [SYNC], { cwd: dataRepo(), encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("tracker-sync status");
  });

  test("an instance with no tracker plans nothing and touches nothing", () => {
    const result = spawnSync("bun", [SYNC, "status"], { cwd: dataRepo(), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry run");
    expect(result.stdout).toContain("0 transition(s)");
  });

  test("a tracker that cannot be reached fails the run and files exactly one ask", () => {
    const root = dataRepo({
      owner: "Alice",
      trackers: { acme: { kind: "linear", workspace: "acme", team: "ACM", statusMap: { merged: "In Review" } } },
      projects: { workboard: { tracker: "acme" } },
    });
    writeFileSync(
      join(root, "items", "workboard-export.md"),
      ["---", "title: Export", "project: workboard", "state: merged", "tickets: [ACM-7]", "next-actor: agent", "next-step: verify", "updated: 2026-09-20", "---", "Context.", ""].join("\n"),
    );
    const first = spawnSync("bun", [SYNC, "status"], { cwd: root, encoding: "utf8" });
    expect(first.status).toBe(1);
    expect(first.stderr).toContain("tokenFile");
    spawnSync("bun", [SYNC, "status"], { cwd: root, encoding: "utf8" });
    const outbox = readFileSync(join(root, "OUTBOX.md"), "utf8");
    expect(outbox.match(/loops:tracker-sync acme/g)).toHaveLength(1);
  });
});
