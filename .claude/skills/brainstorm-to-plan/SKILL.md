---
name: brainstorm-to-plan
description: Turns a brainstorming session — a scratch markdown file, in-conversation ideation, inline notes, or an already-seeded plan that needs re-phasing — into a phased planning document at `docs/planning/not-shipped/<slug>-plan.md` that conforms to `docs/planning/PLANNING.md`. Drives a rubric-driven phase split rather than dumping the brainstorm into a template verbatim. Each phase must pass seven checks — Concrete (noun-form deliverables), Testable (one-sentence Done-when), Isolated (one shippable PR with no scaffolding leaking forward), One-concern (single component or capability slice), Reversibility-classifiable (`safe`/`feature-flagged`/`forward-only`/`destructive` without weasel words), UI-extractable (every user-visible change tagged `[design needed]` or `[no design]`, never `TBD`), Verify-in-prod-statable (production signal that confirms the *outcome*, not just artifact existence). Surfaces failing phases with concrete split suggestions and iterates until every phase passes or the user explicitly waives a check; waivers are logged as a one-line note in §1 Background so future readers know the rubric was bypassed. Applies pre-emptive split heuristics for known anti-patterns — framework-plus-first-user, polish-catch-all, new-connected-service-plus-first-consumer, schema-and-API-and-UI-in-one-phase, pool-support-bolted-onto-feature, docs-padded-onto-feature — so the first proposal is already close before the rubric runs. Re-phase mode (input is an already-seeded plan with real `ALT-NN` IDs in §8) preserves IDs for phases whose scope didn't materially change and emits `ALT-_TBD_` for new phases from splits, with a Linear-impact preview before writing. Use this skill whenever the user says "turn this brainstorm into a plan", "draft a planning doc from these notes", "split this idea into phases", "phase this out for me", "write up a plan for X", "fix the phasing of this plan", "this plan's phases are too big — re-split them", or has clearly been ideating in-session and asks for a plan doc. Do NOT use for ad-hoc one-liner planning, for plans that are already well-phased and only need wording tweaks (edit the doc directly), or for execution planning at the file level (that's `plan-to-linear`'s Phase 3.5 explorer).
---

# Brainstorm to Plan

You're turning a brainstorming session into a phased planning document under `docs/planning/not-shipped/`. The output is consumed by `plan-to-linear` (which seeds Linear) and then by `execute-next-task` (which executes phases one PR at a time). The phased rollout is the load-bearing artifact — get the splits right and the downstream skills work; get them wrong (phases too big, deliverables vague, Done-when untestable) and the executor wastes runs trying to figure out what "done" means.

Plans are **scoping** documents, not implementations. You write goals, deliverables in noun form, reversibility classifiers, UI changes, Done-when, and Verify-in-prod — not file-by-file change lists. The executor's `plan-to-linear` Phase 3.5 explorer maps phases to source-code touchpoints at seed time; this skill never preempts that.

---

## Phase 1 — Capture the brainstorming input

The user's invocation usually points you at one of four input modes. Probe for the right one — don't guess.

### Mode A — Path to a scratch markdown file

The user names a file (`docs/planning/scratch/foo.md`, `~/notes/idea.md`, etc.). Read it end-to-end. Most common case.

### Mode B — Use the current conversation

The user has been ideating with Claude in-session and says "turn that into a plan." Look back through the conversation, extract:

- The problem statement
- Target outcome
- Components likely to be touched
- Anything explicitly ruled out ("we won't do X because…")
- Concrete shapes / contracts / type sketches that came up

Then **summarise back** what you've gathered as bulleted "project intent / target outcome / surface area / non-goals / shared concepts" before proceeding. The user confirms or corrects; only then advance to Phase 2. This summarisation step is non-negotiable — silently reconstructing intent from a long conversation is how plans drift from what the user actually meant.

### Mode C — Inline scoping interview

