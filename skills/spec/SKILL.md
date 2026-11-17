---
name: spec
description: Use when the user asks to brainstorm, asks to write a spec, or when starting feature-level work (new features, components, behavior changes) that isn't specified in a persistent file yet; turns an idea into an agreed design before implementation
---

**Project override:** if the project defines its own design or spec workflow, defer to it
entirely.

# Spec: ideas into agreed designs

Turn ideas into agreed designs through dialogue: settle purpose, scope, architecture and
details, and volunteer the design thinking the user didn't ask for. The role is active design
partner, not requirements secretary.

**Gate:** once spec work has started for a piece of work, no implementation (no code, no
scaffolding, no file changes beyond the spec itself) until the user has approved the design.
Work the user requests outside a spec session follows the operating guide, not this
gate.

**Everything scales with the work:** questions, spec length, number of approaches, presentation
granularity. A small feature is a handful of questions and a one-screen spec, reviewed in one
pass. The spec file itself is never skipped.

## The Process

1. **Understand the context:** files, docs, recent commits. For unfamiliar territory, dispatch a
   subagent with the research skill and link its note from the spec, so discovered constraints
   and conventions survive handoff and compaction.
2. **Check scope and stakes.** A request spanning several independent subsystems is decomposed
   first: name the pieces, how they relate and the build order, then brainstorm the first; each
   gets its own spec and implementation cycle. Classify the work as a new capability or an
   iteration (see Scope); if context doesn't make that clear, ask before narrowing scope.
   Establish the stakes: who is exposed (paying customers on a core path, or a few pilot users
   behind a flag) and how reversible a bad ship is; infer it, or ask one composite question.
   Stakes set the design rigor (interview depth, pre-mortem intensity, spec length, whether
   rollout, flagging or migration belong in the design), never verification or test integrity.
