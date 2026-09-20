// The GitHub Projects (v2) adapter. Candidates are the issues on the configured project
// board - a repository issue that is not on the board is not this tracker's business.
// Query building and parsing are pure; the IO is one `gh api graphql` call per request,
// which reuses the auth the rest of the board tooling already uses.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TicketRecord, TrackerAdapter } from "./tracker-adapter.ts";
import type { TrackerConfig } from "./tracker-config.ts";

export const BOARD_QUERY = `query Board($org: String!, $number: Int!, $cursor: String) {
  organization(login: $org) {
    projectV2(number: $number) {
      id
      field(name: "Status") {
        ... on ProjectV2SingleSelectField { id name options { id name } }
      }
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            __typename
            ... on Issue { id number title body url assignees(first: 1) { nodes { login } } }
            ... on PullRequest { id number }
          }
        }
      }
    }
  }
}`;

export const SET_STATUS_MUTATION = `mutation SetStatus($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(
    input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }
  ) { projectV2Item { id } }
}`;

export const SET_BODY_MUTATION = `mutation SetBody($id: ID!, $body: String!) {
  updateIssue(input: { id: $id, body: $body }) { issue { id } }
}`;

export interface BoardItem {
  /** The project item, which is what a status write addresses. */
  itemId: string;
  /** The issue itself, which is what a body write addresses. */
  contentId: string;
  type: string;
  number: number;
  title: string;
  body: string;
  url: string;
  assignee?: string;
  status: string;
}

export interface ProjectBoard {
  projectId: string;
  statusFieldId: string;
  statusOptions: { id: string; name: string }[];
  items: BoardItem[];
  /** Non-issue entries, counted rather than silently dropped: a board that is mostly
   * pull requests should say so rather than look empty. */
  skipped: { pullRequests: number; drafts: number };
  nextCursor?: string;
}

/** The org that owns the board, from the tracker's "Org/repo" workspace. */
export function projectOrg(tracker: TrackerConfig): string {
  const org = tracker.workspace.split("/")[0];
  if (!org) throw new Error(`tracker workspace "${tracker.workspace}" is not of the form Org/repo`);
  return org;
}

export function projectNumber(tracker: TrackerConfig): number {
  const number = Number(tracker.team);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`tracker team "${tracker.team}" must be the project number for a github-projects board`);
  }
  return number;
}

/** Pure: one page of the board. Pull requests and draft items are counted and skipped -
 * only issues are tickets a board item can advance. */
export function parseProjectBoard(data: unknown): ProjectBoard {
  const project = (data as { organization?: { projectV2?: unknown } }).organization?.projectV2 as
    | {
        id?: string;
        field?: { id?: string; options?: { id: string; name: string }[] } | null;
        items?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: unknown[] };
      }
    | undefined
    | null;
  if (!project?.id) throw new Error("no such GitHub project - check the tracker's workspace org and project number");
  if (!project.field?.id) {
    throw new Error("the GitHub project has no single-select Status field, which is what the board state maps onto");
  }
  const skipped = { pullRequests: 0, drafts: 0 };
  const items: BoardItem[] = [];
  for (const node of project.items?.nodes ?? []) {
    const entry = node as {
      id: string;
      fieldValueByName?: { name?: string } | null;
      content?: {
        __typename?: string;
        id?: string;
        number?: number;
        title?: string;
        body?: string | null;
        url?: string;
        assignees?: { nodes?: { login?: string }[] };
      } | null;
    };
    const type = entry.content?.__typename ?? "DraftIssue";
    if (type === "PullRequest") {
      skipped.pullRequests += 1;
      continue;
    }
    if (type !== "Issue" || entry.content?.number === undefined || !entry.content.id) {
      skipped.drafts += 1;
      continue;
    }
    const assignee = entry.content.assignees?.nodes?.[0]?.login;
    items.push({
      itemId: entry.id,
      contentId: entry.content.id,
      type,
      number: entry.content.number,
      title: entry.content.title ?? "",
      body: entry.content.body ?? "",
      url: entry.content.url ?? "",
      ...(assignee ? { assignee } : {}),
      status: entry.fieldValueByName?.name ?? "",
    });
  }
  const pageInfo = project.items?.pageInfo;
  return {
    projectId: project.id,
    statusFieldId: project.field.id,
    statusOptions: project.field.options ?? [],
    items,
    skipped,
    ...(pageInfo?.hasNextPage && pageInfo.endCursor ? { nextCursor: pageInfo.endCursor } : {}),
  };
}

