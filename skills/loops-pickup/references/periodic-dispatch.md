# Periodic dispatch — mechanics and failure modes

Harness-specific detail behind loops-pickup's "Periodic dispatch (automation)". Written
for **session-bound cron harnesses** (e.g. Claude Code's recurring in-session jobs);
other harnesses schedule differently — map these concepts onto whatever your harness
provides, and ignore the ones it doesn't have. Do not imitate a feature (in-session
cron, subagents) your harness lacks.

- **The job is bound to the exact session that created it.** Closing the window
  silently kills the schedule; nothing inherits it. Re-create the job in a fresh window
  periodically.
- **Recurring jobs may auto-expire after a few days** — another reason to re-create
  them periodically rather than assume they persist.
- **Each firing appends to the same conversation**, so context grows until compaction.
  This is survivable because durable state lives on the board, not in the conversation —
  each wakeup re-hydrates from the item file (loops-pickup step 5).
- **Stagger multiple dispatchers.** When several dispatcher sessions exist, offset their
  schedules so they don't wake simultaneously and collide on usage windows.
- **On a hard usage-limit warning mid-run:** finish the current item safely (deliver or
  park it), stop the recurring job, and log that you did so.
