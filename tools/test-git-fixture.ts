// Temporary git fixtures for the dispatch tests: a bare origin and clones of it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function sh(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export interface GitFixture {
  base: string;
  origin: string;
  clone(name: string): string;
  write(clone: string, path: string, text: string): void;
  read(clone: string, path: string): string;
  commitAll(clone: string, message: string): void;
}

/** A bare origin seeded with `files` on `master`. */
export function gitFixture(files: Record<string, string>): GitFixture {
  const base = mkdtempSync(join(tmpdir(), "dcl-dispatch-git-"));
  const origin = join(base, "origin.git");
  sh(base, ["init", "--quiet", "--bare", "--initial-branch=master", origin]);
  const seed = join(base, "seed");
  sh(base, ["clone", "--quiet", origin, seed]);
  configure(seed);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    writeFileSync(join(seed, path), text);
  }
  sh(seed, ["add", "-A"]);
  sh(seed, ["commit", "--quiet", "-m", "Seed"]);
  sh(seed, ["push", "--quiet", "origin", "HEAD:master"]);
  return {
    base,
    origin,
    clone(name) {
      const path = join(base, name);
      sh(base, ["clone", "--quiet", origin, path]);
      configure(path);
      return path;
    },
    write(clone, path, text) {
      mkdirSync(dirname(join(clone, path)), { recursive: true });
      writeFileSync(join(clone, path), text);
    },
    read(clone, path) {
      return readFileSync(join(clone, path), "utf8");
    },
    commitAll(clone, message) {
      sh(clone, ["add", "-A"]);
      sh(clone, ["commit", "--quiet", "-m", message]);
    },
  };
}

function configure(repo: string): void {
  sh(repo, ["config", "user.name", "Test"]);
  sh(repo, ["config", "user.email", "test@example.invalid"]);
  sh(repo, ["config", "commit.gpgsign", "false"]);
  sh(repo, ["config", "pull.rebase", "true"]);
}