/** Pure: the option id of a named status, or a thrown error listing the board's own
 * option names. A renamed column is a configuration fact to fix, not something to
 * approximate on someone else's board. */
export function statusOptionId(board: ProjectBoard, status: string): string {
  const option = board.statusOptions.find((candidate) => candidate.name === status);
  if (!option) {
    throw new Error(
      `the GitHub project has no Status option "${status}" (it has ${board.statusOptions.map((o) => o.name).join(", ")}) - fix the tracker's statusMap`,
    );
  }
  return option.id;
}

/** Pure: a board item as a ticket record. GitHub ids are the issue number with a hash,
 * which is how they are written on an item and in a commit. */
export function toRecord(item: BoardItem, tracker: string): TicketRecord {
  return {
    ref: { tracker, id: `#${item.number}` },
    externalId: item.contentId,
    status: item.status,
    description: item.body,
    title: item.title,
    url: item.url,
    ...(item.assignee ? { assignee: item.assignee } : {}),
  };
}

export type GraphQlRequest = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

/** IO boundary: `gh api graphql`, with the org's configured token when there is one and
 * ambient gh auth otherwise - the same resolution the integration-status check uses. */
export function ghRequest(tokenFile?: string): GraphQlRequest {
  return async (query, variables) => {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      if (value === undefined || value === null) continue;
      args.push(typeof value === "number" || typeof value === "boolean" ? "-F" : "-f", `${key}=${String(value)}`);
    }
    let env = process.env;
    if (tokenFile) {
      const path = tokenFile.startsWith("~") ? join(homedir(), tokenFile.slice(1)) : tokenFile;
      try {
        env = { ...process.env, GH_TOKEN: readFileSync(path, "utf8").trim() };
      } catch (cause) {
        throw new Error(`cannot read the GitHub token at ${path}: ${(cause as Error).message}`);
      }
    }
    const result = spawnSync("gh", args, { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) {
      throw new Error(`gh api graphql failed: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
    }
    const parsed = JSON.parse(result.stdout) as { data?: unknown; errors?: { message: string }[] };
    if (parsed.errors?.length) {
      throw new Error(`GitHub rejected the request: ${parsed.errors.map((error) => error.message).join("; ")}`);
    }
    return parsed.data;
  };
}

export class GithubProjectsAdapter implements TrackerAdapter {
  private board?: ProjectBoard;

  constructor(
    private readonly name: string,
    private readonly tracker: TrackerConfig,
    private readonly request: GraphQlRequest,
  ) {}

  /** Every issue on the board, read once per run and paged through: a status write needs
   * the project item id, which only the board carries. */
  async loadBoard(): Promise<ProjectBoard> {
    if (this.board) return this.board;
    const org = projectOrg(this.tracker);
    const number = projectNumber(this.tracker);
    let cursor: string | undefined;
    let board: ProjectBoard | undefined;
    do {
      const page = parseProjectBoard(await this.request(BOARD_QUERY, { org, number, cursor }));
      board = board
        ? {
            ...board,
            items: [...board.items, ...page.items],
            skipped: {
              pullRequests: board.skipped.pullRequests + page.skipped.pullRequests,
              drafts: board.skipped.drafts + page.skipped.drafts,
            },
          }
        : page;
      cursor = page.nextCursor;
    } while (cursor);
    this.board = board!;
    return this.board;
  }

  async fetchTickets(ids: string[]): Promise<TicketRecord[]> {
    if (ids.length === 0) return [];
    const board = await this.loadBoard();
    const wanted = new Set(ids);
    return board.items.filter((item) => wanted.has(`#${item.number}`)).map((item) => toRecord(item, this.name));
  }

  async setStatus(ticket: TicketRecord, status: string): Promise<void> {
    const board = await this.loadBoard();
    const item = board.items.find((candidate) => `#${candidate.number}` === ticket.ref.id);
    if (!item) throw new Error(`ticket ${ticket.ref.id} is not on the configured GitHub project board`);
    await this.request(SET_STATUS_MUTATION, {
      project: board.projectId,
      item: item.itemId,
      field: board.statusFieldId,
      option: statusOptionId(board, status),
    });
  }

  async setDescription(externalId: string, description: string): Promise<void> {
    await this.request(SET_BODY_MUTATION, { id: externalId, body: description });
  }
}
