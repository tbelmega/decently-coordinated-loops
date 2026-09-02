// The tags delimiting DCL's managed section inside a harness's global config file.
// They live in their own module so the harness registry can recognise an opted-in
// profile without importing the block renderer that the registry itself feeds.
//
// Tag grammar, shared with decently-capable-powers (agreed 2026-08-23): one outer
// <GENERATED> wrapper per config file holds one inner section per tool. A tag counts
// only when it is the entire trimmed line, and only as part of a nearest open/close
// pair - a prose mention of a tag elsewhere in the file is inert. Full project names,
// not abbreviations, so another tool's marker cannot collide. Whichever tool runs
// first creates the wrapper; each tool touches only its own section inside it.
export const GENERATED_OPEN = "<GENERATED>";
export const GENERATED_CLOSE = "</GENERATED>";
export const SECTION_OPEN = "<DECENTLY-COORDINATED-LOOPS>";
export const SECTION_CLOSE = "</DECENTLY-COORDINATED-LOOPS>";

/** Human-facing provenance, the first line inside the section - the bare tags carry
 * no explanation of who owns the content or how to refresh it. */
export const PROVENANCE =
  "<!-- managed by decently-coordinated-loops; edit in that repo, then re-run install.sh or setup/seed.ts -->";

// Legacy markers, recognised for migration only: every machine seeded before the tag
// grammar carries them, and dropping recognition would orphan those blocks instead of
// refreshing them (the next seed would append a duplicate). Remove once host-inventory
// shows every host re-seeded. Byte-exact copies of what old seeds wrote - do not edit.
export const LEGACY_START_MARK =
  "<!-- LOOPS:START — managed by decently-coordinated-loops; re-run install.sh or setup/seed.ts to refresh -->";
export const LEGACY_END_MARK = "<!-- LOOPS:END -->";
