import {describe, expect, test} from "bun:test";
import {mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {spawnSync, type SpawnSyncReturns} from "node:child_process";
import {TEST_IDENTITIES} from "../test-identities.ts";
import {addReviewRound, createReviewLedger, parseReviewLedger, recordDisposition, type Priority} from "./review-ledger.ts";
import {type TestCapExitRequest} from "./review-test-evidence.ts";
import {reviewEvidencePaths} from "./review-status.ts";

const cli = resolve(import.meta.dirname, "cli-review.ts");
const item = TEST_IDENTITIES.items.householdSlideshow;

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], {encoding: "utf8"});
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

interface Fixture {
  repo: string; data: string; paths: ReturnType<typeof reviewEvidencePaths>; evidence: TestCapExitRequest;
  save: () => void; run: (command?: string) => SpawnSyncReturns<string>; head: string;
}

function fixture(priority: Priority = "P1", enabled = true, maxRounds = 1): Fixture {
  const repo = mkdtempSync(join(tmpdir(), "loops-test-exit-"));
  const data = mkdtempSync(join(tmpdir(), "loops-test-exit-policy-"));
  writeFileSync(join(data, "loops.json"), JSON.stringify({review: {testBackedCapExit: enabled, maxRounds}}));
  git(repo, "init", "-q", "-b", "master");
  git(repo, "config", "user.name", TEST_IDENTITIES.owner);
  git(repo, "config", "user.email", "alice@example.test");
  writeFileSync(join(repo, ".gitignore"), ".reviews/\n");
  git(repo, "add", ".gitignore"); git(repo, "commit", "-qm", "Add repository settings");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "value.cjs"), "module.exports = 1;\n");
  git(repo, "add", "value.cjs"); git(repo, "commit", "-qm", "Add value");
  const reviewed = git(repo, "rev-parse", "HEAD");
  let ledger = addReviewRound(createReviewLedger({item, authority: {dataRepo: data}, branch: "master", baseRef: base, baseSha: base}), {
    headSha: reviewed, model: "test-reviewer", reviewedAt: "2026-01-01T00:00:00.000Z",
    review: {summary: "Value is wrong", findings: [{priority, title: "Return the correct value", file: "value.cjs", line: 1,
      evidence: "Value is one", impact: "Caller receives the wrong value", direction: "Return two", confidence: "high", causality: "introduced"}]},
  });
  const finding = ledger.rounds[0]?.findings[0];
  if (!finding) throw new Error("Missing fixture finding");
  ledger = recordDisposition(ledger, finding.id, "accepted", "The value must be two");
  const paths = reviewEvidencePaths(repo, "master", item);
  mkdirSync(join(repo, ".reviews"));
  writeFileSync(paths.jsonPath, JSON.stringify(ledger));
  writeFileSync(join(repo, "regression.cjs"), "require('node:assert/strict').equal(require('./value.cjs'), 2);\n");
  const red = spawnSync("node", ["regression.cjs"], {cwd: repo, encoding: "utf8"});
  expect(red.status).toBe(1);
  expect(red.stderr).toContain("AssertionError");
  writeFileSync(join(repo, "value.cjs"), "module.exports = 2;\n");
  git(repo, "add", "value.cjs", "regression.cjs"); git(repo, "commit", "-qm", "Correct the value with regression coverage");
  const evidence: TestCapExitRequest = {
    fixes: [{obligationId: finding.id, summary: "Return two", paths: ["value.cjs", "regression.cjs"], tests: ["regression.cjs"],
      command: ["node", "regression.cjs"], redEvidence: {kind: "observed-failure", detail: "node regression.cjs failed with AssertionError before the value fix"},
      coverage: "The assertion exercises the exported value that was defective"}],
    qualityCommand: ["node", "regression.cjs"],
    changeSummary: "Only the value and its regression coverage changed",
    risk: {remaining: "No material unresolved behavior identified", exposure: "Local fixture caller", recovery: "Revert the commit", materialUncertainty: false},
  };
  const evidencePath = join(repo, ".reviews", "request.json");
  const save = (): void => writeFileSync(evidencePath, JSON.stringify(evidence));
  save();
  const run = (command = "test-cap-exit"): SpawnSyncReturns<string> => spawnSync(process.execPath, [cli, command, "--item", item, "--data-repo", data,
    ...(command === "test-cap-exit" ? ["--evidence", evidencePath] : [])], {cwd: repo, encoding: "utf8"});
  return {repo, data, paths, evidence, save, run, head: git(repo, "rev-parse", "HEAD")};
}

