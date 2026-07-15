import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Serializes ledger mutations for one (repository, branch): a second reviewer on the
// same branch fails fast rather than interleaving rounds. Locks live in the OS temp
// dir keyed by a hash of repo+branch; a lock held by a dead pid is reclaimed.

const LOCK_DIR = join(tmpdir(), "loops-review-locks");

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function reviewLockPath(repository: string, branch: string): string {
  const key = createHash("sha256").update(repository).update("\0").update(branch).digest("hex");
  return join(LOCK_DIR, `${key}.lock`);
}

export async function acquireReviewLock(repository: string, branch: string): Promise<() => Promise<void>> {
  const path = reviewLockPath(repository, branch);
  await mkdir(LOCK_DIR, { recursive: true });
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
  } catch (error: unknown) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
    const owner = (await readFile(path, "utf8")).trim();
    const ownerPid = Number(owner);
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
      } catch (processError: unknown) {
        if (hasErrorCode(processError, "ESRCH")) {
          await unlink(path);
          return acquireReviewLock(repository, branch);
        }
      }
    }
    throw new Error(`review ledger is locked by process ${owner || "unknown"}`);
  }

  let released = false;
  return async (): Promise<void> => {
    if (released) return;
    released = true;
    await unlink(path).catch((error: unknown): void => {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    });
  };
}
