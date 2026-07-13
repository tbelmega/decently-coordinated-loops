import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ItemMove } from "./archive.ts";

export interface MoveLog {
  slug: string;
  message: string;
}

/** Executes a batch of item-file moves (items/ <-> for-delivery/ <-> archive/)
 * idempotently: if the source is already gone and the destination already exists,
 * the move already happened on a previous run — skip it rather than erroring, so a
 * sync rerun after a partial previous run doesn't fail. If neither exists, that's a
 * genuine anomaly (the file vanished from both ends) — log it and continue rather
 * than aborting the whole batch. Otherwise copy the content to the destination and
 * remove the source. */
export function performMoves(root: string, moves: ItemMove[]): MoveLog[] {
  const logs: MoveLog[] = [];

  for (const move of moves) {
    const from = join(root, move.item.path);
    const toDir = join(root, move.to);
    const to = join(toDir, `${move.item.slug}.md`);

    const fromExists = existsSync(from);
    const toExists = existsSync(to);

    if (!fromExists && toExists) {
      logs.push({ slug: move.item.slug, message: `already moved (${move.from} -> ${move.to})` });
      continue;
    }
    if (!fromExists && !toExists) {
      logs.push({
        slug: move.item.slug,
        message: `anomaly: neither ${move.item.path} nor ${move.to}/${move.item.slug}.md exists`,
      });
      continue;
    }

    mkdirSync(toDir, { recursive: true });
    const raw = readFileSync(from, "utf8");
    writeFileSync(to, raw);
    unlinkSync(from);
    logs.push({ slug: move.item.slug, message: `moved (${move.from} -> ${move.to})` });
  }

  return logs;
}
