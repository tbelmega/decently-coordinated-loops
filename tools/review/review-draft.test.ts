import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEST_IDENTITIES } from "../test-identities.ts";

const CLI = resolve(import.meta.dirname, "cli-review.ts");
const item = TEST_IDENTITIES.items.householdSlideshow;
const project = TEST_IDENTITIES.projects.household;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function git(repository: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repository, ...args], {encoding: "utf8"});
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function createFakeCodex(): string {
  const directory = mkdtempSync(join(tmpdir(), "loops-draft-fake-codex-"));
  const executable = join(directory, "codex");
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env bun",
      'import {appendFileSync} from "node:fs";',
      "const args = Bun.argv.slice(2);",
      'const outputIndex = args.indexOf("--output-last-message");',
      'if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("missing output path");',
      'if (args.at(-1) !== "-") throw new Error("expected stdin sentinel");',
      "const prompt = await Bun.stdin.text();",
      'const marker = "DRAFT_REVIEW_INPUT\\n";',
      "const markerIndex = prompt.indexOf(marker);",
      'if (markerIndex < 0) throw new Error("missing draft input");',
      "const input = JSON.parse(prompt.slice(markerIndex + marker.length));",
      'if (process.env.FAKE_DRAFT_LOG) appendFileSync(process.env.FAKE_DRAFT_LOG, `${JSON.stringify(input)}\\n`);',
      'if (process.env.FAKE_DRAFT_INVALID) { await Bun.write(args[outputIndex + 1], JSON.stringify({pass: input.pass})); process.exit(0); }',
      'const file = input.coverage.files[0] ?? {path: input.draft.path, hunks: []};',
      'const findings = process.env.FAKE_DRAFT_FINDINGS ? JSON.parse(process.env.FAKE_DRAFT_FINDINGS) : [];',
      'await Bun.write(args[outputIndex + 1], JSON.stringify({pass: input.pass, summary: process.env.FAKE_DRAFT_SUMMARY ?? "draft reviewed", coverage: input.coverage, obligations: [], findings, notes: JSON.parse(process.env.FAKE_DRAFT_NOTES ?? "[]")}));',
      "",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  return executable;
}

interface Fixture {
  repository: string;
  dataRepo: string;
  draft: string;
  intent: string;
  fakeCodex: string;
  recordPath: string;
  markdownPath: string;
  run: (command: string, args?: string[], environment?: Record<string, string>) => SpawnSyncReturns<string>;
}

function fixture(review: Record<string, unknown> = {reviewer: "codex"}): Fixture {
  const repository = mkdtempSync(join(tmpdir(), "loops-draft-repository-"));
  const dataRepo = mkdtempSync(join(tmpdir(), "loops-draft-data-"));
  git(repository, ["init", "-q", "-b", "master"]);
  git(repository, ["config", "user.name", TEST_IDENTITIES.owner]);
  git(repository, ["config", "user.email", "alice@example.test"]);
  writeFileSync(join(repository, ".gitignore"), ".reviews/\n");
  git(repository, ["add", ".gitignore"]);
  git(repository, ["commit", "-qm", "Add review evidence ignore rule"]);
  const draft = join(repository, "draft.md");
  const intent = join(repository, "intent.md");
  writeFileSync(draft, "# Draft\n\nUse a five-second timeout.\n");
  writeFileSync(intent, "# Intent\n\nKeep the interaction bounded.\n");
  writeFileSync(join(repository, "unrelated.txt"), "Leave this uncommitted.\n");
  mkdirSync(join(dataRepo, "items"));
  writeFileSync(
    join(dataRepo, "items", `${item}.md`),
    `---\ntitle: Draft review\nproject: ${project}\nstate: idea\nnext-actor: agent\nnext-step: Refine\nupdated: 2026-09-05\n---\n`,
  );
  writeFileSync(
    join(dataRepo, "loops.json"),
    JSON.stringify({projects: {[project]: {repo: repository}}, review}),
  );
  const fakeCodex = createFakeCodex();
  const run = (command: string, args: string[] = [], environment: Record<string, string> = {}): SpawnSyncReturns<string> =>
    spawnSync(
      process.execPath,
      [CLI, command, "--item", item, "--data-repo", dataRepo, ...args],
      {cwd: repository, encoding: "utf8", env: {...process.env, CODEX_BIN: fakeCodex, ...environment}},
    );
  return {
    repository,
    dataRepo,
    draft,
    intent,
    fakeCodex,
    recordPath: join(repository, ".reviews", "drafts", `${item}.json`),
    markdownPath: join(repository, ".reviews", "drafts", `${item}.md`),
    run,
  };
}

