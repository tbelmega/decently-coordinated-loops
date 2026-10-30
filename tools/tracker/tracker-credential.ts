// Whether this host holds a credential for a tracker at all. A host without one - a
// board-only machine - skips the tracker quietly: everything the sync writes is derived
// from board state, so a host with access catches up later. Only a credential that is
// present and fails is worth the owner's attention.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TrackerConfig } from "./tracker-config.ts";

function expand(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

/** IO boundary: whether ambient `gh` auth is usable on this host. */
export function ghAuthenticated(): boolean {
  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  return result.status === 0 && (result.stdout ?? "").trim() !== "";
}

/** Why this host has no credential for the tracker, or undefined when it has one (or
 * when the gap is a configuration error that must fail loudly instead, such as a Linear
 * tracker naming no token file). `orgTokenFile` is the GitHub org's configured token. */
export function missingCredential(
  tracker: TrackerConfig,
  orgTokenFile: string | undefined,
  ghAuth: () => boolean = ghAuthenticated,
): string | undefined {
  const tokenFile = tracker.tokenFile ?? (tracker.kind === "github-projects" ? orgTokenFile : undefined);
  if (tokenFile) return existsSync(expand(tokenFile)) ? undefined : `no token file at ${tokenFile} on this host`;
  if (tracker.kind === "github-projects" && !ghAuth()) return "gh is not authenticated on this host";
  return undefined;
}
