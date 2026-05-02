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

### Phased rollout section (typically §6)

```markdown
## <N>. Phased rollout

<optional preamble: how phases relate, dependency hints — see "Phase ordering" below>

### Phase 1 — <title>

**Goal:** <one sentence>

Deliverables:
- <bullet>
- <bullet>

Done when: <one sentence acceptance criterion>

### Phase 2 — <title>
…
```

Three required parts per phase:

| Part | Shape | Notes |
|---|---|---|
| **Goal** | one-sentence headline | Becomes the issue's Goal section. State the *outcome*, not the steps. |
| **Deliverables** | bullet list | Concrete artifacts the phase ships. May nest. May include inline links to files/PRs. **Not** a file-by-file change plan — see "What not to write" below. |
| **Done when** | one sentence | The acceptance criterion. Should be testable. |

Optional per-phase subsections (used when they help):

- **Subjects** — for NATS-touching phases, list the subject names + req/reply vs event vs heartbeat shape.
- **Migration shape** — when a phase replaces an existing transport/component, a short numbered list of the swap steps.
- **Deferred to follow-ups** — bullets of work deliberately punted, with one-line rationale each. Prevents scope creep during execution.

Heading convention: `### Phase N — <title>` with an em-dash (`—`), not a hyphen. The em-dash is what `plan-to-linear` parses out.

### §8 Linear tracking (placeholder list)

```markdown
## 8. Linear tracking

<one-line pointer to where these issues will live, plus any blocking-relationship hints>

- ALT-_TBD_ — Phase 1: <title>
- ALT-_TBD_ — Phase 2: <title>
- ALT-_TBD_ — Phase 3: <title>
```

Required:

- One line per phase, in order, count must equal the number of `### Phase N` headings.
- Placeholder is exactly `ALT-_TBD_` (with underscores). `plan-to-linear` rewrites these to real Linear-linked references after seeding.
- Phase title after the colon should match the heading title (minus the em-dash).

After seeding, this section is rewritten in place to:

```markdown
Tracked under the [<Project Name>](<linear project URL>) project on the Altitude Devops team. Phase 1 blocks all later phases.

- [ALT-NN](https://linear.app/altitude-devops/issue/ALT-NN) — Phase 1: <title>
- [ALT-NN](https://linear.app/altitude-devops/issue/ALT-NN) — Phase 2: <title>
```

Don't pre-write that shape — leave the placeholders, let `plan-to-linear` write them.

---

## Optional structural sections

These don't affect Linear seeding but are common and worth knowing.

| Section | Purpose |
|---|---|
| `**Status:** …`, `**Builds on:** …`, `**Excludes:** …` lines under the H1 | Quick orientation for readers. The "Builds on" line is especially useful — link prior PRs or shipped plans. |
| `## 2. Goals` | What success looks like. 3-6 numbered points. |
| `## 3. Non-goals` | Things the plan deliberately doesn't cover, with one-line rationale each. The most important section for preventing scope creep. |
| `## <N>. <Architecture / concept section>` | Type definitions, subject naming conventions, or other shared concepts referenced across multiple phases. Lives between Goals and Phased rollout. |
| `## 7. Risks & open questions` | Bullets that survived planning unresolved. Honest ambiguity > false confidence. |

---

## Phase ordering

`plan-to-linear` builds Linear `blocked-by` relationships from prose hints in the plan doc. Default is **strictly sequential** (each phase blocks the next) if no hints exist.

Patterns that get parsed:

- "Phases land in order" → strictly sequential.
- "Phase 1 blocks all later phases" → fan-out from Phase 1.
- "Phase N also blocks on Phase M" → extra `blocked-by` edge.

Put one explicit ordering sentence in the §6 preamble or §8 intro line. Don't make the skill guess.

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
2. Run `plan-to-linear` (or ask Claude to). It creates the Linear project, files one issue per phase, sets blocked-by edges, and rewrites §8 with the real IDs. The plan-doc edit is staged but not committed — review the diff before committing.
3. Use `execute-next-task` to pick up phases one at a time. Each phase ships as its own PR with `Closes ALT-NN`.
4. When the project is fully shipped, move the plan to `docs/planning/shipped/`.

---

## Quick checklist before running `plan-to-linear`

- [ ] H1 present, single-line, no trailing punctuation.
- [ ] §1 Background first paragraph reads standalone.
- [ ] Every phase has a `### Phase N — <title>` heading with an em-dash.
- [ ] Every phase has Goal, Deliverables, Done when.
- [ ] §8 has exactly one `ALT-_TBD_ — Phase N: <title>` line per phase.
- [ ] Optional/deferred phases say so in the heading.
- [ ] Phase ordering is stated in prose somewhere (or you accept strict sequencing).
- [ ] No pre-baked implementation steps in Deliverables.