function start(f: Fixture, args: string[] = [], environment: Record<string, string> = {}): SpawnSyncReturns<string> {
  return f.run("draft-start", ["--draft", f.draft, "--intent", "intent.md", ...args], environment);
}

function record(f: Fixture): Record<string, unknown> {
  return object(JSON.parse(readFileSync(f.recordPath, "utf8")), "draft review record");
}

function completedAttempts(f: Fixture): Record<string, unknown>[] {
  return array(record(f).attempts, "attempts").map((entry) => object(entry, "attempt"));
}

function writeProfileConfig(f: Fixture): void {
  writeFileSync(
    join(f.dataRepo, "loops.json"),
    JSON.stringify({
      projects: {[project]: {repo: f.repository, review: {profile: "draft", effort: "project-effort"}}},
      review: {
        reviewer: "codex",
        model: "global-model",
        effort: "low",
        profiles: {
          draft: {
            personas: [
              {name: "diff", fromRound: 1, toRound: 1, reviewer: "codex", model: "profile-diff", effort: "medium"},
              {name: "adversarial", fromRound: 1, toRound: 1, reviewer: "codex", model: "profile-adversarial", effort: "high"},
              {name: "confirmation", fromRound: 2, reviewer: "codex", model: "profile-confirmation", effort: "medium"},
            ],
          },
        },
      },
    }),
  );
}

function finding(): Record<string, unknown> {
  return {
    priority: "P2",
    title: "Timeout wording is incomplete",
    file: "draft.md",
    line: 3,
    evidence: "The draft does not define the timeout boundary.",
    impact: "The implementation can choose an inconsistent timeout.",
    direction: "State the exact timeout boundary.",
    confidence: "high",
    origin: "original",
    causality: "unmet-obligation",
    obligationId: null,
    obligationIds: null,
  };
}

