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
 *
 * An exempt class is a match like any other and refuses: it declares no waivable
 * priorities, so it cannot authorize one. That is not a contradiction with its own
 * policy, because a path matched by an exempt class AND a thresholded one is never
 * exempt in the first place (`isExemptOnly` refuses it too) - it is an owner
 * configuration saying two different things about one path, and both halves of the
 * resolution fail it closed rather than picking the looser reading.
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
    if (!entry.waivablePriorities?.includes(subject.priority)) {
      return `class ${JSON.stringify(entry.name)} does not waive ${subject.priority} findings on ${subject.file}`;
    }
  }
  return null;
}

/** Whether a changed file is covered by exempt-policy classes alone: at least one class
 * matches it and every matching class is exempt. A file also matched by a thresholded
 * class stays reviewable — the stricter class wins, same rule as waivers. */
export function isExemptOnly(file: string, classes: ReviewClassConfig[]): boolean {
  const matched = matchingClasses(file, classes);
  return matched.length > 0 && matched.every((entry) => entry.policy === "exempt");
}
