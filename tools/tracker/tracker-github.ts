// The GitHub Projects (v2) adapter. Candidates are the issues on the configured project
// board - a repository issue that is not on the board is not this tracker's business.
// Query building and parsing are pure; the IO is one `gh api graphql` call per request,
// which reuses the auth the rest of the board tooling already uses.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TicketComment, TicketRecord, TrackerAdapter } from "./tracker-adapter.ts";
import type { TrackerBacklinkConfig, TrackerConfig } from "./tracker-config.ts";

/** The board query, asking for the text fields the tracker keeps its backlinks in. Field
 * names are JSON-quoted into the query, which is also how GraphQL quotes a string. */
export function boardQuery(backlink: TrackerBacklinkConfig = {}): string {
  const fieldDefinitions = BACKLINK_FIELDS.filter(([key]) => backlink[key])
    .map(([key, alias]) => `\n      ${alias}Field: field(name: ${JSON.stringify(backlink[key])}) { ... on ProjectV2Field { id } }`)
    .join("");
  const fieldValues = BACKLINK_FIELDS.filter(([key]) => backlink[key])
    .map(
      ([key, alias]) =>
        `\n          ${alias}Value: fieldValueByName(name: ${JSON.stringify(backlink[key])}) { ... on ProjectV2ItemFieldTextValue { text } }`,
    )
    .join("");
  return `query Board($org: String!, $number: Int!, $cursor: String) {
  organization(login: $org) {
    projectV2(number: $number) {
      id
      field(name: "Status") {
        ... on ProjectV2SingleSelectField { id name options { id name } }
      }${fieldDefinitions}
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }${fieldValues}
          content {
            __typename
            ... on Issue {
              id number title body url state createdAt
              author { login }
              assignees(first: 1) { nodes { login } }
            }
            ... on PullRequest { id number }
          }
        }
      }
    }
  }
}`;
}

/** The backlink config keys and the query alias each one is read under. */
const BACKLINK_FIELDS: [keyof TrackerBacklinkConfig, string][] = [
  ["slugField", "slug"],
  ["branchField", "branch"],
];

export const BOARD_QUERY = boardQuery();

export const COMMENTS_QUERY = `query Comments($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on Issue {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { author { login } createdAt body }
      }
    }
  }
}`;

export const BODY_QUERY = `query Body($id: ID!) {
  node(id: $id) { ... on Issue { body } }
}`;

export const SET_TEXT_MUTATION = `mutation SetText($project: ID!, $item: ID!, $field: ID!, $text: String!) {
  updateProjectV2ItemFieldValue(
    input: { projectId: $project, itemId: $item, fieldId: $field, value: { text: $text } }
  ) { projectV2Item { id } }
}`;

export const CLEAR_FIELD_MUTATION = `mutation ClearField($project: ID!, $item: ID!, $field: ID!) {
  clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field }) { projectV2Item { id } }
}`;

export const CLOSE_ISSUE_MUTATION = `mutation CloseIssue($id: ID!) {
  closeIssue(input: { issueId: $id }) { issue { id } }
}`;

