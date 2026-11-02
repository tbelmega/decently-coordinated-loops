# Asynchronous review mechanisms

Loaded from loops-pickup when `HOUSE-RULES.md → Review mechanism` is asynchronous (a PR to
a review bot, a remote reviewer) and you have requested review. The bundled local reviewer
is synchronous and does not need this file.

**Babysit the review** where the harness has self-paced loops: watch for automated-review
feedback and iterate per loops-pickup step 5.3, roughly every 15 minutes.

- Before entering the loop, log the working set on the item file (branch, review link,
  outstanding-feedback status, quality-gate command) and compact your context; each wakeup
  re-hydrates from the item file.
- Each check: if the integration branch moved and your change conflicts or is meaningfully
  behind, rebase, rerun the mechanical quality gate, push, then address feedback.
- Honor the mechanism's terminal "review complete" signal (defined in house rules); a
  completion signal never overrides an unaddressed comment.
- Stop when the change is merged or closed; the terminal signal fired with nothing left to
  address; two consecutive checks find nothing new; the reviewer clearly cannot continue;
  or after about 5 hours regardless, with the next dispatch resuming via step 0.
- Log each iteration on the item.
