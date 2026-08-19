// Finding-level resolution of the review change classes (loops.json → review.classes).
// Everything fails closed toward full review: no file, no matching class, no resolved
// config, or any matching class that does not waive the priority — the finding blocks
// exactly as it would without classes.
import type { ReviewClassConfig, ReviewPriority } from "../config.ts";
import { matchesMetadataPath } from "./review-manifest.ts";

export function matchingClasses(file: string, classes: ReviewClassConfig[]): ReviewClassConfig[] {
  return classes.filter((entry) => matchesMetadataPath(file, entry.match));
}

export interface WaiverSubject {
  file?: string;
  priority: ReviewPriority;
}

/**
 * Whether `waivedClass` authorizes waiving this finding under the resolved classes.
 * Returns null when authorized, or the reason it is not. A file matching several
 * classes is waivable only if EVERY matching class waives the priority - the strictest
 * class wins, so widening one class's paths can never silently weaken another's.
 */
export function waiverRefusalReason(
  subject: WaiverSubject,
  waivedClass: string,
  classes: ReviewClassConfig[] | undefined,
): string | null {
  if (!classes) return "no review classes are configured for this repository";
  if (!subject.file) return "the finding has no file anchor";
  const named = classes.find((entry) => entry.name === waivedClass);
  if (!named) return `class ${JSON.stringify(waivedClass)} is not in the resolved review classes`;
  if (!matchesMetadataPath(subject.file, named.match)) {
    return `class ${JSON.stringify(waivedClass)} does not match ${subject.file}`;
  }
  for (const entry of matchingClasses(subject.file, classes)) {
    if (!entry.waivablePriorities.includes(subject.priority)) {
      return `class ${JSON.stringify(entry.name)} does not waive ${subject.priority} findings on ${subject.file}`;
    }
  }
  return null;
}
