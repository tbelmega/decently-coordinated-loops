---
name: loops-dispatch
description: Use when the owner asks you to set yourself up for dispatch duty or periodic dispatch; configures this session as a recurring unattended-pickup dispatcher, and inspects or stops one that is already running
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

Dispatch needs a recurring scheduler that fires the pickup prompt for this session.
Use only what your harness genuinely provides; never simulate a scheduler by sleeping,
polling in a loop, or promising to "remember" to wake up. A harness without one
cannot hold dispatch duty: say so plainly and stop, so the owner can put the duty on
a harness that can.

Claude Code provides session-bound cron (`CronCreate`/`CronList`/`CronDelete`) that
re-enters this conversation. Grok Build provides an interval scheduler
(`scheduler_create`/`scheduler_list`/`scheduler_delete`, wrapped by `/loop`); each
firing runs as a detached background subagent that cannot see this conversation, so
the prompt from section 4 must stand entirely on its own, and it has no interval
under 60 seconds. OpenCode and Kiro CLI provide no scheduler, so they cannot hold
dispatch duty.

## 2. Resolve the tuning before registering

In precedence order, lowest first:

1. `loops-pickup/references/periodic-dispatch.md` - the default mechanics and
   failure modes (it stays with loops-pickup; house rules point at it by path).
2. `HOUSE-RULES.md → Dispatch` in the data repo - the instance's cadence, usage-limit
   handling, and stagger policy. **Read it every time; never schedule from memory.**
3. The owner's invocation (a one-off frequency, a stagger offset, or a restriction to
   a single project) overrides the house rules for this session.

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
24 the sequence only repeats after 24 terms; stepping by 5 from 14 walks through
every hour of the day, which would schedule **hourly**, not five-hourly.

### Check the wrap gap before registering

An hour-list repeats daily, so when `24 % N != 0` the final gap of the day is shorter
than the rest: `wrap = 24 - N * (ceil(24/N) - 1)`. Compute it every time; it degrades
badly as `N` approaches 24, and the failure is silent.

| `N` | fires | wrap gap | |
| --- | --- | --- | --- |
| 5 | 5×/day | 4h | fine: 80% of the interval, disclose and proceed |
| 10 | 3×/day | 4h | thin: ask first |
| 23 | 2×/day | **1h** | two firings an hour apart; never register this silently |

Rule: proceed when the wrap gap is at least **half of `N`**, and say the number out
loud in the confirmation. Below half, stop and put the choice to the owner: a
rounded cadence that divides 24, an interval-capable scheduler if the harness has
one, or a firing that no-ops unless `N` hours have actually elapsed since the last
pickup. Do not quietly register the compressed schedule.

**Above 24 hours the conversion doesn't hold at all.** A daily hour-list cannot
express a cadence of a day or longer: "every 48 hours" collapses to a single hour
firing *every* 24. For `N >= 24`, use day-stepping if the harness's cron supports it,
or stop and ask. Registering a job that fires twice as often as authorized is worse
than not registering one.

Three adjustments:

- **Pick an off-minute.** Not `:00` or `:30`; every scheduler on the planet fires
  there. Reuse the setup minute, or nudge a few minutes off.
- **Nudge it earlier, never later.** The hour list includes the setup hour, so a
  minute later in the current hour fires almost immediately: registering at 14:23 with
  `26 14,19,…` fires in three minutes, not in `N` hours. Choosing a minute at or
  before the current one puts the first firing a full interval out.
- **Apply a stagger offset** only if house rules ask for one. Some instances
  explicitly waive staggering; don't add it unasked.

An immediate first pickup is a legitimate thing to want; the owner asking for
dispatch duty often wants work starting now. Make it a decision, not an accident:
either start that first pickup deliberately and say so, or keep the first firing a
full `N` hours out.

Exactness is approximate by nature: jobs fire only while the session is idle, so a
pickup still running at the next fire time pushes it out. Don't design around
precision the mechanism doesn't have.

## 4. Compose the pickup prompt

Start from this prompt. Every firing must re-derive its
state from the board, so the prompt carries no context from this conversation beyond
the standing restrictions:

> Periodic dispatch: pick up the next available piece of work per the loops-pickup
> skill. You are running unattended: complete the full prior-obligation sweep,
> then perform substantive eligible work in this firing; preflight bookkeeping does
> not complete the wakeup, and only substantial work in progress inherited from the
> previous turn may itself be the substantive outcome. Deliver a change for review
> or refinement per the protocol, babysit any review you open, and resolve landing
> and development-deployment authority from the house rules; never make other
> deployments. Before going idle, publish all durable item and board state, then use
> the harness-supported compaction mechanism described by the dispatcher setup.

If the owner restricted the session to one project, name it in the prompt as a hard
constraint; loops-pickup must then consider only that project's items and treat
everything else as out of scope, even when a higher-priority item exists elsewhere.

### Compact after each firing

Claude Code's `/compact` is a prompt command, not a command the model can invoke as
the final action inside its current response. The recurring pickup prompt therefore
instructs each firing to use `CronCreate` after its work is durable: schedule a
**one-shot** prompt containing exactly `/compact` for the next minute, then finish
the current turn. Scheduled prompts run between turns; if the pickup is still
finishing when the minute arrives, the command waits until that response ends.

