// Padawan mode: an opt-in section for machines whose user owns the product but is not a
// developer. Its text lives in guide/PADAWAN-MODE.md; this module wraps it per harness and
// writes or removes it. The choice is a marker file on the machine, so a later plain
// `./install.sh` keeps it: install.sh `--padawan` creates the marker, `--no-padawan` deletes it,
// and every install applies whatever the marker says.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PADAWAN_PROVENANCE,
  PADAWAN_SECTION_CLOSE,
  PADAWAN_SECTION_OPEN,
  SECTION_CLOSE,
  SECTION_OPEN,
} from "./marks.ts";
import { removeSection, upsertSection, writeOwnedFile, type ConfigTarget } from "./config-block.ts";

const PADAWAN_SOURCE = fileURLToPath(new URL("../guide/PADAWAN-MODE.md", import.meta.url));

/** Home-relative marker whose existence turns padawan mode on for this machine. */
export const PADAWAN_MARKER = join(".config", "decently-coordinated-loops", "padawan-mode");

/** Base name of the whole-file copy in Cursor's and Kiro's directories. */
const PADAWAN_FILE = "padawan-mode";

export function padawanEnabled(home: string): boolean {
  return existsSync(join(home, PADAWAN_MARKER));
}

function padawanBody(): string {
  return readFileSync(PADAWAN_SOURCE, "utf8").trim();
}

/** The section for a shared config file's <GENERATED> wrapper. */
export function renderPadawanSection(): string {
  return `${PADAWAN_SECTION_OPEN}\n${PADAWAN_PROVENANCE}\n\n${padawanBody()}\n\n${PADAWAN_SECTION_CLOSE}\n`;
}

export function renderPadawanCursorRule(): string {
  return `---
description: Padawan mode - the user owns the product but is not a developer (global).
alwaysApply: true
---

${PADAWAN_PROVENANCE}

${padawanBody()}
`;
}

export function renderPadawanKiroSteering(): string {
  return `---
inclusion: always
---

${PADAWAN_PROVENANCE}

${padawanBody()}
`;
}

/** True when the whole-file copy at `path` is DCL's own: it carries the provenance line. */
function isOwnedFile(path: string): boolean {
  return readFileSync(path, "utf8").split("\n").some((line) => line.trim() === PADAWAN_PROVENANCE);
}

const PADAWAN_SPEC = {
  open: PADAWAN_SECTION_OPEN,
  close: PADAWAN_SECTION_CLOSE,
  before: { open: SECTION_OPEN, close: SECTION_CLOSE },
};

/** Applies the machine's padawan choice to one harness target the operating guide was just
 * written to: writes the section when the marker exists, removes it otherwise. In a shared
 * file the section lands below the guide (written first) and above the board section.
 * Returns false when the file's tags are malformed. */
export function applyPadawan(target: ConfigTarget, enabled: boolean, log: (line: string) => void): boolean {
  if (target.kind === "cursor" || target.kind === "kiro") {
    const path = join(dirname(target.path), `${PADAWAN_FILE}${extname(target.path)}`);
    // A file at this name that lacks the provenance line is someone else's: never replace
    // or delete it, on any install, opted in or not.
    if (existsSync(path) && !isOwnedFile(path)) {
      if (enabled) log(`  ! padawan mode skipped: ${path} exists and is not managed by DCL - left untouched`);
      return true;
    }
    if (enabled) {
      const content = target.kind === "cursor" ? renderPadawanCursorRule() : renderPadawanKiroSteering();
      log(`  padawan mode ${writeOwnedFile(path, content)}: ${path}`);
    } else if (existsSync(path)) {
      rmSync(path);
      log(`  padawan mode removed: ${path}`);
    }
    return true;
  }
  if (target.kind !== "block") return true;
  if (enabled) {
    const outcome = upsertSection(target.path, renderPadawanSection(), PADAWAN_SPEC);
    if (outcome.action === "skipped") {
      log(`  ! padawan mode skipped: ${target.path} - ${outcome.reason}; fix the tags and re-run`);
      return false;
    }
    log(`  padawan mode ${outcome.action}: ${target.path}`);
    return true;
  }
  const outcome = removeSection(target.path, PADAWAN_SECTION_OPEN, PADAWAN_SECTION_CLOSE);
  if (outcome.action === "skipped") {
    log(`  ! padawan mode removal skipped: ${target.path} - ${outcome.reason}; fix the tags and re-run`);
    return false;
  }
  if (outcome.action === "removed") log(`  padawan mode removed: ${target.path}`);
  return true;
}

