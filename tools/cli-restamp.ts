#!/usr/bin/env bun
// `bun run restamp` — advance this data repo's `.loops-version` to the DCL clone's
// current HEAD. `bun run check` warns when the stamp lags the clone (the DCL contracts
// may have evolved past what this repo was seeded with); this is how you acknowledge
// the upgrade and clear the warning, after reviewing what changed. Writes the stamp
// file only — committing the data repo is yours, as with the other tools.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dclHead, dclHome, STAMP_FILE, stampedVersion } from "./version.ts";

const ROOT = process.cwd();

if (!existsSync(join(ROOT, "BOARD.md"))) {
  console.error(`not a loops data repo (no BOARD.md in ${ROOT}) — run from the data repo root`);
  process.exit(2);
}

const home = dclHome();
const current = dclHead(home);
if (!current) {
  console.error(`could not read the DCL clone's HEAD at ${home} — is it a git checkout?`);
  process.exit(1);
}

const previous = stampedVersion(ROOT);
if (previous === current) {
  console.log(`.loops-version already at ${current.slice(0, 12)} (current DCL HEAD) — nothing to advance.`);
  process.exit(0);
}

writeFileSync(join(ROOT, STAMP_FILE), `${current}\n`);

const from = previous && previous !== "unknown" ? previous.slice(0, 12) : (previous ?? "(unset)");
console.log(`.loops-version: ${from} → ${current.slice(0, 12)} (current DCL HEAD).`);
if (previous && previous !== "unknown") {
  console.log(`Review what changed:  git -C ${home} log --oneline ${previous}..${current}`);
}
console.log("Commit the updated .loops-version in this data repo.");
