import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { addReviewRound, createReviewLedger, recordDisposition } from "./review-ledger.ts";
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

function createReviewRepository(): { repository: string; baseSha: string; headSha: string } {
  const repository = mkdtempSync(`${tmpdir()}/loops-review-start-`);
  git(repository, ["init", "-q", "-b", "master"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Test"]);
  writeFileSync(`${repository}/base.txt`, "base\n");
  git(repository, ["add", "base.txt"]);
  git(repository, ["commit", "-q", "-m", "Add base"]);
  const baseSha = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["switch", "-q", "-c", "feature/review-receipt"]);
  writeFileSync(`${repository}/change.txt`, "review me\n");
  git(repository, ["add", "change.txt"]);
  git(repository, ["commit", "-q", "-m", "Add change"]);
  return { repository, baseSha, headSha: git(repository, ["rev-parse", "HEAD"]) };
}

function createReviewDataRepo(maxRounds: number): string {
  const dataRepo = mkdtempSync(`${tmpdir()}/loops-review-data-`);
  writeFileSync(
    `${dataRepo}/loops.json`,
    `${JSON.stringify({ review: { reviewer: "codex", maxRounds } })}\n`,
  );
  return dataRepo;
}

function createFakeCodex(): string {
  const directory = mkdtempSync(`${tmpdir()}/loops-fake-codex-`);
  const executable = `${directory}/codex`;
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env bun",
      "const args = Bun.argv.slice(2);",
      'const outputIndex = args.indexOf("--output-last-message");',
      'if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("missing output path");',
      'await Bun.write(args[outputIndex + 1], JSON.stringify({ summary: "clean", findings: [] }));',
      "",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  return executable;
}

function runStart(repository: string, dataRepo: string, item: string, baseRef = "master") {
  return spawnSync(
    "bun",
    ["run", CLI, "start", "--item", item, "--base", baseRef, "--data-repo", dataRepo],
    {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, CODEX_BIN: createFakeCodex() },
    },
  );
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

  test("blocks a ledger recorded for a different branch", () => {
    const { repository, headSha } = createRepository();
    const paths = reviewEvidencePaths(repository, "feature/review-receipt");
    mkdirSync(dirname(paths.jsonPath), { recursive: true });
    const ledger = addReviewRound(
      createReviewLedger({ branch: "another-branch", baseRef: "master", baseSha: "base" }),
      {
        headSha,
        model: "codex (default)",
        reviewedAt: "2026-07-19T12:00:00Z",
        review: { summary: "clean", findings: [] },
      },
    );
    writeFileSync(paths.jsonPath, `${JSON.stringify(ledger)}\n`);

    const result = runStatus(repository);

    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe(
      `REVIEW_STATUS=blocked head=${headSha} ledger=${relative(repository, paths.markdownPath)} reason="review evidence is invalid: review ledger branch is another-branch, expected feature/review-receipt"`,
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

describe("cli-review start", () => {
  test("uses the configured five-round cap", () => {
    const { repository, baseSha, headSha } = createReviewRepository();
    const item = "five-round-review";
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    mkdirSync(dirname(paths.jsonPath), { recursive: true });
    let ledger = createReviewLedger({ item, branch: "feature/review-receipt", baseRef: "master", baseSha });
    for (let roundNumber = 1; roundNumber <= 4; roundNumber += 1) {
      ledger = addReviewRound(ledger, {
        headSha,
        model: "codex (default)",
        reviewedAt: `2026-07-21T12:00:0${roundNumber}Z`,
        review: {
          summary: "non-actionable suggestion",
          findings: [{
            priority: "P2",
            title: "Suggestion",
            evidence: "Not a defect",
            impact: "None",
            direction: "Keep the implementation",
            confidence: "high",
          }],
        },
      });
      ledger = recordDisposition(ledger, `R${roundNumber}-F1`, "rejected", "Not an actionable defect");
    }
    writeFileSync(paths.jsonPath, `${JSON.stringify(ledger)}\n`);

    const result = runStart(repository, createReviewDataRepo(5), item);

    expect(result.status).toBe(0);
    const updated = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    expect(updated.rounds).toHaveLength(5);
    expect(updated.rounds[4].findings).toEqual([]);
  });

  test("starts fresh evidence after the reviewed base changes", () => {
    const { repository, baseSha } = createReviewRepository();
    const item = "refreshed-base";
    const dataRepo = createReviewDataRepo(5);
    const first = runStart(repository, dataRepo, item, baseSha);
    expect(first.status).toBe(0);

    git(repository, ["switch", "-q", "master"]);
    writeFileSync(`${repository}/base-two.txt`, "new base\n");
    git(repository, ["add", "base-two.txt"]);
    git(repository, ["commit", "-q", "-m", "Advance base"]);
    const newBaseSha = git(repository, ["rev-parse", "HEAD"]);
    expect(newBaseSha).not.toBe(baseSha);
    git(repository, ["switch", "-q", "feature/review-receipt"]);
    git(repository, ["rebase", "-q", "master"]);

    const second = runStart(repository, dataRepo, item);

    expect(second.status).toBe(0);
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    const refreshed = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    expect(refreshed.baseSha).toBe(newBaseSha);
    expect(refreshed.rounds).toHaveLength(1);
    expect(readdirSync(dirname(paths.jsonPath)).some((name) => name.startsWith("superseded-"))).toBe(true);
  });
});
