export interface Entry {
  id: number;
  type: string;
  project: string;
  title: string;
  source: string;
  ask: string;
  speak: string;
  answered: boolean;
  answerLine: { start: number; end: number } | null;
  raw: string;
}

export function parseOutbox(text: string): Entry[] {
  const open = /^## Open[ \t]*\r?$/m.exec(text);
  if (!open) return [];
  const offset = open.index + open[0].length;
  const rest = text.slice(offset);
  const end = rest.search(/^## /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const headings = [...section.matchAll(/^### [^\r\n]*/gm)];
  return headings.flatMap((heading, index) => {
    const fields = /^### (\d+)[ \t]+[-\u2014][ \t]+(\S+)[ \t]+·[ \t]+(\S+)[ \t]+·[ \t]+(.+)$/.exec(heading[0]);
    if (!fields) return [];
    const bodyOffset = heading.index + heading[0].length;
    const body = section.slice(bodyOffset, headings[index + 1]?.index);
    const answers = [...body.matchAll(/^>[ \t]*A:[^\r\n]*/gm)];
    const answer = answers[0];
    const continuation = answer
      ? /^(?:\r?\n>[^\r\n]*)*/.exec(body.slice(answer.index + answer[0].length))![0]
      : "";
    const lineStart = offset + bodyOffset + (answer?.index ?? 0);
    return [{
      id: Number(fields[1]), type: fields[2], project: fields[3], title: fields[4].trim(),
      source: /^(?:\*\*)?Source(?:\*\*)?:(?:\*\*)?[ \t]*([^\r\n]*)/im.exec(body)?.[1].trim() ?? "",
      ask: /^(?:\*\*)?(?:The )?ask(?:\*\*)?:(?:\*\*)?[ \t]*([^\r\n]*)/im.exec(body)?.[1].trim() ?? "",
      speak: /^-[ \t]+speak:[ \t]*([^\r\n]*)/m.exec(body)?.[1].trim() ?? "",
      answered: Boolean(answer?.[0].replace(/^>[ \t]*A:/, "").trim() || continuation.replace(/^>/gm, "").trim()),
      answerLine: answers.length === 1 ? { start: lineStart, end: lineStart + answer[0].length } : null,
      raw: (heading[0] + body).trimEnd(),
    }];
  });
}

export function audioEntries(text: string): Entry[] {
  const entries = parseOutbox(text);
  return entries.filter(entry => entry.speak && entry.answerLine && !entry.answered &&
    entries.filter(candidate => candidate.id === entry.id).length === 1);
}
