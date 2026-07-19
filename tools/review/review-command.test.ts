import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { addReviewRound, createReviewLedger } from "./review-ledger.ts";
import { reviewEvidencePaths } from "./review-status.ts";

const CLI = resolve(import.meta.dirname, "cli-review.ts");

function git(repository: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function createRepository(): { repository: string; headSha: string } {
  const repository = mkdtempSync(`${tmpdir()}/loops-review-status-`);
  git(repository, ["init", "-q", "-b", "feature/review-receipt"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Test"]);
  writeFileSync(`${repository}/change.txt`, "review me\n");
  git(repository, ["add", "change.txt"]);
  git(repository, ["commit", "-q", "-m", "Add change"]);
  return { repository, headSha: git(repository, ["rev-parse", "HEAD"]) };
}

function runStatus(repository: string, item?: string, cwd = repository) {
  return spawnSync("bun", ["run", CLI, "status", ...(item ? ["--item", item] : [])], {
    cwd,
    encoding: "utf8",
  });
}

describe("cli-review status", () => {
  test("prints passed evidence for a clean current-HEAD review", () => {
    const { repository, headSha } = createRepository();
    const paths = reviewEvidencePaths(repository, "feature/review-receipt");
    mkdirSync(dirname(paths.jsonPath), { recursive: true });
    const ledger = addReviewRound(
      createReviewLedger({ branch: "feature/review-receipt", baseRef: "master", baseSha: "base" }),
      {
        headSha,
        model: "codex (default)",
        reviewedAt: "2026-07-19T12:00:00Z",
        review: { summary: "clean", findings: [] },
      },
    );
    writeFileSync(paths.jsonPath, `${JSON.stringify(ledger)}\n`);

    const result = runStatus(repository);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `REVIEW_STATUS=passed model="codex (default)" rounds=1 head=${headSha} ledger=${relative(repository, paths.markdownPath)}`,
    );
  });

  test("selects item-scoped evidence when a persistent branch is reused", () => {
    const { repository, headSha } = createRepository();
    const firstPaths = reviewEvidencePaths(repository, "feature/review-receipt", "first-item");
    const secondPaths = reviewEvidencePaths(repository, "feature/review-receipt", "second-item");
    expect(firstPaths.jsonPath).not.toBe(secondPaths.jsonPath);
    mkdirSync(dirname(secondPaths.jsonPath), { recursive: true });
    const ledger = addReviewRound(
      createReviewLedger({
        item: "second-item",
        branch: "feature/review-receipt",
        baseRef: "parent-head",
        baseSha: "base",
      }),
      {
        headSha,
        model: "codex (default)",
        reviewedAt: "2026-07-19T12:00:00Z",
        review: { summary: "clean", findings: [] },
      },
    );
    writeFileSync(secondPaths.jsonPath, `${JSON.stringify(ledger)}\n`);

    const result = runStatus(repository, "second-item");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `REVIEW_STATUS=passed item="second-item" model="codex (default)" rounds=1 head=${headSha} ledger=${relative(repository, secondPaths.markdownPath)}`,
    );
  });

  test("prints not_run and exits nonzero when the branch has no ledger", () => {
    const { repository, headSha } = createRepository();
    const paths = reviewEvidencePaths(repository, "feature/review-receipt");

    const result = runStatus(repository);

    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe(
      `REVIEW_STATUS=not_run head=${headSha} ledger=${relative(repository, paths.markdownPath)} reason="no review ledger for current branch"`,
    );
  });

  test("prints blocked when the branch ledger is invalid", () => {
    const { repository, headSha } = createRepository();
    const paths = reviewEvidencePaths(repository, "feature/review-receipt");
    mkdirSync(dirname(paths.jsonPath), { recursive: true });
    writeFileSync(paths.jsonPath, "{}\n");

    const result = runStatus(repository);

    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe(
      `REVIEW_STATUS=blocked head=${headSha} ledger=${relative(repository, paths.markdownPath)} reason="review evidence is invalid: review ledger version must be 1"`,
    );
  });

  test("blocks an otherwise-passed review when implementation changes are uncommitted", () => {
    const { repository, headSha } = createRepository();
    const paths = reviewEvidencePaths(repository, "feature/review-receipt");
    mkdirSync(dirname(paths.jsonPath), { recursive: true });
    const ledger = addReviewRound(
      createReviewLedger({ branch: "feature/review-receipt", baseRef: "master", baseSha: "base" }),
      {
        headSha,
        model: "codex (default)",
        reviewedAt: "2026-07-19T12:00:00Z",
        review: { summary: "clean", findings: [] },
      },
    );
    writeFileSync(paths.jsonPath, `${JSON.stringify(ledger)}\n`);
    writeFileSync(`${repository}/uncommitted.txt`, "not reviewed\n");

    const result = runStatus(repository);

    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe(
      `REVIEW_STATUS=blocked head=${headSha} ledger=${relative(repository, paths.markdownPath)} reason="working tree has uncommitted changes outside .reviews"`,
    );
  });

  test("still blocks on dirty files elsewhere when run from a subdirectory", () => {
    const { repository, headSha } = createRepository();
    const paths = reviewEvidencePaths(repository, "feature/review-receipt");
    mkdirSync(dirname(paths.jsonPath), { recursive: true });
    const ledger = addReviewRound(
      createReviewLedger({ branch: "feature/review-receipt", baseRef: "master", baseSha: "base" }),
      {
        headSha,
        model: "codex (default)",
        reviewedAt: "2026-07-19T12:00:00Z",
        review: { summary: "clean", findings: [] },
      },
    );
    writeFileSync(paths.jsonPath, `${JSON.stringify(ledger)}\n`);
    writeFileSync(`${repository}/uncommitted.txt`, "not reviewed\n");
    mkdirSync(`${repository}/sub`);

    const result = runStatus(repository, undefined, `${repository}/sub`);

    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe(
      `REVIEW_STATUS=blocked head=${headSha} ledger=${relative(repository, paths.markdownPath)} reason="working tree has uncommitted changes outside .reviews"`,
    );
  });
});
