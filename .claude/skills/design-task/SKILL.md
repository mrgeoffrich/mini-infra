---
name: design-task
description: Design-exploration agent for an `mk` ticket. Accepts an **optional issue ID** as an argument (e.g. `/design-task MINI-38`, or a bare `38` which `mk` resolves against the current repo's prefix) — when supplied, the skill jumps straight to that issue and skips the picking flow; when omitted, it picks the next unblocked `todo` issue in the current repo via `mk issue list --state todo -o json`, the same picking flow as `execute-next-task`. Reads the ticket body (Goal / Deliverables / Done when) and any plan-doc context if the parent feature has a `Plan:` line. Instead of consuming per-component CLAUDE.md / ARCHITECTURE.md pointers like `execute-next-task` does, this skill **researches design patterns** — architectural / structural / behavioural patterns relevant to the task, plus existing patterns already used in the Mini Infra codebase that could be reused. Generates **two distinct design options**, each with pros/cons, key abstractions, file/component sketch, a rough implementation outline, and — for UI tickets — a wireframe written to a sibling SVG file (`<issue-id>-<slug>-option-<a|b>.svg` next to the markdown, referenced via `![](…)`) plus a "UI components to use" mapping that names existing `client/src/components/ui/*` primitives and feature components to wire up, written to `docs/designs/<issue-id>-<slug>.md` (single file with both options side-by-side), commits to a recommendation, **commits + pushes + opens a PR** for the design artefacts (so reviewers have a real review surface), posts a "design ready" comment on the impl ticket pointing at the PR (so a future `execute-next-task` run finds it via `mk comment list`), and **moves the design ticket to `in_review`** — the design doc + recommendation are the deliverable, the PR is the review surface, and merging the PR (with `Closes MINI-NN` in the commit) is the human's signal that the design is locked in. Delegates worktree creation to the `setup-worktree` skill (with `--no-env`, since design is markdown-only and no dev env is needed). The worktree is torn down later via `finish-worktree` once the PR has merged. Use this skill whenever the user says "design MINI-NN", "design the next task", "explore design options for MINI-NN", "give me two designs for MINI-NN", "what are the design options for MINI-NN", "design-task", "come up with designs for the next ticket", or any equivalent request to brainstorm two alternative designs for an `mk`-tracked task before execution begins. Do NOT trigger when the user wants to actually execute the work (use `execute-next-task` for that), or for design questions on tasks that aren't tracked in `mk`, or for ad-hoc architecture discussions without an `mk` ticket attached.
---

# Design Task

You're a **design-exploration agent**. The mk ticket describes *what* needs to happen (Goal, Deliverables, Done when). Your job is to propose *how* — by surveying relevant design patterns, finding what's already in the Mini Infra codebase that fits, writing up **two distinct design options**, and **committing to a recommendation**.

This skill is the planning step that sits **between** ticket creation (`task-to-mk` / `plan-to-mk`) and execution (`execute-next-task`). It produces a design doc, **commits + pushes the worktree branch and opens a PR**, posts mk comments pointing at the PR, and moves the design ticket to **`in_review`**. The recommendation in the doc is the call — there's no "user picks an option" step. If the user disagrees, they can edit the PR and re-comment; the default flow assumes the recommendation stands. **The skill creates a worktree** (via `setup-worktree --no-env`) so the design doc lives on its own branch in its own checkout, then ships it as a PR. The user reviews and merges the PR on their own cadence — `mk` does not auto-flip state on PR merge, but the design ticket is already in `in_review` from Phase 8; the human reviewer transitions it to `done` (or runs `mk issue state MINI-NN done --user Geoff`) when the PR lands. After the PR has merged, the user runs `/finish-worktree mini-NN` to free the slot.

The Done-when in the ticket body (often "Figma frames signed off") is informational. The skill considers the design doc + recommendation to be the actual deliverable, and the design ticket completes when the human flips it to `done` after merge. If the team starts wanting Figma frames again, that's a future change to this skill.

## What "two distinct designs" means

The two options must be **genuinely different approaches**, not variations of the same thing. If both designs end up with the same key abstractions and the same file layout, you've produced one design twice — go back and find a real alternative.

Useful axes to differ along:

- **Coupling** — one shared module vs. one-per-consumer; one service vs. composed pipeline of small services.
- **Data placement** — DB-backed state vs. in-memory + event-sourced; row-per-thing vs. JSON blob; new table vs. extend existing table.
- **Synchrony** — sync request/response vs. fire-and-forget over the bus; polling vs. push.
- **Pattern family** — strategy vs. inheritance; visitor vs. switch; adapter wrapping a third-party SDK vs. bespoke client.
- **Reuse vs. greenfield** — extend an existing service in the codebase vs. build a parallel one with cleaner separation.
- **Blast radius** — minimal-scope change in one file vs. broader refactor that pays down debt while solving the problem.

The two options should be picked because they meaningfully differ on at least one of those axes. Call out the axis explicitly in each design's opening so the user sees what they're choosing between.

There is no team concept — `mk` auto-scopes by the current repo (the `cwd`'s git toplevel). The repo's prefix in this checkout is **MINI**.

---

## Phase 1 — Verify `mk` is available and confirm the repo

The `mk` skill is auto-discovered as a project skill. Before doing anything else, confirm the binary is available and that `cwd` resolves to the right repo:

```bash
mk status -o json
```

You should see a JSON blob with the repo's prefix (`MINI`) and per-state issue counts. If `mk` errors with "not inside a git repository", `cd` to the repo root and retry. If `mk --help` itself fails, stop and tell the user — don't fall back to anything else.

**Critical agent-mode rules** (these apply to every `mk` call you make in this run):

- **Always pass `--user Claude` on every mutating command.**
- **Always pass `--as Claude` on `mk comment add`.**
- **Always pass `-o json` when parsing output.**
- **Always pass long text via `--description-file` / `--body-file` / `--body -` (stdin).**

Note: this skill calls `mk issue state` exactly once, near the end (Phase 8), to move the issue to **`in_review`**. No other state transitions. The terminal `done` transition is left to the human reviewer flipping it after the PR merges (the `Closes MINI-NN` line in the commit is for the audit trail; `mk` does not parse it).

The phase order is deliberate: write the doc (Phase 5) → commit + push + PR (Phase 6) → mk comments linking to the PR (Phase 7) → move to `in_review` (Phase 8). The mk comments need the PR URL, so the PR must exist before they're posted; the `in_review` transition happens last so the comments post against the previous (`todo`) state.

---

## Phase 2 — Pick the issue (auto-pick or explicit-ID)

Two entry modes, identical to `execute-next-task`'s Phase 2:

### 2.0 Branch on the argument

Look at the arguments the user passed. If they contain an mk issue identifier matching `MINI-\d+` (case-insensitive, may appear with surrounding text — `MINI-38`, `mini-38`, `design MINI-38`) or a bare integer (`38`), treat that as the explicit pick and skip the listing logic. Otherwise fall through to the auto-pick path.

#### Explicit-ID path

1. Fetch the issue with `mk issue show <KEY> -o json` (a bare number works — `mk` resolves it against the current repo's prefix). If it doesn't exist, the command exits non-zero — stop and tell the user.
2. **Soft validations.** Warnings, not stops:
   - If the issue is **not in `todo` state** (e.g. `backlog`, `in_progress`, `done`, `in_review`), surface that and ask "still proceed?". A user might want to redesign an in-progress ticket, but they should consciously confirm.
   - If the issue has **incomplete `blocks` relations pointing in** (i.e. another open issue blocks this one), list them and ask "still proceed?". Designs for blocked tickets are sometimes worth doing ahead of time, but the user should know. The JSON from `mk issue show` exposes both directions of every relation — look for any `blocks`-typed edge whose other side is in a non-terminal state (`backlog`, `todo`, `in_progress`, `in_review`).
3. Once confirmation lands (or the soft validations passed cleanly), proceed to Phase 3.

State the pick the same way as the auto-pick path: id, title, feature slug.

#### Auto-pick path

Same rule as `execute-next-task`: state = `todo`, no unfinished `blocks` edge pointing in. No priority sort, no cycle filter.

1. **List Todos** in the current repo with `mk issue list --state todo -o json`.
2. **For each candidate, check blockers** via `mk issue show <KEY> -o json` and inspect the relations array. A candidate survives if every incoming `blocks` edge originates from an issue in `done`, `cancelled`, or `duplicate` state.
3. **Decide:**
   - **0 unblocked** → tell the user "Nothing to design — every `todo` is blocked or no `todo`s exist." Stop.
   - **1 unblocked** → use it. State the pick: id, title, feature slug.
   - **>1 unblocked** → list them with `id | title | feature` and ask the user to pick. Don't infer.

### 2.1 No state transition at the start

Unlike `execute-next-task`, this skill does **not** transition the issue to `in_progress` when it picks the ticket. Design exploration is fast and one-shot — the only state change this skill makes is at the very end (Phase 8), when the doc is written, the PR is open, and the issue moves from `todo` to `in_review`. There's no "in_progress" leg because there's no useful window where the design ticket is half-done. The terminal `done` transition is left to the human reviewer flipping it after the PR merges.

If the user is re-running design on a ticket that is already `in_progress`, `in_review`, or `done` (per the soft validations above), respect their confirmation and proceed — the final Phase 8 transition still runs and re-asserts `in_review`.

---

## Phase 3 — Read the ticket and any plan-doc context

The ticket body is your input contract. Read it end to end.

1. **Fetch the issue body** with `mk issue show MINI-NN -o json` and pull out:
   - **Goal** — what outcome the ticket is trying to achieve. **Required.**
   - **Deliverables** — the concrete things that have to exist when the work is done. **Required.**
   - **Done when** — the testable acceptance criterion. **Required.**
   - **Source** — plan-doc anchor, if present (stored as text in the description, not a separate field).
   - **Relevant docs** — the per-component CLAUDE.md / ARCHITECTURE.md pointers attached at ticket-creation time. You may glance at these for context (which components are in scope) but **do not lean on them as the design authority** — your job is to think in patterns, not retrace the conventions doc.

   If **Goal / Deliverables / Done when** are missing, **stop and report**. The ticket isn't shaped right for design work.

2. **Try to fetch the parent feature's `Plan:` line.** If the issue's JSON exposes a `feature` slug, run `mk feature show <slug> -o json` and read its description. Same parser as `execute-next-task`:
   - `Plan: [docs/planning/.../<slug>.md](https://...)` — preferred combined form
   - `Plan: docs/planning/.../<slug>.md` — bare path fallback
   - `**Plan doc:** [docs/planning/.../<slug>.md](https://...)` — legacy fallback
   - **No `Plan:` line** is fine — many standalone tickets (e.g. under the `maintenance` feature) won't have one. Note "no plan doc" and skip step 3.

3. **If a plan doc was located**, read its matching `### Phase N` section if one exists. Treat it as supplemental context for *why* the work matters and how it fits into a larger arc. The ticket body still wins on what specifically has to ship — the plan doc helps you understand the surrounding intent so the designs you propose are coherent with the larger plan.

4. **Skim prior comments on the ticket** with `mk comment list MINI-NN -o json`. If a previous design pass already happened (you'll see a comment from this skill pointing at a `docs/designs/...md` file), surface it to the user immediately: "MINI-NN already has a design doc at `<path>` — open it instead, or generate a fresh pair?". Don't silently overwrite a previous pass.

5. **Do not** read every per-component CLAUDE.md / ARCHITECTURE.md pointer the ticket lists. They tell you what *conventions* a future executor must follow; they don't help you compare design patterns. The next phase is where you do the real research.

---

## Phase 4 — Research design patterns

This is the heart of the skill. The output is *not* "what does the codebase say" — it's "what shapes could the solution take, and which shapes work well here." Approach it as a designer who happens to know the codebase, not as a code-archaeologist.

### 4.1 Identify the pattern axes that matter for this ticket

Read the Goal + Deliverables and ask: what is this work fundamentally *doing*?

- **Adding a new resource type** → CRUD shape, persistence layer, validation pattern, audit/event trail.
- **Wiring a new integration** → adapter/facade, retry policy, credential management, connection lifecycle.
- **Long-running operation** → event emission, progress tracking (task tracker), idempotency, cancellation.
- **New UI surface** → page-vs-modal, query/state ownership (TanStack Query patterns), socket vs. polling, form library choice.
- **Refactor / extraction** → seam placement, dependency direction, test boundaries.
- **Cross-cutting concern (auth, logging, metrics, etc.)** → middleware vs. decorator vs. interceptor; opt-in vs. blanket application.

Pick **one or two axes** that dominate the design space for *this* ticket. You don't need to consider every pattern in the GoF book — just the ones that would actually change how the code reads.

### 4.2 Survey the patterns themselves

For each chosen axis, name two or three candidate patterns and what they cost / give you. Examples (illustrative, not exhaustive):

- **Persistence:** single-table polymorphism vs. table-per-type vs. JSONB column on a parent table — trade-offs in query ergonomics, migration cost, type safety.
- **Long-running ops:** synchronous request → bus message → consumer vs. job queue with poller vs. socket-driven progress events. Differences in failure modes, observability, and how the UI consumes them.
- **Adapter shape:** thin wrapper that exposes the SDK 1:1, vs. opinionated facade that picks the right SDK call based on intent — trade-off between escape hatches and clean call sites.
- **Cross-cutting:** Express middleware vs. service-level decorator vs. explicit call at each call site — trade-off between magic and discoverability.
- **State ownership (frontend):** server state in TanStack Query + invalidate-on-event vs. local component state synced via socket — different reactivity models.
- **Composition vs. inheritance:** small composable functions vs. base class + overrides — affects how easy it is to vary one axis without touching another.

You don't need to memorise the GoF taxonomy — name patterns by what they do, not by their textbook label. "Strategy pattern with a registry of handlers" reads better than "Strategy" alone.

### 4.3 If the ticket has a UI surface, research the frontend conventions and catalog reusable components

Skip this step entirely for backend-only tickets (no `client/` changes in the Deliverables). For tickets that touch the UI, do all four sweeps below — they're cheap individually and together they keep the design grounded in how the app actually looks and behaves.

**a) Read the frontend convention docs.** These are the authoritative references for what shapes the design should fit into:
- [`client/CLAUDE.md`](client/CLAUDE.md) — frontend conventions (state ownership, file layout, component patterns).
- [`client/ARCHITECTURE.md`](client/ARCHITECTURE.md) — high-level frontend architecture, routing, data flow.
- [`claude-guidance/ICONOGRAPHY.md`](claude-guidance/ICONOGRAPHY.md) — the icon set and naming conventions. Pick icons from here, don't invent. If a needed glyph isn't listed, flag that as a real decision the design owes (proposed addition + why).

If any of these files have moved or are missing on the current branch, surface it and proceed without — don't fabricate the contents.

**b) Survey the available controls.** Walk `client/src/components/ui/` (shadcn-derived primitives — `button`, `card`, `dialog`, `form`, `input`, `select`, `sheet`, `table`, `tabs`, `popover`, `tooltip`, etc.) and note what's actually there before designing. Don't propose a control the project doesn't have without flagging that it's a new addition.

**c) Survey how pages are laid out in general.** Open two or three existing pages similar in shape to what you're designing (a list page, a detail page, a wizard, a settings page — pick the closest analogues from `client/src/pages/`). Note the recurring patterns: page header + breadcrumb shape, where actions live (top-right toolbar vs. inline), how empty / loading / error states render, where dialogs vs. sheets vs. routes are used for sub-flows. Cite one or two pages by path so the design's wireframe rhymes with the rest of the app instead of inventing a new layout language.

**d) Identify the UI regions the design needs and match them to components.** For each region (page shell, list/table, form, dialog/sheet, status indicators, action buttons, empty/loading/error states):
- Pick a primitive from `client/src/components/ui/` if one fits.
- Pick a feature component from elsewhere in `client/src/components/` or `client/src/pages/` if one already solves a structurally similar problem (status pills, resource list pages, blue-green deploy timelines, task tracker rows, connected-service cards).
- Note the import path and the shape of the API for each component you'll lean on. The reader of the design doc should be able to skim "what's already in the box" without grepping themselves.
- If a region has **no good existing component**, flag it explicitly — it's a real piece of work the design owes the executor an honest estimate of.

