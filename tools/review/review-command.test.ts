import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

function patchId(repository: string, commit: string): string {
  const patch = spawnSync("git", ["-C", repository, "show", "--pretty=format:", "--patch", commit], {
    encoding: "utf8",
  });
  if (patch.status !== 0) throw new Error(patch.stderr || "git show failed");
  const identity = spawnSync("git", ["patch-id", "--stable"], {encoding: "utf8", input: patch.stdout});
  if (identity.status !== 0) throw new Error(identity.stderr || "git patch-id failed");
  return identity.stdout.trim().split(/\s+/)[0];
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

function createReviewDataRepo(maxRounds: number, metadataPaths: string[] = []): string {
  const dataRepo = mkdtempSync(`${tmpdir()}/loops-review-data-`);
  writeFileSync(
    `${dataRepo}/loops.json`,
    `${JSON.stringify({
      review: {
        reviewer: "codex",
        maxRounds,
        ...(metadataPaths.length > 0 ? {metadataPaths} : {}),
      },
    })}\n`,
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
      'import { appendFileSync } from "node:fs";',
      "const args = Bun.argv.slice(2);",
      'const outputIndex = args.indexOf("--output-last-message");',
      'if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("missing output path");',
      // Faithful to the real contract: codex takes `-` and reads instructions from stdin,
      // so the prompt never appears in argv. Asserting the `-` here keeps this fake from
      // silently passing if the caller ever puts the prompt back on the command line —
      // which is what hit MAX_ARG_STRLEN (E2BIG) on a large diff.
      'if (args.at(-1) !== "-") throw new Error("expected the stdin sentinel as the last arg");',
      "const prompt = await Bun.stdin.text();",
      'const inputLine = prompt.split("\\n").find((line) => line.startsWith("AUDIT_INPUT="));',
      'if (!inputLine) throw new Error("missing audit input");',
      'const audit = JSON.parse(inputLine.slice("AUDIT_INPUT=".length));',
      'if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${audit.pass}\\n`);',
      'const files = process.env.FAKE_SKIP_FILE ? audit.manifest.files.slice(0, -1) : audit.manifest.files;',
      'const obligationStatus = process.env.FAKE_OBLIGATION_STATUS ?? "fixed";',
      'const obligations = audit.requiredObligationIds.length > 0 ? audit.obligations.map((obligation) => ({ findingId: obligation.findingId, status: obligationStatus, evidence: "verified" })) : [];',
      'await Bun.write(args[outputIndex + 1], JSON.stringify({ pass: audit.pass, summary: "clean", coverage: { files, instructionFiles: audit.manifest.instructionFiles, callsites: [] }, obligations, findings: [] }));',
      "",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  return executable;
}

function runStart(
  repository: string,
  dataRepo: string,
  item: string,
  baseRef = "master",
  extraEnv: Record<string, string> = {},
) {
  mkdirSync(`${dataRepo}/items`, {recursive: true});
  const itemPath = `${dataRepo}/items/${item}.md`;
  if (!existsSync(itemPath)) {
    writeFileSync(itemPath, `---\ntitle: Review test\nproject: test\nstate: in-progress\nowner: test\nautonomy: autonomous\nnext-actor: agent\nnext-step: Review\nupdated: 2026-07-23\n---\n`);
  }
  return spawnSync(
    "bun",
    ["run", CLI, "start", "--item", item, "--base", baseRef, "--data-repo", dataRepo],
    {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, CODEX_BIN: createFakeCodex(), ...extraEnv },
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
  test("keeps a clean review terminal after a metadata-only finalization commit", () => {
    const {repository} = createReviewRepository();
    const item = "metadata-finalization";
    const dataRepo = createReviewDataRepo(5, ["docs/release-state.md"]);
    expect(runStart(repository, dataRepo, item).status).toBe(0);

    mkdirSync(`${repository}/docs`, {recursive: true});
    writeFileSync(`${repository}/docs/release-state.md`, "landed pointer\n");
    git(repository, ["add", "docs/release-state.md"]);
    git(repository, ["commit", "-q", "-m", "Record landing metadata"]);

    const status = runStatus(repository, item);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("REVIEW_STATUS=passed");
    expect(status.stdout).toContain(`head=${git(repository, ["rev-parse", "HEAD"])}`);
  });

  test("does not let metadata-only finalization hide a failed current-HEAD review attempt", () => {
    const {repository} = createReviewRepository();
    const item = "metadata-failed-attempt";
    const dataRepo = createReviewDataRepo(5, ["docs/release-state.md"]);
    expect(runStart(repository, dataRepo, item).status).toBe(0);
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);

    mkdirSync(`${repository}/docs`, {recursive: true});
    writeFileSync(`${repository}/docs/release-state.md`, "landed pointer\n");
    git(repository, ["add", "docs/release-state.md"]);
    git(repository, ["commit", "-q", "-m", "Record landing metadata"]);
    const currentHead = git(repository, ["rev-parse", "HEAD"]);
    const ledger = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    ledger.failures = [{
      headSha: currentHead,
      model: "codex (default)",
      attemptedAt: "2099-01-01T00:00:00Z",
      reason: "review failed",
    }];
    writeFileSync(paths.jsonPath, `${JSON.stringify(ledger)}\n`);

    const status = runStatus(repository, item);
    expect(status.status).toBe(1);
    expect(status.stdout).toContain("latest review attempt failed");
  });

  test("runs three validated audit passes inside one logical round", () => {
    const { repository } = createReviewRepository();
    const item = "structured-audit";
    const invocationLog = `${mkdtempSync(`${tmpdir()}/loops-review-invocations-`)}/passes.log`;

    const result = runStart(repository, createReviewDataRepo(5), item, "master", {
      FAKE_CODEX_LOG: invocationLog,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(invocationLog, "utf8").trim().split("\n")).toEqual([
      "diff",
      "integration",
      "adversarial",
    ]);
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    const ledger = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    expect(ledger.rounds).toHaveLength(1);
    expect(ledger.rounds[0].audit.passes.map((pass: {pass: string}) => pass.pass)).toEqual([
      "diff",
      "integration",
      "adversarial",
    ]);
    expect(ledger.rounds[0].audit.manifest.files).toEqual([{path: "change.txt", hunks: ["-0,0 +1,1"]}]);
    expect(ledger.rounds[0].audit.manifest.contextReferences[0].label).toBe("item");
  });

  test("fails the logical attempt when one pass omits manifest coverage", () => {
    const { repository } = createReviewRepository();
    const item = "incomplete-coverage";

    const result = runStart(repository, createReviewDataRepo(5), item, "master", {FAKE_SKIP_FILE: "1"});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("coverage is incomplete for change.txt");
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    const ledger = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    expect(ledger.rounds).toHaveLength(0);
    expect(ledger.failures).toHaveLength(1);
  });

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

  test("does not reset the round cap when only the base-ref spelling changes", () => {
    const { repository, baseSha, headSha } = createReviewRepository();
    const item = "same-base-different-ref";
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    mkdirSync(dirname(paths.jsonPath), { recursive: true });
    let ledger = createReviewLedger({ item, branch: "feature/review-receipt", baseRef: "master", baseSha });
    for (let roundNumber = 1; roundNumber <= 5; roundNumber += 1) {
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

    const result = runStart(repository, createReviewDataRepo(5), item, baseSha);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("round limit of 5 reached");
    const unchanged = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    expect(unchanged.rounds).toHaveLength(5);
    expect(readdirSync(dirname(paths.jsonPath)).some((name) => name.startsWith("superseded-"))).toBe(false);
  });

  test("does not extend the round cap for a patch-equivalent base-delta audit", () => {
    const {repository, baseSha} = createReviewRepository();
    const item = "base-delta-cap";
    const dataRepo = createReviewDataRepo(1);
    expect(runStart(repository, dataRepo, item, baseSha).status).toBe(0);

    git(repository, ["switch", "-q", "master"]);
    writeFileSync(`${repository}/base-two.txt`, "new base\n");
    git(repository, ["add", "base-two.txt"]);
    git(repository, ["commit", "-q", "-m", "Advance base"]);
    git(repository, ["switch", "-q", "feature/review-receipt"]);
    git(repository, ["rebase", "-q", "master"]);

    const result = runStart(repository, dataRepo, item);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("round limit of 1 reached");
  });

  test("rejects an incomplete remediation obligation without a linked actionable finding", () => {
    const {repository, baseSha, headSha} = createReviewRepository();
    const item = "unlinked-remediation";
    const dataRepo = createReviewDataRepo(5);
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    mkdirSync(dirname(paths.jsonPath), {recursive: true});
    let ledger = addReviewRound(
      createReviewLedger({item, branch: "feature/review-receipt", baseRef: baseSha, baseSha}),
      {
        headSha,
        model: "codex (default)",
        reviewedAt: "2026-07-23T12:00:00Z",
        review: {summary: "fix", findings: [{
          priority: "P1",
          title: "Defect",
          evidence: "broken",
          impact: "incorrect",
          direction: "fix it",
          confidence: "high",
        }]},
      },
    );
    ledger = recordDisposition(ledger, "R1-F1", "accepted", "will fix");
    writeFileSync(paths.jsonPath, `${JSON.stringify(ledger)}\n`);
    writeFileSync(`${repository}/change.txt`, "review me\nfix attempt\n");
    git(repository, ["add", "change.txt"]);
    git(repository, ["commit", "-q", "-m", "Attempt fix"]);

    const result = runStart(repository, dataRepo, item, baseSha, {FAKE_OBLIGATION_STATUS: "incomplete"});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("R1-F1 must remain an actionable finding");
  });

  test("preserves evidence and runs a base-delta audit after a patch-equivalent rebase", () => {
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
    expect(refreshed.rounds).toHaveLength(2);
    expect(refreshed.rounds[1].audit.kind).toBe("base-delta");
    expect(refreshed.rounds[1].audit.passes.map((pass: {pass: string}) => pass.pass)).toEqual([
      "integration",
      "adversarial",
    ]);
    expect(readdirSync(dirname(paths.jsonPath)).some((name) => name.startsWith("superseded-"))).toBe(false);
  });

  test("archives prior evidence and restarts when the rebased patch series changes", () => {
    const {repository, baseSha} = createReviewRepository();
    const item = "changed-rebased-patch";
    const dataRepo = createReviewDataRepo(5);
    expect(runStart(repository, dataRepo, item, baseSha).status).toBe(0);

    git(repository, ["switch", "-q", "master"]);
    writeFileSync(`${repository}/base-two.txt`, "new base\n");
    git(repository, ["add", "base-two.txt"]);
    git(repository, ["commit", "-q", "-m", "Advance base"]);
    git(repository, ["switch", "-q", "feature/review-receipt"]);
    git(repository, ["rebase", "-q", "master"]);
    writeFileSync(`${repository}/change.txt`, "review me\nchanged patch\n");
    git(repository, ["add", "change.txt"]);
    git(repository, ["commit", "-q", "-m", "Change reviewed patch"]);

    expect(runStart(repository, dataRepo, item).status).toBe(0);
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    const restarted = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    expect(restarted.rounds).toHaveLength(1);
    expect(restarted.rounds[0].audit.kind).toBe("full");
    expect(readdirSync(dirname(paths.jsonPath)).some((name) => name.startsWith("superseded-"))).toBe(true);
  });

  test("starts a fresh confirming review after an accepted fix is rebased", () => {
    const { repository, baseSha, headSha } = createReviewRepository();
    const item = "accepted-finding";
    const dataRepo = createReviewDataRepo(5);
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    mkdirSync(dirname(paths.jsonPath), { recursive: true });
    let ledger = addReviewRound(
      createReviewLedger({
        item,
        branch: "feature/review-receipt",
        baseRef: baseSha,
        baseSha,
        patchIds: [patchId(repository, headSha)],
      }),
      {
        headSha,
        model: "codex (default)",
        reviewedAt: "2026-07-21T12:00:00Z",
        review: {
          summary: "fix required",
          findings: [{
            priority: "P1",
            title: "Defect",
            evidence: "The defect remains",
            impact: "Incorrect behavior",
            direction: "Fix it",
            confidence: "high",
          }],
        },
      },
    );
    ledger = recordDisposition(ledger, "R1-F1", "accepted", "Will fix");
    writeFileSync(paths.jsonPath, `${JSON.stringify(ledger)}\n`);

    git(repository, ["switch", "-q", "master"]);
    writeFileSync(`${repository}/base-two.txt`, "new base\n");
    git(repository, ["add", "base-two.txt"]);
    git(repository, ["commit", "-q", "-m", "Advance base"]);
    git(repository, ["switch", "-q", "feature/review-receipt"]);
    git(repository, ["rebase", "-q", "master"]);

    const result = runStart(repository, dataRepo, item);

    expect(result.status).toBe(0);
    const refreshed = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    expect(refreshed.rounds).toHaveLength(2);
    expect(refreshed.rounds[1].audit.kind).toBe("base-delta");
    expect(refreshed.rounds[1].audit.obligations).toEqual([
      {findingId: "R1-F1", status: "fixed", evidence: "verified"},
    ]);
    expect(refreshed.rounds[1].findings).toEqual([]);
    expect(readdirSync(dirname(paths.jsonPath)).some((name) => name.startsWith("superseded-"))).toBe(false);
  });
});
