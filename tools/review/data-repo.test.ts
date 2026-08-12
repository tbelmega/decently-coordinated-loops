import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveDataRepo } from "./data-repo.ts";

const HOME = "/home/casey";

describe("resolveDataRepo", () => {
  test("the flag wins over the environment", () => {
    expect(resolveDataRepo("/flag/repo", { LOOPS_DATA_REPO: "/env/repo" }, HOME)).toBe("/flag/repo");
  });

  test("the environment is used when no flag is given", () => {
    expect(resolveDataRepo(undefined, { LOOPS_DATA_REPO: "/env/repo" }, HOME)).toBe("/env/repo");
  });

  test("neither present resolves to nothing", () => {
    expect(resolveDataRepo(undefined, {}, HOME)).toBeUndefined();
  });

  test("a blank value is unset, not the current directory", () => {
    // `LOOPS_DATA_REPO=` in a shell profile is the common way to clear it; resolving ""
    // would silently point the reviewer at wherever it happens to be running.
    expect(resolveDataRepo("", { LOOPS_DATA_REPO: "   " }, HOME)).toBeUndefined();
  });

  test("~ is expanded in both sources", () => {
    expect(resolveDataRepo("~/loops", {}, HOME)).toBe(resolve(`${HOME}/loops`));
    expect(resolveDataRepo(undefined, { LOOPS_DATA_REPO: "~/loops" }, HOME)).toBe(resolve(`${HOME}/loops`));
  });
});
