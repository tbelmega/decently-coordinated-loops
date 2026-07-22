// The review instructions handed to whichever reviewer adapter runs. Kept as a pure
// string builder (no I/O) so it is unit-testable and identical across adapters.
//
// The prompt is deliberately coverage-forcing: earlier revisions ("report only
// actionable defects") let a capable model satisfice — surface two or three findings
// and stop — leaving most of a multi-file diff unreviewed, so residual defects only
// surfaced in later rounds. The reviewer runs with read-only shell access, so it can
// enumerate the changed-file set itself; we require it to cover every file and hunk.

export function reviewPrompt(baseSha: string, headSha: string, priorNotes: string[]): string {
  return [
    `Review exactly the committed change ${baseSha}..${headSha} in the current repository.`,
    `First enumerate every changed file with \`git diff --name-only ${baseSha}..${headSha}\`, then review every hunk of every one of those files.`,
    "Complete coverage of the whole diff is required before you return — do not stop after the first few findings, and do not skip files that look unrelated.",
    "Inspect relevant call sites and tests, and judge each change against the surrounding existing code, established patterns, and architecture — not in isolation.",
    "Report every actionable correctness, security, data-loss, concurrency, compatibility, or material maintainability defect; omit style preferences.",
    "Do not edit files, commit, push, fetch, or use the network. Ignore files under .reviews because they are review evidence.",
    ...(priorNotes.length > 0
      ? [
          "Earlier rounds already dispositioned these findings; re-raise one only if you can show its recorded reason is factually wrong:",
          priorNotes.join("; ") + ".",
        ]
      : []),
    "Return only the requested structured result. An empty findings array means no actionable findings.",
  ].join(" ");
}
