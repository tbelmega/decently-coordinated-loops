// Pure logic for the PR merge-status check (`bun run landed`).
// No IO here — the gh shell-out and token file reads live in cli-landed.ts, so
// everything below is unit-testable without network or filesystem access.
import type { ItemFile } from "./types.ts";
import type { LoopsConfig } from "./config.ts";

export type PrState = "MERGED" | "OPEN" | "CLOSED";

/** A GitHub PR URL decomposed. `null` from parsePrUrl means "not a PR URL". */
export interface PrRef {
  org: string;
  repo: string;
  number: number;
}

/** The result of asking gh about one PR. Either a state or a fetch failure. */
export type PrStatus =
  | { url: string; state: PrState; mergedAt?: string; mergeCommit?: string }
  | { url: string; error: string };

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
  prUrl: string;
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

/** Pure: correlate every item that has a `links.pr` with its fetched PR status and
 *  classify. `statusByUrl` is keyed by the exact `links.pr` string. Items with no
 *  PR link, or whose PR URL wasn't fetched, are skipped. */
export function buildMergeReport(
  items: ItemFile[],
  statusByUrl: Map<string, PrStatus>,
): MergeReport {
  const rows: MergeReportRow[] = [];

  for (const item of items) {
    const prUrl = item.links.pr;
    if (!prUrl) continue;
    const status = statusByUrl.get(prUrl);
    if (!status) continue;

    if ("error" in status) {
      rows.push({
        slug: item.slug,
        title: item.title,
        prUrl,
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
      prUrl,
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

/** Pure: the `implemented` items whose PR GitHub reports as MERGED — the flip
 *  candidates for `bun run landed --apply`. Only `implemented` items are eligible;
 *  anything already at `merged`/`tested`/… is left alone (idempotent), and an item
 *  with no fetched-MERGED PR is skipped. Sorted by slug for deterministic output. */
export function itemsToFlipMerged(
  items: ItemFile[],
  statusByUrl: Map<string, PrStatus>,
): ItemFile[] {
  const flip = items.filter((item) => {
    if (item.state !== "implemented") return false;
    const prUrl = item.links.pr;
    if (!prUrl) return false;
    const status = statusByUrl.get(prUrl);
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

/** Pure: rewrite one item file's frontmatter to record an observed merge, writing
 *  the auto-set fields (state/next-actor/autonomy/next-step), dropping `awaiting`,
 *  and bumping `updated` to `today`. Every other line — the body, the `links:`
 *  block, unrelated keys — is preserved verbatim; only top-level scalar keys are
 *  touched (anchored to line start so the indented keys under `links:` are never
 *  matched). */
export function applyMergedFrontmatter(rawText: string, today: string): string {
  const match = rawText.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!match) throw new Error("no frontmatter block found");
  const [, open, block, close] = match;

  const seen = new Set<string>();
  const kept = block.split("\n").flatMap((line) => {
    const keyMatch = line.match(/^([a-z-]+):/);
    const key = keyMatch?.[1];
    if (key === "awaiting") return [];
    if (key === "updated") {
      seen.add("updated");
      return [`updated: ${today}`];
    }
    if (key && key in MERGED_FIELD_VALUES) {
      seen.add(key);
      return [`${key}: ${MERGED_FIELD_VALUES[key]}`];
    }
    return [line];
  });

  // Insert any target key the file happened to be missing, so the transition is
  // complete even for an unusually-shaped item file.
  for (const [key, value] of Object.entries(MERGED_FIELD_VALUES)) {
    if (!seen.has(key)) kept.push(`${key}: ${value}`);
  }
  if (!seen.has("updated")) kept.push(`updated: ${today}`);

  return `${open}${kept.join("\n")}${close}${rawText.slice(match[0].length)}`;
}
