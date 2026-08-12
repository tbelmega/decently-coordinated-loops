// Where the review command finds the data repo whose loops.json configures it.
import { expandHome } from "../registration.ts";
import { resolve } from "node:path";

/** Resolves the data repo for a review invocation: the explicit flag wins, then
 * `$LOOPS_DATA_REPO`, then nothing.
 *
 * The env var is what makes the reviewer usable without repeating `--data-repo` on
 * every call, on a machine where the answer never changes. It was documented in this
 * file's own comments long before it was read, so a user following the docs got the
 * silent no-config path instead of their configured reviewer. A blank or
 * whitespace-only value is treated as unset rather than as the current directory. */
export function resolveDataRepo(
  flagValue: string | undefined,
  env: Record<string, string | undefined>,
  home: string,
): string | undefined {
  const candidate = flagValue?.trim() || env.LOOPS_DATA_REPO?.trim();
  return candidate ? resolve(expandHome(candidate, home)) : undefined;
}
