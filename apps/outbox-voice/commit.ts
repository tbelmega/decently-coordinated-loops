import { audioEntries } from "./parse.ts";
import type { Entry } from "./parse.ts";

export interface Repository {
  repo: string;
  branch: string;
  token: string;
}

export function insertAnswer(text: string, expected: Entry, transcript: string): string | null {
  if (!transcript.trim() || /[\r\n\u2028\u2029]/.test(transcript)) {
    throw new Error("Dictate or enter a single non-empty line.");
  }
  const current = audioEntries(text).find(entry => entry.id === expected.id);
  if (!current?.answerLine || current.raw !== expected.raw) return null;
  const { start, end } = current.answerLine;
  return text.slice(0, start) + "> A: [voice] " + transcript + text.slice(end);
}

function endpoint({ repo }: Repository): URL {
  if (!/^[\w-]+\/[\w.-]+$/.test(repo) || /\/\.{1,2}$/.test(repo)) {
    throw new Error("Enter the repository as owner/name.");
  }
  return new URL(`https://api.github.com/repos/${repo}/contents/OUTBOX.md`);
}

function headers(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

type Request = (input: URL, init: RequestInit) => Promise<Response>;

export async function readOutbox(repository: Repository, request: Request = fetch) {
  const url = endpoint(repository);
  url.searchParams.set("ref", repository.branch);
  const response = await request(url, { headers: headers(repository.token), cache: "no-store" });
  if (!response.ok) throw new Error(`Could not read the outbox (HTTP ${response.status}).`);
  const { sha, content, encoding } = await response.json();
  if (typeof sha !== "string" || typeof content !== "string" || encoding !== "base64") {
    throw new Error("GitHub did not return an outbox file.");
  }
  const bytes = Uint8Array.from(atob(content), character => character.charCodeAt(0));
  return { sha, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
}

export async function commitAnswer(
  repository: Repository, entry: Entry, transcript: string, request: Request = fetch,
): Promise<"committed" | "unavailable"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, sha } = await readOutbox(repository, request);
    const updated = insertAnswer(text, entry, transcript);
    if (updated === null) return "unavailable";
    const content = btoa(Array.from(new TextEncoder().encode(updated), byte => String.fromCharCode(byte)).join(""));
    const response = await request(endpoint(repository), {
      method: "PUT",
      headers: headers(repository.token),
      body: JSON.stringify({ message: `Answer outbox entry ${entry.id}`, sha, content, branch: repository.branch }),
    });
    if (response.ok) return "committed";
    if (response.status !== 409) throw new Error(`Could not save the answer (HTTP ${response.status}).`);
  }
  throw new Error("The outbox changed again. Try committing the answer again.");
}
