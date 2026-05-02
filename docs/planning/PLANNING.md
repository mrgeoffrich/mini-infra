# Planning document format

This directory holds **phased planning documents** that feed two skills:

- **`plan-to-linear`** reads a plan and creates a Linear project + one issue per phase, copying the per-phase Goal / Deliverables / Done when verbatim into each ticket.
- **`execute-next-task`** picks up the resulting issues phase by phase and runs them end-to-end (worktree, code, tests, smoke, PR, Linear state transitions).

The format below is **mechanically required** — `plan-to-linear` stops and reports if a doc doesn't match. It's also the convention humans rely on when reading these docs, so write for both audiences.

Reference, fully populated example: [not-shipped/internal-nats-messaging-plan.md](not-shipped/internal-nats-messaging-plan.md).

---

## File layout

| Stage | Path |
|---|---|
| Drafting / awaiting Linear seed | `docs/planning/not-shipped/<slug>.md` |
| Linear seeded, work in flight or complete | same path; the §8 list now has real `ALT-NN` IDs |
| Project shipped | move to `docs/planning/shipped/<slug>.md` |

Slug is kebab-case, ends in `-plan` for full project plans (e.g. `job-pool-service-type-plan.md`). Single-phase write-ups can drop the `-plan` suffix (e.g. `nats-app-roles-followups.md`) but won't be processed by `plan-to-linear`.

---

## Required structure

A processable plan has these sections in order. Section *numbers* in existing docs vary; what matters is that each required block is present and parseable.

### H1 — project title

```markdown
# <Feature title> — <subtitle or framing>
```

The H1 (stripped of trailing punctuation) becomes the Linear **project name**. Don't change it after seeding — the project lookup is by name.

### §1 Background

```markdown
## 1. Background

<one paragraph stating why this work exists, written so a reader who's never seen the feature understands the motivation>

<optional further paragraphs>
```

The **first paragraph of §1** is copied verbatim into the Linear project description. Make it self-contained — no "see above" references — and fit the gist of the project in 3-6 sentences.

### §2 Goals

```markdown
## 2. Goals

1. <numbered point — what success looks like, stated as an outcome>
2. ...
```

3-6 numbered points. Each point states an *outcome*, not a deliverable. Goals scope what the **project** is for; per-phase Done-when scopes what each **phase** ships. The two should reinforce each other — if a Goal isn't testable from at least one phase's Done-when or Verify-in-prod line, either the Goal is too vague or the plan is missing a phase.

### §3 Non-goals

```markdown
## 3. Non-goals

- **<thing>.** <one-line rationale for why it's out of scope>
- ...
```

The single most important section for preventing scope creep. Anything you've considered and decided not to do belongs here, with a one-line *why*. Without the rationale, future readers (and the executor) will re-litigate the decision. If you find yourself writing more than ~6 non-goals, the project is probably too broad — consider splitting.

### Phased rollout section (typically §6)

```markdown
## <N>. Phased rollout

<optional preamble: how phases relate, dependency hints — see "Phase ordering" below>

### Phase 1 — <title>

**Goal:** <one sentence>

Deliverables:
- <bullet>
- <bullet>

Reversibility: <safe | feature-flagged | forward-only | destructive> — <one-line rationale>

UI changes:
- <user-visible change — page/screen + what changes + what the user sees> [design needed]
- <user-visible change> [no design]
- (or the literal word `none` if this phase ships nothing user-visible)

Schema changes:
- <table>: <column> <type> <nullable?> — <why>
- <table>: new index on (<columns>) — <why>
- Prisma migration: `pnpm --filter mini-infra-server exec prisma migrate dev --name <slug>`
- (or the literal word `none` if this phase touches no DB schema)

Done when: <one sentence acceptance criterion>

Verify in prod: <production signal that confirms the Goal materialised> (or `n/a — internal only`)

### Phase 2 — <title>
…
```

Seven required parts per phase:

