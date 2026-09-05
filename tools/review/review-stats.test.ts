// `cli-review stats`: each test is one definition of the review measurement spec
// (docs/specs/2026-08-26-review-measurement-definitions.md in the reference data repo),
// named by its section. Fixtures are schema-valid ledgers built with the ledger library,
// because the measurement reads only what `parseReviewLedger` accepts. The test process
// runs in the DCL checkout while the measured workspace is a temp directory, so every
// run also proves the command works from a CWD outside the workspace.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addReviewRound,
  createReviewLedger,
  parseReviewLedger,
  recordDisposition,
  supersedeLedgerBase,
  type Finding,
  type ReviewLedger,
  type ReviewRoundAudit,
} from "./review-ledger.ts";
import { testExitReviewStateHash, type TestCapExitEvidence } from "./review-test-evidence.ts";
import { evaluateReviewStatus } from "./review-status.ts";
import { collectStats, discoverLedgers, renderStats, runStats, type StatsLedger } from "./review-stats.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseFinding: Finding = {
  priority: "P1",
  title: "off-by-one",
  evidence: "loop uses <=",
  impact: "reads past the end",
  direction: "use <",
  confidence: "high",
  causality: "introduced",
  origin: "original",
  passes: ["diff"],
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {...baseFinding, ...overrides};
}

/** A minimal valid audit record; `metrics` and `passes` extras are the telemetry under test. */
function audit(extra: {
  files?: number;
  hunks?: number;
  metrics?: Partial<ReviewRoundAudit["metrics"]>;
  passes?: ReviewRoundAudit["passes"];
  policy?: ReviewRoundAudit["policy"];
} = {}): ReviewRoundAudit {
  const files = Array.from({length: extra.files ?? 1}, (_, index) => ({
    path: `f${index}.ts`,
    hunks: Array.from({length: extra.hunks ?? 1}, (_, hunk) => `-${hunk + 1},1 +${hunk + 1},1`),
  }));
  return {
    kind: "full",
    manifest: {baseSha: "base", headSha: "head", files, metadataFiles: [], instructionFiles: [], contextReferences: [], patchIds: []},
    passes: extra.passes ?? [],
    obligations: [],
    metrics: {
      findingsByPass: {diff: 0, integration: 0, adversarial: 0},
      findingsByPriority: {P0: 0, P1: 0, P2: 0, P3: 0},
      findingsByOrigin: {original: 0, remediation: 0, "base-delta": 0, unknown: 0},
      repeatedFindings: 0,
      lateHighPriorityFindings: 0,
      unchangedHeadDrift: false,
      ...extra.metrics,
    },
    ...(extra.policy ? {policy: extra.policy} : {}),
  };
}

function pass(name: "diff" | "integration" | "adversarial" | "confirmation", extra: Partial<ReviewRoundAudit["passes"][number]> = {}) {
  return {pass: name, summary: "s", coverage: {files: [], instructionFiles: [], callsites: []}, ...extra};
}

/** A ledger whose rounds carry the given findings, each round on its own head. */
function ledgerOf(
  item: string,
  rounds: Finding[][],
  options: {audits?: (ReviewRoundAudit | undefined)[]; profile?: string; authority?: ReviewLedger["authority"]} = {},
): ReviewLedger {
  let ledger = createReviewLedger({
    item,
    branch: "feature",
    baseRef: "master",
    baseSha: "base",
    ...(options.profile ? {profile: options.profile} : {}),
    ...(options.authority ? {authority: options.authority} : {}),
  });
  rounds.forEach((findings, index) => {
    ledger = addReviewRound(ledger, {
      headSha: `h${index + 1}`,
      model: "reviewer",
      reviewedAt: `2026-08-2${index + 1}T10:00:00Z`,
      review: {summary: "s", findings},
      ...(options.audits?.[index] ? {audit: options.audits[index]} : {}),
    });
  });
  return ledger;
}

function write(path: string, ledger: ReviewLedger | object): void {
  writeFileSync(path, JSON.stringify(ledger));
}

/** A workspace: <root>/data (the data repo) + <root>/proj (a registered project). */
function makeWorkspace(): {root: string; dataRepo: string; reviews: string} {
  const root = mkdtempSync(join(tmpdir(), "loops-stats-"));
  const dataRepo = join(root, "data");
  mkdirSync(join(dataRepo, ".reviews"), {recursive: true});
  mkdirSync(join(root, "proj", ".reviews"), {recursive: true});
  writeFileSync(join(dataRepo, "loops.json"), JSON.stringify({projects: {proj: {repo: join(root, "proj")}}}));
  return {root, dataRepo, reviews: join(root, "proj", ".reviews")};
}

/** The two-ledger population the table tests share: one three-round item that ends
 * clean, one single-round item in a linked worktree. */