The user names a feature with no scratch file and no prior conversation context ("I want a plan for adding X"). Run a 4-question interview before drafting:

1. **What problem does this solve?** (Background — must be answerable in 3-6 sentences)
2. **What does success look like in production?** (Goals — outcomes, not deliverables)
3. **Which components do you expect to touch?** (Surface area — server / client / sidecars / templates / etc.)
4. **What did you consider and reject?** (Non-goals — at least one item required; pitch it as "what's *out* of scope")

Anything the user can't or won't answer goes into §7 Risks & open questions in the eventual plan, never silently invented. If a question comes back vague, follow up — don't paper over.

### Mode D — Re-phase an already-seeded plan

The user points at an existing plan whose §8 has real `ALT-NN` IDs (i.e. `plan-to-linear` already ran). The phasing is broken — phases too big, Done-when untestable, "polish" catch-all phases — and the user wants the plan re-split.

In this mode, the existing plan **is the brainstorming input**. Read it like a scratch doc, but also extract the existing phase → ALT-NN map from §8 — you'll need it in Phase 8 to preserve IDs where possible. Surface a clear Linear-impact preview before writing (see Phase 8 for the shape).

**Confirm the mode with the user before proceeding.** A one-liner is enough: "Reading `<path>` as a Mode A scratch file" or "Re-phasing `<path>` (Mode D) — its §8 has 6 seeded ALT IDs."

---

## Phase 2 — Read the references once

Before drafting, read these — both for format conformance and for tone match. Skip if you've already read them in this session.

- [`docs/planning/PLANNING.md`](docs/planning/PLANNING.md) — the mechanical format the plan must conform to. Section numbering, the six-required-parts-per-phase rule, §8 placeholder shape, "What not to write."
- [`docs/planning/not-shipped/internal-nats-messaging-plan.md`](docs/planning/not-shipped/internal-nats-messaging-plan.md) — fully-populated reference plan. Tone, depth, level of detail per section.
- [`.claude/skills/plan-to-linear/SKILL.md`](.claude/skills/plan-to-linear/SKILL.md) — only the §8 / mode-detection bits. You write §8; `plan-to-linear` reads it. The contract is shared.

If the user's input includes paths to other planning docs (e.g. "build on auth-proxy-sidecar-plan.md"), read those too — they may set context or constraints for shared concepts.

---

## Phase 3 — Extract project intent

Pull these from the input, in order:

1. **H1 / project title** — short noun phrase, no trailing punctuation.
2. **Background paragraph** — the problem-being-solved + target outcome, standalone-readable in 3-6 sentences. If the input gives you 12 paragraphs of detail, distil; if it gives you "we should improve X", flag back to the user that the background is too thin to seed a plan.
3. **Goals** — 3-6 numbered points, each phrased as an *outcome*. If the user wrote deliverables ("ship X"), reframe as outcomes ("operators can do Y").
4. **Non-goals** — at least one bullet with a one-line *why*. If the user volunteered none, prompt explicitly: "what did you consider and reject during brainstorming?" An empty Non-goals section is almost always a planning bug — operators end up re-litigating decisions during execution because the rationale wasn't captured.
5. **Shared concepts** — types, contracts, naming conventions, subjects, or schemas referenced by ≥ 2 phases. These belong in a `## <N>. <Concept>` section between Non-goals and Phased rollout, not inside any one phase. Surfacing shared concepts up front prevents drift across phases (one phase invents a contract, the next phase invents a parallel one).
6. **Component surface area** — which top-level dirs the work touches (`server/`, `client/`, `lib/`, `agent-sidecar/`, `egress-*`, `pg-az-backup/`, `update-sidecar/`, `acme/`, `deployment/`). Used in Phase 4's heuristics.

If §1 Background or §3 Non-goals doesn't clear the bar, **stop and ask** — don't paper over. Plans built on hand-waved scoping land vague phases.

---

## Phase 4 — First-pass phasing using split heuristics

