import {describe, expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const schema = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "review.schema.json"), "utf8"),
) as unknown;

/** Collect every object schema that declares properties, at any depth. */
function objectSchemas(node: unknown, path = "$"): {path: string; node: Record<string, unknown>}[] {
  if (Array.isArray(node)) return node.flatMap((entry, index) => objectSchemas(entry, `${path}[${index}]`));
  if (typeof node !== "object" || node === null) return [];
  const record = node as Record<string, unknown>;
  const here = record.properties && typeof record.properties === "object" ? [{path, node: record}] : [];
  return [...here, ...Object.entries(record).flatMap(([key, value]) => objectSchemas(value, `${path}.${key}`))];
}

describe("review.schema.json", () => {
  // The codex adapter hands this file to the model as a strict response_format. Strict mode
  // rejects any object whose `required` omits a declared property, with an HTTP 400 and no
  // usable diagnostics in the ledger beyond "codex exited with code 1" - so a property added
  // to `properties` alone breaks every review until someone reads the raw stderr. Measured
  // 2026-08-14 when obligationIds was added.
  test("lists every declared property as required, as strict structured output demands", () => {
    for (const {path, node} of objectSchemas(schema)) {
      const properties = Object.keys(node.properties as Record<string, unknown>);
      const required = Array.isArray(node.required) ? (node.required as string[]) : [];
      expect({path, missing: properties.filter((name) => !required.includes(name))}).toEqual({
        path,
        missing: [],
      });
    }
  });

  test("declares additionalProperties false wherever strict mode requires it", () => {
    for (const {path, node} of objectSchemas(schema)) {
      expect({path, additionalProperties: node.additionalProperties}).toEqual({
        path,
        additionalProperties: false,
      });
    }
  });
});
