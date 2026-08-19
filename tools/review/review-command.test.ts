import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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

/** A range whose diff exceeds spawnSync's 1 MiB default maxBuffer. Written as one large file so
 * the repo stays cheap to build; what matters is the size of `git diff base..head`. */
function createLargeDiffRepository(): { repository: string; baseSha: string; headSha: string } {
  const repository = mkdtempSync(`${tmpdir()}/loops-review-large-`);
  git(repository, ["init", "-q", "-b", "master"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Test"]);
  writeFileSync(`${repository}/base.txt`, "base\n");
  git(repository, ["add", "base.txt"]);
  git(repository, ["commit", "-q", "-m", "Add base"]);
  const baseSha = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["switch", "-q", "-c", "feature/review-receipt"]);
  // ~1.6 MiB of added lines: comfortably past the 1 MiB default, well under the 16 MiB ceiling.
  let big = "";
  for (let line = 0; line < 40_000; line += 1) big += `line ${line} ${"x".repeat(32)}\n`;
  writeFileSync(`${repository}/big.txt`, big);
  git(repository, ["add", "big.txt"]);
  git(repository, ["commit", "-q", "-m", "Add a large file"]);
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
      'let covered = process.env.FAKE_SKIP_FILE ? audit.manifest.files.slice(0, -1) : audit.manifest.files;',
      // Faithful to a compliant reviewer on a remediation round: the prompt embeds
      // remediationFiles and instructs auditing that range, so coverage comes back with
      // those hunks unioned in (measured with codex/gpt-5.6-terra, 2026-08-09).
      'if (process.env.FAKE_UNION_REMEDIATION) covered = covered.map((file) => { const extra = (audit.manifest.remediationFiles ?? []).find((r) => r.path === file.path); return extra ? { path: file.path, hunks: [...new Set([...extra.hunks, ...file.hunks])] } : file; });',
      // Faithful to a compliant reviewer: the prompt names every metadata file and asks for
      // it to be inspected, so coverage comes back including them. The validator must permit
      // that — rejecting it invalidated rounds that had found nothing wrong.
      'const files = [...covered, ...(audit.manifest.metadataFiles ?? [])];',
      // Typed statuses mirror a compliant reviewer: remediation obligations classify
      // fixed, documentation obligations documented, unless a test overrides either.
      'const obligationStatusFor = (obligation) => obligation.type === "documentation" ? (process.env.FAKE_DOC_STATUS ?? "documented") : (process.env.FAKE_OBLIGATION_STATUS ?? "fixed");',
      'const obligations = audit.requiredObligationIds.length > 0 ? audit.obligations.map((obligation) => ({ findingId: obligation.findingId, status: obligationStatusFor(obligation), evidence: "verified" })) : [];',
      'const findings = process.env.FAKE_FINDINGS_JSON ? JSON.parse(process.env.FAKE_FINDINGS_JSON) : [];',
      'await Bun.write(args[outputIndex + 1], JSON.stringify({ pass: audit.pass, summary: "clean", coverage: { files, instructionFiles: audit.manifest.instructionFiles, callsites: [] }, obligations, findings }));',
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
  extraArgs: string[] = [],
) {
  mkdirSync(`${dataRepo}/items`, {recursive: true});
  const itemPath = `${dataRepo}/items/${item}.md`;
  if (!existsSync(itemPath)) {
    writeFileSync(itemPath, `---\ntitle: Review test\nproject: test\nstate: in-progress\nowner: test\nautonomy: autonomous\nnext-actor: agent\nnext-step: Review\nupdated: 2026-07-23\n---\n`);
  }
  return spawnSync(
    "bun",
    ["run", CLI, "start", "--item", item, "--base", baseRef, "--data-repo", dataRepo, ...extraArgs],
    {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, CODEX_BIN: createFakeCodex(), ...extraEnv },
    },
  );
}

/** Writes the tracked item with an explicit `links:` block, so a test can pin how a
 * link is resolved rather than relying on runStart's link-less default. */
function writeItemWithLinks(dataRepo: string, item: string, links: Record<string, string>): void {
  mkdirSync(`${dataRepo}/items`, {recursive: true});
  const linkLines = Object.entries(links)
    .map(([key, value]) => `  ${key}: ${value}`)
    .join("\n");
  writeFileSync(
    `${dataRepo}/items/${item}.md`,
    `---\ntitle: Review test\nproject: test\nstate: in-progress\nowner: test\nautonomy: autonomous\n` +
      `next-actor: agent\nnext-step: Review\nupdated: 2026-07-23\nlinks:\n${linkLines}\n---\n`,
  );
}

function runStatus(repository: string, item?: string, cwd = repository) {
  return spawnSync("bun", ["run", CLI, "status", ...(item ? ["--item", item] : [])], {
    cwd,
    encoding: "utf8",
  });
}

function runDisposition(
  repository: string,
  item: string,
  findingId: string,
  status: string,
  reason: string,
  extraArgs: string[] = [],
) {
  return spawnSync(
    "bun",
    ["run", CLI, "disposition", "--item", item, "--finding", findingId, "--status", status, "--reason", reason, ...extraArgs],
    { cwd: repository, encoding: "utf8" },
  );
}

/** A finding the fake reviewer reports, satisfying the response schema. */
function fakeFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    priority: "P2",
    title: "Lock loss on crash",
    file: "change.txt",
    line: 1,
    evidence: "lock file survives a crash",
    impact: "next writer waits forever",
    direction: "document or fix the recovery path",
    confidence: "high",
    origin: "original",
    obligationId: null,
    ...overrides,
  };
}