Don't show the user a naive 1:1 mapping from brainstorm to phases — that's how the cautionary [service-addons-plan.md](docs/planning/not-shipped/service-addons-plan.md) ended up with a Phase 1 that bundled framework + connected service + authkey minter + first addon + 5 UI changes + docs. Apply the heuristics below first, then run the rubric in Phase 5.

### Recognised anti-patterns and their splits

Watch for these in the input. When the brainstorm is shaped like one of these, the first-pass split should already account for the anti-pattern.

| Anti-pattern (cue in the brainstorm) | Default split |
|---|---|
| **Framework + first user** ("introduce a registry, then build feature X on it") | (1) Land the framework with one trivial built-in consumer that proves it boots, no real feature. (2) Build the first real feature on the framework. The framework phase ships independently behind an empty registry. |
| **Polish / improvements / cleanup** as a phase label | One phase per discrete UI change. Roll multiple changes into one phase only if every change is `[no design]` and shippable in <1 day total. |
| **New connected service + first addon using it** | (1) Add connected service type — CRUD + connectivity prober + admin form, no consumers. (2) First addon that uses it. Splits the credential / OAuth / probing surface from the consumer surface. |
| **Schema + API + UI in one phase** | Split by layer: schema-and-API in N (behind a feature flag if needed), UI in N+1. The UI phase has a real Done-when ("operator can see/do X") that the bundled phase can't have. |
| **Pool support added to an existing feature** | Always its own phase, late in the rollout. Static services first, pool generalisation after. (Pattern from [service-addons-plan.md §6 Phase 4](docs/planning/not-shipped/service-addons-plan.md) — done correctly there.) |
| **Docs padded onto a feature phase** | Docs ride with the feature unless the feature has multiple operator-onboarding steps (OAuth client creation, Vault path setup, ACL bootstrap). Then docs are their own slim phase. |
| **"Foundation" phase with no concrete deliverable** | Reject — there's no such thing as a "foundation" phase. Either it lands a concrete artifact (a type, a registered service, a working endpoint) or it's not a phase. |
| **Cross-cutting concern (auth, observability, error handling) bolted onto every phase** | Surface as a §`<N>` shared-concept section *and* check whether one early phase should land the convention before any consumer phase. |
| **Design / mockup work split out as its own phase** | Don't write standalone `Phase N — Design: …` phases. `plan-to-linear` auto-creates a paired `Backlog` design ticket per phase from each `[design needed]` tag in that phase's UI changes block, and wires it up as a `blocked-by` edge on the phase ticket. Keep design items as `[design needed]` tags inline on the impl phase — the skill materialises them. |

### Optional / deferred phases

Mark phases as `### Phase N — <title> (optional, deferred)` when:

- The brainstorm explicitly punts something ("nice to have", "later")
- The phase depends on external work not in scope (a new external API, a planned org change)
- The phase is for v2 polish that doesn't block v1 outcomes

Optional phases still go through the rubric. They land in Linear `Backlog` instead of `Todo` (handled by `plan-to-linear`).

---

## Phase 5 — Run the rubric and surface failures

Render the proposed phasing as a checklist table for the user — phase × 7 checks. Use this exact shape (it parses cleanly when the user re-asks "show me the rubric"):

```
Phase   | Concrete | Testable | Isolated | One-concern | Reversibility | UI-extractable | Verify-in-prod
--------+----------+----------+----------+-------------+---------------+----------------+----------------
1       | ✓        | ✗        | ✗        | ✗           | ✓             | ✓              | ✓
2       | ✓        | ✓        | ✓        | ✓           | ✓             | ✓              | ✓
3       | ✗        | ✗        | ✓        | ✗           | ✗             | ✗              | ✗
...
```

For every ✗, emit a concrete reject sentence and a concrete split suggestion. Use these wordings — they're calibrated to be specific enough that the user can act without re-reading the plan:

### The 7 checks — pass conditions and reject text

