import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingCredential } from "./tracker-credential.ts";
import type { TrackerConfig } from "./tracker-config.ts";

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

const linear: TrackerConfig = { kind: "linear", workspace: "acme", team: "ACM", statusMap: {} };
const github: TrackerConfig = { kind: "github-projects", workspace: "Acme/workboard", team: "8", statusMap: {} };

describe("missingCredential", () => {
  test("a configured token file absent from this host is a missing credential", () => {
    expect(missingCredential({ ...linear, tokenFile: "/nonexistent/dcl-token" }, undefined, () => true)).toContain("/nonexistent/dcl-token");
  });

  test("a token file that exists is a credential", () => {
    const dir = mkdtempSync(join(tmpdir(), "dcl-cred-"));
    created.push(dir);
    writeFileSync(join(dir, "token"), "secret");
    expect(missingCredential({ ...linear, tokenFile: join(dir, "token") }, undefined, () => false)).toBeUndefined();
  });

  test("a linear tracker without any token file is a configuration error, not a host gap", () => {
    expect(missingCredential(linear, undefined, () => false)).toBeUndefined();
  });

  test("a github tracker without a token file relies on ambient gh auth", () => {
    expect(missingCredential(github, undefined, () => true)).toBeUndefined();
    expect(missingCredential(github, undefined, () => false)).toContain("gh is not authenticated");
  });

  test("the org's configured token file stands in for the tracker's own", () => {
    expect(missingCredential(github, "/nonexistent/org-token", () => true)).toContain("/nonexistent/org-token");
  });
});