Never schedule compaction before updating, committing, and pushing the item/board
state needed to re-hydrate the next firing. Do not create a second recurring job for
compaction; one one-shot per completed firing preserves the required ordering. If
the harness cannot schedule or invoke compaction, say so during setup and omit the
claim that each firing compacts; never simulate support it does not have. Grok's
firings run in detached subagents with their own context, so a Grok dispatcher
omits the compaction step: the dispatcher conversation does not grow per firing.

## 5. Register, then confirm concretely

Register the job, then tell the owner in plain terms:

- the cadence, and the **actual clock times** it will fire (not just the expression)
- the project restriction, if any
- **that the schedule dies with this session:** closing the window silently kills
  dispatch; nothing is written to disk and nothing inherits it
- **the expiry date**, when the harness expires recurring jobs (Claude Code: 7 days,
  after which the job fires one final time and is deleted; Grok Build: 7 days)

The last two are the failure modes that actually bite, and they are invisible unless
you say them out loud. Re-run this skill in a fresh session to renew.

## 6. Inspecting and stopping

- **"What dispatch is running?"** - list the harness's jobs and report cadence, next
  fire time, and expiry. If none, say so; do not infer from this conversation's
  history that a job still exists.
- **"Stop dispatch"** - delete the job and confirm which one. A dispatcher that
  cannot be stopped on request is a bug in the setup.
- **On a hard usage-limit warning mid-run** - finish or park the current item safely
  per loops-pickup, then stop the recurring job and log that you did, rather than
  letting later firings fail against an exhausted budget.

## Central dispatch

Next to this session-timer dispatch, a data repo can run **central dispatch**: the
dispatch program (`bun run dispatch`, no model inside) that a timer on one control host
runs. Each tick claims eligible items the way a session claims work and starts each one
as a job on a **worker**, a host listed in `loops.json → dispatch.workers`; the job
follows loops-pickup → Dispatched item. Absent or `enabled: false`, it starts nothing.

- **Workers and slots are the only capacity.** Each worker takes at most `slots` jobs of
  any kind at once (`kinds` narrows which), and only in a tick where it answers SSH. A
  worker that does not answer keeps every claim it holds and gets nothing new. The control
  host runs no job unless it is listed as a worker itself (an entry without `ssh`).
- **The kind of work picks the executor** (`dispatch.executors`): a T3 Code thread on a
  lane (`type: "t3"`), or a Codex CLI job (`type: "codex-cli"`) that the worker's own DCL
  clone starts and supervises (`tools/dispatch-job.ts`, status and log under
  `~/.local/state/dcl/jobs/` on the worker). Both get the same work message.
- **Where a start goes:** among workers that take the kind, answer, have the project's
  repository, a ready executor and a free slot (and, for a build in a slotted project, an
  idle worktree slot there), the one with the most free slots, ties in configuration
  order. A merge goes only to the worker named in the item's `execution.host`, and runs
  in the recorded worktree (else the project's primary checkout there) once Git confirms
  it exists; without a recorded host a merge is not dispatched.
- **Commands run through the worker's login shell** (`ssh -o BatchMode=yes <ssh>
  '<shell> -lc ...'`), so `t3`, `codex` and `bun` resolve as in a terminal there;
  `t3Bin`, `codexBin`, `dclHome` and `shell` per worker override, as command names or
  absolute or `~/` paths. Each worker resolves them itself (symlinks included) before
  running anything and refuses one that lands inside a project repository, any Git work
  tree holding a `BOARD.md` (a data repo), or a root listed in the worker's own
  `~/.config/dcl/guard-roots` (one path per line, `~/` allowed). That file is required on
  every host that runs dispatch commands, the control host included: list the directories
  the host keeps its checkouts in, which no board edit can move. A host without it, or
  with an empty one, refuses every command, as does a host without `realpath` (it must
  follow symlinks); plan shows such a worker as unreachable with a `dcl-guard` reason.
- **Entries from before workers** (no `worker` in the state file) run on the control host:
  they are observed until they end, and parked for the owner where they would otherwise
  get work or a continue.

Commands:

- `plan --host <name>` - each worker's probe, what a tick would start where, and why every
  other item would not; changes nothing and never pulls.
- `tick --host <name> [--init]` - observe dispatched threads and jobs, clean up, claim,
  start. Runs in a clone of the data repo dedicated to the program; `--init` once, and
  again only after checking each worker for threads whose title ends with a claim tag
  such as `[d-1a2b3c4d]`, and for Codex job status files, when the state file was lost.
- `status` - dispatched items with worker, executor, phase, thread id or job log path,
  item state; worker cooldowns; pause flags.
- `pause [--project <name>] [--note <text>]`, `resume [--project <name>]` - the committed
  `dispatch-control.json`, so a pause can come from any checkout that can push.

**Adding a worker** is a configuration change: give it the project repositories, a DCL
clone outside every project repository (its `tools/dispatch-job.ts` is the launcher; set
the entry's `dclHome`, or export `DCL_HOME` in the worker's login shell, since the
installer does not), `bun`, and the executables its kinds need (`codex`, and `t3` with a running T3 Code server for builds); add its entry; check
`plan`; then run one supervised `tick` and confirm the job's outcome on the board before
the timer runs unattended. A worker whose job fails for a missing prerequisite (secrets,
credentials, browsers) is removed or its `kinds` narrowed until it is provisioned.

Arming a session timer is unchanged, and "dispatch duty" keeps meaning this skill's
session timer unless the owner says otherwise. Where both run, the pushed claim decides
races; worker slots count only the program's own jobs.