This output feeds the per-Option **Wireframe** and **UI components to use** sections in the design doc (Phase 5.2). Different design options may pick different layouts and components — that's fine and often the point.

**e) Pre-decide states, failure modes, and live-input feasibility.** A wireframe shows the happy path. The states a real operator hits — empty, errored, mid-typing — are usually the highest-effort surface to retrofit and the lowest-attention surface during design. Pre-deciding them is one of the cheapest design moves available. For each interactive region, commit to:

- **Empty state.** What renders when there's no data — never-configured, freshly-cleared, no items yet? Placeholder text, hidden block, an explicit "no X yet" message? If a derived preview depends on input, what does it show when the input is empty (e.g. an ACL snippet built from zero tags — `tagOwners: {}` is broken HuJSON; pick: render a placeholder, hide the block, or disable copy).
- **Failure mode.** For any form that calls a server or third-party API, list the *specific* error categories the underlying call returns (auth, scope/permissions, quota, network/timeout, conflict). Pick one of: **(i)** surface each specifically with actionable wording; **(ii)** collapse to one generic error and tell the operator to check their setup; **(iii)** show a tier-1 generic error with a "show details" affordance exposing the raw vendor response. Pick one — don't leave the failure UX to the executor; it's the most likely real-world experience and the easiest to under-design.
- **Mid-typed / invalid input.** For any field driving a downstream preview or derivation (live-snippet, computed totals, generated config), pick: render-on-valid only / render with placeholder for invalid parts / debounce + render last-valid. Same call for what the submit button shows when the form is invalid (disabled vs. enabled-with-message).
- **Live input feasibility.** If a field's correctness can be checked client-side (regex, zod schema), inline feedback as they type is essentially free — propose it. If it requires a server call (DNS resolves, OAuth client exists, name uniqueness), weigh debounced lookup with a "checking…" indicator against the server-load and rate-limit cost; flag the trade-off explicitly so the executor isn't re-deriving it. For tickets where live feedback is genuinely infeasible (expensive call, no rate budget, async-only API), say so and commit to validate-on-submit.

