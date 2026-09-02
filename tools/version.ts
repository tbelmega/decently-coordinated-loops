// The DCL version stamp: a data repo records (in `.loops-version`) which DCL commit
// seeded it, so `bun run check` can warn when the DCL clone has since moved on and
// `bun run restamp` can advance the stamp once an upgrade has been reviewed. Both the
// check and restamp CLIs share these helpers so the stamp mechanism lives in one place.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const STAMP_FILE = ".loops-version";

/** The DCL clone serving this run - the parent of tools/, where this module lives.
 *  Resolves from this file's own location, so it is independent of the data repo's cwd. */
export function dclHome(): string {
  return resolve(import.meta.dirname, "..");
}

/** The DCL clone's current HEAD commit, or null when git can't report it (not a git
 *  checkout, git missing, …). */
export function dclHead(home = dclHome()): string | null {
  const head = spawnSync("git", ["-C", home, "rev-parse", "HEAD"], { encoding: "utf8" });
  return head.status === 0 ? head.stdout.trim() : null;
}

/** The commit recorded in a data repo's `.loops-version`, or null when it is unstamped. */
export function stampedVersion(root: string): string | null {
  const path = join(root, STAMP_FILE);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}