function readLedgerJson(repository: string, item: string): any {
  const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
  return JSON.parse(readFileSync(paths.jsonPath, "utf8"));
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
  // `~/...` is the convention every item file in a real data repo uses for links, and
  // the CLI already expands it for --data-repo. It did not for links.spec, so an item
  // that recorded its spec the documented way could never be reviewed at all: the path
  // resolved against the data repo as a literal "~" directory and start refused.
  test("resolves a links.spec recorded as a ~ path", () => {
    const {repository} = createReviewRepository();
    const item = "home-relative-spec";
    const dataRepo = createReviewDataRepo(5);
    const home = mkdtempSync(`${tmpdir()}/loops-review-home-`);
    mkdirSync(`${home}/specs`, {recursive: true});
    writeFileSync(`${home}/specs/thing.md`, "# Spec\n\nThe reviewed change is specified here.\n");
    writeItemWithLinks(dataRepo, item, {spec: "~/specs/thing.md"});

    const result = runStart(repository, dataRepo, item, "master", {HOME: home});
    expect(result.stderr).not.toContain("was not found");
    expect(result.status).toBe(0);
  });

  test("still refuses a links.spec that genuinely does not exist", () => {
    const {repository} = createReviewRepository();
    const item = "missing-spec";
    const dataRepo = createReviewDataRepo(5);
    const home = mkdtempSync(`${tmpdir()}/loops-review-home-`);
    writeItemWithLinks(dataRepo, item, {spec: "~/specs/absent.md"});

    const result = runStart(repository, dataRepo, item, "master", {HOME: home});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("was not found");
  });

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

  test("completes a round when the range's diff exceeds spawnSync's default output buffer", () => {
    // spawnSync's default maxBuffer is 1 MiB. A review range outgrows that long before anything
    // else strains, and when it does spawnSync returns status=null with an EMPTY stderr — so the
    // failure surfaced as "git <args> failed" with no cause, while running the same `git diff` by
    // hand succeeded. A whole round died on it 2026-08-08 at a diff of 1,093,049 bytes.
    const {repository} = createLargeDiffRepository();
    const item = "large-diff-range";

    const result = runStart(repository, createReviewDataRepo(5), item);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("failed");
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    const ledger = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    expect(ledger.rounds).toHaveLength(1);
    expect(ledger.failures ?? []).toHaveLength(0);
    expect(ledger.rounds[0].audit.manifest.files.map((file: {path: string}) => file.path)).toEqual([
      "big.txt",
    ]);
  });

  test("completes a round when the reviewed range itself contains a metadata path", () => {
    const {repository} = createReviewRepository();
    const item = "metadata-in-range";
    // The shape that blocks a data repo committing its own ledger: the evidence file is
    // inside the reviewed range and matches metadataPaths, so it reaches the reviewer as a
    // file to inspect and comes back in coverage.
    mkdirSync(`${repository}/.reviews`, {recursive: true});
    writeFileSync(`${repository}/.reviews/round.md`, "prior round evidence\n");
    git(repository, ["add", "-f", ".reviews/round.md"]);
    git(repository, ["commit", "-q", "-m", "Commit review evidence"]);

    const result = runStart(repository, createReviewDataRepo(5, [".reviews/**"]), item);

    expect(result.status).toBe(0);
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    const ledger = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    expect(ledger.rounds).toHaveLength(1);
    expect(ledger.failures ?? []).toHaveLength(0);
    expect(ledger.rounds[0].audit.manifest.files.map((file: {path: string}) => file.path)).toEqual([
      "change.txt",
    ]);
    expect(ledger.rounds[0].audit.manifest.metadataFiles.map((file: {path: string}) => file.path)).toEqual([
      ".reviews/round.md",
    ]);
  });

  test("writes each pass prompt only when LOOPS_REVIEW_DUMP_PROMPT names a directory", () => {
    const {repository} = createReviewRepository();
    const dumpDirectory = `${mkdtempSync(`${tmpdir()}/loops-review-dump-`)}/prompts`;

    expect(runStart(repository, createReviewDataRepo(5), "dump-off").status).toBe(0);
    expect(existsSync(dumpDirectory)).toBe(false);

    expect(
      runStart(repository, createReviewDataRepo(5), "dump-on", "master", {
        LOOPS_REVIEW_DUMP_PROMPT: dumpDirectory,
      }).status,
    ).toBe(0);

    expect(readdirSync(dumpDirectory).sort()).toEqual([
      "dump-on-round1-adversarial.prompt.txt",
      "dump-on-round1-diff.prompt.txt",
      "dump-on-round1-integration.prompt.txt",
    ]);
    // The dump is the reviewer's actual input, so a rejected round can be reproduced by
    // hand rather than reconstructed from this tool's source.
    const dumped = readFileSync(`${dumpDirectory}/dump-on-round1-diff.prompt.txt`, "utf8");
    expect(dumped).toContain("AUDIT_PASS=diff");
    expect(dumped).toContain("change.txt");
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

  test("applies the reviewed repository's project review override from loops.json", () => {
    const { repository, baseSha, headSha } = createReviewRepository();
    const item = "project-override-review";
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    mkdirSync(dirname(paths.jsonPath), { recursive: true });
    // One recorded round with a rejected finding: the global five-round policy would run
    // a confirming round, so only the project override's cap of 1 can refuse this start.
    let ledger = createReviewLedger({ item, branch: "feature/review-receipt", baseRef: "master", baseSha });
    ledger = addReviewRound(ledger, {
      headSha,
      model: "codex (default)",
      reviewedAt: "2026-07-21T12:00:01Z",
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
    ledger = recordDisposition(ledger, "R1-F1", "rejected", "Not an actionable defect");
    writeFileSync(paths.jsonPath, `${JSON.stringify(ledger)}\n`);
    const dataRepo = mkdtempSync(`${tmpdir()}/loops-review-data-`);
    writeFileSync(
      `${dataRepo}/loops.json`,
      `${JSON.stringify({
        review: { reviewer: "codex", maxRounds: 5 },
        projects: { atlas: { repo: repository, review: { maxRounds: 1 } } },
      })}\n`,
    );

    const result = runStart(repository, dataRepo, item);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("review round limit of 1 reached");
  });

  test("records a policy-exempt round without invoking the reviewer for an exempt-only range", () => {
    const { repository } = createReviewRepository();
    const item = "exempt-range-review";
    const dataRepo = mkdtempSync(`${tmpdir()}/loops-review-data-`);
    writeFileSync(
      `${dataRepo}/loops.json`,
      `${JSON.stringify({
        review: {
          reviewer: "codex",
          maxRounds: 5,
          classes: [{ name: "bookkeeping", match: ["change.txt"], policy: "exempt" }],
        },
      })}\n`,
    );
    const log = `${mkdtempSync(`${tmpdir()}/loops-fake-log-`)}/passes.log`;

    const result = runStart(repository, dataRepo, item, "master", { FAKE_CODEX_LOG: log });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("policy-exempt");
    expect(existsSync(log)).toBe(false);
    const ledger = readLedgerJson(repository, item);
    expect(ledger.rounds).toHaveLength(1);
    expect(ledger.rounds[0].model).toBe("policy-exempt");
    expect(ledger.rounds[0].audit.kind).toBe("exempt");
    expect(ledger.rounds[0].findings).toEqual([]);
    const status = runStatus(repository, item);
    expect(status.stdout).toContain("REVIEW_STATUS=passed");
  });

  test("runs a normal review when the range mixes exempt and reviewable files", () => {
    const { repository } = createReviewRepository();
    writeFileSync(`${repository}/code.ts`, "export const x = 1;\n");
    git(repository, ["add", "code.ts"]);
    git(repository, ["commit", "-q", "-m", "Add code"]);
    const item = "mixed-range-review";
    const dataRepo = mkdtempSync(`${tmpdir()}/loops-review-data-`);
    writeFileSync(
      `${dataRepo}/loops.json`,
      `${JSON.stringify({
        review: {
          reviewer: "codex",
          maxRounds: 5,
          classes: [{ name: "bookkeeping", match: ["change.txt"], policy: "exempt" }],
        },
      })}\n`,
    );

    const result = runStart(repository, dataRepo, item);

    expect(result.status).toBe(0);
    const ledger = readLedgerJson(repository, item);
    expect(ledger.rounds[0].model).not.toBe("policy-exempt");
    expect(ledger.rounds[0].audit.kind).toBe("full");
  });

  test("refuses the exempt short-circuit when a changed instruction file is landing metadata", () => {
    const repository = mkdtempSync(`${tmpdir()}/loops-review-exempt-metadata-`);
    git(repository, ["init", "-q", "-b", "master"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["config", "user.name", "Test"]);
    writeFileSync(`${repository}/AGENTS.md`, "# Rules\n");
    writeFileSync(`${repository}/BOARD.md`, "old board\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-q", "-m", "Add rules and a board"]);
    git(repository, ["switch", "-q", "-c", "feature/review-receipt"]);
    writeFileSync(`${repository}/AGENTS.md`, "# Rules\n\nWeakened rule.\n");
    writeFileSync(`${repository}/BOARD.md`, "new board\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-q", "-m", "Change the board and the rules"]);
    const item = "exempt-metadata-instruction";
    const dataRepo = mkdtempSync(`${tmpdir()}/loops-review-data-`);
    writeFileSync(
      `${dataRepo}/loops.json`,
      `${JSON.stringify({
        review: {
          reviewer: "codex",
          maxRounds: 5,
          // AGENTS.md as landing metadata keeps it out of manifest.files, which is what
          // the exempt condition used to look at on its own.
          metadataPaths: ["AGENTS.md"],
          classes: [{ name: "bookkeeping", match: ["BOARD.md"], policy: "exempt" }],
        },
      })}\n`,
    );
    const log = `${mkdtempSync(`${tmpdir()}/loops-fake-log-`)}/passes.log`;

    const result = runStart(repository, dataRepo, item, "master", { FAKE_CODEX_LOG: log });

    expect(result.status).toBe(0);
    // The reviewer runs: a rule file must never ride into a round that skips review.
    expect(result.stdout).not.toContain("policy-exempt");
    expect(existsSync(log)).toBe(true);
    expect(readLedgerJson(repository, item).rounds[0].audit.kind).not.toBe("exempt");
  });

  test("waives a classed finding end to end and fails closed without the data repo", () => {
    const { repository } = createReviewRepository();
    const item = "waiver-flow-review";
    const dataRepo = mkdtempSync(`${tmpdir()}/loops-review-data-`);
    writeFileSync(
      `${dataRepo}/loops.json`,
      `${JSON.stringify({
        review: {
          reviewer: "codex",
          maxRounds: 5,
          classes: [{ name: "coordination-prose", match: ["change.txt"], waivablePriorities: ["P2", "P3"] }],
        },
      })}\n`,
    );
    const first = runStart(repository, dataRepo, item, "master", {
      FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
    });
    expect(first.status).toBe(0);

    const unauthorized = runDisposition(repository, item, "R1-F1", "waived-by-policy", "Prose nit", [
      "--class",
      "coordination-prose",
    ]);
    expect(unauthorized.status).not.toBe(0);
    expect(unauthorized.stderr).toContain("waiver is not authorized: no data repo resolved");

    const waived = runDisposition(repository, item, "R1-F1", "waived-by-policy", "Prose nit", [
      "--class",
      "coordination-prose",
      "--data-repo",
      dataRepo,
    ]);
    expect(waived.status).toBe(0);
    expect(readLedgerJson(repository, item).rounds[0].findings[0].disposition.class).toBe("coordination-prose");

    // Status resolves the classes via $LOOPS_DATA_REPO; without it the waiver blocks.
    const blocked = runStatus(repository, item);
    expect(blocked.stdout).toContain("not authorized");
    const passed = spawnSync("bun", ["run", CLI, "status", "--item", item], {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, LOOPS_DATA_REPO: dataRepo },
    });
    expect(passed.stdout).toContain("REVIEW_STATUS=passed");

    // The documented flow passes --data-repo explicitly to start and disposition, so
    // status must accept it too; resolving from the environment alone left every
    // waiver recorded that way blocked at the gate that has to certify it.
    const passedByFlag = spawnSync(
      "bun",
      ["run", CLI, "status", "--item", item, "--data-repo", dataRepo],
      { cwd: repository, encoding: "utf8" },
    );
    expect(passedByFlag.status).toBe(0);
    expect(passedByFlag.stdout).toContain("REVIEW_STATUS=passed");

    const rejected = spawnSync("bun", ["run", CLI, "status", "--data-repo"], {
      cwd: repository,
      encoding: "utf8",
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("status accepts only");

    // A second data repo whose global classes waive the very same path and priority.
    // Both gates must refuse it: the waiver's authority is the repo the ledger recorded,
    // not whichever loops.json the caller names afterwards.
    const foreignRepo = mkdtempSync(`${tmpdir()}/loops-review-foreign-`);
    writeFileSync(
      `${foreignRepo}/loops.json`,
      `${JSON.stringify({
        review: {
          reviewer: "codex",
          maxRounds: 5,
          classes: [{ name: "coordination-prose", match: ["change.txt"], waivablePriorities: ["P2", "P3"] }],
        },
      })}\n`,
    );
    expect(readLedgerJson(repository, item).authority).toEqual({dataRepo: realpathSync.native(dataRepo)});
    const foreignStatus = spawnSync(
      "bun",
      ["run", CLI, "status", "--item", item, "--data-repo", foreignRepo],
      { cwd: repository, encoding: "utf8" },
    );
    expect(foreignStatus.status).not.toBe(0);
    expect(foreignStatus.stdout).toContain("not authorized");
    const foreignWaiver = runDisposition(repository, item, "R1-F1", "waived-by-policy", "Prose nit", [
      "--class",
      "coordination-prose",
      "--data-repo",
      foreignRepo,
    ]);
    expect(foreignWaiver.status).not.toBe(0);
    expect(foreignWaiver.stderr).toContain("is not this review's policy authority");
  });

  test("binds a waiver to the project whose policy the review started under", () => {
    const { repository } = createReviewRepository();
    const item = "waiver-project-authority";
    const dataRepo = mkdtempSync(`${tmpdir()}/loops-review-data-`);
    const writeConfig = (projects: Record<string, unknown>) =>
      writeFileSync(
        `${dataRepo}/loops.json`,
        `${JSON.stringify({
          review: { reviewer: "codex", maxRounds: 5 },
          projects,
        })}\n`,
      );
    // The reviewed checkout is registered as "target", whose block waives P2 on the file.
    writeConfig({
      target: {
        repo: repository,
        review: { classes: [{ name: "coordination-prose", match: ["change.txt"], waivablePriorities: ["P2"] }] },
      },
    });
    expect(
      runStart(repository, dataRepo, item, "master", {
        FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
      }).status,
    ).toBe(0);
    expect(readLedgerJson(repository, item).authority).toEqual({
      dataRepo: realpathSync.native(dataRepo),
      project: "target",
      projectRepo: realpathSync.native(repository),
    });

    // Unregistering that project would otherwise fall the resolution through to the
    // global block; the recorded authority has to refuse instead.
    writeConfig({});
    const unregistered = runDisposition(repository, item, "R1-F1", "waived-by-policy", "Prose nit", [
      "--class",
      "coordination-prose",
      "--data-repo",
      dataRepo,
    ]);
    expect(unregistered.status).not.toBe(0);
    expect(unregistered.stderr).toContain("is no longer registered");

    writeConfig({
      target: {
        repo: repository,
        review: { classes: [{ name: "coordination-prose", match: ["change.txt"], waivablePriorities: ["P2"] }] },
      },
    });
    const waived = runDisposition(repository, item, "R1-F1", "waived-by-policy", "Prose nit", [
      "--class",
      "coordination-prose",
      "--data-repo",
      dataRepo,
    ]);
    expect(waived.status).toBe(0);
    const passed = spawnSync(
      "bun",
      ["run", CLI, "status", "--item", item, "--data-repo", dataRepo],
      { cwd: repository, encoding: "utf8" },
    );
    expect(passed.stdout).toContain("REVIEW_STATUS=passed");

    // A registered name is not an identity: keeping "target" but repointing it at
    // another checkout makes its policy somebody else's, and both gates must refuse.
    const elsewhere = mkdtempSync(`${tmpdir()}/loops-review-elsewhere-`);
    writeConfig({
      target: {
        repo: elsewhere,
        review: { classes: [{ name: "coordination-prose", match: ["change.txt"], waivablePriorities: ["P2"] }] },
      },
    });
    const repointedStatus = spawnSync(
      "bun",
      ["run", CLI, "status", "--item", item, "--data-repo", dataRepo],
      { cwd: repository, encoding: "utf8" },
    );
    expect(repointedStatus.status).not.toBe(0);
    expect(repointedStatus.stdout).toContain("not authorized");
    const repointedWaiver = runDisposition(repository, item, "R1-F1", "waived-by-policy", "Prose nit", [
      "--class",
      "coordination-prose",
      "--data-repo",
      dataRepo,
    ]);
    expect(repointedWaiver.status).not.toBe(0);
    expect(repointedWaiver.stderr).toContain("now points at");

    // An authority naming a project but no checkout cannot rule a repoint out, so it
    // refuses rather than skips - otherwise a ledger in the older shape would be the
    // way around the check.
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    const stored = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    delete stored.authority.projectRepo;
    writeFileSync(paths.jsonPath, `${JSON.stringify(stored)}\n`);
    writeConfig({
      target: {
        repo: elsewhere,
        review: { classes: [{ name: "coordination-prose", match: ["change.txt"], waivablePriorities: ["P2"] }] },
      },
    });
    const uncheckable = runDisposition(repository, item, "R1-F1", "waived-by-policy", "Prose nit", [
      "--class",
      "coordination-prose",
      "--data-repo",
      dataRepo,
    ]);
    expect(uncheckable.status).not.toBe(0);
    expect(uncheckable.stderr).toContain("without the checkout it pointed at");
  });

  test("resolves the exempt short-circuit from the recorded authority, not a fresh match", () => {
    const { repository } = createReviewRepository();
    const item = "exempt-authority-binding";
    const dataRepo = mkdtempSync(`${tmpdir()}/loops-review-data-`);
    const writeConfig = (projects: Record<string, unknown>) =>
      writeFileSync(
        `${dataRepo}/loops.json`,
        `${JSON.stringify({ review: { reviewer: "codex", maxRounds: 5 }, projects })}\n`,
      );
    // Round 1 starts under a project with no classes at all.
    writeConfig({ target: { repo: repository } });
    expect(
      runStart(repository, dataRepo, item, "master", {
        FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
      }).status,
    ).toBe(0);
    expect(runDisposition(repository, item, "R1-F1", "rejected", "Not a defect").status).toBe(0);
    writeFileSync(`${repository}/change.txt`, "review me\nagain\n");
    git(repository, ["add", "change.txt"]);
    git(repository, ["commit", "-q", "-m", "Touch the file again"]);

    // Repointing the recorded project at another checkout and declaring the range
    // exempt must NOT buy a reviewer-free passing round: the exempt short-circuit is
    // the class consumer with the most to give away, so it fails closed like the rest.
    const elsewhere = mkdtempSync(`${tmpdir()}/loops-review-elsewhere-`);
    writeConfig({
      target: {
        repo: elsewhere,
        review: { classes: [{ name: "bookkeeping", match: ["change.txt"], policy: "exempt" }] },
      },
    });
    const log = `${mkdtempSync(`${tmpdir()}/loops-fake-log-`)}/passes.log`;
    const result = runStart(repository, dataRepo, item, "master", { FAKE_CODEX_LOG: log });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("policy-exempt");
    expect(result.stderr).toContain("review classes are not applied this round");
    expect(existsSync(log)).toBe(true);
    expect(readLedgerJson(repository, item).rounds[1].audit.kind).not.toBe("exempt");
  });

  test("runs a governance round with the declared change surface recorded in the ledger", () => {
    const repository = mkdtempSync(`${tmpdir()}/loops-review-governance-`);
    git(repository, ["init", "-q", "-b", "master"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["config", "user.name", "Test"]);
    writeFileSync(`${repository}/AGENTS.md`, "# Rules\n\nOld rule.\n");
    git(repository, ["add", "AGENTS.md"]);
    git(repository, ["commit", "-q", "-m", "Add rules"]);
    git(repository, ["switch", "-q", "-c", "feature/review-receipt"]);
    writeFileSync(`${repository}/AGENTS.md`, "# Rules\n\nNew rule.\n");
    git(repository, ["add", "AGENTS.md"]);
    git(repository, ["commit", "-q", "-m", "Rewrite the rule"]);
    const item = "governance-rewrite-review";
    const dataRepo = createReviewDataRepo(5);
    mkdirSync(`${dataRepo}/items`, {recursive: true});
    mkdirSync(`${dataRepo}/docs/specs`, {recursive: true});
    writeFileSync(`${dataRepo}/docs/specs/rewrite.md`, "# Approved spec\n");
    writeFileSync(
      `${dataRepo}/items/${item}.md`,
      `---\ntitle: Review test\nproject: test\nstate: in-progress\nowner: test\nautonomy: autonomous\n` +
        `next-actor: agent\nnext-step: Review\nupdated: 2026-08-18\nreview:\n  rewrites: [AGENTS.md]\n` +
        `links:\n  spec: docs/specs/rewrite.md\n---\n`,
    );

    const result = runStart(repository, dataRepo, item);

    expect(result.status).toBe(0);
    const ledger = readLedgerJson(repository, item);
    expect(ledger.rounds[0].audit.manifest.instructionFilesUnderRevision).toEqual(["AGENTS.md"]);
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    expect(readFileSync(paths.markdownPath, "utf8")).toContain(
      "Instruction files under revision (declared change surface): AGENTS.md",
    );
  });

  test("refuses a rewrite declaration a rebased base, not the item's patch, satisfies", () => {
    const repository = mkdtempSync(`${tmpdir()}/loops-review-rewrites-basedelta-`);
    git(repository, ["init", "-q", "-b", "master"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["config", "user.name", "Test"]);
    writeFileSync(`${repository}/AGENTS.md`, "# Rules\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-q", "-m", "Add rules"]);
    git(repository, ["switch", "-q", "-c", "feature/review-receipt"]);
    writeFileSync(`${repository}/change.txt`, "review me\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-q", "-m", "Add change"]);
    const item = "rewrites-base-delta";
    const dataRepo = createReviewDataRepo(5);
    mkdirSync(`${dataRepo}/docs/specs`, {recursive: true});
    writeFileSync(`${dataRepo}/docs/specs/rewrite.md`, "# Approved spec\n");
    expect(runStart(repository, dataRepo, item, "master").status).toBe(0);

    // The integration base moves and touches AGENTS.md; the item's own patch does not.
    git(repository, ["switch", "-q", "master"]);
    writeFileSync(`${repository}/AGENTS.md`, "# Rules\n\nBase-side edit.\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-q", "-m", "Edit rules on the base"]);
    git(repository, ["switch", "-q", "feature/review-receipt"]);
    git(repository, ["rebase", "-q", "master"]);
    writeItemWithLinks(dataRepo, item, {spec: "docs/specs/rewrite.md"});
    const itemPath = `${dataRepo}/items/${item}.md`;
    writeFileSync(
      itemPath,
      readFileSync(itemPath, "utf8").replace("links:", "review:\n  rewrites: [AGENTS.md]\nlinks:"),
    );

    const result = runStart(repository, dataRepo, item, "master");

    // The manifest folds the base delta in, so an unscoped check would accept this.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("which is not changed in");
  });

  test("discovers skill rule files and lets an item declare a skill rewrite", () => {
    const repository = mkdtempSync(`${tmpdir()}/loops-review-skill-governance-`);
    git(repository, ["init", "-q", "-b", "master"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["config", "user.name", "Test"]);
    mkdirSync(`${repository}/skills/loops-pickup`, {recursive: true});
    writeFileSync(`${repository}/AGENTS.md`, "# Rules\n");
    writeFileSync(`${repository}/skills/loops-pickup/SKILL.md`, "# Pickup\n\nOld step.\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-q", "-m", "Add rules and a skill"]);
    git(repository, ["switch", "-q", "-c", "feature/review-receipt"]);
    writeFileSync(`${repository}/skills/loops-pickup/SKILL.md`, "# Pickup\n\nNew step.\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-q", "-m", "Rewrite the skill"]);
    const item = "skill-rewrite-review";
    const dataRepo = createReviewDataRepo(5);
    mkdirSync(`${dataRepo}/items`, {recursive: true});
    mkdirSync(`${dataRepo}/docs/specs`, {recursive: true});
    writeFileSync(`${dataRepo}/docs/specs/rewrite.md`, "# Approved spec\n");
    writeFileSync(
      `${dataRepo}/items/${item}.md`,
      `---\ntitle: Review test\nproject: test\nstate: in-progress\nowner: test\nautonomy: autonomous\n` +
        `next-actor: agent\nnext-step: Review\nupdated: 2026-08-18\nreview:\n  rewrites: [skills/loops-pickup/SKILL.md]\n` +
        `links:\n  spec: docs/specs/rewrite.md\n---\n`,
    );

    const result = runStart(repository, dataRepo, item);

    expect(result.status).toBe(0);
    const manifest = readLedgerJson(repository, item).rounds[0].audit.manifest;
    // A skill is authority the reviewer reads AND subject the item may declare; the two
    // questions share one discovered set.
    expect(manifest.instructionFiles).toEqual(["AGENTS.md", "skills/loops-pickup/SKILL.md"]);
    expect(manifest.instructionFilesUnderRevision).toEqual(["skills/loops-pickup/SKILL.md"]);
  });

  test("fails a rewrites declaration closed on every invalid leg", () => {
    // AGENTS.md exists at the base; the reviewed branch changes only change.txt.
    const repository = mkdtempSync(`${tmpdir()}/loops-review-rewrites-`);
    git(repository, ["init", "-q", "-b", "master"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["config", "user.name", "Test"]);
    writeFileSync(`${repository}/AGENTS.md`, "# Rules\n");
    git(repository, ["add", "AGENTS.md"]);
    git(repository, ["commit", "-q", "-m", "Add rules"]);
    git(repository, ["switch", "-q", "-c", "feature/review-receipt"]);
    writeFileSync(`${repository}/change.txt`, "review me\n");
    git(repository, ["add", "change.txt"]);
    git(repository, ["commit", "-q", "-m", "Add change"]);
    const item = "invalid-rewrites-review";
    const dataRepo = createReviewDataRepo(5);
    mkdirSync(`${dataRepo}/items`, {recursive: true});
    mkdirSync(`${dataRepo}/docs/specs`, {recursive: true});
    writeFileSync(`${dataRepo}/docs/specs/rewrite.md`, "# Approved spec\n");
    const writeItem = (frontmatterTail: string) =>
      writeFileSync(
        `${dataRepo}/items/${item}.md`,
        `---\ntitle: Review test\nproject: test\nstate: in-progress\nowner: test\nautonomy: autonomous\n` +
          `next-actor: agent\nnext-step: Review\nupdated: 2026-08-18\n${frontmatterTail}---\n`,
      );

    // Missing links.spec: a governance rewrite needs an owner-approved spec.
    writeItem("review:\n  rewrites: [AGENTS.md]\n");
    const withoutSpec = runStart(repository, dataRepo, item);
    expect(withoutSpec.status).not.toBe(0);
    expect(withoutSpec.stderr).toContain("no links.spec");

    // Not an instruction file of the repository.
    writeItem("review:\n  rewrites: [change.txt]\nlinks:\n  spec: docs/specs/rewrite.md\n");
    const notInstruction = runStart(repository, dataRepo, item);
    expect(notInstruction.status).not.toBe(0);
    expect(notInstruction.stderr).toContain("not an instruction file");

    // An instruction file the reviewed range does not change.
    writeItem("review:\n  rewrites: [AGENTS.md]\nlinks:\n  spec: docs/specs/rewrite.md\n");
    const unchanged = runStart(repository, dataRepo, item);
    expect(unchanged.status).not.toBe(0);
    expect(unchanged.stderr).toContain("not changed in");

    // A malformed declaration aborts instead of silently running without it.
    writeItem("review:\n  rewrites: []\nlinks:\n  spec: docs/specs/rewrite.md\n");
    const malformed = runStart(repository, dataRepo, item);
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain("review.rewrites");

    // No round was recorded by any of the refused attempts.
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    const ledger = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    expect(ledger.rounds).toHaveLength(0);
  });

  test("keeps the global review policy for a repository registered to no project", () => {
    const { repository } = createReviewRepository();
    const item = "unregistered-repo-review";
    const dataRepo = mkdtempSync(`${tmpdir()}/loops-review-data-`);
    writeFileSync(
      `${dataRepo}/loops.json`,
      `${JSON.stringify({
        review: { reviewer: "codex", maxRounds: 5 },
        projects: { atlas: { repo: `${tmpdir()}/somewhere-else`, review: { reviewer: "cursor", maxRounds: 1 } } },
      })}\n`,
    );

    const result = runStart(repository, dataRepo, item);

    expect(result.status).toBe(0);
    expect(readLedgerJson(repository, item).rounds).toHaveLength(1);
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

  test("keeps sibling obligations answered by one finding that names them all", () => {
    // Measured on real reviews, three times across two changes: one defect reported once
    // per pass becomes several accepted findings, so the next round carries several
    // obligations for it. The reviewer marks the whole set incomplete and attaches its
    // single follow-up to one id; the siblings then failed the round and burned a full
    // frontier-model run. Naming them all must be accepted.
    const {repository, baseSha, headSha} = createReviewRepository();
    const item = "duplicate-obligations";
    const dataRepo = createReviewDataRepo(5);
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    mkdirSync(dirname(paths.jsonPath), {recursive: true});
    const finding = (title: string) => ({
      priority: "P1" as const,
      title,
      evidence: "broken",
      impact: "incorrect",
      direction: "fix it",
      confidence: "high" as const,
    });
    let ledger = addReviewRound(
      createReviewLedger({item, branch: "feature/review-receipt", baseRef: baseSha, baseSha}),
      {
        headSha,
        model: "codex (default)",
        reviewedAt: "2026-07-23T12:00:00Z",
        review: {summary: "fix", findings: [finding("Defect as the diff pass saw it"), finding("Defect as the adversarial pass saw it")]},
      },
    );
    ledger = recordDisposition(ledger, "R1-F1", "accepted", "will fix");
    ledger = recordDisposition(ledger, "R1-F2", "accepted", "same defect, will fix with R1-F1");
    writeFileSync(paths.jsonPath, `${JSON.stringify(ledger)}\n`);
    writeFileSync(`${repository}/change.txt`, "review me\nfix attempt\n");
    git(repository, ["add", "change.txt"]);
    git(repository, ["commit", "-q", "-m", "Attempt fix"]);

    const followUp = {
      priority: "P1",
      title: "The shared root cause is still open",
      file: "change.txt",
      line: 2,
      evidence: "the conditional write is still missing",
      impact: "lost update",
      direction: "make the write conditional",
      confidence: "high",
      origin: "remediation",
      obligationIds: ["R1-F1", "R1-F2"],
    };
    const result = runStart(repository, dataRepo, item, baseSha, {
      FAKE_OBLIGATION_STATUS: "incomplete",
      FAKE_FINDINGS_JSON: JSON.stringify([followUp]),
    });

    expect(result.status).toBe(0);
    const recorded = readLedgerJson(repository, item);
    expect(recorded.rounds).toHaveLength(2);
    expect(recorded.rounds[1].findings[0].obligationIds).toEqual(["R1-F1", "R1-F2"]);

    // The first write is not the test: any later command reloads and rewrites the whole
    // ledger, and a decoder that drops the set would silently reduce the audit record to
    // the primary id from then on.
    expect(runDisposition(repository, item, "R2-F1", "accepted", "fix the root cause").status).toBe(0);
    const afterRewrite = readLedgerJson(repository, item);
    expect(afterRewrite.rounds[1].findings[0].obligationIds).toEqual(["R1-F1", "R1-F2"]);
    expect(readFileSync(reviewEvidencePaths(repository, "feature/review-receipt", item).markdownPath, "utf8"))
      .toContain("R1-F1, R1-F2");
  });

  test("names the pass whose classification left an obligation unanswered", () => {
    const {repository, baseSha, headSha} = createReviewRepository();
    const item = "unanswered-names-pass";
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
          priority: "P1" as const,
          title: "Defect",
          evidence: "broken",
          impact: "incorrect",
          direction: "fix it",
          confidence: "high" as const,
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
    expect(result.stderr).toContain("reported by the diff pass");
  });

  test("records a remediation round whose coverage unions the fix-delta hunks", () => {
    const {repository, baseSha, headSha} = createReviewRepository();
    const item = "remediation-union-coverage";
    const dataRepo = createReviewDataRepo(5);
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    mkdirSync(dirname(paths.jsonPath), {recursive: true});
    let ledger = addReviewRound(
      createReviewLedger({item, branch: "feature/review-receipt", baseRef: baseSha, baseSha}),
      {
        headSha,
        model: "codex (default)",
        reviewedAt: "2026-08-09T12:00:00Z",
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
    writeFileSync(`${repository}/change.txt`, "review me\nfix applied\n");
    git(repository, ["add", "change.txt"]);
    git(repository, ["commit", "-q", "-m", "Apply fix"]);

    const result = runStart(repository, dataRepo, item, baseSha, {FAKE_UNION_REMEDIATION: "1"});

    expect(result.status).toBe(0);
    const refreshed = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    expect(refreshed.rounds).toHaveLength(2);
    expect(refreshed.failures ?? []).toHaveLength(0);
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

  // Enforcement contract rule 5 replaced the fresh-ledger restart this test used to
  // assert: a changed patch series now supersedes the base IN the same ledger — round
  // mechanics reset while every round and decision stays — with a snapshot of the
  // pre-supersession evidence left beside it.
  test("supersedes the base in place when the rebased patch series changes", () => {
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
    const newBaseSha = git(repository, ["rev-parse", "master"]);

    expect(runStart(repository, dataRepo, item).status).toBe(0);
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    const superseded = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    expect(superseded.rounds).toHaveLength(2);
    expect(superseded.baseSha).toBe(newBaseSha);
    expect(superseded.supersessions).toHaveLength(1);
    expect(superseded.supersessions[0]).toMatchObject({afterRound: 1, baseSha});
    expect(superseded.rounds[1].audit.kind).toBe("full");
    expect(readdirSync(dirname(paths.jsonPath)).some((name) => name.startsWith("superseded-"))).toBe(true);
  });

  test("carries an open remediation obligation across a changed-patch supersession", () => {
    const {repository, baseSha} = createReviewRepository();
    const item = "supersession-remediation";
    const dataRepo = createReviewDataRepo(5);
    expect(
      runStart(repository, dataRepo, item, baseSha, {
        FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
      }).status,
    ).toBe(0);
    expect(runDisposition(repository, item, "R1-F1", "accepted", "will fix").status).toBe(0);

    git(repository, ["switch", "-q", "master"]);
    writeFileSync(`${repository}/base-two.txt`, "new base\n");
    git(repository, ["add", "base-two.txt"]);
    git(repository, ["commit", "-q", "-m", "Advance base"]);
    git(repository, ["switch", "-q", "feature/review-receipt"]);
    git(repository, ["rebase", "-q", "master"]);
    writeFileSync(`${repository}/change.txt`, "review me\nfix folded into the changed patch\n");
    git(repository, ["add", "change.txt"]);
    git(repository, ["commit", "-q", "-m", "Change reviewed patch"]);

    expect(runStart(repository, dataRepo, item).status).toBe(0);
    const ledger = readLedgerJson(repository, item);
    expect(ledger.supersessions).toHaveLength(1);
    expect(ledger.rounds).toHaveLength(2);
    expect(ledger.rounds[1].audit.kind).toBe("remediation");
    expect(ledger.rounds[1].audit.obligations).toEqual([
      {findingId: "R1-F1", status: "fixed", evidence: "verified", type: "remediation"},
    ]);
  });

  test("carries an open documentation obligation across a changed-patch supersession", () => {
    const {repository, baseSha} = createReviewRepository();
    const item = "supersession-documentation";
    const dataRepo = createReviewDataRepo(5);
    expect(
      runStart(repository, dataRepo, item, baseSha, {
        FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
      }).status,
    ).toBe(0);
    expect(
      runDisposition(repository, item, "R1-F1", "accepted-as-limitation", "below the bar", [
        "--doc",
        "docs/limits.md",
      ]).status,
    ).toBe(0);
    mkdirSync(`${repository}/docs`, {recursive: true});
    writeFileSync(`${repository}/docs/limits.md`, "The lock is an optimisation; loss is tolerated.\n");
    git(repository, ["add", "docs/limits.md"]);
    git(repository, ["commit", "-q", "-m", "Document the limitation"]);

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
    const ledger = readLedgerJson(repository, item);
    expect(ledger.supersessions).toHaveLength(1);
    expect(ledger.rounds).toHaveLength(2);
    expect(ledger.rounds[1].audit.obligations).toEqual([
      {findingId: "R1-F1", status: "documented", evidence: "verified", type: "documentation"},
    ]);
  });

  test("carries a reversal-created obligation across a changed-patch supersession", () => {
    const {repository, baseSha} = createReviewRepository();
    const item = "supersession-reversal";
    const dataRepo = createReviewDataRepo(9);
    expect(
      runStart(repository, dataRepo, item, baseSha, {
        FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
      }).status,
    ).toBe(0);
    expect(
      runDisposition(repository, item, "R1-F1", "accepted-as-limitation", "below the bar", [
        "--doc",
        "docs/limits.md",
      ]).status,
    ).toBe(0);
    mkdirSync(`${repository}/docs`, {recursive: true});
    writeFileSync(`${repository}/docs/limits.md`, "The lock is an optimisation; loss is tolerated.\n");
    git(repository, ["add", "docs/limits.md"]);
    git(repository, ["commit", "-q", "-m", "Document the limitation"]);
    expect(runStart(repository, dataRepo, item).status).toBe(0);
    expect(
      runDisposition(repository, item, "R1-F1", "accepted", "owner ruled: fix it", ["--owner"]).status,
    ).toBe(0);

    git(repository, ["switch", "-q", "master"]);
    writeFileSync(`${repository}/base-two.txt`, "new base\n");
    git(repository, ["add", "base-two.txt"]);
    git(repository, ["commit", "-q", "-m", "Advance base"]);
    git(repository, ["switch", "-q", "feature/review-receipt"]);
    git(repository, ["rebase", "-q", "master"]);
    writeFileSync(`${repository}/change.txt`, "review me\nfix folded into the changed patch\n");
    git(repository, ["add", "change.txt"]);
    git(repository, ["commit", "-q", "-m", "Change reviewed patch"]);

    expect(runStart(repository, dataRepo, item).status).toBe(0);
    const ledger = readLedgerJson(repository, item);
    expect(ledger.supersessions).toHaveLength(1);
    expect(ledger.rounds.at(-1).audit.obligations).toEqual([
      {findingId: "R1-F1#2", status: "fixed", evidence: "verified", type: "remediation"},
    ]);
  });

  test("refuses a base refresh at an unchanged HEAD while a reversal's obligation is open", () => {
    // The same-HEAD remediation guard must hold on every path, not only same-base:
    // shrinking the base to a mid-series ancestor changes the patch series without
    // moving HEAD, and used to reach the reviewer with no fix committed. (The
    // patch-equivalent variant of this cannot be constructed - an unchanged HEAD with
    // a changed base always changes the series except for empty-patch edge commits -
    // so the guard is placed path-independently instead of per-path.)
    const {repository, baseSha} = createReviewRepository();
    const item = "refresh-unfixed-reversal";
    const dataRepo = createReviewDataRepo(9);
    expect(
      runStart(repository, dataRepo, item, baseSha, {
        FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
      }).status,
    ).toBe(0);
    expect(
      runDisposition(repository, item, "R1-F1", "accepted-as-limitation", "below the bar", [
        "--doc",
        "docs/limits.md",
      ]).status,
    ).toBe(0);
    mkdirSync(`${repository}/docs`, {recursive: true});
    writeFileSync(`${repository}/docs/limits.md`, "The lock is an optimisation; loss is tolerated.\n");
    git(repository, ["add", "docs/limits.md"]);
    git(repository, ["commit", "-q", "-m", "Document the limitation"]);
    expect(runStart(repository, dataRepo, item).status).toBe(0);
    expect(
      runDisposition(repository, item, "R1-F1", "accepted", "owner ruled: fix it", ["--owner"]).status,
    ).toBe(0);

    const midSeriesBase = git(repository, ["rev-parse", "HEAD~1"]);
    const refreshed = runStart(repository, dataRepo, item, midSeriesBase);
    expect(refreshed.status).toBe(1);
    expect(refreshed.stderr).toContain("implement and commit");
  });

  test("keeps a documentation obligation live through a patch-equivalent rebase", () => {
    const {repository, baseSha} = createReviewRepository();
    const item = "base-delta-documentation";
    const dataRepo = createReviewDataRepo(9);
    // The doc is part of the reviewed series BEFORE the first round, so the later
    // rebase replays an unchanged patch series.
    mkdirSync(`${repository}/docs`, {recursive: true});
    writeFileSync(`${repository}/docs/limits.md`, "The lock is an optimisation; loss is tolerated.\n");
    git(repository, ["add", "docs/limits.md"]);
    git(repository, ["commit", "-q", "-m", "Document the limitation"]);
    expect(
      runStart(repository, dataRepo, item, baseSha, {
        FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
      }).status,
    ).toBe(0);
    expect(
      runDisposition(repository, item, "R1-F1", "accepted-as-limitation", "below the bar", [
        "--doc",
        "docs/limits.md",
      ]).status,
    ).toBe(0);

    git(repository, ["switch", "-q", "master"]);
    writeFileSync(`${repository}/base-two.txt`, "new base\n");
    git(repository, ["add", "base-two.txt"]);
    git(repository, ["commit", "-q", "-m", "Advance base"]);
    git(repository, ["switch", "-q", "feature/review-receipt"]);
    git(repository, ["rebase", "-q", "master"]);

    expect(runStart(repository, dataRepo, item).status).toBe(0);
    const ledger = readLedgerJson(repository, item);
    expect(ledger.supersessions ?? []).toHaveLength(0);
    expect(ledger.rounds.at(-1).audit.kind).toBe("base-delta");
    expect(ledger.rounds.at(-1).audit.obligations).toEqual([
      {findingId: "R1-F1", status: "documented", evidence: "verified", type: "documentation"},
    ]);
  });

  test("keeps the tripwire armed through a patch-equivalent rebase", () => {
    const {repository, baseSha, headSha} = createReviewRepository();
    const item = "base-delta-tripwire";
    const dataRepo = createReviewDataRepo(9);
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    mkdirSync(dirname(paths.jsonPath), {recursive: true});
    let ledger = createReviewLedger({
      item,
      branch: "feature/review-receipt",
      baseRef: "master",
      baseSha,
      patchIds: [patchId(repository, headSha)],
    });
    for (const roundNumber of [1, 2]) {
      ledger = addReviewRound(ledger, {
        headSha,
        model: "codex (default)",
        reviewedAt: `2026-08-14T12:00:0${roundNumber}Z`,
        review: {
          summary: "churn",
          findings: [{
            priority: "P2",
            title: `Guard interaction ${roundNumber}`,
            evidence: "the previous fix created this",
            impact: "regression",
            direction: "patch it",
            confidence: "high",
            origin: "remediation",
          }],
        },
      });
      ledger = recordDisposition(ledger, `R${roundNumber}-F1`, "rejected", "Not reproducible on re-check");
    }
    writeFileSync(paths.jsonPath, `${JSON.stringify(ledger)}\n`);

    git(repository, ["switch", "-q", "master"]);
    writeFileSync(`${repository}/base-two.txt`, "new base\n");
    git(repository, ["add", "base-two.txt"]);
    git(repository, ["commit", "-q", "-m", "Advance base"]);
    git(repository, ["switch", "-q", "feature/review-receipt"]);
    git(repository, ["rebase", "-q", "master"]);

    const refused = runStart(repository, dataRepo, item);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("remediation-churn tripwire");
  });

  test("keeps the tripwire armed across a changed-patch supersession", () => {
    const {repository, baseSha, headSha} = createReviewRepository();
    const item = "supersession-tripwire";
    const dataRepo = createReviewDataRepo(9);
    seedTripwireLedger(repository, item, baseSha, headSha);

    git(repository, ["switch", "-q", "master"]);
    writeFileSync(`${repository}/base-two.txt`, "new base\n");
    git(repository, ["add", "base-two.txt"]);
    git(repository, ["commit", "-q", "-m", "Advance base"]);
    git(repository, ["switch", "-q", "feature/review-receipt"]);
    git(repository, ["rebase", "-q", "master"]);

    const refused = runStart(repository, dataRepo, item);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("remediation-churn tripwire");
  });

  test("records a limitation disposition with its doc path and gates P0/P1 on owner attribution", () => {
    const {repository} = createReviewRepository();
    const item = "limitation-disposition";
    const dataRepo = createReviewDataRepo(9);
    const findings = [fakeFinding(), fakeFinding({priority: "P1", title: "High severity defect"})];
    expect(
      runStart(repository, dataRepo, item, "master", {FAKE_FINDINGS_JSON: JSON.stringify(findings)}).status,
    ).toBe(0);

    const limited = runDisposition(repository, item, "R1-F1", "accepted-as-limitation", "below the documented bar", [
      "--doc",
      "docs/limits.md",
    ]);
    expect(limited.status).toBe(0);
    const ledger = readLedgerJson(repository, item);
    expect(ledger.rounds[0].findings[0].disposition).toEqual({
      kind: "accepted-as-limitation",
      reason: "below the documented bar",
      doc: "docs/limits.md",
      decidedAfterRound: 1,
    });

    const withoutOwner = runDisposition(repository, item, "R1-F2", "accepted-as-limitation", "too costly", [
      "--doc",
      "docs/limits.md",
    ]);
    expect(withoutOwner.status).toBe(1);
    expect(withoutOwner.stderr).toContain("owner");
    const withOwner = runDisposition(
      repository,
      item,
      "R1-F2",
      "accepted-as-limitation",
      "owner ruled 2026-08-14: below the bar",
      ["--doc", "docs/limits.md", "--owner"],
    );
    expect(withOwner.status).toBe(0);
    expect(readLedgerJson(repository, item).rounds[0].findings[1].disposition.owner).toBe(true);
  });

  test("rejects an absolute or traversal doc path at recording time", () => {
    const {repository} = createReviewRepository();
    const item = "doc-path-shape";
    const dataRepo = createReviewDataRepo(9);
    expect(
      runStart(repository, dataRepo, item, "master", {
        FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
      }).status,
    ).toBe(0);

    for (const doc of ["/etc/limits.md", "../outside.md"]) {
      const result = runDisposition(repository, item, "R1-F1", "accepted-as-limitation", "below the bar", [
        "--doc",
        doc,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("repository-relative");
    }
  });

  test("refuses the next round until the documentation obligation's path is a tracked regular file", () => {
    const {repository} = createReviewRepository();
    const item = "missing-documentation";
    const dataRepo = createReviewDataRepo(9);
    expect(
      runStart(repository, dataRepo, item, "master", {
        FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
      }).status,
    ).toBe(0);
    expect(
      runDisposition(repository, item, "R1-F1", "accepted-as-limitation", "below the bar", [
        "--doc",
        "docs/limits.md",
      ]).status,
    ).toBe(0);

    const missing = runStart(repository, dataRepo, item);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("tracked regular file");

    mkdirSync(`${repository}/docs`, {recursive: true});
    writeFileSync(`${repository}/docs/limits.md`, "The lock is an optimisation; loss is tolerated.\n");
    git(repository, ["add", "docs/limits.md"]);
    git(repository, ["commit", "-q", "-m", "Document the lock limitation"]);

    const confirmed = runStart(repository, dataRepo, item);
    expect(confirmed.status).toBe(0);
    const ledger = readLedgerJson(repository, item);
    expect(ledger.rounds).toHaveLength(2);
    expect(ledger.rounds[1].findings).toEqual([]);
    expect(ledger.rounds[1].audit.obligations).toEqual([
      {findingId: "R1-F1", status: "documented", evidence: "verified", type: "documentation"},
    ]);
    const status = runStatus(repository, item);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("REVIEW_STATUS=passed");
  });

  test("rejects a symlinked doc path at the start gate", () => {
    const {repository} = createReviewRepository();
    const item = "symlinked-doc";
    const dataRepo = createReviewDataRepo(9);
    expect(
      runStart(repository, dataRepo, item, "master", {
        FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
      }).status,
    ).toBe(0);
    expect(
      runDisposition(repository, item, "R1-F1", "accepted-as-limitation", "below the bar", [
        "--doc",
        "docs/limits.md",
      ]).status,
    ).toBe(0);

    mkdirSync(`${repository}/docs`, {recursive: true});
    writeFileSync(`${repository}/real.md`, "documented elsewhere\n");
    symlinkSync("../real.md", `${repository}/docs/limits.md`);
    git(repository, ["add", "real.md", "docs/limits.md"]);
    git(repository, ["commit", "-q", "-m", "Symlink the doc path"]);

    const result = runStart(repository, dataRepo, item);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tracked regular file");
  });

  test("rejects a doc path that resolves to a directory at the start gate", () => {
    const {repository} = createReviewRepository();
    const item = "directory-doc";
    const dataRepo = createReviewDataRepo(9);
    expect(
      runStart(repository, dataRepo, item, "master", {
        FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
      }).status,
    ).toBe(0);
    expect(
      runDisposition(repository, item, "R1-F1", "accepted-as-limitation", "below the bar", [
        "--doc",
        "docs",
      ]).status,
    ).toBe(0);
    mkdirSync(`${repository}/docs`, {recursive: true});
    writeFileSync(`${repository}/docs/limits.md`, "content lives below the recorded path\n");
    git(repository, ["add", "docs/limits.md"]);
    git(repository, ["commit", "-q", "-m", "Commit a directory at the doc path"]);

    const result = runStart(repository, dataRepo, item);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tracked regular file");
  });

  test("keeps an incomplete documentation result actionable even with an empty findings array", () => {
    const {repository} = createReviewRepository();
    const item = "incomplete-documentation";
    const dataRepo = createReviewDataRepo(9);
    expect(
      runStart(repository, dataRepo, item, "master", {
        FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
      }).status,
    ).toBe(0);
    expect(
      runDisposition(repository, item, "R1-F1", "accepted-as-limitation", "below the bar", [
        "--doc",
        "docs/limits.md",
      ]).status,
    ).toBe(0);
    mkdirSync(`${repository}/docs`, {recursive: true});
    writeFileSync(`${repository}/docs/limits.md`, "unrelated text\n");
    git(repository, ["add", "docs/limits.md"]);
    git(repository, ["commit", "-q", "-m", "Add an unrelated doc"]);

    const result = runStart(repository, dataRepo, item, "master", {FAKE_DOC_STATUS: "incomplete"});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must remain an actionable finding");
    const ledger = readLedgerJson(repository, item);
    expect(ledger.rounds).toHaveLength(1);
    expect(ledger.failures).toHaveLength(1);
  });

  test("walks the owner-reversal chain: documented, reversed, unchanged-HEAD refusal, then a required fresh obligation", () => {
    const {repository} = createReviewRepository();
    const item = "limitation-reversal";
    const dataRepo = createReviewDataRepo(9);
    expect(
      runStart(repository, dataRepo, item, "master", {
        FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
      }).status,
    ).toBe(0);
    expect(
      runDisposition(repository, item, "R1-F1", "accepted-as-limitation", "below the bar", [
        "--doc",
        "docs/limits.md",
      ]).status,
    ).toBe(0);
    mkdirSync(`${repository}/docs`, {recursive: true});
    writeFileSync(`${repository}/docs/limits.md`, "The lock is an optimisation; loss is tolerated.\n");
    git(repository, ["add", "docs/limits.md"]);
    git(repository, ["commit", "-q", "-m", "Document the lock limitation"]);
    expect(runStart(repository, dataRepo, item).status).toBe(0);
    expect(runStatus(repository, item).stdout).toContain("REVIEW_STATUS=passed");

    const withoutOwner = runDisposition(repository, item, "R1-F1", "accepted", "changed my mind");
    expect(withoutOwner.status).toBe(1);
    const reversal = runDisposition(repository, item, "R1-F1", "accepted", "owner ruled: fix it", ["--owner"]);
    expect(reversal.status).toBe(0);
    const reversed = readLedgerJson(repository, item);
    expect(reversed.rounds[0].findings[0].disposition).toEqual({
      kind: "accepted",
      reason: "owner ruled: fix it",
      owner: true,
      decidedAfterRound: 2,
    });
    expect(reversed.rounds[0].findings[0].history).toEqual([
      {kind: "accepted-as-limitation", reason: "below the bar", doc: "docs/limits.md", decidedAfterRound: 1},
    ]);

    const unchangedHead = runStart(repository, dataRepo, item);
    expect(unchangedHead.status).toBe(1);
    expect(unchangedHead.stderr).toContain("implement and commit");
    const reopenedStatus = runStatus(repository, item);
    expect(reopenedStatus.status).toBe(1);
    expect(reopenedStatus.stdout).toContain("open obligation");

    writeFileSync(`${repository}/change.txt`, "review me\ncrash-safe now\n");
    git(repository, ["add", "change.txt"]);
    git(repository, ["commit", "-q", "-m", "Fix the reversed limitation"]);
    expect(runStart(repository, dataRepo, item).status).toBe(0);
    const confirmed = readLedgerJson(repository, item);
    expect(confirmed.rounds).toHaveLength(3);
    expect(confirmed.rounds[2].audit.obligations).toEqual([
      {findingId: "R1-F1#2", status: "fixed", evidence: "verified", type: "remediation"},
    ]);
    expect(runStatus(repository, item).stdout).toContain("REVIEW_STATUS=passed");
  });

  /** Two completed remediation-dominated rounds at the given head, all findings
   * rejected so the round loop itself may continue. */
  function seedTripwireLedger(repository: string, item: string, baseSha: string, headSha: string): void {
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    mkdirSync(dirname(paths.jsonPath), {recursive: true});
    let ledger = createReviewLedger({item, branch: "feature/review-receipt", baseRef: "master", baseSha});
    for (const roundNumber of [1, 2]) {
      ledger = addReviewRound(ledger, {
        headSha,
        model: "codex (default)",
        reviewedAt: `2026-08-14T12:00:0${roundNumber}Z`,
        review: {
          summary: "churn",
          findings: [{
            priority: "P2",
            title: `Guard interaction ${roundNumber}`,
            evidence: "the previous fix created this",
            impact: "regression",
            direction: "patch it",
            confidence: "high",
            origin: "remediation",
          }],
        },
      });
      ledger = recordDisposition(ledger, `R${roundNumber}-F1`, "rejected", "Not reproducible on re-check");
    }
    writeFileSync(paths.jsonPath, `${JSON.stringify(ledger)}\n`);
  }

  test("refuses the round after two remediation-dominated rounds until a step-back note is supplied", () => {
    const {repository, baseSha, headSha} = createReviewRepository();
    const item = "tripwire-armed";
    const dataRepo = createReviewDataRepo(9);
    seedTripwireLedger(repository, item, baseSha, headSha);

    const refused = runStart(repository, dataRepo, item);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("rounds 1 and 2");
    expect(refused.stderr).toContain("1/1");
    expect(refused.stderr).toContain("--step-back");
  });

  test("rejects a pre-trigger step-back note and accepts an updated one", () => {
    const {repository, baseSha} = createReviewRepository();
    const item = "tripwire-freshness";
    const dataRepo = createReviewDataRepo(9);
    writeFileSync(`${repository}/step-back.md`, "Invariants: none yet. Decision: continue.\n");
    git(repository, ["add", "step-back.md"]);
    git(repository, ["commit", "-q", "-m", "Write a note before the tripwire fired"]);
    const headWithNote = git(repository, ["rev-parse", "HEAD"]);
    seedTripwireLedger(repository, item, baseSha, headWithNote);

    const stale = runStart(repository, dataRepo, item, "master", {}, ["--step-back", "step-back.md"]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("unchanged from round 2");

    writeFileSync(
      `${repository}/step-back.md`,
      "Invariants: lock identity, release-on-crash. Decision: rewrite from the invariant list. Covers R1-F1, R2-F1.\n",
    );
    git(repository, ["add", "step-back.md"]);
    git(repository, ["commit", "-q", "-m", "Step back after rounds 1 and 2"]);

    const accepted = runStart(repository, dataRepo, item, "master", {}, ["--step-back", "step-back.md"]);
    expect(accepted.status).toBe(0);
    const ledger = readLedgerJson(repository, item);
    expect(ledger.rounds).toHaveLength(3);
    expect(ledger.rounds[2].stepBack).toEqual({path: "step-back.md", triggerRounds: [1, 2]});
  });

  test("fails closed when the triggering round's reviewed tree is unavailable", () => {
    const {repository, baseSha} = createReviewRepository();
    const item = "tripwire-pruned-trigger";
    const dataRepo = createReviewDataRepo(9);
    seedTripwireLedger(repository, item, baseSha, "0123456789abcdef0123456789abcdef01234567");
    writeFileSync(
      `${repository}/step-back.md`,
      "Invariants: lock identity. Decision: rewrite. Covers R1-F1, R2-F1.\n",
    );
    git(repository, ["add", "step-back.md"]);
    git(repository, ["commit", "-q", "-m", "Fresh step-back note"]);

    const result = runStart(repository, dataRepo, item, "master", {}, ["--step-back", "step-back.md"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reviewed tree");
    expect(result.stderr).toContain("not available");
  });

  test("refuses --step-back while no tripwire is armed", () => {
    const {repository} = createReviewRepository();
    const item = "step-back-unarmed";
    const dataRepo = createReviewDataRepo(9);
    writeFileSync(`${repository}/step-back.md`, "premature\n");
    git(repository, ["add", "step-back.md"]);
    git(repository, ["commit", "-q", "-m", "Premature note"]);

    const result = runStart(repository, dataRepo, item, "master", {}, ["--step-back", "step-back.md"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no remediation-churn tripwire is armed");
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
      {findingId: "R1-F1", status: "fixed", evidence: "verified", type: "remediation"},
    ]);
    expect(refreshed.rounds[1].findings).toEqual([]);
    expect(readdirSync(dirname(paths.jsonPath)).some((name) => name.startsWith("superseded-"))).toBe(false);
  });
});

describe("cli-review scoped confirmation", () => {
  /** Data repo whose review policy opts into scoped confirmation rounds. */
  function createScopedDataRepo(confirmation: string): string {
    const dataRepo = mkdtempSync(`${tmpdir()}/loops-review-data-`);
    writeFileSync(
      `${dataRepo}/loops.json`,
      `${JSON.stringify({review: {reviewer: "codex", maxRounds: 5, confirmation}})}\n`,
    );
    return dataRepo;
  }

  /** A branch whose reviewed range spans two files, with a first round that accepted a
   * finding and a fix commit touching only one of them, so a scoped round's narrower
   * range is visible in the manifest rather than merely asserted. */
  function createConfirmationRepository(): {
    repository: string;
    baseSha: string;
    firstHeadSha: string;
    item: string;
  } {
    const {repository, baseSha} = createReviewRepository();
    writeFileSync(`${repository}/other.txt`, "untouched by the fix\n");
    git(repository, ["add", "other.txt"]);
    git(repository, ["commit", "-q", "-m", "Add a second reviewed file"]);
    return {repository, baseSha, firstHeadSha: git(repository, ["rev-parse", "HEAD"]), item: "scoped-confirmation"};
  }

  /** Round 1 with one accepted finding, then the fix commit that answers it. */
  function acceptAndFix(repository: string, item: string, baseSha: string, firstHeadSha: string): void {
    const paths = reviewEvidencePaths(repository, "feature/review-receipt", item);
    mkdirSync(dirname(paths.jsonPath), {recursive: true});
    let ledger = addReviewRound(
      createReviewLedger({item, branch: "feature/review-receipt", baseRef: baseSha, baseSha}),
      {
        headSha: firstHeadSha,
        model: "codex (default)",
        reviewedAt: "2026-08-18T12:00:00Z",
        review: {
          summary: "one defect",
          findings: [
            {
              priority: "P1",
              title: "Defect",
              file: "change.txt",
              evidence: "broken",
              impact: "incorrect",
              direction: "fix it",
              confidence: "high",
            },
          ],
        },
      },
    );
    ledger = recordDisposition(ledger, "R1-F1", "accepted", "will fix");
    writeFileSync(paths.jsonPath, `${JSON.stringify(ledger)}\n`);
    writeFileSync(`${repository}/change.txt`, "review me\nfix applied\n");
    git(repository, ["add", "change.txt"]);
    git(repository, ["commit", "-q", "-m", "Apply fix"]);
  }

  test("runs the obligation pass alone over the remediation range when the round qualifies", () => {
    const {repository, baseSha, firstHeadSha, item} = createConfirmationRepository();
    const dataRepo = createScopedDataRepo("scoped");
    acceptAndFix(repository, item, baseSha, firstHeadSha);
    const log = `${mkdtempSync(`${tmpdir()}/loops-fake-log-`)}/passes.log`;

    const result = runStart(repository, dataRepo, item, baseSha, {FAKE_CODEX_LOG: log});

    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["diff"]);
    const ledger = readLedgerJson(repository, item);
    expect(ledger.rounds).toHaveLength(2);
    const audit = ledger.rounds[1].audit;
    expect(audit.kind).toBe("remediation");
    expect(audit.scope).toBe("remediation-range");
    // The recorded manifest is the range the reviewer actually saw: the fix delta, not
    // base..HEAD; otherwise the ledger would claim coverage nobody asked for.
    expect(audit.manifest.baseSha).toBe(firstHeadSha);
    expect(audit.manifest.files.map((file: {path: string}) => file.path)).toEqual(["change.txt"]);
  });

  test("keeps the full range and every pass when the policy leaves confirmation at full", () => {
    const {repository, baseSha, firstHeadSha, item} = createConfirmationRepository();
    const dataRepo = createScopedDataRepo("full");
    acceptAndFix(repository, item, baseSha, firstHeadSha);
    const log = `${mkdtempSync(`${tmpdir()}/loops-fake-log-`)}/passes.log`;

    const result = runStart(repository, dataRepo, item, baseSha, {
      FAKE_CODEX_LOG: log,
      FAKE_UNION_REMEDIATION: "1",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["diff", "integration", "adversarial"]);
    const ledger = readLedgerJson(repository, item);
    const audit = ledger.rounds[1].audit;
    expect(audit.scope).toBeUndefined();
    expect(audit.manifest.baseSha).toBe(baseSha);
    expect(audit.manifest.files.map((file: {path: string}) => file.path).sort()).toEqual(["change.txt", "other.txt"]);
  });

  test("does not narrow a round that owes no remediation", () => {
    const {repository, baseSha, item} = createConfirmationRepository();
    const dataRepo = createScopedDataRepo("scoped");
    const log = `${mkdtempSync(`${tmpdir()}/loops-fake-log-`)}/passes.log`;

    const result = runStart(repository, dataRepo, item, baseSha, {FAKE_CODEX_LOG: log});

    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["diff", "integration", "adversarial"]);
    const ledger = readLedgerJson(repository, item);
    expect(ledger.rounds[0].audit.kind).toBe("full");
    expect(ledger.rounds[0].audit.scope).toBeUndefined();
    expect(ledger.rounds[0].audit.manifest.baseSha).toBe(baseSha);
  });

  test("does not narrow a round whose configured passes omit the diff pass", () => {
    const {repository, baseSha, firstHeadSha, item} = createConfirmationRepository();
    const dataRepo = mkdtempSync(`${tmpdir()}/loops-review-data-`);
    writeFileSync(
      `${dataRepo}/loops.json`,
      `${JSON.stringify({
        review: {reviewer: "codex", maxRounds: 5, confirmation: "scoped", auditPasses: ["integration", "adversarial"]},
      })}\n`,
    );
    acceptAndFix(repository, item, baseSha, firstHeadSha);
    const log = `${mkdtempSync(`${tmpdir()}/loops-fake-log-`)}/passes.log`;

    const result = runStart(repository, dataRepo, item, baseSha, {
      FAKE_CODEX_LOG: log,
      FAKE_UNION_REMEDIATION: "1",
    });

    expect(result.status).toBe(0);
    // The narrowed round IS the diff pass. With diff excluded there is nothing to
    // narrow to, and scoping would run integration over the fix delta - the pass the
    // contract says to skip - so the round stays full.
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["integration", "adversarial"]);
    const ledger = readLedgerJson(repository, item);
    expect(ledger.rounds[1].audit.scope).toBeUndefined();
    expect(ledger.rounds[1].audit.manifest.baseSha).toBe(baseSha);
  });

  test("does not narrow a round that still owes a documentation obligation", () => {
    const {repository, baseSha, item} = createConfirmationRepository();
    const dataRepo = createScopedDataRepo("scoped");
    expect(
      runStart(repository, dataRepo, item, baseSha, {
        FAKE_FINDINGS_JSON: JSON.stringify([fakeFinding()]),
      }).status,
    ).toBe(0);
    expect(
      runDisposition(repository, item, "R1-F1", "accepted-as-limitation", "below the bar", [
        "--doc",
        "docs/limits.md",
      ]).status,
    ).toBe(0);
    mkdirSync(`${repository}/docs`, {recursive: true});
    writeFileSync(`${repository}/docs/limits.md`, "The lock is an optimisation; loss is tolerated.\n");
    git(repository, ["add", "docs/limits.md"]);
    git(repository, ["commit", "-q", "-m", "Document the limitation"]);
    const log = `${mkdtempSync(`${tmpdir()}/loops-fake-log-`)}/passes.log`;

    const result = runStart(repository, dataRepo, item, baseSha, {FAKE_CODEX_LOG: log});

    expect(result.status).toBe(0);
    // A documentation obligation is verified against the whole reviewed range, not the
    // fix delta; the artifact it names need not be in any remediation commit.
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["diff", "integration", "adversarial"]);
    const ledger = readLedgerJson(repository, item);
    expect(ledger.rounds[1].audit.scope).toBeUndefined();
    expect(ledger.rounds[1].audit.manifest.baseSha).toBe(baseSha);
  });
});
