// Pure logic for the PR merge-status check (`bun run landed`).
// No IO here — the gh shell-out and token file reads live in cli-landed.ts, so
// everything below is unit-testable without network or filesystem access.
import type { ItemFile } from "./types.ts";
import type { LoopsConfig } from "./config.ts";
import { isMap, isNode, isScalar, parseDocument } from "yaml";

export type PrState = "MERGED" | "OPEN" | "CLOSED";

/** A GitHub PR URL decomposed. `null` from parsePrUrl means "not a PR URL". */
export interface PrRef {
  org: string;
  repo: string;
  number: number;
}

/** The landed-status of one item's work ref (a PR URL for the github adapter, a
 *  branch name for the git adapter). Either a state or a lookup failure. The git
 *  adapter maps LANDED -> MERGED and PENDING -> OPEN so both adapters share one
 *  report pipeline. */
export type PrStatus =
  | { ref: string; state: PrState; mergedAt?: string; mergeCommit?: string }
  | { ref: string; error: string };

/** The work ref an item's status is *reported* under: its review URL when it has
 *  one, else its branch. Null for items with neither (nothing to check). This is a
 *  display value, not a lookup key — a bare branch is not unique across projects, so
 *  it must never be used to key the status store (use `statusKey`). */
export function workRef(item: ItemFile): string | null {
  return item.links.pr ?? item.links.branch ?? null;
}

/** The store/lookup key for an item's landed status, qualified by project so two
 *  projects that share a branch name (git adapter: `workRef` is the bare branch,
 *  e.g. `master`) don't collide on one cached result. A PR URL is already globally
 *  unique, but qualifying it too keeps one key scheme. The NUL separator can
 *  appear in neither a project name nor a git ref, so the join is unambiguous. */
export function statusKeyFor(project: string, ref: string): string {
  return `${project}\0${ref}`;
}

/** The `statusKey` for an item, or null when it carries no work ref (nothing to
 *  check). Immutable item HEADs distinguish multiple items that use the same
 *  persistent branch. Legacy items remain keyed by project + work ref. */
export function statusKey(item: ItemFile): string | null {
  const ref = workRef(item);
  if (ref === null) return null;
  const identity = item.links.headSha ? `item:${item.slug}:head:${item.links.headSha}` : ref;
  return statusKeyFor(item.project, identity);
}

/** What `bun run landed` must do to check one item, and — crucially — the key its
 *  result must be stored under. The key is ALWAYS `statusKey(item)`, because that is
 *  what buildMergeReport / itemsToFlipMerged look the result up by. The git adapter
 *  must not key by branch: an item that also carries a `links.pr` would then be
 *  stored under its branch but looked up under its PR URL, and silently skipped. */
export type LandedPlan =
  | { kind: "github"; ref: string; pr: string }
  | { kind: "git"; ref: string; branch: string; baseSha?: string; headSha?: string }
  | { kind: "error"; ref: string; error: string };

/** Pure: decide how to check an item's landed status under the given adapter, and
 *  under which key to store the result. Returns null only for items with no work ref
 *  (nothing to check). The github adapter needs a `links.pr`; the git adapter needs a
 *  `links.branch` — a missing one yields an `error` plan keyed under `workRef(item)`. */
export function planLandedCheck(
  item: ItemFile,
  adapter: "github" | "git",
): LandedPlan | null {
  const ref = workRef(item);
  if (ref === null) return null;
  if (adapter === "github") {
    return item.links.pr
      ? { kind: "github", ref, pr: item.links.pr }
      : {
          kind: "error",
          ref,
          error: "github adapter needs a links.pr (or switch the project to the git adapter)",
        };
  }
  if ((item.links.baseSha && !item.links.headSha) || (!item.links.baseSha && item.links.headSha)) {
    return {
      kind: "error",
      ref,
      error: "git adapter needs both links.base-sha and links.head-sha when either is recorded",
    };
  }
  return item.links.branch
    ? {
        kind: "git",
        ref,
        branch: item.links.branch,
        ...(item.links.baseSha && item.links.headSha
          ? { baseSha: item.links.baseSha, headSha: item.links.headSha }
          : {}),
      }
    : {
        kind: "error",
        ref,
        error: "git adapter needs a links.branch (or switch the project to the github adapter)",
      };
}

/** Extracts {org, repo, number} from a GitHub PR URL. Returns null for anything
 *  that isn't a `.../pull/<n>` URL (e.g. an issue link or a bare branch ref). */
