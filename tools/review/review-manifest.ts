export interface ReviewFileCoverage {
  path: string;
  hunks: string[];
}

export interface ReviewContextReference {
  label: string;
  path: string;
  digest: string;
}

export interface ReviewManifest {
  baseSha: string;
  headSha: string;
  files: ReviewFileCoverage[];
  metadataFiles: ReviewFileCoverage[];
  metadataPaths?: string[];
  remediationFiles?: ReviewFileCoverage[];
  baseDeltaFiles?: ReviewFileCoverage[];
  instructionFiles: string[];
  /** Instruction files this range is authorized to rewrite (the item's declared change
   * surface): the reviewer treats their NEW text as the proposed rule under review,
   * while every other instruction file remains authority. Persisted per round so the
   * suspended authority stays auditable in the ledger. */
  instructionFilesUnderRevision?: string[];
  contextReferences: ReviewContextReference[];
  patchIds: string[];
}

export interface ReviewDiffFiles {
  files: ReviewFileCoverage[];
  metadataFiles: ReviewFileCoverage[];
}

export function matchesMetadataPath(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern,
  );
}

export function parseReviewDiff(diffText: string, metadataPaths: string[]): ReviewDiffFiles {
  const changedFiles = new Map<string, ReviewFileCoverage>();
  let currentFile: ReviewFileCoverage | undefined;
  for (const line of diffText.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      currentFile = changedFiles.get(fileMatch[2]) ?? {path: fileMatch[2], hunks: []};
      changedFiles.set(fileMatch[2], currentFile);
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!currentFile || !hunkMatch) continue;
    const hunk = `-${hunkMatch[1]},${hunkMatch[2] ?? "1"} +${hunkMatch[3]},${hunkMatch[4] ?? "1"}`;
    if (!currentFile.hunks.includes(hunk)) currentFile.hunks.push(hunk);
  }
  const files = [...changedFiles.values()];
  return {
    files: files.filter((file) => !matchesMetadataPath(file.path, metadataPaths)),
    metadataFiles: files.filter((file) => matchesMetadataPath(file.path, metadataPaths)),
  };
}

export function buildReviewManifest(input: {
  baseSha: string;
  headSha: string;
  diffText: string;
  remediationDiffText?: string;
  baseDeltaDiffText?: string;
  metadataPaths: string[];
  instructionFiles: string[];
  instructionFilesUnderRevision?: string[];
  contextReferences: ReviewContextReference[];
  patchIds: string[];
}): ReviewManifest {
  const {files, metadataFiles} = parseReviewDiff(input.diffText, input.metadataPaths);
  const remediationFiles = parseReviewDiff(input.remediationDiffText ?? "", input.metadataPaths).files;
  const baseDeltaFiles = parseReviewDiff(input.baseDeltaDiffText ?? "", input.metadataPaths).files;
  return {
    baseSha: input.baseSha,
    headSha: input.headSha,
    files,
    metadataFiles,
    metadataPaths: [...input.metadataPaths].sort(),
    remediationFiles,
    baseDeltaFiles,
    instructionFiles: [...input.instructionFiles].sort(),
    ...(input.instructionFilesUnderRevision?.length
      ? {instructionFilesUnderRevision: [...input.instructionFilesUnderRevision].sort()}
      : {}),
    contextReferences: [...input.contextReferences],
    patchIds: [...input.patchIds].sort(),
  };
}
