---
name: loops-dispatch
description: Use when the owner asks you to set yourself up for dispatch duty or periodic dispatch — configures this session as a recurring unattended-pickup dispatcher, and inspects or stops one that is already running
---

# Dispatch duty

A **dispatcher** is a long-lived session holding a recurring job that fires the
loops-pickup prompt on a cadence, so unattended work proceeds without the owner
starting each round by hand. This skill performs that setup; loops-pickup defines
what each firing actually does.

Triggers: "set yourself up for dispatch duty", "start periodic dispatch", "what
dispatch is running", "stop dispatch".

Scope: this configures **the current session** as a dispatcher. It does not assign
roles across a roster of harnesses or coordinate other machines.

## 1. Check the harness can do this at all

Dispatch needs a recurring scheduler that re-enters *this* conversation. Use only
what your harness genuinely provides — never simulate a scheduler by sleeping,
polling in a loop, or promising to "remember" to wake up. A harness without one
cannot hold dispatch duty: say so plainly and stop, so the owner can put the duty on
a harness that can.

Claude Code provides session-bound cron (`CronCreate`/`CronList`/`CronDelete`).

## 2. Resolve the tuning before registering

In precedence order, lowest first:

1. `loops-pickup/references/periodic-dispatch.md` — the default mechanics and
   failure modes (it stays with loops-pickup; house rules point at it by path).
2. `HOUSE-RULES.md → Dispatch` in the data repo — the instance's cadence, usage-limit
   handling, and stagger policy. **Read it every time; never schedule from memory.**
3. The owner's invocation — a one-off frequency, a stagger offset, or a restriction
   to a single project overrides the house rules for this session.

If house rules leave `Dispatch` empty or `TODO`, do not invent a cadence. Ask the
owner for one, and offer to record the answer there so the next setup resolves it.

## 3. Express the cadence

House-rule cadences are usually **intervals anchored at setup time** ("every N hours
from the moment of scheduling"). Cron is wall-clock and has no interval primitive, so
convert: take the current hour `h` and emit **exactly `ceil(24 / N)` hours**,
`(h + k*N) mod 24` for `k = 0 … ceil(24/N) - 1`.

```
every 5 hours, set up at 14:23  →  ceil(24/5) = 5 hours
                                →  14, 19, 0, 5, 10
                                →  "23 14,19,0,5,10 * * *"
```

The term count matters: don't step until the values repeat. When `N` does not divide
24 the sequence only repeats after 24 terms — stepping by 5 from 14 walks through
every hour of the day, which would schedule **hourly**, not five-hourly.

### Check the wrap gap before registering

An hour-list repeats daily, so when `24 % N != 0` the final gap of the day is shorter
than the rest: `wrap = 24 - N * (ceil(24/N) - 1)`. Compute it every time — it degrades
badly as `N` approaches 24, and the failure is silent.

| `N` | fires | wrap gap | |
| --- | --- | --- | --- |
| 5 | 5×/day | 4h | fine — 80% of the interval, disclose and proceed |
| 10 | 3×/day | 4h | thin — ask first |
| 23 | 2×/day | **1h** | two firings an hour apart; never register this silently |

Rule: proceed when the wrap gap is at least **half of `N`**, and say the number out
loud in the confirmation. Below half, stop and put the choice to the owner — a
rounded cadence that divides 24, an interval-capable scheduler if the harness has
one, or a firing that no-ops unless `N` hours have actually elapsed since the last
pickup. Do not quietly register the compressed schedule.

**Above 24 hours the conversion doesn't hold at all.** A daily hour-list cannot
express a cadence of a day or longer: "every 48 hours" collapses to a single hour
firing *every* 24. For `N >= 24`, use day-stepping if the harness's cron supports it,
or stop and ask. Registering a job that fires twice as often as authorized is worse
than not registering one.

Two adjustments:

- **Pick an off-minute.** Not `:00` or `:30` — every scheduler on the planet fires
  there. Reuse the setup minute, or nudge a few minutes off.
- **Apply a stagger offset** only if house rules ask for one. Some instances
  explicitly waive staggering; don't add it unasked.

Exactness is approximate by nature: jobs fire only while the session is idle, so a
pickup still running at the next fire time pushes it out. Don't design around
precision the mechanism doesn't have.

## 4. Compose the pickup prompt

Start from loops-pickup's suggested dispatch prompt. Every firing must re-derive its
state from the board, so the prompt carries no context from this conversation beyond
the standing restrictions:

> Periodic dispatch: pick up the next available piece of work per the loops-pickup
> skill. You are running unattended — deliver a change for review or refinement per
> the protocol, babysit any review you open, and never land changes or deploy.

If the owner restricted the session to one project, name it in the prompt as a hard
constraint — loops-pickup must then consider only that project's items and treat
everything else as out of scope, even when a higher-priority item exists elsewhere.

## 5. Register, then confirm concretely

Register the job, then tell the owner in plain terms:

- the cadence, and the **actual clock times** it will fire (not just the expression)
- the project restriction, if any
- **that the schedule dies with this session** — closing the window silently kills
  dispatch; nothing is written to disk and nothing inherits it
- **the expiry date**, when the harness expires recurring jobs (Claude Code: 7 days,
  after which the job fires one final time and is deleted)

The last two are the failure modes that actually bite, and they are invisible unless
you say them out loud. Re-run this skill in a fresh session to renew.

## 6. Inspecting and stopping

- **"What dispatch is running?"** — list the harness's jobs and report cadence, next
  fire time, and expiry. If none, say so; do not infer from this conversation's
  history that a job still exists.
- **"Stop dispatch"** — delete the job and confirm which one. A dispatcher that
  cannot be stopped on request is a bug in the setup.
- **On a hard usage-limit warning mid-run** — finish or park the current item safely
  per loops-pickup, then stop the recurring job and log that you did, rather than
  letting later firings fail against an exhausted budget.
