import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Writes `content` to `path` via a temp file + rename, so a concurrent reader
 * never sees a half-written file. */
export async function writeFileAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(path), `${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporaryPath, content);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