describe("test-backed review cap exit", () => {
  test("runs real checks and persists a distinct current-HEAD policy pass without a review round", () => {
    const f = fixture();
    expect(f.run("status").status).toBe(1);
    const result = f.run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const status = f.run("status");
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("test_cap_exit=true");
    expect(status.stdout).toContain("test_verified_fixes=1");
    expect(status.stdout).toContain("independently_reviewed=false");
    expect(status.stdout).toContain(`head=${f.head}`);
    const persisted = parseReviewLedger(JSON.parse(readFileSync(f.paths.jsonPath, "utf8")));
    expect(persisted.rounds).toHaveLength(1);
    expect(readFileSync(f.paths.markdownPath, "utf8")).toContain("Test-backed cap exit");
    git(f.repo, "commit", "--allow-empty", "-qm", "Advance HEAD");
    expect(f.run("status").status).toBe(1);
  });

  test.each([
    {priority: "P0" as const, enabled: true, maxRounds: 1, message: "P0"},
    {priority: "P1" as const, enabled: false, maxRounds: 1, message: "not enabled"},
    {priority: "P1" as const, enabled: true, maxRounds: 2, message: "round cap"},
  ])("refuses excluded severity or policy: $message", ({priority, enabled, maxRounds, message}) => {
    const f = fixture(priority, enabled, maxRounds);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(f.run("status").status).toBe(1);
  });

  test("failed regression or quality checks cannot produce a pass", () => {
    for (const quality of [false, true]) {
      const f = fixture();
      const command = ["node", "-e", "process.exit(1)"];
      if (quality) f.evidence.qualityCommand = command;
      else {const fix = f.evidence.fixes[0]; if (fix) fix.command = command;}
      f.save();
      const result = f.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("check failed");
      expect(f.run("status").status).toBe(1);
    }
  });

  test("requires complete changed-path coverage and no material uncertainty", () => {
    const f = fixture();
    writeFileSync(join(f.repo, "other.txt"), "Unassessed change\n");
    git(f.repo, "add", "other.txt"); git(f.repo, "commit", "-qm", "Add another change");
    expect(f.run().stderr).toContain("uncovered changed path");
    const fix = f.evidence.fixes[0]; if (fix) fix.paths.push("other.txt");
    f.evidence.risk.materialUncertainty = true; f.save();
    expect(f.run().stderr).toContain("material uncertainty");
  });

  test("revoked policy and changed review state invalidate recorded evidence", () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    writeFileSync(join(f.data, "loops.json"), JSON.stringify({review: {maxRounds: 1, testBackedCapExit: false}}));
    expect(f.run("status").status).toBe(1);
    writeFileSync(join(f.data, "loops.json"), JSON.stringify({review: {maxRounds: 1, testBackedCapExit: true}}));
    expect(f.run("status").status).toBe(0);
    const ledger = parseReviewLedger(JSON.parse(readFileSync(f.paths.jsonPath, "utf8")));
    const finding = ledger.rounds[0]?.findings[0];
    if (!finding?.disposition) throw new Error("Missing fixture disposition");
    finding.disposition.reason = "Changed decision evidence";
    writeFileSync(f.paths.jsonPath, JSON.stringify(ledger));
    expect(f.run("status").status).toBe(1);
  });
  test("cannot select a different policy authority", () => {
    const f = fixture();
    const other = mkdtempSync(join(tmpdir(), "loops-other-policy-"));
    writeFileSync(join(other, "loops.json"), JSON.stringify({review: {maxRounds: 1, testBackedCapExit: true}}));
    const result = spawnSync(process.execPath, [cli, "test-cap-exit", "--item", item, "--data-repo", other,
      "--evidence", join(f.repo, ".reviews/request.json")], {cwd: f.repo, encoding: "utf8"});
    expect(result.status).toBe(1);
    expect(f.run("status").status).toBe(1);
  });

  test("requires exact obligation coverage and excludes deferred or documentation work", () => {
    for (const kind of ["extra", "deferred", "documentation"] as const) {
      const f = fixture();
      const ledger = parseReviewLedger(JSON.parse(readFileSync(f.paths.jsonPath, "utf8")));
      const round = ledger.rounds[0]; const finding = round?.findings[0];
      if (!round || !finding?.disposition) throw new Error("Missing fixture finding");
      if (kind === "extra") round.findings.push({...finding, id: "E1-R1-F2", title: "Another accepted defect"});
      if (kind === "deferred") finding.disposition = {kind: "deferred-to-human", reason: "Owner decision needed"};
      if (kind === "documentation") finding.disposition = {kind: "accepted-as-limitation", reason: "Owner accepts the assurance limit", owner: true, doc: "value.cjs"};
      writeFileSync(f.paths.jsonPath, JSON.stringify(ledger));
      expect(f.run().status).toBe(1);
      expect(f.run("status").status).toBe(1);
    }
  });

  test("rejects missing new test coverage and malformed persisted evidence", () => {
    const f = fixture();
    const fix = f.evidence.fixes[0]; if (!fix) throw new Error("Missing fixture evidence");
    fix.tests = [".gitignore"]; f.save();
    expect(f.run().stderr).toContain("regression test must change");
    const raw: unknown = JSON.parse(readFileSync(f.paths.jsonPath, "utf8"));
    expect(() => parseReviewLedger({...parseReviewLedger(raw), testCapExits: [{headSha: f.head}]})).toThrow();
  });

  test("newly identified uncertainty or a failed retry revokes an earlier test pass", () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    f.evidence.risk.materialUncertainty = true; f.save();
    expect(f.run().status).toBe(1);
    expect(f.run("status").status).toBe(1);
    f.evidence.risk.materialUncertainty = false;
    f.evidence.qualityCommand = ["node", "-e", "process.exit(1)"]; f.save();
    expect(f.run().status).toBe(1);
    expect(f.run("status").status).toBe(1);
  });

  test.each(["malformed JSON", "invalid field", "missing file"])("an unreadable retry revokes the prior pass: %s", (failure) => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    expect(f.run("status").status).toBe(0);
    const evidencePath = join(f.repo, ".reviews", "request.json");
    if (failure === "missing file") unlinkSync(evidencePath);
    else writeFileSync(evidencePath, failure === "malformed JSON" ? "{" : JSON.stringify({risk: {materialUncertainty: true}}));
    expect(f.run().status).toBe(1);
    expect(f.run("status").status).toBe(1);
    expect(readFileSync(f.paths.markdownPath, "utf8")).toContain("pending or unavailable");
    f.save();
    expect(f.run().status).toBe(0);
  });

  test("refuses checks that dirty the checkout or change HEAD", () => {
    for (const change of ["dirty", "commit"] as const) {
      const f = fixture();
      f.evidence.qualityCommand = change === "dirty"
        ? ["node", "-e", "require('node:fs').writeFileSync('value.cjs', 'module.exports = 3;')"]
        : ["git", "commit", "--allow-empty", "-qm", "Move HEAD during verification"];
      f.save();
      expect(f.run().stderr).toContain("changed during test verification");
      expect(f.run("status").status).toBe(1);
    }
  });

});