function makeTablePopulation(): {root: string; dataRepo: string; reviews: string} {
  const ws = makeWorkspace();
  mkdirSync(join(ws.root, "proj", ".worktrees", "wt", ".reviews"), {recursive: true});
  write(
    join(ws.reviews, "one.json"),
    ledgerOf(
      "item-one",
      [
        [finding(), finding({priority: "P2", passes: ["diff", "adversarial"], title: "stale comment", impact: "prose"})],
        [finding({origin: "remediation", passes: ["integration"], title: "missing regression", impact: "test coverage"})],
        [],
      ],
      {audits: [audit({files: 2, hunks: 2}), audit({files: 2, hunks: 2}), audit({files: 2, hunks: 2})]},
    ),
  );
  write(
    join(ws.root, "proj", ".worktrees", "wt", ".reviews", "two.json"),
    ledgerOf("item-two", [[finding({priority: "P0", passes: ["adversarial"]})]], {audits: [audit({files: 2, hunks: 2})]}),
  );
  // Superseded copies never join the population.
  write(join(ws.reviews, "superseded-x-one.json"), ledgerOf("item-one", [[]]));
  return ws;
}

const EXPECTED_TABLE = `ledgers 2 rounds 4 findings 4
rounds-per-ledger 1=1 3=1
ended clean 1
single-pass findings 3 confidence high=4
test-like 1 doc-like 1
median files R1->last 2 2
median hunks R1->last 4 4
R1: rounds=2 findings=3 per-round=1.5 disp:none=3 orig:original=3 prio:P0=1 prio:P1=1 prio:P2=1
R2: rounds=1 findings=1 per-round=1.0 disp:none=1 orig:remediation=1 prio:P1=1
R3: rounds=1 findings=0 per-round=0.0
 3 2-1-0                    item-one
 1 1                        item-two
`;

function lines(report: string): string[] {
  return report.trimEnd().split("\n");
}

function outcomeLine(report: string): string | undefined {
  return lines(report).find((line) => line.startsWith("outcome "));
}

// ---------------------------------------------------------------------------
// Population
// ---------------------------------------------------------------------------