| Part | Shape | Notes |
|---|---|---|
| **Goal** | one-sentence headline | Becomes the issue's Goal section. State the *outcome*, not the steps. |
| **Deliverables** | bullet list | Concrete artifacts the phase ships. May nest. May include inline links to files/PRs. **Not** a file-by-file change plan — see "What not to write" below. |
| **Reversibility** | one of `safe` / `feature-flagged` / `forward-only` / `destructive`, plus one-line rationale | What happens if this phase ships and breaks. `safe` = revert the PR cleanly. `feature-flagged` = flip a flag, no rollback PR needed. `forward-only` = a forward-fix is required (data migration, contract change, irreversible state). `destructive` = data loss or external state change that cannot be undone. The executor uses this to decide whether to gate the rollout, add a flag, or require ops sign-off before merging. |
| **UI changes** | bullet list, or the literal word `none` | Every user-visible change this phase ships. Write in user terms ("operators see a new column on the certificates page"), not implementation terms ("add `<CertStatusBadge>` to the cert table"). For each item, tag `[design needed]` if it needs a designer to mock first, or `[no design]` if it can ship as-is (copy tweaks, new technical fields with obvious layouts). Saying `none` is fine — but say it; don't omit the line. **Why this exists:** UI changes are extracted from plans before implementation so the designer can be looped in early. A missing line is indistinguishable from "no UI changes" and leads to mid-PR surprises and rework. Grep `[design needed]` across `docs/planning/` for an instant designer-todo list. |
| **Schema changes** | bullet list, or the literal word `none` | Every DB schema change this phase ships — new tables, new columns (with type + nullability), new indexes, removed/renamed columns. End the list with the Prisma migration command the executor will run (`pnpm --filter mini-infra-server exec prisma migrate dev --name <slug>`) so the migration name lands in the plan rather than being invented at execution time. Write the *what*, not the *why for every column* — the why belongs in Goal / Deliverables. Saying `none` is fine — but say it; don't omit the line. **Why this exists:** schema migrations are forward-only in production and high-blast-radius — surfacing them at plan time makes the phase ordering obvious (schema lands ahead of API + UI), gives reviewers a single place to spot risky DDL, and lets `execute-next-task` know up front which phases will touch `prisma/schema.prisma`. **Plan-level cue:** when a plan has multiple phases all listing schema changes, that's often a signal the schema work should be pulled into its own Phase 1 — see the "Schema migration sharing a phase with feature work" anti-pattern in `brainstorm-to-plan`. |
| **Done when** | one sentence | The acceptance criterion. Should be testable in CI or the dev env. |
| **Verify in prod** | one bullet, or `n/a — internal only` | The production signal that confirms the *outcome* (Goal), not just the *deliverables*. A counter that should appear, an error rate that should drop, a dashboard panel to watch, a graph that should change shape, an alert to wire up. Different from Done-when: Done-when is "the code does the right thing in CI"; Verify-in-prod is "we can tell the goal materialised after rollout." Use `n/a — internal only` for refactors and other phases with no user-visible production signal — but write it explicitly so reviewers know you considered it. |

Optional per-phase subsections (used when they help):

- **Subjects** — for NATS-touching phases, list the subject names + req/reply vs event vs heartbeat shape.
- **Migration shape** — when a phase replaces an existing transport/component, a short numbered list of the swap steps.
- **Deferred to follow-ups** — bullets of work deliberately punted, with one-line rationale each. Prevents scope creep during execution.

Heading convention: `### Phase N — <title>` with an em-dash (`—`), not a hyphen. The em-dash is what `plan-to-linear` parses out.

### §8 Linear tracking (placeholder list)

```markdown
## 8. Linear tracking

<one-line pointer to where these issues will live>

- ALT-_TBD_ — Phase 1: <title>
- ALT-_TBD_ — Phase 2: <title>  [blocks-by: 1]
- ALT-_TBD_ — Phase 3: <title>  [blocks-by: 1, 2]
```

Required:

- One line per phase, in order, count must equal the number of `### Phase N` headings.
- Placeholder is exactly `ALT-_TBD_` (with underscores). `plan-to-linear` rewrites these to real Linear-linked references after seeding.
- Phase title after the colon should match the heading title (minus the em-dash).
- **`[blocks-by: N, M]` brackets** encode the dependency graph (see "Phase ordering" below). Omit the brackets entirely on every line to fall back to strict-sequential default. Brackets are preserved through seeding so the graph stays readable from the doc.

After seeding, this section is rewritten in place to:

```markdown
Tracked under the [<Project Name>](<linear project URL>) project on the Altitude Devops team.

- [ALT-NN](https://linear.app/altitude-devops/issue/ALT-NN) — Phase 1: <title>
- [ALT-NN](https://linear.app/altitude-devops/issue/ALT-NN) — Phase 2: <title>  [blocks-by: 1]
```

`[blocks-by: …]` brackets are preserved verbatim through seeding so the dependency graph remains readable in the doc without opening Linear. Don't pre-write the linked shape — leave the placeholders, let `plan-to-linear` write them.

---

## Optional structural sections

These don't affect Linear seeding but are common and worth knowing.

| Section | Purpose |
|---|---|
| `**Status:** …`, `**Builds on:** …`, `**Excludes:** …` lines under the H1 | Quick orientation for readers. The "Builds on" line is especially useful — link prior PRs or shipped plans. |
| `## <N>. <Architecture / concept section>` | Type definitions, subject naming conventions, or other shared concepts referenced across multiple phases. Lives between Non-goals and Phased rollout. Worth writing whenever ≥2 phases share a contract or convention — without it the same decision gets baked into each phase implicitly and drifts. |
| `## 7. Risks & open questions` | Bullets that survived planning unresolved. Honest ambiguity > false confidence. |

---

