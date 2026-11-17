# Final review layout

For the spec skill's finalization step only, not for interviewing or early drafts. A reordering
checklist, not a form: keep only relevant sections and never invent content to fill a heading.

```md
Status: Draft - not for implementation

# <Topic>

## Review summary
<!-- Write last. State what this builds and what it deliberately does not do. -->

## Decisions and assumptions requiring review
<!-- Include agent-made judgments, their rationale, and reversibility. -->

## Scope boundary
### This iteration
### Deferred scope summary
<!-- Summarize the canonical ledger near the end; no extra effort toward these extensions. -->
### Out of scope
<!-- No reasoning or implementation now; no judgment about future desirability. -->
### Prohibited outcomes
<!-- State what must be prevented and why; cover it in acceptance criteria. -->

## Risks and failure modes

## Acceptance criteria and high-level workflow

## Implementation detail
<!-- Architecture, placement, data flow, errors, testing, and other implementer detail. -->

## Deferred scope
<!-- Canonical ledger: what, why, reconsideration condition, intended fit if known.
     Omit when nothing is deferred. -->

## Implementation guidance
```