**1. Concrete.** Pass: every deliverable is a noun-form artifact ("the foo service emits a bar event"; "an `addons` field on the schema"; "a Tailscale-typed connected-service row"). Reject: "Phase N's deliverables include verb-form work like '<quote>'. Restate as the artifact that exists after the phase ships, or the deliverable is too soft to track."

**2. Testable.** Pass: Done-when is one sentence with no "and" / no comma-list of separate criteria. Reject: "Phase N's Done-when is multi-clause: '<quote>'. Each comma-separated criterion is its own phase. Pick the one that's the actual outcome and split out the rest."

**3. Isolated.** Pass: the phase ships as one mergeable PR with no scaffolding for Phase N+1 leaking out. Reject: "Phase N's deliverables include scaffolding for Phase N+1 ('<quote>'). Either pull it forward (does Phase N actually need it for its own Done-when?) or push it back (let N+1 own it)."

**4. One-concern.** Pass: touches one component, OR one capability slice across components — not "schema + API + UI + docs". Reject: "Phase N touches <list of components / surfaces>. That's a [framework + first-user / multi-feature bundle / UI-polish catch-all] pattern. Suggest splitting along [layer / capability / component] axis."

**5. Reversibility-classifiable.** Pass: one of `safe` / `feature-flagged` / `forward-only` / `destructive` fits without weasel words ("mostly safe except…"). Reject: "Phase N's reversibility doesn't classify cleanly — its rollback story has '<quote of weasel clause>'. That's a sign it's doing two things; split the destructive part out."

**6. UI-extractable.** Pass: every user-visible change is a bullet tagged `[design needed]` or `[no design]`, or the literal word `none`. Never `TBD`. Reject: "Phase N's UI changes include 'TBD' or untagged items. Either tag each item explicitly (a clean [no design] is fine) or split out the UI-bearing slice as its own phase so the design ask is scoped." (Note: `[design needed]` tags become paired `Backlog` design tickets at seed time via `plan-to-linear` — don't pre-split design out as its own phase; just tag the items.)

**7. Verify-in-prod-statable.** Pass: a production signal that confirms the *outcome* (the Goal), not just that the artifacts exist. Or `n/a — internal only` and the phase actually is. Reject: "Phase N's Verify-in-prod restates Done-when ('<quote>'). Done-when is 'the code does the right thing in CI'; Verify-in-prod is 'the goal materialised in production'. They should be different signals — what counter / dashboard / log line / user-visible state confirms the *Goal* in prod?"

### How to surface

For each failing phase, write a short paragraph: "Phase N fails [check names]. <Reject text per check.> Suggest splitting into [proposed sub-phases with one-line scope each]."

Don't silently fix. The user must commit to the split (or waive a check with a one-line rationale you'll log in §1 Background) before you re-render. Iterate the table until every cell is ✓ or waived.

---

## Phase 6 — Iterate to convergence

Repeat: surface the table → user accepts splits / proposes alternatives / waives checks → re-render. Stop when every cell is ✓ or marked `~waived`.

