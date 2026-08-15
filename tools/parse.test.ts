import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadArchiveDir, loadForDeliveryDir, loadItemsDir, parseItemFileText } from "./parse.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__/items");
const ARCHIVE_FIXTURES = join(import.meta.dir, "__fixtures__/archive");
const FOR_DELIVERY_FIXTURES = join(import.meta.dir, "__fixtures__/for-delivery");

describe("parseItemFileText", () => {
  test("parses core fields from frontmatter", () => {
    const text = `---
title: "Alpha needs approve"
project: alpha
state: spec-filed
owner: "-"
autonomy: supervised
next-actor: owner
awaiting: approve
next-step: "Owner: approve the spec"
updated: 2026-07-01
---
Body text.
`;
    const item = parseItemFileText("items/alpha-needs-approve.md", text);
    expect(item.slug).toBe("alpha-needs-approve");
    expect(item.title).toBe("Alpha needs approve");
    expect(item.project).toBe("alpha");
    expect(item.state).toBe("spec-filed");
    expect(item).toMatchObject({ assignee: "-" });
    expect(item.nextActor).toBe("owner");
    expect(item.awaiting).toBe("approve");
    expect(item.updated).toBe("2026-07-01");
    expect(item.dependsOn).toEqual([]);
    // No `spec:` key in the frontmatter → absent, not "".
    expect(item.spec).toBeUndefined();
  });

  test("prefers the assignee field for new items", () => {
    const text = `---
title: "Assigned item"
project: alpha
state: in-progress
assignee: codex/default
autonomy: supervised
next-actor: agent
next-step: "Build it"
updated: 2026-08-09
---
Body.
`;
    expect(parseItemFileText("items/assigned-item.md", text)).toMatchObject({
      assignee: "codex/default",
    });
  });

  test("retains the legacy owner value only when both assignment keys are present", () => {
    const text = `---
title: "Conflicting assignment"
project: alpha
state: in-progress
assignee: codex/default
owner: claude-code/primary
autonomy: supervised
next-actor: agent
next-step: "Resolve the conflict"
updated: 2026-08-09
---
Body.
`;
    expect(parseItemFileText("items/conflicting-assignment.md", text)).toMatchObject({
      assignee: "codex/default",
      legacyOwner: "claude-code/primary",
    });
  });

  test("records which assignment key the item was written with", () => {
    const base = `---
title: "Keyed item"
project: alpha
state: in-progress
KEY
autonomy: supervised
next-actor: agent
next-step: "Build it"
updated: 2026-08-09
---
`;
    const parsedWith = (line: string) => parseItemFileText("items/keyed-item.md", base.replace("KEY", line));
    expect(parsedWith("assignee: codex/default").assignmentKey).toBe("assignee");
    expect(parsedWith("owner: codex/default").assignmentKey).toBe("owner");
    expect(parsedWith("assignee: codex/default\nowner: claude-code/primary").assignmentKey).toBe("assignee");
    expect(parsedWith('fit: "mechanical"').assignmentKey).toBeUndefined();
  });

  test("parses absent and partial execution locators", () => {
    const absent = `---
title: "No location"
project: alpha
state: idea
assignee: "-"
autonomy: supervised
next-actor: agent
next-step: "Wait"
updated: 2026-08-09
---
`;
    const hostOnly = absent.replace('title: "No location"', 'title: "Host selected"').replace(
      "updated: 2026-08-09",
      "execution:\n  host: worker-one\nupdated: 2026-08-09",
    );
    const worktreeOnly = absent.replace('title: "No location"', 'title: "Worktree selected"').replace(
      "updated: 2026-08-09",
      "execution:\n  worktree: /srv/work/project\nupdated: 2026-08-09",
    );

    expect(parseItemFileText("items/no-location.md", absent).execution).toBeUndefined();
    expect(parseItemFileText("items/host-selected.md", hostOnly)).toMatchObject({
      execution: { host: "worker-one" },
    });
    expect(parseItemFileText("items/worktree-selected.md", worktreeOnly)).toMatchObject({
      execution: { worktree: "/srv/work/project" },
    });
  });

  test("parses a complete execution locator", () => {
    const text = `---
title: "Located item"
project: alpha
state: in-progress
assignee: codex/default
autonomy: supervised
next-actor: agent
execution:
  host: worker-one
  worktree: /srv/work/project
next-step: "Build it"
updated: 2026-08-09
---
`;
    expect(parseItemFileText("items/located-item.md", text)).toMatchObject({
      execution: { host: "worker-one", worktree: "/srv/work/project" },
    });
  });

  test("parses the owner's spec waiver", () => {
    const text = `---
title: "Waived item"
project: alpha
state: in-progress
owner: "-"
autonomy: auto
next-actor: agent
spec: waived
next-step: "Build it"
updated: 2026-07-19
---
Body.
`;
    expect(parseItemFileText("items/waived-item.md", text).spec).toBe("waived");
  });

  test("parses depends-on array and links block", () => {
    const text = `---
title: "Delivery slice"
project: atlas
state: spec-filed
owner: "-"
autonomy: auto
next-actor: agent
depends-on: [atlas-foundation, atlas-other]
next-step: "Build it"
updated: 2026-07-06
links:
  spec: docs/specs/2026-07-08-thing.md
  pr: https://github.com/example/pr/1
  inventory: docs/inventory/current.md
  parent-item: items/atlas-parent.md
---
Body.
`;
    const item = parseItemFileText("items/delivery-slice.md", text);
    expect(item.dependsOn).toEqual(["atlas-foundation", "atlas-other"]);
    expect(item.links.spec).toBe("docs/specs/2026-07-08-thing.md");
    expect(item.links.pr).toBe("https://github.com/example/pr/1");
    expect(item.links.inventory).toBe("docs/inventory/current.md");
    expect(item.links["parent-item"]).toBe("items/atlas-parent.md");
    // Absent stack fields must be absent keys, not own-properties set to undefined.
    expect(Object.keys(item.links)).toEqual(["spec", "pr", "inventory", "parent-item"]);
  });

  test("parses immutable handoff and stack-parent links", () => {
    const text = `---
title: "Stacked delivery slice"
project: atlas
state: implemented
owner: agent-1
autonomy: auto
next-actor: owner
awaiting: review-merge
next-step: "Owner lands it"
updated: 2026-07-19
links:
  branch: agents/worker-1--stacked-delivery-slice
  stack-parent: first-delivery-slice
  base-sha: abc123
  head-sha: def456
---
Body.
`;
    const item = parseItemFileText("items/stacked-delivery-slice.md", text);
    expect(item.links).toEqual({
      branch: "agents/worker-1--stacked-delivery-slice",
      stackParent: "first-delivery-slice",
      baseSha: "abc123",
      headSha: "def456",
    });
  });

  test("omits awaiting when absent", () => {
    const text = `---
title: "Agent item"
project: atlas
state: spec-filed
owner: "-"
autonomy: auto
next-actor: agent
next-step: "Build it"
updated: 2026-07-06
---
Body.
`;
    const item = parseItemFileText("items/agent-item.md", text);
    expect(item.awaiting).toBeUndefined();
  });

  test("throws on missing frontmatter block", () => {
    expect(() => parseItemFileText("items/broken.md", "no frontmatter here")).toThrow();
  });
});

