/**
 * Shared synthetic identities for tests and examples. Keep their shapes realistic so
 * parser coverage does not depend on names copied from a real DCL installation.
 */
export const TEST_IDENTITIES = {
  owner: "Alice",
  host: "workstation-one",
  projects: {
    calendar: "daybook",
    coordination: "workboard",
    integration: "relay",
    household: "household-app",
  },
  items: {
    householdSlideshow: "household-app-slideshow-photo-management",
  },
} as const;
