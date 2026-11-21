import { expect, test } from "bun:test";
import { commitAnswer, insertAnswer } from "./commit.ts";
import { audioEntries } from "./parse.ts";

const document = [
  "# Outbox", "## Open", "### 42 - question · daybook · Which store?",
  "- speak: Choose SQLite or Postgres.", "> A:", "", "## Archive", "",
].join("\r\n");
const [entry] = audioEntries(document);

test("inserts one transcript without changing surrounding bytes", () => {
  expect(insertAnswer(document, entry, "Choose für now.")).toEqual(
    document.replace("> A:", "> A: [voice] Choose für now."),
  );
  expect(() => insertAnswer(document, entry, "first\nsecond")).toThrow();
});

test("refetches and preserves concurrent changes on one conflict", async () => {
  const changed = document.replace("# Outbox", "# Updated outbox");
  let gets = 0;
  const puts: unknown[] = [];
  const request: typeof fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "PUT") {
      gets++;
      return Response.json({
        sha: String(gets), encoding: "base64",
        content: Buffer.from(gets === 1 ? document : changed).toString("base64"),
      });
    }
    const body = JSON.parse(String(init.body));
    puts.push({ sha: body.sha, text: Buffer.from(body.content, "base64").toString() });
    return new Response(null, { status: puts.length === 1 ? 409 : 200 });
  }, { preconnect: fetch.preconnect });
  await expect(commitAnswer({ repo: "example/workboard", branch: "master", token: "example" },
    entry, "SQLite.", request)).resolves.toBe("committed");
  expect(puts).toEqual([
    { sha: "1", text: document.replace("> A:", "> A: [voice] SQLite.") },
    { sha: "2", text: changed.replace("> A:", "> A: [voice] SQLite.") },
  ]);
});

test("rejects an answered entry and a reused ID", () => {
  expect(insertAnswer(document.replace("> A:", "> A: already answered"), entry, "SQLite.")).toBeNull();
  expect(insertAnswer(document.replace("Which store?", "A different ask"), entry, "SQLite.")).toBeNull();
});