## Phase ordering

`plan-to-linear` builds Linear `blocked-by` relationships from the §8 list. Two ways to express ordering, in order of preference:

**Preferred — explicit `[blocks-by: N, M]` brackets in §8.** Mechanical, unambiguous, survives copy-paste and review:

```markdown
- ALT-_TBD_ — Phase 1: foundation
- ALT-_TBD_ — Phase 2: migration A   [blocks-by: 1]
- ALT-_TBD_ — Phase 3: migration B   [blocks-by: 1]
- ALT-_TBD_ — Phase 4: cleanup       [blocks-by: 2, 3]
```

Phases 2 and 3 fan out from Phase 1 in parallel; Phase 4 waits for both. Omit the brackets entirely on every line to fall back to **strict sequential** (each phase blocks-by the previous).

**Fallback — prose hints.** Still parsed for back-compat with older plans:

- "Phases land in order" → strictly sequential.
- "Phase 1 blocks all later phases" → fan-out from Phase 1.
- "Phase N also blocks on Phase M" → extra `blocked-by` edge.

Brackets win if both forms are present. Don't mix them in the same plan.

### Optional / deferred phases

Mark optional phases in the **heading** itself:

```markdown
### Phase 5 — `update-sidecar` progress (optional)
### Phase 6 — App-level metrics (optional, deferred)
```

The keywords `optional` or `deferred` (case-insensitive) put the issue into Linear `Backlog` instead of `Todo`. They still get `blocked-by` edges from previous phases — backlog just means "not active yet."

---

## What not to write

Plan docs are **scoping** documents, not implementation plans. The executor (`execute-next-task`) does its own implementation planning against the current code state at execution time.

- ❌ **File-by-file change lists.** "Edit `server/src/foo.ts:42` to add field X" is execution detail. Just say "Add field X on the foo service" in Deliverables.
- ❌ **Pre-baked code patches.** Concrete TypeScript snippets are fine when they're *defining a contract* (a new type, a subject namespace, a config schema). They're not fine as "here's how to write the implementation."
- ❌ **"Read X, then Y, then Z" task lists.** That's the executor's job.
- ❌ **Status updates in-place.** Don't edit the plan to say "Phase 2 done." That state lives in Linear / git, not in the plan doc.
- ❌ **Stale TBD scaffolding after seeding.** Once `plan-to-linear` rewrites §8, the doc is the seeded contract — don't reintroduce `ALT-_TBD_` placeholders by hand.

What's good to write:

- ✅ **Why the work exists** (Background).
- ✅ **What's deliberately not covered** (Non-goals).
- ✅ **The shared concepts** the phases reference (type shapes, naming conventions, contracts).
- ✅ **Per-phase deliverables in noun form** ("the foo service gains a bar field", not "edit foo.ts").
- ✅ **Risks the executor can't discover from the code alone** (storage budgets, behavior changes operators will notice, ordering subtleties).

---

## Workflow

1. Author the plan in `docs/planning/not-shipped/<slug>.md` with `ALT-_TBD_` placeholders in §8.
2. **If any phase has `[design needed]` UI changes**, brief the designer with those phases extracted before seeding to Linear. Either delay seeding the design-blocked phases until designs land, or seed them as `(deferred)` so they go into Linear `Backlog` rather than `Todo`. Grep across all in-flight plans for outstanding designer work with `grep -r "\[design needed\]" docs/planning/`.
3. Run `plan-to-linear` (or ask Claude to). It creates the Linear project, files one issue per phase, sets blocked-by edges, and rewrites §8 with the real IDs. The plan-doc edit is staged but not committed — review the diff before committing.
4. Use `execute-next-task` to pick up phases one at a time. Each phase ships as its own PR with `Closes ALT-NN`.
5. When the project is fully shipped, move the plan to `docs/planning/shipped/`.

---

## Quick checklist before running `plan-to-linear`

- [ ] H1 present, single-line, no trailing punctuation.
- [ ] §1 Background first paragraph reads standalone in 3-6 sentences.
- [ ] §2 Goals and §3 Non-goals present.
- [ ] Every phase has a `### Phase N — <title>` heading with an em-dash.
- [ ] Every phase has all six required parts: Goal, Deliverables, Reversibility, UI changes, Done when, Verify in prod.
- [ ] UI changes is either a bullet list (each item tagged `[design needed]` or `[no design]`) or the literal word `none`. Don't omit the line.
- [ ] Verify in prod is a production signal or the literal `n/a — internal only`.
- [ ] §8 has exactly one `ALT-_TBD_ — Phase N: <title>[ [blocks-by: …]]` line per phase.
- [ ] Optional/deferred phases say so in the heading.
- [ ] Phase ordering uses `[blocks-by: …]` brackets, prose hints, or strict-sequential default — pick one, don't mix.
- [ ] No pre-baked implementation steps in Deliverables.
