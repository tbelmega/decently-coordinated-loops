// The Linear adapter. The query building and response parsing are pure and tested; the
// only IO is one POST to Linear's GraphQL endpoint, injected so tests never reach it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { TicketRecord, TrackerAdapter } from "./tracker-adapter.ts";
import type { TrackerConfig } from "./tracker-config.ts";
import type { TicketRef } from "./tracker-plan.ts";

const ENDPOINT = "https://api.linear.app/graphql";

export const ISSUES_QUERY = `query Issues($team: String!, $numbers: [Float!]!) {
  issues(filter: { team: { key: { eq: $team } }, number: { in: $numbers } }) {
    nodes {
      id
      identifier
      title
      description
      url
      state { name }
      assignee { displayName }
    }
  }
}`;

export const TEAM_STATES_QUERY = `query TeamStates($team: String!) {
  teams(filter: { key: { eq: $team } }) {
    nodes { id key states { nodes { id name } } }
  }
}`;

export const ISSUE_UPDATE_MUTATION = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

/** The issue number inside a Linear identifier, checked against the tracker's own team:
 * a key from another team would be a different board's ticket wearing a familiar shape. */
export function issueNumber(team: string, id: string): number {
  const match = id.match(/^([A-Z][A-Z0-9]*)-(\d+)$/);
  if (!match || match[1] !== team) {
    throw new Error(`ticket "${id}" does not belong to Linear team ${team}`);
  }
  return Number(match[2]);
}

interface GraphQlResponse {
  data?: unknown;
  errors?: { message: string }[];
}

/** The data of a GraphQL response, or a thrown error naming what the API refused. A
 * silent failure here would look exactly like an empty board. */
export function graphQlData(response: GraphQlResponse, what: string): unknown {
  if (response.errors?.length) {
    throw new Error(`Linear rejected the ${what}: ${response.errors.map((error) => error.message).join("; ")}`);
  }
  if (response.data === undefined || response.data === null) throw new Error(`Linear returned no data for the ${what}`);
  return response.data;
}

/** Pure: the issues of a fetch response as ticket records. */
export function parseIssues(data: unknown, tracker: string): TicketRecord[] {
  const nodes = (data as { issues?: { nodes?: unknown[] } }).issues?.nodes ?? [];
  return nodes.map((node) => {
    const issue = node as {
      id: string;
      identifier: string;
      title?: string;
      description?: string | null;
      url?: string;
      state?: { name?: string };
      assignee?: { displayName?: string } | null;
    };
    const ref: TicketRef = { tracker, id: issue.identifier };
    return {
      ref,
      externalId: issue.id,
      status: issue.state?.name ?? "",
      description: issue.description ?? "",
      ...(issue.title !== undefined ? { title: issue.title } : {}),
      ...(issue.url !== undefined ? { url: issue.url } : {}),
      ...(issue.assignee?.displayName ? { assignee: issue.assignee.displayName } : {}),
    };
  });
}

/** Pure: the id of a named workflow state, or a thrown error listing what the team
 * actually has. A renamed state is a configuration fact for the owner to fix; guessing
 * the nearest match would move a collaborator's ticket somewhere nobody chose. */
export function stateId(data: unknown, team: string, status: string): string {
  const nodes = (data as { teams?: { nodes?: unknown[] } }).teams?.nodes ?? [];
  const found = nodes.find((node) => (node as { key?: string }).key === team) as
    | { states?: { nodes?: { id: string; name: string }[] } }
    | undefined;
  if (!found) throw new Error(`Linear has no team ${team}`);
  const states = found.states?.nodes ?? [];
  const state = states.find((candidate) => candidate.name === status);
  if (!state) {
    throw new Error(
      `Linear team ${team} has no workflow state "${status}" (it has ${states.map((s) => s.name).join(", ")}) - fix the tracker's statusMap`,
    );
  }
  return state.id;
}

export type GraphQlRequest = (query: string, variables: Record<string, unknown>) => Promise<GraphQlResponse>;

/** IO boundary: one authenticated POST. The token is read per call rather than held, so
 * a rotated key takes effect without restarting anything. */
export function httpRequest(tokenFile: string): GraphQlRequest {
  const path = tokenFile.startsWith("~/") ? `${homedir()}/${tokenFile.slice(2)}` : tokenFile;
  return async (query, variables) => {
    let token: string;
    try {
      token = readFileSync(path, "utf8").trim();
    } catch (cause) {
      throw new Error(`cannot read the Linear token at ${path}: ${(cause as Error).message}`);
    }
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Linear API returned ${response.status} ${response.statusText}`);
    return (await response.json()) as GraphQlResponse;
  };
}

export class LinearAdapter implements TrackerAdapter {
  constructor(
    private readonly name: string,
    private readonly tracker: TrackerConfig,
    private readonly request: GraphQlRequest,
  ) {}

  async fetchTickets(ids: string[]): Promise<TicketRecord[]> {
    if (ids.length === 0) return [];
    const numbers = ids.map((id) => issueNumber(this.tracker.team, id));
    const response = await this.request(ISSUES_QUERY, { team: this.tracker.team, numbers });
    return parseIssues(graphQlData(response, "issue query"), this.name);
  }

  async setStatus(ticket: TicketRecord, status: string): Promise<void> {
    const states = await this.request(TEAM_STATES_QUERY, { team: this.tracker.team });
    const id = stateId(graphQlData(states, "workflow state query"), this.tracker.team, status);
    const response = await this.request(ISSUE_UPDATE_MUTATION, { id: ticket.externalId, input: { stateId: id } });
    graphQlData(response, `status update of ${ticket.ref.id}`);
  }

  async setDescription(externalId: string, description: string): Promise<void> {
    const response = await this.request(ISSUE_UPDATE_MUTATION, { id: externalId, input: { description } });
    graphQlData(response, "description update");
  }
}