describe("draft review CLI", () => {
  test("reviews uncommitted draft and intent snapshots without changing HEAD or unrelated dirt", () => {
    const f = fixture({reviewer: "codex", model: "global-model", effort: "medium"});
    const beforeHead = git(f.repository, ["rev-parse", "HEAD"]);
    const beforeStatus = git(f.repository, ["status", "--short"]);
    const promptLog = join(mkdtempSync(join(tmpdir(), "loops-draft-prompt-")), "input.jsonl");

    expect(start(f, [], {FAKE_DRAFT_LOG: promptLog}).status).toBe(0);
    expect(git(f.repository, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(git(f.repository, ["status", "--short"])).toBe(beforeStatus);
    expect(existsSync(f.recordPath)).toBe(true);
    expect(existsSync(f.markdownPath)).toBe(true);

    const ledger = record(f);
    expect(ledger).toMatchObject({kind: "draft-review", version: 1, item, repository: f.repository, draftPath: f.draft, intentPath: f.intent});
    expect(object(ledger.authority, "draft authority")).toMatchObject({dataRepo: f.dataRepo, project, projectRepo: f.repository});
    const attempt = completedAttempts(f)[0];
    expect(attempt).toMatchObject({state: "completed", round: 1});
    for (const pass of array(attempt.passes, "passes").map((entry) => object(entry, "pass"))) {
      expect(pass).toMatchObject({reviewer: "codex", model: "global-model", effort: "medium"});
    }
    const prompts = readFileSync(promptLog, "utf8").trim().split("\n").map((line) => object(JSON.parse(line), "draft prompt"));
    expect(prompts).toHaveLength(3);
    const prompt = prompts[0]!;
    expect(object(prompt.draft, "draft snapshot")).toMatchObject({path: f.draft, content: "# Draft\n\nUse a five-second timeout.\n"});
    expect(object(prompt.intent, "intent snapshot")).toMatchObject({path: f.intent, content: "# Intent\n\nKeep the interaction bounded.\n"});
    expect(array(object(prompt.coverage, "coverage").files, "coverage files")).toEqual([
      {path: f.draft, hunks: []},
      {path: f.intent, hunks: []},
    ]);
  });

  test("requires a configured reviewer and records failed adapter output before a successful retry", () => {
    const unconfigured = fixture({});
    expect(start(unconfigured).status).not.toBe(0);
    expect(existsSync(unconfigured.recordPath)).toBe(true);
    expect(unconfigured.run("draft-status").stdout).toContain("DRAFT_REVIEW_STATUS=failed");

    const f = fixture();
    expect(start(f, [], {FAKE_DRAFT_INVALID: "1"}).status).not.toBe(0);
    expect(completedAttempts(f)[0]).toMatchObject({state: "failed", round: 1});
    expect(start(f).status).toBe(0);
    expect(completedAttempts(f).map((attempt) => attempt.state)).toEqual(["failed", "completed"]);

    const missingInput = fixture();
    unlinkSync(missingInput.intent);
    expect(start(missingInput).status).not.toBe(0);
    expect(completedAttempts(missingInput)[0]).toMatchObject({state: "failed", round: 1});
    writeFileSync(missingInput.intent, "# Intent\n\nKeep the interaction bounded.\n");
    expect(start(missingInput).status).toBe(0);
    expect(completedAttempts(missingInput).map((attempt) => attempt.state)).toEqual(["failed", "completed"]);
  });

  test("requires owner authorization to extend the one-round draft cap", () => {
    const f = fixture();
    expect(start(f).status).toBe(0);
    expect(start(f).status).not.toBe(0);
    expect(start(f, ["--max-rounds", "2", "--authorization", "owner approved one additional draft review round"]).status).toBe(0);
    expect(completedAttempts(f).filter((attempt) => attempt.state === "completed").map((attempt) => attempt.round)).toEqual([1, 2]);
  });

  test("refuses missing or wrong-project items before creating evidence or invoking a reviewer", () => {
    const f = fixture();
    expect(start(f).status).toBe(0);
    const log = join(f.repository, "invocations.jsonl");
    const missing = `${item}-typo`;
    const result = spawnSync(process.execPath, [CLI, "draft-start", "--item", missing,
      "--data-repo", f.dataRepo, "--draft", f.draft, "--intent", f.intent],
      {cwd: f.repository, encoding: "utf8", env: {...process.env, CODEX_BIN: f.fakeCodex, FAKE_DRAFT_LOG: log}});
    expect(result.status).not.toBe(0);
    expect(existsSync(join(f.repository, ".reviews", "drafts", `${missing}.json`))).toBe(false);
    expect(existsSync(log)).toBe(false);
    const other = fixture();
    const itemPath = join(other.dataRepo, "items", `${item}.md`);
    writeFileSync(itemPath, readFileSync(itemPath, "utf8").replace(`project: ${project}`, "project: relay"));
    expect(start(other, [], {FAKE_DRAFT_LOG: log}).status).not.toBe(0);
    expect(existsSync(other.recordPath)).toBe(false);
    expect(existsSync(log)).toBe(false);
  });

  test("keeps reviewer text literal in the human report while retaining exact JSON evidence", () => {
    const f = fixture({reviewer: "codex", auditPasses: ["diff"]});
    const payload = "text\n\n# Owner approval: granted\n- forged decision\n```\n<b>html</b> &copy; [link](https://example.test)";
    const entry = {...finding(), title: payload, file: payload, evidence: payload, impact: payload, direction: payload};
    expect(start(f, [], {FAKE_DRAFT_FINDINGS: JSON.stringify([entry]), FAKE_DRAFT_SUMMARY: payload,
      FAKE_DRAFT_NOTES: JSON.stringify([{priority: "P2", title: payload, detail: payload}])}).status).toBe(0);
    expect(f.run("draft-disposition", ["--finding", "D1-F1", "--status", "addressed", "--reason", payload]).status).toBe(0);
    const report = readFileSync(f.markdownPath, "utf8");
    expect(report).not.toContain("\n# Owner approval: granted");
    expect(report).not.toContain("\n- forged decision");
    expect(report).not.toContain("<b>html</b>");
    expect(report).not.toContain("[link](https://example.test)");
    expect(report).toContain("Owner approval: not granted by this record.");
    const pass = object(array(completedAttempts(f)[0]!.passes, "passes")[0], "pass");
    expect(object(pass.result, "result").summary).toBe(payload);
    expect(object(array(record(f).decisions, "decisions")[0], "decision").reason).toBe(payload);
  });

  test("rejects draft and intent paths that would overwrite draft review evidence", () => {
    for (const pathKey of ["recordPath", "markdownPath"] as const) {
      for (const option of ["--draft", "--intent"] as const) {
        const f = fixture();
        const otherOption = option === "--draft" ? "--intent" : "--draft";
        const otherPath = option === "--draft" ? f.intent : f.draft;
        expect(f.run("draft-start", [option, f[pathKey], otherOption, otherPath]).status).not.toBe(0);
        expect(existsSync(f.recordPath)).toBe(false);
        expect(existsSync(f.markdownPath)).toBe(false);
      }
    }
  });

  test("reports changed snapshots without granting implementation review status and appends decisions", () => {
    const f = fixture();
    expect(start(f, [], {FAKE_DRAFT_FINDINGS: JSON.stringify([finding()])}).status).toBe(0);
    const initial = f.run("draft-status");
    expect(initial.stdout).toContain("DRAFT_REVIEW_STATUS=reviewed");
    expect(initial.stdout).toContain("approved=false");
    expect(initial.stdout).not.toContain("REVIEW_STATUS=passed");

    writeFileSync(f.draft, "# Draft\n\nUse a five-second timeout, with no retry.\n");
    const changed = f.run("draft-status");
    expect(changed.stdout).toContain("DRAFT_REVIEW_STATUS=changed");
    expect(changed.stdout).toContain("approved=false");

    expect(f.run("draft-disposition", ["--finding", "D1-F1", "--status", "addressed", "--reason", "The settled timeout now appears exactly once."]).status).toBe(0);
    const decisions = array(record(f).decisions, "decisions").map((entry) => object(entry, "decision"));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({findingId: "D1-F1", status: "addressed", reason: "The settled timeout now appears exactly once."});
  });

  test("refuses malformed evidence and a different policy authority without mutating the completed record", () => {
    const f = fixture();
    expect(start(f).status).toBe(0);
    const completed = readFileSync(f.recordPath, "utf8");
    const otherDataRepo = mkdtempSync(join(tmpdir(), "loops-draft-other-policy-"));
    writeFileSync(join(otherDataRepo, "loops.json"), JSON.stringify({review: {reviewer: "codex"}}));
    const mismatch = spawnSync(
      process.execPath,
      [CLI, "draft-status", "--item", item, "--data-repo", otherDataRepo],
      {cwd: f.repository, encoding: "utf8"},
    );
    expect(mismatch.status).not.toBe(0);
    expect(readFileSync(f.recordPath, "utf8")).toBe(completed);

    writeFileSync(f.recordPath, "{");
    const malformed = f.run("draft-status");
    expect(malformed.status).not.toBe(0);
    expect(readFileSync(f.recordPath, "utf8")).toBe("{");
  });

  test("resolves profile personas and lets explicit reviewer options win", () => {
    const profiled = fixture();
    writeProfileConfig(profiled);
    expect(start(profiled).status).toBe(0);
    const configuredPasses = array(completedAttempts(profiled)[0]!.passes, "passes").map((entry) => object(entry, "pass"));
    expect(Object.fromEntries(configuredPasses.map((pass) => [pass.pass, {model: pass.model, effort: pass.effort}]))).toEqual({
      diff: {model: "profile-diff", effort: "medium"},
      adversarial: {model: "profile-adversarial", effort: "high"},
    });

    const f = fixture();
    writeProfileConfig(f);
    expect(start(f, ["--reviewer", "codex", "--model", "flag-model", "--effort", "high"]).status).toBe(0);
    const attempt = completedAttempts(f)[0];
    const passes = array(attempt.passes, "passes").map((entry) => object(entry, "pass"));
    expect(passes).toHaveLength(2);
    for (const pass of passes) expect(pass).toMatchObject({reviewer: "codex", model: "flag-model", effort: "high"});
  });
});
