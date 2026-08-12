// The markers delimiting DCL's managed block inside a harness's global config file.
// They live in their own module so the harness registry can recognise an opted-in
// profile without importing the block renderer that the registry itself feeds.
//
// These strings are matched against config files already installed on every machine:
// changing either one orphans the block it delimits instead of refreshing it.
export const START_MARK =
  "<!-- LOOPS:START — managed by decently-coordinated-loops; re-run install.sh or setup/seed.ts to refresh -->";
export const END_MARK = "<!-- LOOPS:END -->";