3. **Clarify the goal.** While purpose and scope are vague, questions beat proposals.
   - Ask only questions whose answers change the design; stop when the rest wouldn't.
   - Decide by default: when the answer is inferable from code, docs or the user's demonstrated
     preferences, or the decision is cheap to reverse, decide it and record it in the spec as
     an assumption. Ask only where being wrong is expensive given the stakes; low exposure
     widens what counts as cheap to reverse.
   - Write each question as `interview-me` describes, with your recommended answer; the
     batching rule below overrides its one question per message.
   - Batch up to 4 questions per message only when they are independent (no question's
     relevance depends on another's answer) and close in topic; a dependent chain stays one
     question at a time.
4. **Draft the spec early.** Create `docs/specs/YYYY-MM-DD-<topic>.md` with
   `Status: Draft - not for implementation` at the first settled decision, and write each
   decision into it in the turn it is made; a decision that lives only in conversation is one
   compaction or crash away from lost. Don't let draft wording turn assumptions into
   requirements the user never agreed to. A draft may list open questions, but is not
   approval-ready while any would materially change scope, behavior, ownership, acceptance
   criteria or implementation cost. Structure the draft freely; review-layout.md is for
   finalization only.
5. **Pivot to proposing.** Once purpose and rough scope are settled, stop interviewing and
   propose: a concrete draft surfaces the remaining requirements faster than abstract
   questions. Offer 2-3 approaches where trade-offs genuinely differ; lead with your
   recommendation and why.
6. **Volunteer what wasn't asked.**
   - *Premise:* is this the right solution to the underlying problem? Say so early if not.
   - *Pre-mortem:* migrations, concurrency, data loss, security, backward compatibility,
     operational cost; the failure modes the user didn't know to ask about.
   - *Opportunities:* existing code that already half-solves it; platform or harness
     capabilities that make a planned component unnecessary.
   - Before finalizing, name the 3 or so most impactful things the spec still doesn't consider
     and triage them with the user.
   - Before presenting, list every design element not strictly entailed by the request and
     confirm each as current scope, deferred scope, out of scope or a prohibited outcome (see
     Scope); record them in the spec as labeled decisions, not prose the user is assumed to
     have absorbed.
7. **Present the design** in one pass; go section by section only when it is too large to
   review in one sitting.
8. **Finalize and gate** when the user asks for it, once the direction is settled; run no
   independent review loop during exploratory drafting.
   1. Ask every remaining material question directly, with a recommendation, and update the
      draft. Decide low-impact, reversible points yourself and label them as agent decisions
      so the user can object.
   2. Self-review for placeholders, contradictions, ambiguity and scope, and against the
      project's own design principles and conventions.
   3. If the spec outgrew one implementation cycle, propose a split (see Scope). Add a Mermaid
      diagram only where a picture clarifies.
   4. Reconcile the Deferred scope ledger.
   5. Write the Review summary from the finished body, reorder the whole spec with
      [review-layout.md](review-layout.md), and append the Implementation guidance tail.
   6. Where loops-review is available and a reviewer is configured, use its draft-finalization
      procedure: one independent round plus relevant fixes. Otherwise follow any configured
      project design review, and say so when none is available. Findings authorize
      corrections within agreed intent, not changes to scope, user-visible behavior, cost or
      settled trade-offs; raise those as questions, also when unsure which it is. More rounds
      need user authorization and a concrete unresolved issue.
   7. Present the still-Draft spec with its substantive changes, open decisions and risks, and
      edits lacking re-review, and ask for explicit approval. Finalization and agent review
      are not approval: only after the user approves, drop the Draft status and commit the
      spec.
9. **Transition to implementation.** For multi-task work, use the harness's native planning
   with the spec as source of truth, and turn the tail's Routing line into a concrete dispatch
   plan before writing code. Call out the Deferred scope ledger again and follow any
   project-defined tracking for its entries. For small work, implement directly.

**Revising an approved spec** is a new approval, not an edit: present the delta (above all, what
new scope or cost it introduces) and get explicit sign-off on each addition before marking the
revision approved. Regenerate the Review summary with new [added] items called out as new.

## Review Summary

Every finalized spec opens with a Review summary for a tired reviewer, in plain words without
architecture vocabulary, followed by the other front sections from review-layout.md. Order the
front by what the user most needs to notice and judge, not by conversation chronology or build
order: a reviewer who reads only the first quarter must meet every decision, assumption, scope
boundary, deferral, exclusion and risk they could reasonably object to.

- What this builds, in 3 sentences or fewer.
- Every element beyond what the user literally asked for, tagged **[added]**, with one line of
  why and its cost. If a simpler path to the goal exists and the spec doesn't take it, say so
  and why.
- What this deliberately does not do.

Write it last, from the finished body, and regenerate it (and reorder the spec) on every
revision: a summary written before the body is a plan, and a stale one is wrong exactly where
review matters most. [added] tags live only here, not inline in body sections. The body stays
as detailed as the implementer needs.

## What the Spec Covers

Purpose and acceptance criteria the implementing agent can test against. Architecture and
placement: existing modules touched, new vs modified files, seams created, patterns to follow.
Data flow, error handling, testing. Record rejected alternatives with their rationale; rejecting
an approach does not prohibit its outcome. Classify features removed during dialogue by the
actual decision (Scope below), so implementers neither reintroduce them nor infer a future
commitment. Use the scope categories instead of a "Non-goals" heading; when revising a spec that
has one, move its entries to the right category, asking where intent cannot be inferred. A small
feature may cover several of these in a paragraph.

## Scope

**New capability or iteration.** For a new capability, recommend the smallest end-to-end first
slice; polish, optional workflows, broad option sets and speculative edge cases are later by
default. For an iteration of an existing feature or approved plan, the established scope and
prior commitments stay current scope; don't use MVP reasoning to remove expected parts. Splitting
an oversized spec: for a new capability, an MVP spec now plus follow-up specs; for an iteration,
defer only separable work or work whose cost or risk warrants a new approval.

**Categories.** Only current scope is authorized for implementation; nothing else is added
"because it is free", and moving a boundary needs explicit approval. Omit empty categories.

- **Deferred scope:** a possible future capability kept in mind, including named roadmap
  extensions. Where implementation already requires a choice, prefer an equally simple option
  that leaves it open, but spend no extra design or implementation effort on it: no preparatory
  abstractions, hooks, scaffolding or partial implementation. If accommodating it would add
  effort or complexity, build current scope without it.
- **Out of scope:** outside this work's reasoning. Don't explore it, plan for it or shape
  extensibility around it; name the boundary without analyzing or justifying it. It is neither
  a future commitment nor a prohibition; reopening it needs a new scope decision.
- **Prohibited outcomes:** results the design must actively prevent. State what must not happen
  and why, with verifiable acceptance criteria for preventing it.

Don't design for speculative extensions. Resolve choices against current requirements and the
recorded deferred scope; ask when an unresolved choice materially affects current scope.

**Deferred scope ledger.** When anything is deferred, end the spec with a `Deferred scope`
section just before Implementation guidance. It is the one durable record; the front section
summarizes it without keeping a competing list. Per entry: what is deferred, why, the condition
for reconsidering it, and its intended fit if known ("not designed" is valid; don't design an
extension point to fill it). Record already-known consequences without investigating them.
Questions the user explicitly decided to defer belong here; unresolved material decisions do
not, ask those before approval. Reconcile the ledger on every revision before approval, and if
project instructions define a tracking system, record the follow-ups there too.

## Implementation Guidance (spec tail)

End every finalized spec with this section, so any implementing agent (after compaction, a
handoff, or in a different harness) still carries the agreed working decisions:

```md
## Implementation guidance
- Checkout: <per project rule, else the current checkout>
- Verify: run <project's typecheck+test commands> before claiming any task done
- Review: <once after every task in this spec is complete and final verification passes;
  configured project mechanism or user choice, terminal signal, and clean-commit requirement>
- Scope: build only current scope; deferred scope adds no effort, out-of-scope topics receive
  no exploration or preparation, and prohibited outcomes must be prevented
- Deferred scope: <confirm the ledger was reconciled; point to it and any required tracker>
- Build order: <suggested sequence and why; e.g. riskiest interface first, thin vertical slice>
- Routing: <per work item: orchestrator or delegate, at what model/effort, and why (hard core
  needing accumulated context vs compressible leaf), per the model-selection skill>
- Orchestrator: <model/effort for the implementing session: the cheapest that still covers the
  hardest orchestrator-bound Routing item. A fresh session must be able to implement the spec;
  continuing the spec session is a cost call, never a dependency, so anything only that
  session knows belongs in the spec>
```
