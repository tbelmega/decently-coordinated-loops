import { describe, expect, test } from "bun:test";
import { commitReference } from "./tracker-commit.ts";
import type { TrackerConfig } from "./tracker-config.ts";

const linear: TrackerConfig = { kind: "linear", workspace: "acme", team: "ACM", statusMap: {} };
const github: TrackerConfig = { kind: "github-projects", workspace: "Acme/workboard", team: "8", statusMap: {} };

describe("commitReference", () => {
  test("a linear commit names the ticket in the subject and links it with a relation word", () => {
    expect(commitReference(["ACM-12"], linear)).toEqual({ subject: "[ACM-12]", body: ["Related to ACM-12"] });
  });

  test("a github commit cross-references on the number alone", () => {
    expect(commitReference(["#12"], github)).toEqual({ subject: "[#12]", body: [] });
  });

  test("an item serving several tickets names each of them", () => {
    expect(commitReference(["ACM-12", "ACM-15"], linear)).toEqual({
      subject: "[ACM-12] [ACM-15]",
      body: ["Related to ACM-12", "Related to ACM-15"],
    });
  });

  test("an overridden template decides the form", () => {
    expect(commitReference(["ACM-12"], { ...linear, commit: { subject: "({id})", body: "See {id}" } })).toEqual({
      subject: "(ACM-12)",
      body: ["See ACM-12"],
    });
  });

  test("no tickets means no reference at all", () => {
    expect(commitReference([], linear)).toEqual({ subject: "", body: [] });
  });
});