export function parsePrUrl(url: string): PrRef | null {
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
  );
  if (!match) return null;
  return { org: match[1], repo: match[2], number: Number(match[3]) };
}

/** Pure: the configured token file path for a GitHub org, or null when the org
 *  has no dedicated token configured (the caller then falls back to ambient gh
 *  auth). Expanding a leading "~" to the home directory is the caller's job — this
 *  just returns whatever path was configured, verbatim. */
export function tokenPathForOrg(config: LoopsConfig, org: string): string | null {
  return config.githubTokens[org] ?? null;
}

export interface MergeReportRow {
  slug: string;
  title: string;
  /** The work ref the status was looked up under (PR URL or branch). */
  ref: string;
  state: PrState | "ERROR";
  itemState: string;
  awaiting?: string;
  /** MERGED PR whose item still sits in `awaiting: review-merge` — the actionable case. */
  staleReviewMerge: boolean;
  /** CLOSED-but-not-merged PR: the item points at an abandoned PR. */
  closedUnmerged: boolean;
  mergedAt?: string;
  error?: string;
}

export interface MergeReport {
  rows: MergeReportRow[];
  /** Rows a human/agent should act on now: MERGED but still awaiting review-merge. */
  stale: MergeReportRow[];
}

/** Pure: correlate every item that has a work ref with its fetched status and
 *  classify. `statusByKey` is keyed by `statusKey(item)` (project + item-scoped ref). Items with
 *  no work ref, or whose key wasn't fetched, are skipped. */
export function buildMergeReport(
  items: ItemFile[],
  statusByKey: Map<string, PrStatus>,
): MergeReport {
  const rows: MergeReportRow[] = [];

  for (const item of items) {
    const ref = workRef(item);
    const key = statusKey(item);
    if (!ref || !key) continue;
    const status = statusByKey.get(key);
    if (!status) continue;

    if ("error" in status) {
      rows.push({
        slug: item.slug,
        title: item.title,
        ref,
        state: "ERROR",
        itemState: item.state,
        awaiting: item.awaiting,
        staleReviewMerge: false,
        closedUnmerged: false,
        error: status.error,
      });
      continue;
    }

    const staleReviewMerge =
      status.state === "MERGED" && item.awaiting === "review-merge";
    const closedUnmerged = status.state === "CLOSED";

    rows.push({
      slug: item.slug,
      title: item.title,
      ref,
      state: status.state,
      itemState: item.state,
      awaiting: item.awaiting,
      staleReviewMerge,
      closedUnmerged,
      mergedAt: status.mergedAt,
    });
  }

  rows.sort((a, b) => a.slug.localeCompare(b.slug));
  return { rows, stale: rows.filter((r) => r.staleReviewMerge) };
}

/** Pure: the `implemented` items whose work is reported landed (MERGED) — the flip
 *  candidates for `bun run landed --apply`. Only `implemented` items are eligible;
 *  anything already at `merged`/`tested`/… is left alone (idempotent), and an item
 *  with no fetched-MERGED status is skipped. Sorted by slug for deterministic output. */