When the user proposes their own split, run the rubric on the proposal before accepting — they may have introduced a new failure (e.g. splitting Phase 1 into 1a / 1b but 1b inherits a fragment of Phase 2's scope by accident). Surface and iterate.

When the user waives a check, log it as a one-line bullet in §1 Background's last paragraph: "*Rubric waivers: Phase N's `<check name>` waived — `<rationale the user gave>`.*" Future readers see exactly which checks weren't met and why.

If the user pushes back hard ("just write the plan, I know what I want"), confirm once: "I can write this plan as-is. The Phase N rubric failures will land in §1 Background as waivers so future readers know they were bypassed. Proceed?" If yes, set every failing check to `~waived` with rationale "user override at write time" and proceed to Phase 7.

---

## Phase 7 — Compute phase ordering

Default to **strictly sequential** — each phase from 2 onward `[blocks-by: N-1]`. Then ask once:

> "Default ordering is strict sequential. Do any phases fan out in parallel — i.e., can Phase B and Phase C both start as soon as Phase A is done? Examples: independent migrations of different subsystems, UI work that can land alongside backend work."

Apply the user's parallel edges as `[blocks-by: N, M]` brackets in §8. If the user says "no, sequential", keep the default and don't render brackets at all (per [PLANNING.md](docs/planning/PLANNING.md) — bracket-free §8 means strict sequential to `plan-to-linear`).

Optional/deferred phases keep their `[blocks-by: …]` edge from the predecessor phase — being in `Backlog` doesn't mean unblocked.

---

## Phase 8 — Write the plan doc

Write to `docs/planning/not-shipped/<slug>-plan.md`. Slug is kebab-case from the H1, ending in `-plan` (e.g. `service-addons-plan`, `nats-app-roles-plan`).

### Document shape

Match the structure from [PLANNING.md](docs/planning/PLANNING.md) and the populated reference [internal-nats-messaging-plan.md](docs/planning/not-shipped/internal-nats-messaging-plan.md). The exact section ordering:

```markdown
# <H1 — feature title>

**Status:** planned, not implemented. Phased rollout — each phase is a separate Linear issue.
**Builds on:** <optional, if the plan extends a prior shipped or in-flight feature — link the relevant docs/PRs>
**Excludes:** <optional, if there's a related plan whose scope is intentionally separate — link it>

---

## 1. Background

<3-6 sentences, standalone-readable. Last paragraph carries any rubric waivers as italicised bullets.>

## 2. Goals

1. <numbered outcome>
2. ...

## 3. Non-goals

- **<thing>.** <one-line why>
- ...

## <N>. <Shared concept section> (optional, only if ≥ 2 phases reference shared types/contracts)

<type definitions, naming conventions, contracts spanning phases>

## <N+1>. Phased rollout

<one-line preamble describing how phases relate>

### Phase 1 — <title>

**Goal:** <one sentence>

Deliverables:
- <noun-form artifact>
- ...

Reversibility: <classifier> — <one-line rationale>

UI changes:
- <user-visible change> [design needed]
- <user-visible change> [no design]
- (or `none`)

Done when: <one-sentence acceptance criterion>

Verify in prod: <production signal confirming the Goal> (or `n/a — internal only`)

<optional phase-specific subsections: Migration shape, Subjects, etc.>

### Phase 2 — <title>
...

## <N+2>. Risks & open questions

- <unresolved tradeoff or ambiguity captured during brainstorming>
- ...

## <N+3>. Linear tracking

<one-line pointer to where these issues will live>

- ALT-_TBD_ — Phase 1: <title>
- ALT-_TBD_ — Phase 2: <title>  [blocks-by: 1]
- ...
```

### Re-phase mode (Mode D) — preserve IDs and preview Linear impact

When the input was a seeded plan, §8 must reflect both the existing IDs and any new phases from splits. Before writing, surface this preview to the user:

```
Re-phasing detected. Existing Linear issues:
  ALT-NN — Phase 1: <old title>
  ALT-NN — Phase 2: <old title>
  ...

Proposed re-phasing:
  Phase 1: <new title> — keeps ALT-NN  (subset of old Phase 1 scope)
  Phase 2: <new title> — NEW (ALT-_TBD_)
  Phase 3: <new title> — NEW (ALT-_TBD_)
  Phase 4: <new title> — keeps ALT-NN  (was old Phase 2, unchanged)
  ...

Linear impact when you next run plan-to-linear update mode:
  - <count> new issues will be created
  - <count> existing issues will have their bodies refreshed against the new (narrower) scope
  - <count> orphan issues from phases that were merged or dropped (surfaced, not auto-deleted)
  - Phase numbering shifts; ALT-NN ↔ Phase-N alignment is no longer stable

Note: plan-to-linear currently rejects mixed §8 (placeholders + real IDs). Until that's
relaxed, you may need to either (a) hand-reconcile §8 to all real IDs or all placeholders,
or (b) update plan-to-linear to accept mixed §8 in update mode (placeholders = new phases).

Confirm to write the updated plan?
```

Heuristic for ID preservation: a re-shaped phase **inherits the original `ALT-NN`** if its new scope is a recognisable subset of the original (≥ half the original deliverables retained, same Goal direction). A re-shaped phase **gets `ALT-_TBD_`** if it's effectively new (split-off scope, new component, new capability). When in doubt, ask the user — don't guess on ID preservation. Old IDs that have no successor become orphans (already handled by `plan-to-linear` update mode — surfaced not deleted).

### Don't commit

Leave the file untracked / staged. The user reviews, then runs `plan-to-linear` (create mode for fresh plans, update mode for re-phased ones).

---

## Phase 9 — Final summary

Print a short report:

```
✓ Wrote <plan-doc-path>

Phases: <total>
  - Passed rubric first time: <count>
  - Re-split during iteration: <count>
  - Rubric waivers: <count> (logged in §1 Background)

<for re-phase mode:>
  - Existing ALT IDs preserved: <count>
  - New phases (ALT-_TBD_): <count>
  - Phases dropped (will become orphans in plan-to-linear update): <count>

Next step: read through the plan, then `plan-to-linear` (<create|update> mode based on §8 state).
```

If iteration produced zero re-splits (the brainstorm was already well-shaped), say so explicitly — that's a good signal the user can trust the rubric was real, not a rubber stamp.

---

## Hard rules

These are non-negotiable. The skill enforces them.

- **Plans are scoping documents, not implementations.** No file-by-file change lists, no "edit foo.ts to do X." Source-code touchpoints get derived at seed time by `plan-to-linear`'s Phase 3.5 explorer — never preempt that.
- **Don't dump the brainstorm verbatim into the plan template.** The whole point is the rubric-driven split. If the user pushes back ("just write it up"), confirm once and proceed, but every failing rubric cell is logged as a `~waived` bullet in §1 Background. Future readers must be able to see the rubric was bypassed and why.
- **§1 Background is standalone-readable in 3-6 sentences.** Too long → distil and ask. Too vague ("we should improve X") → flag back; the project description body needs to read as self-contained motivation.
- **§3 Non-goals has at least one item with a one-line *why*.** If the user volunteered none, prompt: "what did you consider and reject during brainstorming?" An empty Non-goals section is almost always a planning bug.
- **Shared concepts surface up front, not in phases.** When ≥ 2 phases reference the same type, contract, naming convention, or subject, write a `## <N>. <Concept>` section between Non-goals and Phased rollout. Don't let the same decision get re-baked into each phase implicitly — that's how phases drift.
- **Never invent.** If the user hasn't said how to verify a phase in prod, ask. If a non-goal is missing rationale, ask. If a contract is referenced but not defined, ask. Don't paper over with reasonable-sounding defaults — the plan becomes a lie about what was actually decided.
- **Don't commit.** Leave the plan-doc edit untracked or staged. The user owns the commit and decides whether to bundle it with related work.
- **The 7 rubric checks are the rubric, not suggestions.** Every cell is ✓ or `~waived` (with rationale). No silent fixes, no "I'll just clean this up while writing."
- **Re-phase mode never deletes Linear issues.** Phases dropped from the plan become orphans in `plan-to-linear` update mode — surfaced for manual handling, never auto-deleted. Old issues may have retro comments, deferred-then-cancelled context, or scheduled-for-later state that this skill can't safely reason about.
- **The skill writes plans, not retrospectives.** Don't comment on the brainstorm's quality, don't critique past decisions, don't add unsolicited "consider also…" bullets. The plan reflects what the user wants to ship; refinement of the *idea* is the brainstorming step that came before this skill.