export const REOPEN_ISSUE_MUTATION = `mutation ReopenIssue($id: ID!) {
  reopenIssue(input: { issueId: $id }) { issue { id } }
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
  /** Absent when the board did not say, e.g. an older recorded fixture. */
  open?: boolean;
  author?: string;
  createdAt?: string;
  /** Configured text field values by field name; an empty field is absent. */
  fields?: Record<string, string>;
}

export interface ProjectBoard {
  projectId: string;
  statusFieldId: string;
  /** Configured text field ids by field name; a field the project lacks is absent. */
  textFieldIds: Record<string, string>;
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
export function parseProjectBoard(data: unknown, backlink: TrackerBacklinkConfig = {}): ProjectBoard {
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
  const textFieldIds: Record<string, string> = {};
  for (const [key, alias] of BACKLINK_FIELDS) {
    const name = backlink[key];
    const id = (project as Record<string, { id?: string } | null | undefined>)[`${alias}Field`]?.id;
    if (name && id) textFieldIds[name] = id;
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
        state?: string;
        createdAt?: string;
        author?: { login?: string } | null;
        assignees?: { nodes?: { login?: string }[] };
      } | null;
    } & Record<string, unknown>;
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
    const fields: Record<string, string> = {};
    for (const [key, alias] of BACKLINK_FIELDS) {
      const name = backlink[key];
      const text = (entry[`${alias}Value`] as { text?: string } | null | undefined)?.text;
      if (name && text) fields[name] = text;
    }
    const author = entry.content.author?.login;
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
      ...(entry.content.state ? { open: entry.content.state === "OPEN" } : {}),
      ...(author ? { author } : {}),
      ...(entry.content.createdAt ? { createdAt: entry.content.createdAt } : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
    });
  }
  const pageInfo = project.items?.pageInfo;
  return {
    projectId: project.id,
    statusFieldId: project.field.id,
    statusOptions: project.field.options ?? [],
    textFieldIds,
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
    ...(item.open === undefined ? {} : { open: item.open }),
    ...(item.author ? { author: item.author } : {}),
    ...(item.createdAt ? { createdAt: item.createdAt } : {}),
    ...(item.fields ? { fields: item.fields } : {}),
  };
}

/** Pure: an issue's comments, oldest first. A deleted account reads as GitHub shows it. */
export function parseComments(data: unknown): TicketComment[] {
  const nodes =
    (data as { node?: { comments?: { nodes?: unknown[] } } | null }).node?.comments?.nodes ?? [];
  return nodes.map((node) => {
    const comment = node as { author?: { login?: string } | null; createdAt?: string; body?: string };
    return { author: comment.author?.login ?? "ghost", createdAt: comment.createdAt ?? "", body: comment.body ?? "" };
  });
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
      const backlink = this.tracker.backlink ?? {};
      const page = parseProjectBoard(await this.request(boardQuery(backlink), { org, number, cursor }), backlink);
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

  async listOpenTickets(): Promise<TicketRecord[]> {
    const board = await this.loadBoard();
    return board.items.filter((item) => item.open === true).map((item) => toRecord(item, this.name));
  }

  /** Every comment, paged to the end: a pulled ticket is never pulled again, so a
   * truncated discussion would stay truncated on the board for good. */
  async fetchComments(ticket: TicketRecord): Promise<TicketComment[]> {
    const comments: TicketComment[] = [];
    let cursor: string | undefined;
    do {
      const data = await this.request(COMMENTS_QUERY, { id: ticket.externalId, ...(cursor ? { cursor } : {}) });
      comments.push(...parseComments(data));
      const pageInfo = (data as { node?: { comments?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string } } } | null })
        .node?.comments?.pageInfo;
      cursor = pageInfo?.hasNextPage && pageInfo.endCursor ? pageInfo.endCursor : undefined;
    } while (cursor);
    return comments;
  }

  skippedEntries(): { pullRequests: number; drafts: number } | undefined {
    return this.board?.skipped;
  }

  async fetchDescription(ticket: TicketRecord): Promise<string> {
    const data = (await this.request(BODY_QUERY, { id: ticket.externalId })) as { node?: { body?: string | null } | null };
    if (!data.node) throw new Error(`ticket ${ticket.ref.id} no longer exists`);
    return data.node.body ?? "";
  }

  private async boardItem(ticket: TicketRecord): Promise<{ board: ProjectBoard; item: BoardItem }> {
    const board = await this.loadBoard();
    const item = board.items.find((candidate) => `#${candidate.number}` === ticket.ref.id);
    if (!item) throw new Error(`ticket ${ticket.ref.id} is not on the configured GitHub project board`);
    return { board, item };
  }

  async setTextField(ticket: TicketRecord, field: string, value: string): Promise<void> {
    const { board, item } = await this.boardItem(ticket);
    const fieldId = board.textFieldIds[field];
    if (!fieldId) {
      throw new Error(`the GitHub project has no text field "${field}" - add it to the project or fix the tracker's backlink config`);
    }
    if (value === "") {
      await this.request(CLEAR_FIELD_MUTATION, { project: board.projectId, item: item.itemId, field: fieldId });
      return;
    }
    await this.request(SET_TEXT_MUTATION, { project: board.projectId, item: item.itemId, field: fieldId, text: value });
  }

  async setOpen(ticket: TicketRecord, open: boolean): Promise<void> {
    await this.request(open ? REOPEN_ISSUE_MUTATION : CLOSE_ISSUE_MUTATION, { id: ticket.externalId });
  }

  async setStatus(ticket: TicketRecord, status: string): Promise<void> {
    const { board, item } = await this.boardItem(ticket);
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
