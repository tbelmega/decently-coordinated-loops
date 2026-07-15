import { describe, expect, test } from "bun:test";
import { posix } from "node:path";
import { expandHome, matchProject, type Canonicalize } from "./registration.ts";

const HOME = "/home/casey";

// A deterministic, existence-free stand-in for the CLI's realpath-based canonicalizer:
// tilde-expand, then resolve — the faithful analog of the CLI's `resolve()` on this
// platform (strips trailing slashes, normalizes) without touching the filesystem.
const canonicalize: Canonicalize = (path) => posix.resolve(expandHome(path, HOME));

describe("expandHome", () => {
  test("expands a bare tilde and a tilde-prefixed path", () => {
    expect(expandHome("~", HOME)).toBe(HOME);
    expect(expandHome("~/workspace/app", HOME)).toBe("/home/casey/workspace/app");
  });

  test("leaves absolute and tilde-in-name paths alone", () => {
    expect(expandHome("/opt/app", HOME)).toBe("/opt/app");
    expect(expandHome("~backup/app", HOME)).toBe("~backup/app");
  });
});

describe("matchProject", () => {
  const projects = {
    app: { repo: "~/workspace/app" },
    api: { repo: "/srv/api" },
    docs: {}, // registered but no repo path — never matches
  };

  test("matches when the checkout root is a registered repo", () => {
    expect(matchProject(projects, ["/home/casey/workspace/app"], canonicalize)).toBe("app");
    expect(matchProject(projects, ["/srv/api"], canonicalize)).toBe("api");
  });

  test("matches the main checkout root even when the worktree root does not (worktree case)", () => {
    // A linked worktree lives elsewhere; its main checkout root is the registered repo.
    const roots = ["/home/casey/.worktrees/app-feature", "/home/casey/workspace/app"];
    expect(matchProject(projects, roots, canonicalize)).toBe("app");
  });

  test("tilde in loops.json and an absolute checkout path resolve to the same repo", () => {
    expect(matchProject(projects, ["/home/casey/workspace/app/"], canonicalize)).toBe("app");
  });

  test("returns null for an unregistered checkout", () => {
    expect(matchProject(projects, ["/home/casey/scratch/throwaway"], canonicalize)).toBeNull();
  });

  test("a project entry without a repo path never matches, even for an empty root", () => {
    expect(matchProject(projects, [""], canonicalize)).toBeNull();
  });

  test("returns null when there are no registered projects", () => {
    expect(matchProject({}, ["/home/casey/workspace/app"], canonicalize)).toBeNull();
  });
});
