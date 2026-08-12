import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNPARSEABLE_PROJECT,
  appendOrphanRowEntry,
  orphanRoutingOutcome,
  replaceIfUnchanged,
  routeOrphanRows,
  withOutboxLock,
} from "./outbox.ts";
import type { OrphanRow } from "./preflight.ts";

const orphan: OrphanRow = {
  title: "Ghost row",
  path: "items/does-not-exist.md",
  project: "atlas",
  state: "idea",
  nextActor: "owner",
  awaiting: "decide",
  auto: "-",
  assignee: "codex/default",
  updated: "2026-07-01",
};

/** The heading shape the loops-queues entry contract defines, and the only one the
 * readers of this file parse: id, type, project, title, em dash then middle dots. */
const CANONICAL_HEADING = /^### (\d+) — (\S+) · (\S+) · (.+)$/m;

describe("appendOrphanRowEntry", () => {
  test("emits the canonical heading the entry contract defines", () => {
    const result = appendOrphanRowEntry(`# Outbox\n\n## Open\n`, orphan);
    const heading = CANONICAL_HEADING.exec(result);
    expect(heading).not.toBeNull();
    const [, id, type, project] = heading!;
    expect(id).toBe("1");
    expect(type).toBe("question");
    expect(project).toBe("atlas");
  });

  test("emits an answerable entry", () => {
    const result = appendOrphanRowEntry(`# Outbox\n\n## Open\n`, orphan);
    expect(result).toMatch(/^> A:$/m);
  });

  test("carries no `- item:` line — an orphan row is precisely a row with no item", () => {
    const result = appendOrphanRowEntry(`# Outbox\n\n## Open\n`, orphan);
    expect(result).not.toMatch(/^- item:/m);
  });

  test("records the dropped row's fields so its data is not lost with it", () => {
    const result = appendOrphanRowEntry(`# Outbox\n\n## Open\n`, orphan);
    expect(result).toContain("items/does-not-exist.md");
    expect(result).toContain("assignee=codex/default");
    expect(result).toContain("state=idea");
  });

  test("marks a label it cannot represent instead of inventing a project", () => {
    // The consumer reads the project field as one whitespace-free token and compares it
    // to its own project labels. A label like "family app" cannot be that token, and
    // neither substituting nor escaping it is honest: one merges two real projects, the
    // other names a project that exists nowhere. The exact label goes in the body.
    const spaced: OrphanRow = { ...orphan, project: "family app" };
    const result = appendOrphanRowEntry(`# Outbox\n\n## Open\n`, spaced);
    expect(CANONICAL_HEADING.exec(result)![3]).toBe(UNPARSEABLE_PROJECT);
    expect(result).toContain("project=family app");
  });

  const headingOf = (project: string) =>
    CANONICAL_HEADING.exec(appendOrphanRowEntry(`# Outbox\n\n## Open\n`, { ...orphan, project }))![3];

  test("never renames a project that already is a valid token", () => {
    expect(headingOf("family-app")).toBe("family-app");
    expect(headingOf("100%-done")).toBe("100%-done");
  });

  test("marks a padded label instead of trimming it into a real project", () => {
    expect(headingOf(" atlas ")).toBe(UNPARSEABLE_PROJECT);
    expect(headingOf("   ")).toBe(UNPARSEABLE_PROJECT);
  });

  test("uses a marker no board row could ever carry", () => {
    // A board row is split on `|` before its project cell is read, so a label containing
    // one cannot reach this writer — which is what makes the marker unforgeable rather
    // than just unlikely. A plain word would be a legal project name.
    expect(UNPARSEABLE_PROJECT).toContain("|");
    expect(headingOf("UNPARSEABLE")).toBe("UNPARSEABLE");
  });

  test("appends a new sequential entry after the highest existing ID", () => {
    const outbox = `# Outbox\n\n## Open\n\n### 1 — question · atlas · foo\n\n> A:\n\n### 2 — question · atlas · bar\n\n> A:\n`;
    const result = appendOrphanRowEntry(outbox, orphan);
    expect(CANONICAL_HEADING.exec(result.slice(result.indexOf("### 3")))![1]).toBe("3");
    expect(result.indexOf("### 3")).toBeGreaterThan(result.indexOf("### 2"));
  });

  test("numbers against the whole file, so an id never collides with an archived entry", () => {
    const outbox = `# Outbox\n\n## Open\n\n### 2 — question · atlas · bar\n\n> A:\n\n## Answered\n\n### 7 — question · atlas · settled\n\n> A: yes\n`;
    const result = appendOrphanRowEntry(outbox, orphan);
    expect(result).toContain("### 8 — question · atlas · ");
  });

  test("appends inside `## Open`, not after a later section", () => {
    const outbox = `# Outbox\n\n## Open\n\n### 1 — question · atlas · foo\n\n> A:\n\n## Answered\n\n### 7 — question · atlas · settled\n\n> A: yes\n`;
    const result = appendOrphanRowEntry(outbox, orphan);
    expect(result.indexOf("orphan BOARD.md row")).toBeLessThan(result.indexOf("## Answered"));
    expect(result).toContain("### 7 — question · atlas · settled");
  });

  test("refuses a file with no `## Open` section rather than guessing", () => {
    expect(() => appendOrphanRowEntry(`# Outbox\n`, orphan)).toThrow(/## Open/);
  });

  test("starts at 1 when there are no existing entries", () => {
    const result = appendOrphanRowEntry(`# Outbox\n\n## Open\n`, orphan);
    expect(result).toContain("### 1 — question · atlas · ");
  });

  test("is idempotent: re-appending the same orphan is a no-op", () => {
    const outbox = `# Outbox\n\n## Open\n`;
    const once = appendOrphanRowEntry(outbox, orphan);
    const twice = appendOrphanRowEntry(once, orphan);
    expect(twice).toBe(once);
    expect([...twice.matchAll(/orphan BOARD.md row with no item file/g)]).toHaveLength(1);
  });

  test("still appends a different orphan alongside an existing one", () => {
    const once = appendOrphanRowEntry(`# Outbox\n\n## Open\n`, orphan);
    const other: OrphanRow = { ...orphan, path: "items/other-ghost.md", title: "Other ghost" };
    const both = appendOrphanRowEntry(once, other);
    expect(both).toContain("items/does-not-exist.md");
    expect(both).toContain("items/other-ghost.md");
    expect([...both.matchAll(/orphan BOARD.md row with no item file/g)]).toHaveLength(2);
  });
});

describe("outbox file transactions", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dcl-outbox-"));
    path = join(dir, "OUTBOX.md");
    writeFileSync(path, `# Outbox\n\n## Open\n`);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe("withOutboxLock", () => {
    test("runs the body and returns its value", () => {
      expect(withOutboxLock(path, () => "done")).toBe("done");
    });

    test("returns null instead of running when the lock is held", () => {
      writeFileSync(`${path}.lock`, "999");
      let ran = false;
      expect(
        withOutboxLock(path, () => {
          ran = true;
          return "done";
        }),
      ).toBeNull();
      expect(ran).toBe(false);
    });

    test("does not strand the lock when its own initialization failed", () => {
      // Between the exclusive create and the token write the file is ours but anonymous.
      // A conditional release that only recognises the token would leave it forever.
      expect(() =>
        withOutboxLock(path, () => {
          writeFileSync(`${path}.lock`, ""); // as if the token write never landed
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(existsSync(`${path}.lock`)).toBe(false);
    });

    test("leaves a replacement lock alone when its own was removed under it", () => {
      // The documented manual recovery targets a crashed holder. Applied to a live one it
      // would otherwise cascade: this holder's release would delete the next holder's
      // lock, admitting a third writer into an occupied critical section.
      withOutboxLock(path, () => {
        rmSync(`${path}.lock`);
        writeFileSync(`${path}.lock`, "4242"); // a second writer acquired it
      });
      expect(readFileSync(`${path}.lock`, "utf8")).toBe("4242");
      rmSync(`${path}.lock`);
    });

    test("releases the lock afterwards, including when the body throws", () => {
      withOutboxLock(path, () => "done");
      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(() =>
        withOutboxLock(path, () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(existsSync(`${path}.lock`)).toBe(false);
    });
  });

  describe("replaceIfUnchanged", () => {
    test("writes when the file still holds the snapshot", () => {
      expect(replaceIfUnchanged(path, `# Outbox\n\n## Open\n`, "next")).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("next");
    });

    test("refuses, and preserves the newer content, when the file moved under us", () => {
      writeFileSync(path, "somebody else's edit");
      expect(replaceIfUnchanged(path, `# Outbox\n\n## Open\n`, "next")).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("somebody else's edit");
    });

    test("keeps the existing file mode, so a restricted outbox is not published", () => {
      chmodSync(path, 0o600);
      replaceIfUnchanged(path, `# Outbox\n\n## Open\n`, "next");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    test("leaves no temporary file behind", () => {
      replaceIfUnchanged(path, `# Outbox\n\n## Open\n`, "next");
      expect(readdirSync(dir).sort()).toEqual(["OUTBOX.md"]);
    });
  });

  describe("routeOrphanRows", () => {
    test("routes the rows and reports how many", () => {
      expect(routeOrphanRows(path, [orphan])).toEqual({ status: "routed", count: 1 });
      expect(CANONICAL_HEADING.test(readFileSync(path, "utf8"))).toBe(true);
    });

    test("counts what it appended, not what it was asked to append", () => {
      const other: OrphanRow = { ...orphan, path: "items/other-ghost.md", title: "Other ghost" };
      routeOrphanRows(path, [orphan]);
      expect(routeOrphanRows(path, [orphan, other])).toEqual({ status: "routed", count: 1 });
      expect(orphanRoutingOutcome({ status: "routed", count: 1 }, 2).message).toContain("already recorded");
    });

    test("reports `unchanged` when every row is already recorded", () => {
      routeOrphanRows(path, [orphan]);
      const after = readFileSync(path, "utf8");
      expect(routeOrphanRows(path, [orphan])).toEqual({ status: "unchanged" });
      expect(readFileSync(path, "utf8")).toBe(after);
    });

    test("reports `conflict` and preserves the other writer's content", () => {
      // The conflict branch is a race between the snapshot read and the verification
      // read, so the injected reader stands exactly where a competing writer would: the
      // snapshot is the real file, and by verification time the file has moved on.
      const other = "somebody else's edit\n";
      let reads = 0;
      const racingRead = (target: string) => {
        reads += 1;
        if (reads === 1) return readFileSync(target, "utf8");
        writeFileSync(target, other);
        return other;
      };

      expect(routeOrphanRows(path, [orphan], racingRead)).toEqual({ status: "conflict" });
      expect(readFileSync(path, "utf8")).toBe(other);
    });

    test("reports `locked` rather than writing behind another writer's lock", () => {
      writeFileSync(`${path}.lock`, "999");
      expect(routeOrphanRows(path, [orphan])).toEqual({ status: "locked" });
      expect(readFileSync(path, "utf8")).toBe(`# Outbox\n\n## Open\n`);
    });
  });
});

describe("orphanRoutingOutcome", () => {
  test("lets sync continue when the rows reached the outbox", () => {
    expect(orphanRoutingOutcome({ status: "routed", count: 2 }, 2).abort).toBe(false);
    expect(orphanRoutingOutcome({ status: "unchanged" }, 2).abort).toBe(false);
  });

  test("aborts sync when the rows did not reach the outbox", () => {
    // Continuing would regenerate BOARD.md without the orphan rows — they have no item
    // file, so the board is the only remaining copy. The next sync could not re-route
    // what it can no longer see.
    for (const routing of [{ status: "locked" } as const, { status: "conflict" } as const]) {
      const outcome = orphanRoutingOutcome(routing, 2);
      expect(outcome.abort).toBe(true);
      expect(outcome.message).toContain("NOT routed");
    }
  });
});
