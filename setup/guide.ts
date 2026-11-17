// The operating guide: the working defaults every agent session loads, installed into each
// detected harness on every machine, with or without a data repo. Its text lives in
// guide/OPERATING-GUIDE.md; this module wraps it per harness and writes it.
//
// Harness knowledge stays in setup/harnesses.ts. The two whole-file harnesses (Cursor
// rules, Kiro steering) get the guide as a sibling of the board's own file there, so the
// registry names one directory per harness and this module derives the file names.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GUIDE_PROVENANCE,
  GUIDE_SECTION_CLOSE,
  GUIDE_SECTION_OPEN,
  RETIRED_GUIDE_SECTION_CLOSE,
  RETIRED_GUIDE_SECTION_OPEN,
  SECTION_CLOSE,
  SECTION_OPEN,
} from "./marks.ts";
import { detectConfigTargets } from "./harnesses.ts";
import { upsertSection, writeOwnedFile, type UpsertOutcome } from "./config-block.ts";

const GUIDE_SOURCE = fileURLToPath(new URL("../guide/OPERATING-GUIDE.md", import.meta.url));

/** Base name of the guide's own file in whole-file harnesses, and of the file the retired
 * decently-capable-powers installer wrote there. */
const GUIDE_FILE = "operating-guide";
const RETIRED_GUIDE_FILE = "decently-capable-powers";

function guideBody(): string {
  return readFileSync(GUIDE_SOURCE, "utf8").trim();
}

/** The guide as a tagged section for a shared config file's <GENERATED> wrapper. */
export function renderGuideSection(): string {
  return `${GUIDE_SECTION_OPEN}\n${GUIDE_PROVENANCE}\n\n${guideBody()}\n\n${GUIDE_SECTION_CLOSE}\n`;
}

/** Cursor reads global rules as standalone `.mdc` files under `~/.cursor/rules/`. */
export function renderGuideCursorRule(): string {
  return `---
description: Operating guide - working defaults for every session (global). Project rules override on conflict.
alwaysApply: true
---

${guideBody()}
`;
}

/** Kiro loads every markdown file under `~/.kiro/steering/` as global steering. */
export function renderGuideKiroSteering(): string {
  return `---
inclusion: always
---

${guideBody()}
`;
}

/** Upserts the guide section above the board section, replacing the retired guide. */
export function upsertGuideSection(target: string, section: string): UpsertOutcome {
  return upsertSection(target, section, {
    open: GUIDE_SECTION_OPEN,
    close: GUIDE_SECTION_CLOSE,
    retired: { open: RETIRED_GUIDE_SECTION_OPEN, close: RETIRED_GUIDE_SECTION_CLOSE },
    before: { open: SECTION_OPEN, close: SECTION_CLOSE },
  });
}

/** Writes the guide's whole-file copy next to the board's file in `boardFile`'s directory
 * and removes the retired installer's copy there. */
function writeGuideFile(boardFile: string, content: string): { path: string; action: string; retired: boolean } {
  const ext = extname(boardFile);
  const path = join(dirname(boardFile), `${GUIDE_FILE}${ext}`);
  const action = writeOwnedFile(path, content);
  const retiredPath = join(dirname(boardFile), `${RETIRED_GUIDE_FILE}${ext}`);
  const retired = existsSync(retiredPath);
  if (retired) rmSync(retiredPath);
  return { path, action, retired };
}

/** Installs the guide into every harness detected under `home`. Returns the number of
 * config files left untouched because their tags are malformed. */
export function installGuide(home: string, log: (line: string) => void = console.log): number {
  const targets = detectConfigTargets(home);
  if (!targets.length) {
    log("no harness config directories detected - operating guide not installed");
    return 0;
  }
  const section = renderGuideSection();
  let skipped = 0;
  for (const target of targets) {
    if (target.kind === "cursor" || target.kind === "kiro") {
      const content = target.kind === "cursor" ? renderGuideCursorRule() : renderGuideKiroSteering();
      const { path, action, retired } = writeGuideFile(target.path, content);
      log(`  operating guide ${action}: ${path}${retired ? " (retired guide file removed)" : ""}`);
    } else if (target.kind === "block") {
      const outcome = upsertGuideSection(target.path, section);
      if (outcome.action === "skipped") {
        skipped++;
        log(`  ! operating guide skipped: ${target.path} - ${outcome.reason}; fix the tags and re-run`);
      } else {
        log(`  operating guide ${outcome.action}: ${target.path}`);
      }
    }
  }
  return skipped;
}
