import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ItemMove } from "./archive.ts";

export interface MoveLog {
  slug: string;
  message: string;
}

/** Move a tracked file with `git mv` so the change is recorded as a rename (git keeps
 * the item file's history under `--follow`) and staged for the agent's commit. Returns
 * false when git can't do it — the data repo isn't a git repo, or the file isn't
 * tracked yet (a freshly filed item that was never committed) — so the caller falls
 * back to a plain filesystem move. `fromRel`/`toRel` are repo-relative paths. */
function gitMv(root: string, fromRel: string, toRel: string): boolean {
  const result = spawnSync("git", ["-C", root, "mv", fromRel, toRel], { encoding: "utf8" });
  return result.status === 0;
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
    // Prefer `git mv` (records a rename, preserving the item file's history); fall
    // back to a filesystem move when the file isn't tracked or this isn't a git repo.
    const toRel = `${move.to}/${move.item.slug}.md`;
    if (!gitMv(root, move.item.path, toRel)) {
      const raw = readFileSync(from, "utf8");
      writeFileSync(to, raw);
      unlinkSync(from);
    }
    logs.push({ slug: move.item.slug, message: `moved (${move.from} -> ${move.to})` });
  }

  return logs;
}