export function itemsToFlipMerged(
  items: ItemFile[],
  statusByKey: Map<string, PrStatus>,
): ItemFile[] {
  const flip = items.filter((item) => {
    if (item.state !== "implemented") return false;
    const key = statusKey(item);
    if (!key) return false;
    const status = statusByKey.get(key);
    return status != null && !("error" in status) && status.state === "MERGED";
  });
  return flip.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The frontmatter keys the `merged` transition sets, in the spec's field order.
 *  `awaiting` is removed (it is only meaningful for `next-actor: owner`). */
const MERGED_FIELD_VALUES: Record<string, string> = {
  state: "merged",
  "next-actor": "agent",
  autonomy: "auto",
  "next-step": '"Verify per the project verify gate, then flip to tested"',
};

interface ScalarKeyLine {
  indent: string;
  key: string;
  valueStart: number;
}

interface ScalarKeySource {
  key: string;
  start: number;
  end: number;
}

const LINE_REWRITTEN_KEYS = new Set([...Object.keys(MERGED_FIELD_VALUES), "awaiting", "updated"]);

function parseTopLevelScalarKeys(block: string): ScalarKeySource[] {
  const document = parseDocument(block, { keepSourceTokens: true, uniqueKeys: false });
  if (!isMap(document.contents) || document.contents.flow) {
    throw new Error("landed update requires a block-style root mapping");
  }
  return document.contents.items.flatMap((pair) => {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string" || !pair.key.range) return [];
    if (LINE_REWRITTEN_KEYS.has(pair.key.value)) {
      const keyLineEnd = block.indexOf("\n", pair.key.range[1]);
      const lineEnd = keyLineEnd === -1 ? block.length : keyLineEnd;
      const valueIndicator = pair.srcToken?.sep?.find(({ type }) => type === "map-value-ind");
      const valueEndsOnKeyLine = pair.value === null || (
        isNode(pair.value) && pair.value.range !== undefined && pair.value.range[1] <= lineEnd
      );
      if (!valueIndicator || valueIndicator.offset > lineEnd || !valueEndsOnKeyLine) {
        throw new Error("landed update requires single-line lifecycle fields");
      }
    }
    return [{ key: pair.key.value, start: pair.key.range[0], end: pair.key.range[1] }];
  });
}

function parseTopLevelScalarKeyLines(block: string, keys: ScalarKeySource[]): Array<ScalarKeyLine | undefined> {
  const lines = block.split("\n");
  const parsedLines: Array<ScalarKeyLine | undefined> = lines.map(() => undefined);

  for (const { key, start: keyStart, end: keyEnd } of keys) {
    const lineStart = block.lastIndexOf("\n", keyStart - 1) + 1;
    const nextNewline = block.indexOf("\n", keyEnd);
    const lineEnd = nextNewline === -1 ? block.length : nextNewline;
    const colon = block.indexOf(":", keyEnd);
    if (colon === -1 || colon > lineEnd) continue;
    const lineIndex = block.slice(0, lineStart).split("\n").length - 1;
    parsedLines[lineIndex] = {
      indent: block.slice(lineStart, keyStart),
      key,
      valueStart: colon - lineStart + 1,
    };
  }

  return parsedLines;
}

/** Pure: rewrite one item file's frontmatter to record an observed merge, writing
 *  the auto-set fields (state/next-actor/autonomy/next-step), dropping `awaiting`,
 *  and bumping `updated` to `today`. Every other line — the body, the `links:`
 *  block, unrelated keys — is preserved verbatim; only top-level scalar keys are
 *  touched (anchored to line start so the indented keys under `links:` are never
 *  matched). */
export function applyMergedFrontmatter(rawText: string, today: string): string {
  const match = rawText.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!match) throw new Error("no frontmatter block found");
  const [, open, originalBlock, close] = match;

  const originalKeys = parseTopLevelScalarKeys(originalBlock);
  const owner = originalKeys.find(({ key }) => key === "owner");
  const hasAssignee = originalKeys.some(({ key }) => key === "assignee");
  let block = originalBlock;
  if (owner && !hasAssignee) {
    block = `${originalBlock.slice(0, owner.start)}assignee${originalBlock.slice(owner.end)}`;
  }

  const lines = block.split("\n");
  const parsedLines = parseTopLevelScalarKeyLines(block, parseTopLevelScalarKeys(block));
  const indentLengths = parsedLines.flatMap((entry) => entry?.indent.length ?? []);
  const rootIndentLength = indentLengths.length > 0 ? Math.min(...indentLengths) : 0;
  const rootIndent = " ".repeat(rootIndentLength);
  const seen = new Set<string>();
  const kept = lines.flatMap((line, index) => {
    const parsed = parsedLines[index];
    const topLevel = parsed?.indent.length === rootIndentLength ? parsed : undefined;
    if (!topLevel) return [line];
    const { key } = topLevel;
    if (key === "awaiting") return [];
    if (key === "updated") {
      seen.add("updated");
      return [`${topLevel.indent}updated: ${today}`];
    }
    if (key && key in MERGED_FIELD_VALUES) {
      seen.add(key);
      return [`${topLevel.indent}${key}: ${MERGED_FIELD_VALUES[key]}`];
    }
    return [line];
  });

  // Insert any target key the file happened to be missing, so the transition is
  // complete even for an unusually-shaped item file.
  for (const [key, value] of Object.entries(MERGED_FIELD_VALUES)) {
    if (!seen.has(key)) kept.push(`${rootIndent}${key}: ${value}`);
  }
  if (!seen.has("updated")) kept.push(`${rootIndent}updated: ${today}`);

  return `${open}${kept.join("\n")}${close}${rawText.slice(match[0].length)}`;
}
