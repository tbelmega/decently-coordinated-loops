import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ItemFile, Links } from "./types.ts";

/** Pure: parse one item file's raw text into an ItemFile. `path` is the repo-relative
 * path to record on the result (e.g. "items/foo.md"); `slug` is derived from it. */
export function parseItemFileText(path: string, text: string): ItemFile {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error(`no frontmatter block found in ${path}`);
  }
  const fm = parseYaml(match[1]) as Record<string, unknown>;

  const slug = path.replace(/^(items|archive|for-delivery)\//, "").replace(/\.md$/, "");
  const rawLinks = (fm.links ?? {}) as Record<string, unknown>;
  const links: Links = {};
  for (const [key, value] of Object.entries(rawLinks)) {
    if (typeof value === "string" && value.length > 0) links[key] = value;
  }
  links.stackParent = links["stack-parent"];
  links.baseSha = links["base-sha"];
  links.headSha = links["head-sha"];
  delete links["stack-parent"];
  delete links["base-sha"];
  delete links["head-sha"];
  const dependsOn = Array.isArray(fm["depends-on"]) ? (fm["depends-on"] as string[]) : [];

  return {
    slug,
    path,
    title: String(fm.title ?? ""),
    project: String(fm.project ?? ""),
    state: String(fm.state ?? ""),
    owner: String(fm.owner ?? "-"),
    autonomy: String(fm.autonomy ?? "-"),
    nextActor: String(fm["next-actor"] ?? ""),
    awaiting: fm.awaiting != null ? String(fm.awaiting) : undefined,
    fit: fm.fit != null ? String(fm.fit) : undefined,
    dependsOn,
    nextStep: String(fm["next-step"] ?? ""),
    updated: String(fm.updated ?? ""),
    links,
  };
}

function loadDir(dir: string, pathPrefix: string): ItemFile[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  const items = files.map((f) => {
    const text = readFileSync(join(dir, f), "utf8");
    return parseItemFileText(`${pathPrefix}/${f}`, text);
  });
  items.sort((a, b) => a.slug.localeCompare(b.slug));
  return items;
}

/** IO boundary: read every items/*.md file from `itemsDir` and parse it. Sorted by
 * slug for deterministic output regardless of directory listing order. */
export function loadItemsDir(itemsDir: string): ItemFile[] {
  return loadDir(itemsDir, "items");
}

/** IO boundary: read every archive/*.md file from `archiveDir` and parse it. Same
 * shape as loadItemsDir — used so depends-on targets that have since been archived
 * still resolve. Missing directory (archive/ doesn't exist until the first item is
 * archived) is not an error — returns []. */
export function loadArchiveDir(archiveDir: string): ItemFile[] {
  if (!existsSync(archiveDir)) return [];
  return loadDir(archiveDir, "archive");
}

/** IO boundary: read every for-delivery/*.md file and parse it — the verified
 * (tested/delivered) work-streams that have left the active board. Loaded so they
 * feed depends-on resolution against merged/verified targets. Missing directory is
 * not an error — returns []. */
export function loadForDeliveryDir(forDeliveryDir: string): ItemFile[] {
  if (!existsSync(forDeliveryDir)) return [];
  return loadDir(forDeliveryDir, "for-delivery");
}