describe("Population", () => {
  test("discovery reads every registered project's ledgers, worktrees included, and skips superseded copies", () => {
    const {dataRepo} = makeTablePopulation();
    const report = runStats({dataRepo});
    expect(report.startsWith(EXPECTED_TABLE)).toBe(true);
    // Every discovered ledger is undecided by the gate only when it has findings open:
    // item-one ended clean and passed, item-two has a finding open.
    expect(outcomeLine(report)).toBe("outcome passed=1 cap-exit=0 open=1 legacy=0 rounds-to-passed-median=3 within-cap=0 cap-unknown=2");
  });

  test("ledger identity is filesystem identity: a git checkout's own ledgers count once", () => {
    const ws = makeTablePopulation();
    const proj = join(ws.root, "proj");
    const init = spawnSync("git", ["-C", proj, "init", "-q"], {encoding: "utf8"});
    expect(init.status).toBe(0);
    expect(discoverLedgers(ws.dataRepo, ws.root)).toEqual(["proj/.reviews/one.json"]);
  });

  test("ledger identity is filesystem identity: a symlinked registered checkout counts once", () => {
    const ws = makeTablePopulation();
    symlinkSync(join(ws.root, "proj"), join(ws.root, "link"));
    writeFileSync(
      join(ws.dataRepo, "loops.json"),
      JSON.stringify({projects: {proj: {repo: join(ws.root, "proj")}, alias: {repo: join(ws.root, "link")}}}),
    );
    expect(runStats({dataRepo: ws.dataRepo}).startsWith(EXPECTED_TABLE)).toBe(true);
  });

  test("a ledger the schema rejects and a ledger without live rounds are excluded, and each exclusion is reported", () => {
    const ws = makeTablePopulation();
    writeFileSync(join(ws.reviews, "damaged.json"), JSON.stringify({version: 1, rounds: [{number: 1, findings: [{confidence: "certain"}]}]}));
    write(join(ws.reviews, "empty.json"), ledgerOf("item-empty", []));
    const report = runStats({dataRepo: ws.dataRepo});
    expect(report.startsWith(EXPECTED_TABLE)).toBe(true);
    expect(lines(report)).toContain("excluded 1 no-rounds");
    expect(lines(report)).toContain("excluded 1 unparseable");
  });

  test("a linked worktree outside .worktrees is discovered through git", () => {
    const ws = makeWorkspace();
    const proj = join(ws.root, "proj");
    const git = (...args: string[]) => spawnSync("git", ["-C", proj, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {encoding: "utf8"});
    expect(git("init", "-q").status).toBe(0);
    expect(git("commit", "-q", "--allow-empty", "-m", "root").status).toBe(0);
    expect(git("worktree", "add", "-q", join(ws.root, "elsewhere"), "-b", "wt").status).toBe(0);
    mkdirSync(join(ws.root, "elsewhere", ".reviews"));
    write(join(ws.root, "elsewhere", ".reviews", "far.json"), ledgerOf("item-far", [[]]));
    expect(discoverLedgers(ws.dataRepo, ws.root)).toEqual(["elsewhere/.reviews/far.json"]);
  });

  test("a snapshot is measured verbatim and excludes nothing", () => {
    const ws = makeTablePopulation();
    const population = collectStats({dataRepo: ws.dataRepo});
    writeFileSync(join(ws.root, "snap.json"), JSON.stringify({ledgers: population.ledgers}));
    expect(collectStats({dataRepo: ws.dataRepo, snapshotIn: "snap.json"})).toEqual({ledgers: population.ledgers, excluded: []});
  });
});

describe("Population: explicit sources stay strict", () => {
  test("a cohort restricts the population to exactly the listed ledgers", () => {
    const ws = makeTablePopulation();
    writeFileSync(join(ws.root, "cohort.txt"), "# one only\nproj/.reviews/one.json\n");
    expect(runStats({dataRepo: ws.dataRepo, cohort: "cohort.txt"})).toContain("ledgers 1 rounds 3 findings 3\n");
  });

  test("a missing cohort entry fails by name", () => {
    const ws = makeTablePopulation();
    writeFileSync(join(ws.root, "cohort.txt"), "proj/.reviews/gone.json\n");
    expect(() => runStats({dataRepo: ws.dataRepo, cohort: "cohort.txt"})).toThrow("cohort member missing: proj/.reviews/gone.json");
  });

  test("a cohort names each ledger once whatever its spelling: duplicates and symlink aliases count once", () => {
    const ws = makeTablePopulation();
    symlinkSync(join(ws.root, "proj"), join(ws.root, "link"));
    writeFileSync(join(ws.root, "cohort.txt"), "proj/.reviews/one.json\nproj/.reviews/one.json\nlink/.reviews/one.json\n");
    expect(runStats({dataRepo: ws.dataRepo, cohort: "cohort.txt"})).toContain("ledgers 1 rounds 3 findings 3\n");
  });

  test("a cohort entry that would be excluded fails instead of silently thinning the list", () => {
    const ws = makeTablePopulation();
    write(join(ws.reviews, "empty.json"), ledgerOf("item-empty", []));
    writeFileSync(join(ws.root, "cohort.txt"), "proj/.reviews/one.json\nproj/.reviews/empty.json\n");
    expect(() => runStats({dataRepo: ws.dataRepo, cohort: "cohort.txt"})).toThrow("cohort member(s) excluded: no-rounds: proj/.reviews/empty.json");
  });
});

// ---------------------------------------------------------------------------
// Epochs
// ---------------------------------------------------------------------------

describe("Epochs", () => {
  test("only the active epoch is measured; superseded rounds are reported as history, not counted", () => {
    const ws = makeWorkspace();
    let ledger = ledgerOf("item-epoch", [[finding()], [finding({title: "second"})]]);
    ledger = supersedeLedgerBase(ledger, {baseRef: "master", baseSha: "base2", archivedAt: "2026-08-23T00:00:00Z"});
    ledger = addReviewRound(ledger, {headSha: "h3", model: "reviewer", reviewedAt: "2026-08-24T10:00:00Z", review: {summary: "clean", findings: []}});
    write(join(ws.reviews, "epoch.json"), ledger);
    const report = runStats({dataRepo: ws.dataRepo});
    expect(report).toContain("ledgers 1 rounds 1 findings 0\n");
    expect(lines(report)).toContain("epochs superseded=1");
    expect(outcomeLine(report)).toContain("passed=1");
  });

  test("an obligation accepted in a superseded epoch stays open across the supersession", () => {
    const ws = makeWorkspace();
    let ledger = ledgerOf("item-carried", [[finding()]]);
    ledger = recordDisposition(ledger, "E1-R1-F1", "accepted", "real");
    ledger = supersedeLedgerBase(ledger, {baseRef: "master", baseSha: "base2", archivedAt: "2026-08-23T00:00:00Z"});
    ledger = addReviewRound(ledger, {headSha: "h2", model: "reviewer", reviewedAt: "2026-08-24T10:00:00Z", review: {summary: "clean", findings: []}});
    write(join(ws.reviews, "carried.json"), ledger);
    expect(outcomeLine(runStats({dataRepo: ws.dataRepo}))).toContain("passed=0 cap-exit=0 open=1");
  });

  test("an older snapshot's liveFrom is honored so it measures the rounds it was written to measure", () => {
    const ws = makeWorkspace();
    const population = collectStats({dataRepo: ws.dataRepo});
    const legacySnapshot: StatsLedger = {
      path: "p", item: "old", sha256: "x", liveFrom: 1,
      rounds: [
        {number: 1, manifestFiles: 0, manifestHunks: 0, findings: [{priority: "P1", origin: null, passes: null, confidence: "high", title: "t", impact: "i", disposition: null}]},
        {number: 2, manifestFiles: 0, manifestHunks: 0, findings: []},
      ],
    };
    writeFileSync(join(ws.root, "snap.json"), JSON.stringify({ledgers: [...population.ledgers, legacySnapshot]}));
    const report = runStats({dataRepo: ws.dataRepo, snapshotIn: "snap.json"});
    expect(report).toContain("ledgers 1 rounds 1 findings 0\n");
    expect(lines(report)).toContain("epochs superseded=1");
  });
});

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

describe("Outcome", () => {
  function capExitLedger(priority: "P1" | "P2"): ReviewLedger {
    const policy = {maxRounds: 2, capExit: true};
    let ledger = ledgerOf("item-cap", [[finding({priority})]], {audits: [audit({policy})]});
    ledger = recordDisposition(ledger, "E1-R1-F1", "accepted", "needs work");
    return addReviewRound(ledger, {headSha: "h2", model: "reviewer", reviewedAt: "2026-08-24T10:00:00Z", review: {summary: "still open", findings: []}, audit: audit({policy})});
  }

  test("a cap exit under the round's recorded capExit key is cap-exit, and a P1 residual keeps it open", () => {
    const ws = makeWorkspace();
    write(join(ws.reviews, "p2.json"), capExitLedger("P2"));
    expect(outcomeLine(runStats({dataRepo: ws.dataRepo}))).toBe("outcome passed=0 cap-exit=1 open=0 legacy=0 rounds-to-passed-median=2 within-cap=1 cap-unknown=0");
    write(join(ws.reviews, "p2.json"), capExitLedger("P1"));
    expect(outcomeLine(runStats({dataRepo: ws.dataRepo}))).toBe("outcome passed=0 cap-exit=0 open=1 legacy=0 within-cap=0 cap-unknown=0");
  });

  function testCapExitLedger(ws: {root: string; dataRepo: string}, authorityDataRepo = ws.dataRepo): ReviewLedger {
    const reviewedHeadSha = "a".repeat(40);
    const evidenceHeadSha = "b".repeat(40);
    let ledger = createReviewLedger({
      item: "item-test-cap",
      authority: {dataRepo: authorityDataRepo, project: "proj", projectRepo: join(ws.root, "proj")},
      branch: "feature",
      baseRef: "master",
      baseSha: "c".repeat(40),
    });
    ledger = addReviewRound(ledger, {
      headSha: reviewedHeadSha,
      model: "reviewer",
      reviewedAt: "2026-08-24T10:00:00Z",
      review: {summary: "needs a regression", findings: [finding()]},
      audit: audit({policy: {maxRounds: 2, testBackedCapExit: true}}),
    });
    ledger = recordDisposition(ledger, "E1-R1-F1", "accepted", "add a regression test");
    const persistedLedger = parseReviewLedger(JSON.parse(JSON.stringify(ledger)));
    const evidence: TestCapExitEvidence = {
      headSha: evidenceHeadSha,
      reviewedHeadSha,
      baseSha: persistedLedger.baseSha,
      reviewStateHash: testExitReviewStateHash(persistedLedger),
      recordedAt: "2026-08-25T10:00:00Z",
      maxRounds: 1,
      request: {
        fixes: [{
          obligationId: "E1-R1-F1",
          summary: "add regression coverage",
          paths: ["tools/review/review-stats.ts"],
          tests: ["tools/review/review-stats.test.ts"],
          command: ["bun", "test", "tools/review/review-stats.test.ts"],
          redEvidence: {kind: "observed-failure", detail: "the regression test failed before the fix"},
          coverage: "the regression covers the accepted remediation obligation",
        }],
        qualityCommand: ["bun", "run", "check"],
        changeSummary: "add the missing regression coverage",
        risk: {remaining: "none known", exposure: "the reviewed change", recovery: "revert the change", materialUncertainty: false},
      },
      checks: [
        {kind: "regression", obligationId: "E1-R1-F1", command: ["bun", "test", "tools/review/review-stats.test.ts"], exitCode: 0, stdout: "pass", stderr: ""},
        {kind: "quality", command: ["bun", "run", "check"], exitCode: 0, stdout: "pass", stderr: ""},
      ],
    };
    return {...persistedLedger, testCapExits: [evidence]};
  }

  function enableTestCapExit(ws: {root: string; dataRepo: string}): void {
    writeFileSync(
      join(ws.dataRepo, "loops.json"),
      JSON.stringify({
        projects: {proj: {repo: join(ws.root, "proj")}},
        review: {reviewer: "codex", maxRounds: 1, testBackedCapExit: true},
      }),
    );
  }

  test("records a verified test-backed cap exit separately from an independently clean confirmation", () => {
    const ws = makeWorkspace();
    enableTestCapExit(ws);
    const ledger = testCapExitLedger(ws);
    expect(evaluateReviewStatus(
      ledger,
      ledger.testCapExits![0]!.headSha,
      "",
      undefined,
      false,
      undefined,
      {maxRounds: 1},
    )).toMatchObject({kind: "passed", testCapExit: true});
    const parsed = parseReviewLedger(JSON.parse(JSON.stringify(ledger)));
    expect(testExitReviewStateHash(parsed)).toBe(ledger.testCapExits![0]!.reviewStateHash);
    write(join(ws.reviews, "test-cap.json"), ledger);
    const report = runStats({dataRepo: ws.dataRepo});
    expect(report).toContain("ended clean 0\n");
    expect(outcomeLine(report)).toBe("outcome passed=0 cap-exit=0 test-cap-exit=1 open=0 legacy=0 within-cap=1 cap-unknown=0");
  });

  test("requires the current recorded authority before counting a test-backed cap exit", () => {
    const ws = makeWorkspace();
    enableTestCapExit(ws);
    write(join(ws.reviews, "wrong-authority.json"), testCapExitLedger(ws, "/other/data-repo"));
    expect(outcomeLine(runStats({dataRepo: ws.dataRepo}))).toBe(
      "outcome passed=0 cap-exit=0 open=1 legacy=0 within-cap=0 cap-unknown=0",
    );
  });

  test("uses a later clean review instead of stale test evidence", () => {
    const ws = makeWorkspace();
    enableTestCapExit(ws);
    let ledger = testCapExitLedger(ws);
    ledger = addReviewRound(ledger, {
      headSha: "d".repeat(40),
      model: "reviewer",
      reviewedAt: "2026-08-26T10:00:00Z",
      review: {summary: "clean confirmation", findings: []},
      audit: {
        ...audit({policy: {maxRounds: 1, testBackedCapExit: true}}),
        obligations: [{findingId: "E1-R1-F1", status: "fixed", type: "remediation", evidence: "regression passes"}],
      },
    });
    write(join(ws.reviews, "later-clean.json"), ledger);
    expect(outcomeLine(runStats({dataRepo: ws.dataRepo}))).toBe(
      "outcome passed=1 cap-exit=0 open=0 legacy=0 rounds-to-passed-median=2 within-cap=0 cap-unknown=0",
    );
  });

  test("a round with no recorded policy is evaluated with the keys off: the same ledger is open, not a cap exit", () => {
    const ws = makeWorkspace();
    let ledger = ledgerOf("item-nopolicy", [[finding({priority: "P2"})]]);
    ledger = recordDisposition(ledger, "E1-R1-F1", "accepted", "needs work");
    ledger = addReviewRound(ledger, {headSha: "h2", model: "reviewer", reviewedAt: "2026-08-24T10:00:00Z", review: {summary: "still open", findings: []}});
    write(join(ws.reviews, "nopolicy.json"), ledger);
    expect(outcomeLine(runStats({dataRepo: ws.dataRepo}))).toBe("outcome passed=0 cap-exit=0 open=1 legacy=0 within-cap=0 cap-unknown=1");
  });

  test("an owner-authorized round override counts toward the recorded cap", () => {
    const ws = makeWorkspace();
    const policy = {maxRounds: 1, capExit: true};
    let ledger = ledgerOf("item-override", [[finding()], [finding({title: "second"})], []], {audits: [audit({policy}), audit({policy}), audit({policy})]});
    ledger = {...ledger, maxRoundsOverride: 3};
    write(join(ws.reviews, "override.json"), ledger);
    expect(outcomeLine(runStats({dataRepo: ws.dataRepo}))).toBe("outcome passed=1 cap-exit=0 open=0 legacy=0 rounds-to-passed-median=3 within-cap=1 cap-unknown=0");
  });

  test("a ledger written before causal classification is legacy, whatever its last round holds", () => {
    const ws = makeWorkspace();
    const {causalScopeVersion: _dropped, ...legacy} = ledgerOf("item-legacy", [[finding()], []]);
    write(join(ws.reviews, "legacy.json"), legacy);
    const report = runStats({dataRepo: ws.dataRepo});
    expect(report).toContain("ended clean 1\n");
    expect(outcomeLine(report)).toBe("outcome passed=0 cap-exit=0 open=0 legacy=1 within-cap=0 cap-unknown=1");
  });

  test("a waiver is authorized by the data repo's classes as currently resolved for the ledger's project", () => {
    const ws = makeWorkspace();
    const classes = [{name: "docs", match: ["docs/**"], waivablePriorities: ["P2"]}];
    writeFileSync(
      join(ws.dataRepo, "loops.json"),
      JSON.stringify({projects: {proj: {repo: join(ws.root, "proj"), review: {classes}}}, review: {reviewer: "codex"}}),
    );
    let ledger = createReviewLedger({
      item: "item-waived",
      authority: {dataRepo: ws.dataRepo, project: "proj", projectRepo: join(ws.root, "proj")},
      branch: "feature",
      baseRef: "master",
      baseSha: "base",
    });
    ledger = addReviewRound(ledger, {headSha: "h1", model: "reviewer", reviewedAt: "2026-08-24T10:00:00Z", review: {summary: "s", findings: [finding({priority: "P2", file: "docs/a.md"})]}});
    ledger = recordDisposition(ledger, "E1-R1-F1", "waived-by-policy", "docs nit", {waivedClass: "docs", classes: classes as never});
    write(join(ws.reviews, "waived.json"), ledger);
    expect(outcomeLine(runStats({dataRepo: ws.dataRepo}))).toContain("passed=1 cap-exit=0 open=0");
    // The same ledger under a config that no longer authorizes the class is open.
    writeFileSync(join(ws.dataRepo, "loops.json"), JSON.stringify({projects: {proj: {repo: join(ws.root, "proj")}}}));
    expect(outcomeLine(runStats({dataRepo: ws.dataRepo}))).toContain("passed=0 cap-exit=0 open=1");
  });

  function waivedLedger(ws: {root: string; dataRepo: string}, authority: Partial<ReviewLedger["authority"]> | undefined, profile?: string): ReviewLedger {
    let ledger = createReviewLedger({
      item: "item-waived",
      ...(authority ? {authority: {dataRepo: ws.dataRepo, ...authority}} : {}),
      ...(profile ? {profile} : {}),
      branch: "feature",
      baseRef: "master",
      baseSha: "base",
    });
    ledger = addReviewRound(ledger, {headSha: "h1", model: "reviewer", reviewedAt: "2026-08-24T10:00:00Z", review: {summary: "s", findings: [finding({priority: "P2", file: "docs/a.md"})]}});
    return recordDisposition(ledger, "E1-R1-F1", "waived-by-policy", "docs nit", {waivedClass: "docs", classes: DOCS_CLASSES as never});
  }
  const DOCS_CLASSES = [{name: "docs", match: ["docs/**"], waivablePriorities: ["P2"]}];

  test("a ledger bound to no project is governed by the global classes", () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.dataRepo, "loops.json"), JSON.stringify({projects: {proj: {repo: join(ws.root, "proj")}}, review: {reviewer: "codex", classes: DOCS_CLASSES}}));
    write(join(ws.reviews, "global.json"), waivedLedger(ws, {}));
    expect(outcomeLine(runStats({dataRepo: ws.dataRepo}))).toContain("passed=1 cap-exit=0 open=0");
  });

  test("a waiver bound to another data repo, a repointed project, or a vanished profile is refused and the ledger reads open, never aborts", () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.dataRepo, "loops.json"), JSON.stringify({projects: {proj: {repo: join(ws.root, "proj"), review: {classes: DOCS_CLASSES}}}, review: {reviewer: "codex"}}));
    write(join(ws.reviews, "a.json"), {...waivedLedger(ws, {project: "proj", projectRepo: join(ws.root, "proj")}), authority: {dataRepo: "/somewhere/else", project: "proj", projectRepo: join(ws.root, "proj")}});
    write(join(ws.reviews, "b.json"), waivedLedger(ws, {project: "proj", projectRepo: join(ws.root, "moved")}));
    write(join(ws.reviews, "c.json"), waivedLedger(ws, {project: "proj", projectRepo: join(ws.root, "proj")}, "gone"));
    write(join(ws.reviews, "d.json"), waivedLedger(ws, {project: "proj", projectRepo: join(ws.root, "proj")}));
    expect(outcomeLine(runStats({dataRepo: ws.dataRepo}))).toContain("passed=1 cap-exit=0 open=3");
  });

  test("a refused binding blocks a profiled ledger outright, waivers or not, and leaves an unprofiled clean ledger to its own waivers", () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.dataRepo, "loops.json"), JSON.stringify({projects: {proj: {repo: join(ws.root, "proj")}}, review: {reviewer: "codex", profiles: {mvp: {maxRounds: 2}}}}));
    const clean = (profile: string | undefined, authority: ReviewLedger["authority"]) =>
      addReviewRound(
        createReviewLedger({item: `item-${profile ?? "none"}`, authority, ...(profile ? {profile} : {}), branch: "feature", baseRef: "master", baseSha: "base"}),
        {headSha: "h1", model: "reviewer", reviewedAt: "2026-08-24T10:00:00Z", review: {summary: "clean", findings: []}},
      );
    // Profiled, bound to a profile that no longer resolves: the gate blocks, so open.
    write(join(ws.reviews, "gone.json"), clean("gone", {dataRepo: ws.dataRepo}));
    // Profiled, bound to another data repo: the gate blocks, so open.
    write(join(ws.reviews, "foreign.json"), clean("mvp", {dataRepo: "/somewhere/else"}));
    // Unprofiled, bound to another data repo: the gate evaluates with no classes, and
    // a clean round with no waiver passes.
    write(join(ws.reviews, "unprofiled.json"), clean(undefined, {dataRepo: "/somewhere/else"}));
    expect(outcomeLine(runStats({dataRepo: ws.dataRepo}))).toContain("passed=1 cap-exit=0 open=2");
  });

  test("a snapshot stores the outcome with the epoch boundary and the recorded policy it was derived from", () => {
    const ws = makeWorkspace();
    const policy = {maxRounds: 2, capExit: true, terminalRejection: true};
    let ledger = ledgerOf("item-prov", [[finding()]], {audits: [audit({policy})]});
    ledger = supersedeLedgerBase(ledger, {baseRef: "master", baseSha: "base2", archivedAt: "2026-08-23T00:00:00Z"});
    ledger = addReviewRound(ledger, {headSha: "h2", model: "reviewer", reviewedAt: "2026-08-24T10:00:00Z", review: {summary: "clean", findings: []}, audit: audit({policy})});
    write(join(ws.reviews, "prov.json"), ledger);
    const live = runStats({dataRepo: ws.dataRepo, snapshotOut: "snapshot.json"});
    const snapshot = JSON.parse(readFileSync(join(ws.root, "snapshot.json"), "utf8")) as {ledgers: StatsLedger[]};
    expect(snapshot.ledgers[0]).toMatchObject({outcome: "passed", cap: 2, policy, supersededRounds: 1});
    expect(snapshot.ledgers[0]!.rounds).toHaveLength(1);
    expect(runStats({dataRepo: ws.dataRepo, snapshotIn: "snapshot.json"})).toBe(live);
  });

  test("a snapshot without outcomes prints no outcome line", () => {
    const ws = makeWorkspace();
    const population = collectStats({dataRepo: makeTablePopulation().dataRepo});
    const stripped = population.ledgers.map(({outcome: _o, cap: _c, policy: _p, ...ledger}) => ledger);
    writeFileSync(join(ws.root, "snap.json"), JSON.stringify({ledgers: stripped}));
    expect(outcomeLine(runStats({dataRepo: ws.dataRepo, snapshotIn: "snap.json"}))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The round clock
// ---------------------------------------------------------------------------

describe("The round clock", () => {
  test("wall time is the round's own; compute is compared beside it over the same rounds", () => {
    const ws = makeWorkspace();
    write(
      join(ws.reviews, "clock.json"),
      ledgerOf("item-clock", [[finding()], []], {
        audits: [
          // Two concurrent passes: wall 40s, compute 60s.
          audit({metrics: {elapsedMs: 40_000, reviewerMs: 60_000}, passes: [pass("diff", {elapsedMs: 40_000}), pass("adversarial", {elapsedMs: 20_000})]}),
          // A round recorded before the compute split: wall only.
          audit({metrics: {elapsedMs: 30_000}}),
        ],
      }),
    );
    const telemetry = lines(runStats({dataRepo: ws.dataRepo})).find((line) => line.startsWith("telemetry "));
    expect(telemetry).toBe("telemetry ledgers=1 rounds=2 wall-s=70.0 wall-s-per-round-median=35.0 reviewer-s=60.0 of-wall-s=40.0");
  });

  test("tokens sum over the rounds that reported them, and the report says how many did", () => {
    const ws = makeWorkspace();
    write(
      join(ws.reviews, "tokens.json"),
      ledgerOf("item-tokens", [[finding()], [], []], {
        audits: [audit({metrics: {tokens: {input: 900, output: 100}}}), audit({metrics: {tokens: {total: 500}}}), audit()],
      }),
    );
    const telemetry = lines(runStats({dataRepo: ws.dataRepo})).find((line) => line.startsWith("telemetry "));
    expect(telemetry).toBe("telemetry ledgers=1 rounds=3 tokens=1500 tokens-rounds=2 tokens-per-round-median=750");
  });

  test("shadow passes are reported apart from the blocking figures, with the total beside them", () => {
    const ws = makeWorkspace();
    write(
      join(ws.reviews, "shadow.json"),
      ledgerOf("item-shadow", [[]], {
        audits: [audit({metrics: {elapsedMs: 10_000, tokens: {total: 100}, shadowElapsedMs: 30_000, shadowTokens: {total: 900}}})],
      }),
    );
    const report = runStats({dataRepo: ws.dataRepo});
    const telemetry = lines(report).find((line) => line.startsWith("telemetry "));
    expect(telemetry).toBe("telemetry ledgers=1 rounds=1 wall-s=10.0 wall-s-per-round-median=10.0 tokens=100 tokens-rounds=1 tokens-per-round-median=100 shadow-s=30.0 total-s=40.0 shadow-tokens=900 total-tokens=1000");
    expect(lines(report)).toContain("telemetry-item item-shadow rounds=1 wall-s=10.0 tokens=100");
  });

  test("a round carrying only compute or shadow figures still counts as instrumented", () => {
    const ws = makeWorkspace();
    write(join(ws.reviews, "shadow-only.json"), ledgerOf("item-shadow-only", [[]], {audits: [audit({metrics: {shadowElapsedMs: 30_000}})]}));
    expect(lines(runStats({dataRepo: ws.dataRepo}))).toContain("telemetry ledgers=1 rounds=1 shadow-s=30.0 total-s=30.0");
  });

  test("per-pass attribution carries the model and effort each pass ran with", () => {
    const ws = makeWorkspace();
    write(
      join(ws.reviews, "passes.json"),
      ledgerOf("item-passes", [[finding()], []], {
        audits: [
          audit({metrics: {elapsedMs: 40_000}, passes: [pass("diff", {elapsedMs: 40_000, tokens: {total: 600}, model: "sol", effort: "high"}), pass("adversarial", {elapsedMs: 20_000, tokens: {total: 400}, model: "sol", effort: "high"})]}),
          audit({metrics: {elapsedMs: 15_000}, passes: [pass("confirmation", {elapsedMs: 15_000, tokens: {total: 200}, model: "terra", effort: "medium"})]}),
        ],
      }),
    );
    const report = lines(runStats({dataRepo: ws.dataRepo}));
    expect(report).toContain("telemetry-R1 rounds=1 wall-s-median=40.0");
    expect(report).toContain("telemetry-R2 rounds=1 wall-s-median=15.0");
    expect(report).toContain("telemetry-pass adversarial passes=1 wall-s-median=20.0 tokens-median=400 model=sol effort=high");
    expect(report).toContain("telemetry-pass confirmation passes=1 wall-s-median=15.0 tokens-median=200 model=terra effort=medium");
    expect(report).toContain("telemetry-pass diff passes=1 wall-s-median=40.0 tokens-median=600 model=sol effort=high");
  });

  test("an uninstrumented population renders no telemetry lines", () => {
    const {dataRepo} = makeTablePopulation();
    expect(lines(runStats({dataRepo})).some((line) => line.startsWith("telemetry"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

describe("Baseline", () => {
  test("a snapshot round-trips: --snapshot-out then --snapshot-in reproduces the table", () => {
    const ws = makeTablePopulation();
    const live = runStats({dataRepo: ws.dataRepo, snapshotOut: "snapshot.json"});
    const snapshot = JSON.parse(readFileSync(join(ws.root, "snapshot.json"), "utf8")) as {ledgers: StatsLedger[]};
    expect(snapshot.ledgers.map((ledger) => ledger.item)).toEqual(["item-one", "item-two"]);
    expect(snapshot.ledgers[0]!.rounds[0]!.findings[0]).toEqual({
      priority: "P1", origin: "original", passes: ["diff"], confidence: "high", title: "off-by-one", impact: "reads past the end", disposition: null,
    });
    expect(runStats({dataRepo: ws.dataRepo, snapshotIn: "snapshot.json"})).toBe(live);
  });

  test("rounds beyond the sixth bucket as R6", () => {
    const ws = makeWorkspace();
    write(join(ws.reviews, "long.json"), ledgerOf("item-long", Array.from({length: 8}, (_, index) => (index < 7 ? [finding({title: `t${index}`})] : []))));
    const report = lines(runStats({dataRepo: ws.dataRepo}));
    expect(report).toContain("R6: rounds=3 findings=2 per-round=0.7 disp:none=2 orig:original=2 prio:P1=2");
    expect(report.some((line) => line.startsWith("R7"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Windows after the bundled enablement: the per-profile split
// ---------------------------------------------------------------------------

describe("Profiles", () => {
  test("profiled ledgers are read against the unprofiled population", () => {
    const ws = makeTablePopulation();
    writeFileSync(join(ws.dataRepo, "loops.json"), JSON.stringify({projects: {proj: {repo: join(ws.root, "proj")}}, review: {reviewer: "codex", profiles: {mvp: {maxRounds: 2}}}}));
    write(
      join(ws.reviews, "mvp.json"),
      ledgerOf("item-mvp", [[finding()], []], {profile: "mvp", authority: {dataRepo: ws.dataRepo}, audits: [audit({metrics: {tokens: {total: 700}, lateHighPriorityFindings: 0}}), audit({metrics: {tokens: {total: 300}, lateHighPriorityFindings: 1}})]}),
    );
    const report = lines(runStats({dataRepo: ws.dataRepo}));
    expect(report).toContain("profile mvp ledgers=1 clean=1 rounds-to-clean-median=2 passed=1 rounds-to-passed-median=2 late-p0p1=1 tokens-per-item-median=1000");
    expect(report).toContain("profile none ledgers=2 clean=1 rounds-to-clean-median=3 passed=1 rounds-to-passed-median=3 late-p0p1=0");
  });

  test("an unprofiled population prints no profile split", () => {
    const {dataRepo} = makeTablePopulation();
    expect(lines(runStats({dataRepo})).some((line) => line.startsWith("profile "))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

describe("Output contract", () => {
  test("the report is the table, then exclusions, epochs, telemetry, outcome and profiles", () => {
    const ws = makeTablePopulation();
    write(join(ws.reviews, "empty.json"), ledgerOf("item-empty", []));
    let epoch = ledgerOf("item-epoch", [[finding()]], {profile: "mvp"});
    epoch = supersedeLedgerBase(epoch, {baseRef: "master", baseSha: "base2", archivedAt: "2026-08-23T00:00:00Z"});
    epoch = addReviewRound(epoch, {headSha: "h2", model: "reviewer", reviewedAt: "2026-08-24T10:00:00Z", review: {summary: "clean", findings: []}, audit: audit({metrics: {elapsedMs: 5_000}})});
    write(join(ws.reviews, "epoch.json"), epoch);
    const prefixes = lines(renderStats(collectStats({dataRepo: ws.dataRepo})))
      .map((line) => line.split(/[ :]/)[0]!)
      .filter((word) => ["excluded", "epochs", "telemetry", "telemetry-R1", "telemetry-item", "outcome", "profile"].includes(word));
    expect(prefixes).toEqual(["excluded", "epochs", "telemetry", "telemetry-R1", "telemetry-item", "outcome", "profile", "profile"]);
  });
});