**f) Task-sequence fidelity — order the regions to match the operator's real-world setup flow.** Schemas drive *backend-shaped* forms (fields ordered by entity); operators need *user-shaped* forms (fields ordered by the order they can fill them). For any design that wraps an external integration (DNS provider, OAuth client, third-party API, ACME), read the vendor's setup doc and walk through the operator's real setup steps before drafting the wireframe — the natural form ordering is often *inverted* from the schema's field order. Specifically: if step N produces an artefact (a tag, a snippet, an ID) that step N+1 depends on, step N's region must precede step N+1's region in the form, even if the schema declares the fields in the opposite order. Failure mode: an operator who fills the form top-to-bottom hits a wall at the bottom because the prerequisite for the last field was a copy-paste action they should have done in the middle.

For internal-only forms (no external dependencies), this step is a no-op — the schema order is fine. Flag explicitly when you decide it's a no-op so a reviewer sees you considered it.

**g) Pre-decide configured-state, latency, and reversibility.** Three more commitments the wireframe can't show and the executor will otherwise have to make under deadline pressure:

- **Configured state (re-edit-six-months-later).** Settings pages are visited *more often* in the re-edit case than in the first-time case. A first-time form (clear inputs, big primary button) is the wrong UX once the page is configured. Pick: **(i)** same form, pre-filled — simplest, fine for low-touch settings; **(ii)** read-only summary with per-section edit affordances — better when re-edit is rare and credentials/secrets should stay masked; **(iii)** banner-with-edit-toggle on top of the form — middle ground. Pick one and describe what the page looks like in three states: never-configured, just-saved, re-edit-after-N-months.
- **Latency window for slow server calls.** "Validate & Save" against a third-party API is 1–30s of wall-clock; ACME issuance is minutes; container apply is seconds-to-minutes. Spec the during-action UX: button label sequence ("Validate" → "Validating…" → "Saving…" → "Saved"), whether the form is locked while pending, what cancellation looks like (or whether it's not supported — say so), and what the operator sees if the call exceeds expected duration. "Show a spinner" is not enough — name the label sequence and the lock posture.
- **Reversibility classification.** For each editable field, classify the edit as **safe** (no side effects on existing resources), **breaks-existing-resources** (e.g. removing `tag:mini-infra-managed` orphans devices already minted with that tag; rotating credentials invalidates active sessions; renaming an environment may cascade to network names), or **requires-re-validation** (changing the OAuth scope means the next API call may fail until the operator re-validates; changing the cert challenge type may break renewal). For non-safe classes, surface the consequence at edit time — confirmation dialog, inline warning, "this will affect N existing X" indicator. Don't trust the operator to know which edits cascade; the design owes an explicit list.

This output feeds the per-Option **States & failure modes** section in the design doc (Phase 5.2). Two options may legitimately pick different state strategies (e.g. a wizard surfaces "step 1 incomplete" differently than a flat form; a summary-view design handles re-edit natively while a flat-form design doesn't) — call that out.

### 4.4 Look for prior art in the Mini Infra codebase

This is the part that anchors the designs to the real repo. For each pattern axis, find one or two existing places in the codebase that already solve a *similar* problem — not necessarily the same problem, but a structurally similar one. Use `Grep` / `Read` / `Glob` directly, or spawn an `Explore` subagent if the search is wide ("how does the codebase generally handle progress events for long-running ops?").

Capture, for each prior-art reference:

- **What it does** in one sentence.
- **The pattern it uses** in your own words.
- **Why it's a good fit (or not) for the current ticket** — be honest. If the existing pattern has known pain points (referenced in CLAUDE.md or visible in the code), call that out.

Cite the file path and (where helpful) a line range so the user can jump to it.

The point of this step is two-fold: **(a)** it grounds your proposed designs in shapes the codebase already supports — reducing "this would be lovely if we rewrote half the repo first" suggestions; **(b)** it surfaces opportunities to *deliberately diverge* from the existing pattern when there's a good reason. Both reuse and intentional divergence are legitimate design moves; the design doc should make the choice explicit either way.

### 4.5 Decide on the two options

From the patterns you surveyed and the prior art you found, pick **two options that differ along at least one axis from §What "two distinct designs" means**. Different points on the same axis (e.g. "small refactor" vs. "bigger refactor") often *aren't* meaningfully different — push for two ideas a thoughtful reviewer would actually weigh against each other.

If you can only think of one good design and the alternatives all feel weaker, that's important data — surface it to the user before writing the doc, and ask whether they want a single recommendation with a "rejected alternatives" appendix instead. Forcing a second option to fill the slot just produces noise.

---

## Phase 5 — Write the design doc

The output is a single markdown file at `docs/designs/<issue-id>-<slug>.md` containing both options side-by-side. A single file (not two) is deliberate — readers compare options most easily when they're scrollable in one view.

### 5.1 Filename

- **Issue ID** — lowercase, e.g. `mini-38`.
- **Slug** — short kebab-case derived from the ticket title, max ~6 words. `Phase 4: pg-az-backup progress + result events` → `pg-az-backup-progress-events`. Strip articles / punctuation.
- **Full path:** `docs/designs/mini-38-pg-az-backup-progress-events.md` (relative to the repo root).

If `docs/designs/` doesn't exist yet, create it. If a file with the same name already exists, the Phase 3 comment-skim should have caught it; if it slipped through, stop and ask whether to overwrite or append a `-v2` suffix.

### 5.2 Doc template

Use this structure verbatim. Omit a section only if it genuinely doesn't apply (e.g. the "Open questions" section can be empty if there are none — but say "None." rather than dropping the heading).

```markdown
# Design: <Ticket Title> (<MINI-NN>)

**Issue:** <MINI-NN> (run `mk issue show <MINI-NN>` for the full ticket)
**Goal (from ticket):** <one-line copy of the ticket's Goal>
**Done when (from ticket):** <one-line copy>

## Context

<2–4 paragraphs. What does the ticket actually need? What constraints come from the Deliverables / Done-when? What did Phase 4 prior-art research surface — i.e. what shapes does the codebase already support that bear on this work? What axis or two are the alternative designs varying along (be explicit so the reader knows what they're choosing between)?>

---

## Option A — <Short evocative name>

**Differs from Option B on:** <axis, e.g. "persistence shape", "synchrony", "blast radius">

### Idea in one paragraph
<The design in plain English. A reviewer should be able to picture the shape from this paragraph alone.>

### Wireframe
<**Only include this section if the option has a UI surface AND a wireframe earns its keep.** Drop it entirely for backend-only designs (no image, no placeholder).

**Earns-its-keep test.** A wireframe pays off when there's something prose can't easily say:
- **Multiple states in one frame** — wizard vs. summary, before vs. after, populated vs. empty side-by-side.
- **Novel spatial layout** — split panes, asymmetric grids, anything that doesn't reduce to "header + card + form".
- **Structurally differs from cited prior art** — if the design is *not* "looks like `cloudflare/page.tsx` with X added", a wireframe is worth drawing because the reader can't picture it from the prior-art reference alone.

If the layout is fully describable as "looks like `<existing-page>` with these additions in this order", **skip the SVG** and lean on the prior-art reference in `UI components to use` instead. Drawing a wireframe that the prose already narrates verbatim wastes both the writer's time and the reader's — the SVG ends up restating the section ordering, copy-button placement, and chip styling that the prose already covers, so the reader looks at it once and never returns. The prior-art page is a higher-fidelity reference than any wireframe you can draw in 60 SVG lines.

When in doubt: write the prose first, then ask whether the SVG would say something the prose doesn't. If the answer is no, drop the wireframe section for that option.

The wireframe lives in a **sibling SVG file**, not inline in the markdown — single source of truth, easy to open directly in a browser or editor. Reference it from the design doc via standard markdown image syntax:

```markdown
![Option A wireframe](<filename>-option-a.svg)
```

Filename convention: `<issue-id>-<slug>-option-<a|b>.svg`, sitting flat next to the `.md` in `docs/designs/`. For the MINI-38 example doc `mini-38-pg-az-backup-progress-events.md`, the sibling files would be `mini-38-pg-az-backup-progress-events-option-a.svg` and `…-option-b.svg`. GitHub, VS Code, and most markdown previewers render the image inline.

When **writing the SVG file**, aim for wireframe fidelity — labelled rectangles for regions, plain text for labels, simple arrows for flow if needed — not pixel perfection. Keep `viewBox` ≤ ~600px wide so it fits in a doc view without horizontal scroll. Skeleton:

```
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 360" width="600" font-family="system-ui, sans-serif" font-size="13">
  <rect x="0" y="0" width="600" height="360" fill="#fafafa" stroke="#ddd"/>
  <rect x="16" y="16" width="568" height="40" fill="#fff" stroke="#ccc"/>
  <text x="28" y="40">PageHeader: Backups · [+ New backup]</text>
  ...
</svg>
```

If the two options have *the same* layout and only differ behind the scenes, write one SVG file and reference it from both Options ("Layout identical to Option A — same wireframe."), rather than producing two identical files.>

### UI components to use
<**Only include this section if the option has a UI surface.** Drop it entirely otherwise.

Bullet list mapping each region from the wireframe to an existing component (or flagging where a new one is needed). Cite the import path so the executor can jump straight to it. Format:

- **<Region>:** `<ComponentName>` from [`<path>`](<path>) — <one-line note on the API shape or variant being used>
- **<Region>:** *(new)* `<ProposedName>` — <what it'll look like; why no existing component fits>

Group primitives (`client/src/components/ui/*`) and feature components separately if it aids reading. Don't list a component just because it might be tangentially relevant — only the ones the executor will actually wire up.>

### States, failure modes & lifecycle
<**Only include this section if the option has a UI surface.** Drop it entirely otherwise.

The wireframe shows the happy path. This section captures the commitments the wireframe *can't* show — the surfaces that hit operators most often in real-world use and get the least design attention. Don't punt to "the executor will handle it"; the executor has less context than the designer does.

**Per-region states** (for each interactive region in the wireframe):

- **<Region>:**
  - **Empty:** <what renders when there's no data / never-configured / freshly-cleared>
  - **Failure:** <which API errors get surfaced specifically vs. folded into a generic catch-all; for third-party calls, name the vendor error categories you're branching on>
  - **Live input:** <inline feedback as the user types — regex/zod check, debounced server call, derived preview update — or "none — validates on submit only" with a one-line reason if a live affordance was infeasible>

**Page-level lifecycle:**

- **Configured state.** Describe the page in three states: **never-configured** (first-time setup), **just-saved** (immediately after the operator's first successful Save), **re-edit-after-N-months** (the operator returns to change one thing). Pick the layout strategy for the configured state — same form pre-filled / read-only summary with per-section edit / banner-with-edit-toggle — and say which.
- **Latency window.** For each slow server call the page can trigger (validate, save, third-party round-trip), name the button-label sequence, whether the form locks while pending, and cancellation posture (or "no cancellation").
- **Reversibility.** Per editable field: **safe** / **breaks-existing-resources** / **requires-re-validation**. For non-safe edits, name the surface (confirmation dialog, inline warning, "will affect N existing X" indicator).

If the two options differ on any of these (a wizard surfaces step-1 incompleteness differently than a flat form; a summary-view design handles re-edit natively while a flat-form design glosses it; one option has a faster validate path), make that explicit — these are often more honest axes of difference than the surface form-shape.>

### Key abstractions
- **<Name>** — <what it represents, what its responsibilities are>
- **<Name>** — <…>
- <one bullet per significant new abstraction; reuse existing ones where possible and say so>

### File / component sketch
<Bullet list of new and changed files, each with a one-line note on what it holds. Group by directory. Mark new with `(new)` and changed with `(changed)`.>

```
server/src/services/<area>/<thing>.ts          (new)        — <what>
server/src/routes/<area>.ts                    (changed)    — <what>
client/src/hooks/<area>/use<Thing>.ts          (new)        — <what>
lib/types/<thing>.ts                           (changed)    — <what>
```

### Implementation outline
<Numbered list, 4–8 steps, each one a meaningful chunk of work — not "import x" granularity. The point is to give the executor (and the reader) a sense of the order of operations and where the risk lives.>

1. <step>
2. <step>
3. <…>

### Pros
- <bullet — concrete, not generic>
- <bullet>

### Cons
- <bullet>
- <bullet>

---

## Option B — <Short evocative name>

<Same structure as Option A. Repeat all sub-headings. Don't shortcut the second option just because the first one took longer — a reviewer who skips A and reads B should still get the full picture.>

---

## Recommendation

<**Required, not optional.** 1–2 paragraphs naming the picked option and why, framed as "for the ticket as currently scoped". The user does not pick afterwards — this is the call. If the two options are genuinely close, still pick one and name the one or two facts that would flip the call (so a future reader can spot if the world changed). Don't hedge — "no strong preference" is not a valid output of this skill.>

## Open questions

<Questions that would change the design if answered differently. One bullet each. "None" is a valid answer; don't manufacture questions to fill the section.>

## Out of scope

<Things you considered and consciously did not propose. Each with a one-line "why not" — usually scope-creep beyond the ticket, or a different ticket's territory. Helps the reader trust that the absence is deliberate, not an oversight.>
```

### 5.3 Writing notes

- **Voice:** match the rest of the project's docs — direct, concrete, no marketing language. The docs in `docs/architecture/` and `docs/planning/` are good tonal references.
- **Specificity:** name files, name functions, name constants. "Add a new service" is weaker than "Add `BackupProgressEmitter` in `server/src/services/backup/`". The reader should not have to guess where things land.
- **Length:** designs vary in size, but most should fit in 200–500 lines total. If you're heading past 700 lines, you're probably over-specifying — back off to "outline" granularity and trust the executor to fill in.
- **No code blocks longer than ~10 lines.** The doc is a design, not an implementation. If a code snippet is essential to the idea (e.g. a particularly weird type signature), keep it tight; otherwise describe in prose. (Wireframes don't trigger this rule — they live in sibling `.svg` files, referenced via `![]()`, not inline.)
- **No preamble.** Start at `## Context`. Don't write a meta paragraph about the skill, the template, the design process, or how this doc relates to a previous one — those facts decay fast and add nothing for the reader implementing the page.
- **Cite prior art with file paths the editor can click** — `[server/src/services/backup/backup-executor.ts](server/src/services/backup/backup-executor.ts)`. Include a **line range** when the relevant pattern is in a small section of a larger file (`cloudflare/page.tsx:283-329`) — the executor will copy from those exact lines, so naming them saves a grep.
- **Cite each prior-art reference once per option, in the section where it actually helps** (usually `UI components to use`, `Key abstractions`, or one specific step in `Implementation outline`). The same `cloudflare/page.tsx` link appearing in three sections is the single most common form of padding — don't.
- **Don't narrate the wireframe in prose.** The SVG already shows section ordering, copy-button placement, what's a chip vs. a code block. Prose should cover what the SVG can't: *why* the layout, what changes between options, interactions a static image can't convey. If a paragraph is restating what the reader can see in the SVG, delete it.
- **`Implementation outline` is action-density only.** Each step describes what to *do* — "Stand up `useTailscaleSettings` hooks", "Wire `buildAclSnippet` to `form.watch('tags')`". Steps that reduce to "read file X" or "build skeleton from page Y" are prior-art references in disguise; cite the file inline in `UI components to use` or `Key abstractions` instead and drop the step.

### 5.4 Where to write it

Delegate worktree creation to the **`setup-worktree`** skill with `--no-env` (design is markdown-only, no dev env required):

```
Skill(skill: "setup-worktree", args: "MINI-NN --no-env")
```

When the skill returns, you're `cd`ed into `.claude/worktrees/mini-NN` on branch `claude/mini-NN`, with `pnpm install` complete. Write the design doc inside that worktree at `docs/designs/<filename>.md`.

If `setup-worktree` stops because the worktree or branch already exists, that's almost always a previous design or execution session. Surface the collision and ask the user how to proceed (resume the existing worktree if the design was in flight, or run `/finish-worktree mini-NN` to clear the stale one). Don't auto-recover.

If `setup-worktree` stops for any other reason (dirty tree, non-default branch on the calling shell, `pnpm install` failure), surface the failure and stop — don't fall back to writing the doc on the current branch.

Leave the file unstaged at this point — Phase 6 is responsible for the commit + push + PR. Don't `git add` from inside Phase 5.

The branch is `claude/mini-NN` (matching execute-next-task's convention), not the legacy `design/...` shape — using one prefix for both flows simplifies cleanup via `/finish-worktree`.

---

## Phase 6 — Commit, push, open a PR

The design doc is the deliverable; reviewers want it on a PR they can comment on inline, not as a stash sitting in a worktree. Commit the design artefacts, push the branch, and open a PR via `gh pr create`. The PR URL feeds the mk comments in Phase 7, so this phase has to run before commenting.

### 6.1 Stage and commit

From the worktree (you're already `cd`ed in from Phase 5.4):

```bash
git add docs/designs/<filename>.md \
        docs/designs/<filename>-option-a.svg \
        docs/designs/<filename>-option-b.svg
```

Adjust the SVG paths to match what was actually written — drop them entirely if neither option had a wireframe; include only one if the options shared a wireframe; include extras if the design has more wireframes (e.g. a separate state-flow diagram). **Don't `git add .`** — keep the commit scoped to the design artefacts so a stale `pnpm-lock.yaml` change or anything else picked up by the worktree doesn't sneak in.

Commit using the `docs(designs):` prefix the repo's existing design-doc commits use (run `git log --oneline -- docs/designs/` if you want to confirm the style):

```bash
git commit -m "$(cat <<'EOF'
docs(designs): <short title> (<MINI-NN>)

<1–2 sentences: what was explored, what was picked, the why-in-one-line.
Pull from §Recommendation; don't restate the whole doc.>

Closes <MINI-NN>.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

The `Closes <MINI-NN>` line is the audit-trail reference back to the ticket — `mk` does not parse it (state changes are explicit), but human reviewers and the GitHub-side commit history rely on it. Keep it in.

### 6.2 Push the branch

```bash
git push -u origin claude/mini-NN
```

`-u` sets the upstream so subsequent pushes don't need it. If the push fails (network, permissions, branch-protection rule), surface the error and stop. Phase 7's mk comments depend on a pushed branch and a real PR URL; don't fall back to relative-path links unless the user explicitly asks you to (which Phase 7's URL-derivation already supports as a manual override).

### 6.3 Open the PR

```bash
gh pr create --title "docs(designs): <short title> (<MINI-NN>)" --body "$(cat <<'EOF'
## Summary
- <1-line: what's being designed>
- **Option A — <name>** — <one-line gist>
- **Option B — <name>** — <one-line gist>
- **Recommendation: Option <X>** — <one-sentence reason>

## Test plan
- [ ] Skim `docs/designs/<filename>.md` end-to-end.
- [ ] Open the sibling SVG wireframe(s) in a previewer.
- [ ] Confirm the recommendation lines up with the relevant plan-doc deliverables.
- [ ] <one bullet per Open question in the doc — these are choices the reviewer should resolve before the impl ticket starts>

Closes <MINI-NN>.

Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

`gh pr create` prints the PR URL on success — **capture it**, you'll need it in Phase 7. The PR title mirrors the commit title so the PR list reads cleanly.

Once the PR URL is back, attach it to the design ticket so `mk issue show MINI-NN` and `mk pr list MINI-NN` both link to it:

```bash
mk pr attach MINI-NN <PR_URL> --user Claude
```

If `gh pr create` fails (no `gh` auth, repo settings, branch-protection rules), surface the error and stop. Don't retry silently. The user can authenticate `gh` and re-run the skill, or open the PR manually and paste the URL into Phase 7's comments — but don't try to half-ship by posting mk comments without a PR.

### 6.4 Register the design doc + sibling SVGs with mk and link them

Why: downstream skills (`execute-next-task`, `address-review`, `review`) fetch the design doc as supplemental context for the impl ticket. Linking via `mk doc link` gives them a single uniform fetch (`mk doc show <name> --raw`) instead of having to know which branch the doc lives on. SVG wireframes go in too (they're just XML — mk's `doc` subsystem stores arbitrary text content), so the executor can materialise them on demand even when the design PR hasn't merged yet.

`mk doc upsert --from-path` derives the mk filename (path with `/` → `-`) and reads the file content in one shot. Pass `--type designs` because `--from-path` only auto-derives type for plan-doc paths; design paths need an explicit type.

```bash
register_and_link() {
  local path="$1"
  [ -f "$path" ] || return 0                            # skip artefacts not produced
  local name="${path//\//-}"                            # docs/designs/foo.md → docs-designs-foo.md
  mk doc upsert --from-path "$path" --type designs --user Claude
  mk doc link "$name" MINI-NN \
    --why "Design exploration artefacts for this design ticket" --user Claude
  if [ -n "<impl-MINI-NN>" ]; then
    mk doc link "$name" <impl-MINI-NN> \
      --why "Design recommendation + wireframes for this implementation" --user Claude
  fi
}

register_and_link "docs/designs/<filename>.md"
register_and_link "docs/designs/<filename>-option-a.svg"
register_and_link "docs/designs/<filename>-option-b.svg"
```

`mk doc upsert` and `mk doc link` are both upserts — re-running the whole block on a re-design pass is safe (content refreshes, `--why` refreshes, no duplicate rows). The mk docs are the authoritative copies for downstream skills; the `.md` + `.svg` files on disk and the merged design PR are the source of truth for humans browsing the repo.

---

## Phase 7 — Post mk comments linking to the PR

Two comments here, not one. Both are short navigation aids — the design PR is the artefact.

The PR URL captured in Phase 6.3 is what both comments link to. Reviewers can read the doc rendered in GitHub, comment inline on either the markdown or the SVG wireframes, and merge from one place — that's strictly better than pointing at a blob URL on a feature branch.

### 7.1 Comment on the design ticket

```bash
cat <<'EOF' > /tmp/design-comment.md
**Designs drafted (PR open):** [<PR title>](<PR URL captured in Phase 6.3>)

Two options explored:
- **Option A — <name>** — <one-line gist>
- **Option B — <name>** — <one-line gist>

**Picked: Option <X>** — <one-sentence reason from §Recommendation>.

Moving this design ticket to `in_review` — once the PR merges, the human reviewer flips it to `done`, which unblocks `/execute-next-task <impl-MINI-NN>`. If you disagree with the pick, comment on the PR or reopen the ticket.
EOF

mk comment add MINI-NN --as Claude --user Claude --body-file /tmp/design-comment.md
```

If the parent ticket lists an impl ticket it blocks (look at the issue's relations in the JSON from `mk issue show` — specifically outgoing `blocks`-typed edges), name that ticket explicitly so the user has a one-click follow-up. If there's no blocked impl ticket, drop the impl-ticket clause.

### 7.2 Comment on the impl ticket (if there is one)

`execute-next-task` reads the impl ticket's body as the contract and skims its comments via `mk comment list`. The impl ticket needs a pointer to the design PR, otherwise a future executor opens the ticket cold and has no idea a design pass happened. Don't edit the impl ticket's body — comments are sufficient and don't risk corrupting the contract.

If the design issue's relations include exactly one outgoing `blocks` edge to an impl ticket (the typical shape produced by `plan-to-mk`), post:

```bash
cat <<'EOF' > /tmp/impl-comment.md
**Design ready (PR open):** [<PR title>](<PR URL captured in Phase 6.3>) — design doc at `docs/designs/<filename>.md` (also attached to this issue as mk doc `docs-designs-<filename>.md` along with any sibling SVG wireframes; `/execute-next-task` fetches them via `mk doc show`).

**Picked: Option <X>** — <one-sentence reason from §Recommendation>.

Read this before starting implementation — it includes Key abstractions, File / component sketch, and Implementation outline that the design doc commits to. Open questions in the doc are unresolved choices that may matter at implementation time. Wait for the design PR to merge before kicking off `/execute-next-task` so the doc + SVGs land on `main`; the executor can technically run sooner because the design artefacts are also linked as mk docs, but the design hasn't been reviewed by a human yet.
EOF

mk comment add <impl-MINI-NN> --as Claude --user Claude --body-file /tmp/impl-comment.md
```

If there's no outgoing `blocks` edge (standalone design, no impl ticket), skip 7.2. If there's more than one (rare — usually a planning mistake), post the comment on each one and surface the multi-target case to the user in the final report.

---

## Phase 8 — Move the issue to `in_review`

The PR is open, the comments are posted. Move the design ticket from `todo` to `in_review` so the mk board reflects the actual state of play:

```bash
mk issue state MINI-NN in_review --user Claude
```

That single call is all this phase does. The terminal `done` transition is **not** this skill's job — when the PR merges, the human reviewer flips the design ticket to `done` (or runs `mk issue state MINI-NN done --user Geoff`), at which point any impl ticket that had this design ticket as a `blocks` edge becomes pickable by `execute-next-task`.

If `mk issue state` errors (e.g. invalid state name — verify the canonical states with `mk status -o json` or by reading the `mk` skill's reference), surface the error to the user and tell them to move the issue manually; do not retry silently and do not fall back to a different state without asking.

The Done-when on the ticket body (often "Design doc attached and recommendation merged" since the plan-to-mk template was updated; older tickets may still say "Figma frames signed off") is **informational, not gating**. The recommendation in the doc is what the team is going to ship; treating sign-off as a hard gate would only stall the impl ticket.

---

## Phase 9 — Final report to the user

End the run with a tight summary so the user knows what landed:

```
Design doc written + committed: docs/designs/<filename>.md (worktree .claude/worktrees/mini-NN, branch claude/mini-NN)
PR opened: <PR URL>
mk docs registered + linked: docs-designs-<filename>.md + sibling SVG wireframes (linked to design <MINI-NN> and impl <MINI-MM>)
mk comment posted on design ticket <MINI-NN>
"Design ready" comment posted on impl ticket <MINI-MM>
<MINI-NN> moved to in_review (human flips to done after merge; impl ticket <MINI-MM> unblocks then)

Two options:
  A) <name> — <one-line>
  B) <name> — <one-line>

Picked: Option <X> — <one-line reason>.

Next: review and merge the PR on your cadence. After merge, run /finish-worktree mini-NN to tear down the worktree.
If you disagree with the pick, comment on the PR or close it and reopen the ticket.
```

If there's no impl ticket the design ticket was blocking, drop the impl-ticket comment line and the "impl ticket … unblocks then" clause.

That's the whole skill. Keep the output short — the design PR is the substantive thing; the chat reply just navigates to it.

---

## Hard rules

- **Only one mk state transition per run, and only at the end.** The skill calls `mk issue state` exactly once, in Phase 8, to set the issue to `in_review`. Never set `in_progress`, never set `done` directly (the human reviewer does that after PR merge), never re-transition during the run.
- **Never create a worktree manually.** Worktree creation is delegated to `setup-worktree --no-env` (Phase 5.4). Don't run `git worktree add`, `git checkout -b`, or any other branch/worktree operation directly — the delegated skill owns the convention.
- **Always commit + push + open a PR before posting mk comments.** Phase 6 must complete before Phase 7. The mk comments link to the PR URL — without a PR, the comments would point at a blob URL on a feature branch that may never reach `main`. If `gh pr create` fails, stop the whole run; don't half-ship.
- **Commit only the design artefacts.** `git add` the design `.md` and any sibling `.svg` files explicitly. Never `git add .` — a stale `pnpm-lock.yaml` change or other in-flight worktree noise must not land in the design commit.
- **Always include `Closes <MINI-NN>` in the commit message.** It's the audit-trail reference back to the ticket. `mk` does not parse it, but human reviewers and the commit history rely on it. Keep it in.
- **Never call `mk` without `--user Claude` on a mutating command, or without `--as Claude` on `mk comment add`.** The audit log silently falls back to `geoff` otherwise — useless attribution for agent-driven runs.
- **Never collapse two options into one.** If you genuinely can't think of two distinct approaches, surface that and ask the user whether to write one with a "rejected alternatives" appendix instead. Forcing a weak second option produces noise.
- **Never punt the recommendation back to the user.** The §Recommendation section must commit to one option. "No strong preference" / "either works" / "user picks" are invalid outputs — pick one and name what would flip the call. The PR body and mk comments depend on the recommendation; the skill cannot ship them if it hasn't picked.
- **Never skip the prior-art search (Phase 4.4).** Designs that ignore the existing codebase are usually wrong about what's expensive vs. cheap. Even if you find nothing reusable, the search itself should inform your options.
- **Never overwrite an existing design doc silently.** If `docs/designs/<filename>.md` already exists (or a comment from a previous design pass exists on the ticket), stop and ask.
- **Never produce an ExitPlanMode block.** The design doc *is* the plan. ExitPlanMode is for implementation plans presented in chat; this skill writes a markdown file instead.

---

## Example end-to-end (abbreviated)

> User: "design MINI-38"
>
> *Skill runs `mk status -o json` to confirm `mk` is available and the prefix is `MINI`. Fetches MINI-38 with `mk issue show MINI-38 -o json`: "Phase 2: container-level egress firewall toggle", part of the `egress-firewall-per-container` feature. Runs `mk feature show egress-firewall-per-container -o json` and finds `Plan: docs/planning/not-shipped/egress-per-container-plan.md` in the description. Skill reads the ticket body (Goal: per-container override of the egress firewall policy; Deliverables: API field, UI control, applied at apply-time, audit-logged; Done when: integration test shows the override flips behaviour). Reads the plan doc's Phase 2 section as supplemental context. Skims prior comments via `mk comment list MINI-38 -o json` — none from this skill — so no overwrite risk.*
>
> *Phase 4: identifies the dominant pattern axis as "where does the override live and how does it propagate to apply-time" — i.e. a state-placement + propagation question. Surveys two candidate shapes: (i) override stored on the StackService row, propagated through the existing apply pipeline; (ii) override stored on a new `EgressOverride` table keyed by service, looked up at apply-time. Searches the codebase for similar override patterns: finds `server/src/services/networking/haproxy-frontend-overrides.ts` (per-frontend overrides on the frontend row, similar to option (i)) and `server/src/services/registry/registry-credential-resolver.ts` (separate-table indirection lookup, similar to option (ii)). Cites both.*
>
> *Phase 5.4: invokes `Skill(setup-worktree, args: "MINI-38 --no-env")`. The setup-worktree skill pre-flights main, pulls, creates the worktree at `.claude/worktrees/mini-38` on `claude/mini-38`, runs `pnpm install`, and skips the dev-env spin-up. Returns control with cwd = the worktree.*
>
> *Phase 5: writes `docs/designs/mini-38-egress-per-container-override.md` inside the worktree. Option A is the row-extension shape (cheap, follows the haproxy pattern, but couples the override to the service row's lifecycle). Option B is the separate-table shape (heavier, needs a new migration and model, but cleaner audit trail and easier to extend with override types later). Each option has Key abstractions / File sketch / Implementation outline / Pros / Cons. **Recommendation: Option A** — the team has no plans for other override types and the cheaper change is the right call for the ticket as scoped; flip to B if a second override type lands on the roadmap. One Open question: "do we want overrides to survive a service rename?" — answer changes which option wins. Two items in Out-of-scope: bulk override import (different ticket), override expiry (no Deliverable for it).*
>
> *Phase 6: stages the design `.md`, commits with `docs(designs): egress per-container override (MINI-38)` and a `Closes MINI-38` line, pushes `claude/mini-38`, opens PR #371 via `gh pr create`. Captures the PR URL and runs `mk pr attach MINI-38 <PR URL> --user Claude` so future `mk issue show MINI-38` calls surface the link.*
>
> *Phase 7.1: writes the design-ticket comment to a temp file, then `mk comment add MINI-38 --as Claude --user Claude --body-file /tmp/design-comment.md`: "Designs drafted (PR open): #371. A — Service-row column; B — Separate EgressOverride table. **Picked: Option A** — cheap, leans on the haproxy override pattern; flip to B only if a second override type lands. Moving this design ticket to in_review — once the PR merges, the human reviewer flips it to done, which unblocks `/execute-next-task MINI-39`."*
>
> *Phase 7.2: MINI-38's relations include an outgoing `blocks` edge to MINI-39 (the impl ticket). Writes the impl-ticket comment to a temp file and `mk comment add MINI-39 --as Claude --user Claude --body-file /tmp/impl-comment.md`: "**Design ready (PR open):** #371 — design doc at `docs/designs/mini-38-egress-per-container-override.md` once merged. Picked: Option A — Service-row column. Read this before starting implementation … Wait for the design PR to merge before kicking off `/execute-next-task` — the doc lands on `main` at that point, and once the human flips the design ticket to `done` the impl ticket becomes pickable." A future `/execute-next-task MINI-39` skim of comments via `mk comment list` will see this immediately.*
>
> *Phase 8: `mk issue state MINI-38 in_review --user Claude`. The single state transition. MINI-38 will be flipped to `done` by the human after PR #371 merges; MINI-39 becomes picker-eligible at that point.*
>
> Skill: "Design doc written + committed: `docs/designs/mini-38-egress-per-container-override.md`. PR opened: #371. mk comment posted on design ticket MINI-38. 'Design ready' comment posted on impl ticket MINI-39. MINI-38 moved to in_review (human flips to done after merge; MINI-39 unblocks then). Two options: A) Service-row column. B) Separate EgressOverride table. Picked: A — cheap, leans on the haproxy override pattern. Next: review and merge the PR; after merge, `/finish-worktree mini-38`."
