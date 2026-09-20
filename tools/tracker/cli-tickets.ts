#!/usr/bin/env bun
// `bun run tickets <item-slug>` - the commit reference for one item's tickets, printed
// so an agent copies it rather than composing it from memory. Read-only.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveProjectTracker } from "../config.ts";
import { loadArchiveDir, loadForDeliveryDir, loadItemsDir } from "../parse.ts";
import { commitReference } from "./tracker-commit.ts";

const ROOT = process.cwd();
const slug = process.argv[2];

if (!existsSync(join(ROOT, "BOARD.md"))) {
  console.error(`not a loops data repo (no BOARD.md in ${ROOT}) - run from the data repo root`);
  process.exit(2);
}
if (!slug) {
  console.error("usage: bun run tickets <item-slug>");
  process.exit(2);
}

const config = loadConfig(ROOT);
const items = [
  ...loadItemsDir(join(ROOT, "items")),
  ...loadForDeliveryDir(join(ROOT, "for-delivery")),
  ...loadArchiveDir(join(ROOT, "archive")),
];
const item = items.find((candidate) => candidate.slug === slug);
if (!item) {
  console.error(`no item file for "${slug}" in items/, for-delivery/ or archive/`);
  process.exit(2);
}

const resolved = resolveProjectTracker(config, item.project);
if (!resolved) {
  console.log(`${slug}: project ${item.project} declares no tracker - commits carry no ticket reference.`);
  process.exit(0);
}
if (item.tickets === "local") {
  console.log(`${slug}: marked \`tickets: local\` - commits carry no ticket reference.`);
  process.exit(0);
}
if (item.tickets === undefined || item.tickets.length === 0) {
  console.log(
    `${slug}: no ticket decision yet. Record the tickets it advances (\`tickets: [id]\`), or \`tickets: local\` if this work-stream stays on the board.`,
  );
  process.exit(0);
}

const reference = commitReference(item.tickets, resolved.tracker);
console.log(`${slug} -> ${resolved.name} (${resolved.tracker.kind}): ${item.tickets.join(", ")}\n`);
console.log("Subject suffix (append to a subject that already describes the change):");
console.log(`  ${reference.subject}`);
if (reference.body.length) {
  console.log("\nBody lines (before any trailers):");
  for (const line of reference.body) console.log(`  ${line}`);
}