describe("loadItemsDir", () => {
  test("loads and sorts all fixture item files by slug", () => {
    const items = loadItemsDir(FIXTURES);
    expect(items.length).toBe(14);
    const slugs = items.map((i) => i.slug);
    expect(slugs).toEqual([...slugs].sort());
    const one = items.find((i) => i.slug === "atlas-ready-blocked");
    expect(one?.dependsOn).toEqual(["atlas-dep-target-unmerged"]);
  });
});

describe("loadArchiveDir", () => {
  test("loads and sorts all fixture archive files by slug, with archive/ paths", () => {
    const items = loadArchiveDir(ARCHIVE_FIXTURES);
    expect(items.length).toBe(2);
    const slugs = items.map((i) => i.slug);
    expect(slugs).toEqual(["zeta-accepted", "zeta-dropped"]);
    const accepted = items.find((i) => i.slug === "zeta-accepted");
    expect(accepted?.path).toBe("archive/zeta-accepted.md");
    expect(accepted?.state).toBe("accepted");
  });

  test("returns an empty array for a directory that doesn't exist yet", () => {
    expect(loadArchiveDir(join(import.meta.dir, "__fixtures__/no-such-archive-dir"))).toEqual([]);
  });
});

describe("loadForDeliveryDir", () => {
  test("loads for-delivery files by slug, with for-delivery/ paths", () => {
    const items = loadForDeliveryDir(FOR_DELIVERY_FIXTURES);
    const slugs = items.map((i) => i.slug);
    expect(slugs).toEqual(["eta-delivered", "eta-tested"]);
    const tested = items.find((i) => i.slug === "eta-tested");
    expect(tested?.path).toBe("for-delivery/eta-tested.md");
    expect(tested?.state).toBe("tested");
  });

  test("returns an empty array for a directory that doesn't exist yet", () => {
    expect(loadForDeliveryDir(join(import.meta.dir, "__fixtures__/no-such-dir"))).toEqual([]);
  });
});
