---
name: plan-to-linear
description: Reads a phased markdown planning document under `docs/planning/` and either seeds Linear with a matching project plus one issue per phase (**create mode** — §8 has `ALT-_TBD_` placeholders) or refreshes an already-seeded project's issue bodies and dependency edges from the plan doc (**update mode** — §8 has real `ALT-NN` IDs). Each issue carries the phase's Goal / Deliverables / Reversibility / UI changes / Done when / Verify in prod, the relevant per-component CLAUDE.md and ARCHITECTURE.md pointers (server vs client vs lib vs go sidecars), a **Source-code touchpoints** section produced by a per-phase codebase exploration (best-guess New / Modify / Read paths) plus a **Shared-library opportunities** sub-section flagging types/constants/helpers that should land in `lib/` or `egress-shared/` rather than be duplicated, a Workflow section (worktree pre-flight, `pnpm install`, background `pnpm worktree-env start`), phase-specific smoke-test recipes derived from which directories the phase touches, prior-art commit references, and the commit/PR conventions — enough context that the `execute-next-task` skill can execute the issue without re-planning the high-level scope or re-exploring from scratch. Phases whose UI changes block contains one or more `[design needed]` items also get a **paired design ticket** auto-created in `Backlog` (designer-owned, kept out of the execute-next-task queue), tagged with the team's `design` label so designers can filter their queue with one chip, and wired up to the impl ticket via two relation edges — a `blocked-by` (the hard ordering constraint the picker reads) and a `related` (the soft "this design is for that work" link that stays visible in both issues' side panels even after the design has shipped). Plan authors don't write standalone "Design: …" phases. Update mode preserves issue state, assignee, cycle, estimate, labels, and all prior comments (retros, handoff notes); only the body, title (if changed), and blocked-by edges are refreshed, and orphan issues (phases removed from the plan since seeding) are surfaced for manual handling rather than auto-deleted. In create mode, rewrites the plan doc's §8 to replace `ALT-_TBD_` placeholders with real issue IDs. Use this skill whenever the user says "populate linear from plan", "create the linear tickets", "plan to linear", "scaffold linear from this plan", "turn this plan into linear issues", "refresh linear from plan", "update linear issues", "re-sync linear from plan", "plan-to-linear refresh", or any equivalent request to seed *or* refresh Linear from a plan markdown. Do NOT trigger for one-off issue creation, for plans that aren't phased, or when the user wants to ad-hoc-edit a single Linear issue (use the Linear UI directly).
---

# Plan to Linear

You're either **seeding** Linear with a project and per-phase issues from an existing markdown planning document, or **refreshing** the issue bodies and dependency edges of an already-seeded project after the plan doc has changed. In both cases the output is a populated Linear project that the companion skill `execute-next-task` can pick up phase by phase.

The mode is detected from §8 of the plan doc:

- **Create mode** — §8 has `ALT-_TBD_` placeholders. Default flow: create the project, file one issue per phase, set blocked-by edges, rewrite §8 with real IDs.
- **Update mode** — §8 has real `ALT-NN` IDs. Refresh the body of each existing issue from the plan, recompute blocked-by edges as a delta, leave state / assignee / cycle / estimate / labels / comments alone. Never delete issues — if the plan dropped a phase, surface it for manual handling.

Throughout the rest of this doc, **default behaviour is create mode** unless a step is explicitly tagged with an *Update mode* sub-section. When both branches exist for a phase, follow only the one matching the detected mode.

## What the plan doc looks like

Reference examples in this repo:
- `docs/planning/not-shipped/internal-nats-messaging-plan.md` — fully populated.
- `docs/planning/not-shipped/observability-otel-tracing-plan.md` — has `ALT-_TBD_` placeholders waiting for this skill.
- `docs/planning/shipped/nats-app-roles-plan.md` — same shape, already shipped.

The conventions you depend on (full spec in [`docs/planning/PLANNING.md`](../../../docs/planning/PLANNING.md); also referenced from `execute-next-task/SKILL.md`):

- **H1** (`# <feature title>`) is the Linear project name.
- **§1 Background** — first paragraph is the project description body.
- **§2 Goals** and **§3 Non-goals** — required scoping sections.
- **A "Phased rollout" section** (usually §6) with `### Phase N — <title>` subsections. Each phase has **six required parts**:
  - **Goal** — one-sentence outcome.
  - **Deliverables** — bullet list.
  - **Reversibility** — `safe` / `feature-flagged` / `forward-only` / `destructive`, plus rationale.
  - **UI changes** — bullet list (each item tagged `[design needed]` or `[no design]`) or the literal `none`.
  - **Done when** — testable acceptance criterion.
  - **Verify in prod** — production signal, or `n/a — internal only`.
  Phases may have extra subsections like "Migration shape" or "Subjects" — keep them.
- **A Linear-tracking section** (usually §8) with a placeholder list and optional `[blocks-by: …]` brackets:
  ```
  - ALT-_TBD_ — Phase 1: <title>
  - ALT-_TBD_ — Phase 2: <title>  [blocks-by: 1]
  - ALT-_TBD_ — Phase 3: <title>  [blocks-by: 1, 2]
  ```
  This list is the contract — the skill writes back into it. Brackets are preserved through seeding.
- **Phase ordering** — preferred form is `[blocks-by: N, M]` brackets in §8 (above). Fallback is prose hints in the §6 preamble or §8 intro line ("phases land in order", "Phase 1 blocks all later phases", "Phase N also blocks on Phase M"). Brackets win if both are present. If neither is present, default to **strictly sequential** (each phase blocks-by the previous).
- **Optional / deferred phases** — marked in the heading or first line ("optional", "deferred", "(optional, deferred)"). They go into Linear as `Backlog`, not `Todo`.

If the doc doesn't follow this shape, **stop and report**. Don't guess. Older plans (pre-Reversibility / UI changes / Verify-in-prod) may be missing those fields — surface that to the user and ask whether to backfill before seeding rather than silently dropping the new sections from the issue body.

The team is hardcoded as **Altitude Devops**.

---

## Phase 1 — Load the Linear MCP tools

Linear MCP tools are deferred. Load them in bulk before doing anything else:

```
ToolSearch(query: "linear", max_results: 30)
```

You need at minimum: `list_issues`, `get_issue`, `list_projects`, `get_project`, `save_project`, `save_issue`, `list_issue_statuses`, `list_issue_labels`. If any are missing, stop and tell the user.

Also fetch, once each:

- **Team issue statuses** via `list_issue_statuses` for Altitude Devops — you'll need the canonical names for `Todo` and `Backlog`. Different teams capitalise / name them differently.
- **The `design` label** via `list_issue_labels` for Altitude Devops — used to tag every paired design ticket created in Phase 8.1 so designers can filter their queue with one label. If a label literally named `design` (case-insensitive) doesn't exist on the team, **create it** via `create_issue_label` with name `design` and a sensible colour (use the same blue/purple family Linear's UI suggests; if unsure, omit `color` and let Linear pick). Capture the label's ID — every design-ticket `save_issue` call in Phase 8.1 (and Phase 8 update-mode reconciliation when a new design ticket is born) will pass `labels: [<design-label-id>]`.

---

## Phase 2 — Locate and parse the plan doc

The user usually points at a path; if not, list `docs/planning/not-shipped/*.md` and ask.

Read the doc end-to-end and extract:

1. **Project name** — the H1, stripped of trailing punctuation.
2. **Project description body** — §1 Background, first paragraph.
3. **Phases** — every `### Phase N — <title>` subsection. For each, extract:
   - The phase number `N` and the title (everything after the em-dash).
   - **Optional flag** — true if the heading or first line contains "optional", "deferred", or both. (Plan §6 in the OTel doc has "Phase 6 — App-level metrics (optional, deferred)" as a deliberate example.)
   - The **Goal** line.
   - The **Deliverables** list (bullet points; can be nested).
   - The **Reversibility** line (classifier + rationale).
   - The **UI changes** block — bullet list with `[design needed]` / `[no design]` tags, or the literal `none`. Capture each `[design needed]` bullet verbatim per phase — these become the body of the paired design ticket created in Phase 8.1. Surface the per-phase count in the Phase 6 confirmation prompt so the user can see how many design tickets will be created (or refreshed in update mode).
   - The **Done when** line.
   - The **Verify in prod** line (production signal or `n/a — internal only`).
   - Any other phase-specific subsections (e.g. "Migration shape", "Subjects", "Subjects:") — keep verbatim.
   - File paths mentioned in any of the above (anything matching `[\w-]+/[\w/.-]+\.\w+` or markdown links to repo paths). Used in Phase 3.

   If a phase is missing any of the six required parts, **stop and report which phase / which field**. Do not silently fill in defaults — the convention is the convention. (Older pre-spec plans that genuinely have no UI/Reversibility/Verify lines are the one exception: ask the user whether to seed anyway with empty placeholders, or pause to backfill the plan first.)
4. **Plan-doc-level architecture references** — any links to `docs/architecture/*.md` anywhere in the doc. Surface them to every phase as background.
5. **Linear-tracking section** — confirm a placeholder list exists with the same number of phases as you found. If the count doesn't match, **stop and report** — the doc and §8 are out of sync.
6. **Ordering** — preferred is `[blocks-by: N, M]` brackets on each §8 line; parse them first. If no brackets are present anywhere in §8, fall back to prose hints elsewhere in the doc ("phases land in order", "Phase 1 blocks all later phases", "Phase N also blocks on Phase M"). If neither brackets nor prose are present, default to **strictly sequential** (each phase blocked by the previous). If both brackets and prose are present, brackets win — log it and continue.
7. **Mode** — classify the run from §8:
   - Every line has `ALT-_TBD_` (or `ALT-TBD`) → **create mode**. Continue with the full pipeline below.
   - Every line has a real `ALT-NN` reference (markdown link or bare ID) → **update mode**. Phase 3 still runs (touched-paths and smoke recipes may have shifted with the plan); Phase 4 still runs (area tag is re-detected too in case the project's commit pattern changed); Phase 5 takes the update-mode pre-flight branch.
   - **Mixed §8** (some placeholders, some real IDs) → **stop and report**. Either a previous seed run partially completed and is now in an inconsistent state, or someone hand-edited §8 — both need human reconciliation, not a guess.

   Carry the detected mode forward as a single state flag the rest of the phases branch on.

---

## Phase 3 — Map touched components to docs and smoke tests

For each phase, look at the file paths you extracted. Group them by top-level directory. Two outputs come from this step: which **doc pointers** to attach to the ticket, and which **smoke-test recipes** to recommend at the end of execution.

### 3.1 Doc pointers per component

| Top-level dir matched | Docs to attach (relative to repo root) |
|---|---|
| `server/` | `server/CLAUDE.md`, `server/ARCHITECTURE.md` |
| `client/` | `client/CLAUDE.md`, `client/ARCHITECTURE.md` |
| `lib/` | `lib/CLAUDE.md` |
| `acme/` | `acme/CLAUDE.md` |
| `egress-gateway/` | `egress-gateway/CLAUDE.md` |
| `egress-fw-agent/` | `egress-fw-agent/CLAUDE.md` |
| `egress-shared/` | `egress-shared/CLAUDE.md` |
| `update-sidecar/` | `update-sidecar/CLAUDE.md` |
| `agent-sidecar/` | `agent-sidecar/CLAUDE.md` |
| `pg-az-backup/` | `pg-az-backup/CLAUDE.md` |
| `deployment/`, `scripts/`, `docs/`, root configs only | (no extra; root docs cover it) |

Verify each attached file actually exists with `Read` or `ls` before including it — the map above is correct as of writing but a future component might not have its own doc yet. Drop any that 404.

**Always include** the root `CLAUDE.md` and `ARCHITECTURE.md` — every phase touches the wider codebase.

**Also include** any `docs/architecture/*.md` from the plan-doc-level references collected in Phase 2.

This is the difference between Reading 1 and Reading 2 of the populator design: the executor doesn't get a pre-baked plan, it gets pointers to exactly the right convention files for the components it'll touch.

### 3.2 Smoke-test recipes per component

Map the same touched paths to the live-smoke recipe the executor should run after build/lint/unit tests pass. These go into the ticket's "Smoke tests" section. Pick whichever apply — multiple components → multiple recipes.

| Touched path pattern | Smoke recipe to recommend |
|---|---|
| `client/src/`, `client/public/` | Invoke the `test-dev` skill walking the affected user flow in the dev environment. Don't re-implement what `test-dev` does. |
| `server/src/routes/` | Hit the affected endpoint(s) with `curl` against the URL in `environment-details.xml`. Use the admin API key from `//admin/apiKey` in the same file. |
| `server/src/services/` (no route change) | If the service runs at boot or on a schedule, watch the server logs for the relevant subcomponent (`grep '"subcomponent":"<name>"' logs/app.*.log`). If it's invoked from a route that already exists, hit that route. |
| `server/templates/` | Confirm the affected stack reconciles cleanly: `docker ps` shows the new containers, no errors in the relevant container's logs (`docker logs <container>`). |
| `egress-gateway/`, `egress-fw-agent/`, `egress-shared/` | Confirm the binary builds, the container starts, and the egress page in dev shows the agent/gateway healthy. |
| Server NATS subjects (`server/src/services/nats/`, `lib/types/nats-subjects.ts`) | Publish a test message via `NatsBus` (or the smoke ping `mini-infra.system.ping`) and verify the consumer side fires. Reference `docs/architecture/internal-messaging.md` for the subject inventory. |
| `update-sidecar/`, `agent-sidecar/` | Run the sidecar's npm tests (`cd <dir> && npm test`). Live smoke is component-specific; if the phase exercises a runtime path, drive it from the server side. |
| `pg-az-backup/` | Trigger a backup from the dev UI (or via the API) and confirm the run completes; check Azure Blob if the env has Azure configured, otherwise just confirm the runner exited cleanly. |
| `lib/types/` only | No live smoke needed; build pass = types compile. |
| `docs/`, README, SKILL.md, root configs only | No live smoke; build/lint is enough. The phase is docs-only — also tell the executor to skip the backgrounded `pnpm worktree-env start`. |

If the phase touches several components, list one recipe per. If none of these match (rare — usually means a totally new component), write `<no recipe — confirm with user before merging>` and the executor will surface it.

---

## Phase 3.5 — Explore the codebase per phase (touchpoints + shared-lib opportunities)

This is where the skill replaces "the executor will figure out where to make the changes" with a concrete starting map. Plans are scoping documents (`docs/planning/PLANNING.md` "What not to write") — they don't list files, and we don't want them to. Instead, we do the exploration here, once per seed/refresh, and bake the result into the ticket.

For **every phase** (in both create and update mode — same logic, no skip flag), spawn an `Explore` subagent. **Fan all phases out in parallel from a single message** — they're independent, and one round-trip beats N for a multi-phase plan.

### 3.5.1 Explorer prompt template

The prompt for each Explore call must be self-contained — the subagent has no conversation context. Use this shape:

```
You're seeding a Linear ticket for a phase of planned work in the mini-infra repo. The plan is a SCOPING document — it doesn't name files, and that's deliberate. Your job is to translate the phase's intent into a starting map of source-code touchpoints.

Phase: <Phase N — title>

Goal: <verbatim from plan>

Deliverables:
<verbatim deliverables block>

Reversibility: <classifier + rationale>
UI changes: <verbatim>

Other phase-specific subsections (Migration shape, Subjects, etc.):
<verbatim, if any>

Doc pointers (already attached to the ticket — for your context, not output):
- root CLAUDE.md, ARCHITECTURE.md
- <per-component CLAUDE.md / ARCHITECTURE.md from Phase 3.1>
- <docs/architecture/*.md from plan-doc-level refs>

Existing shared-package precedents to look for opportunities against:
- lib/types/socket-events.ts — Socket.IO Channel/Event constants shared client↔server
- lib/types/nats-subjects.ts — NATS subject constants shared across components
- server/src/services/nats/payload-schemas.ts — Zod payload schemas registry
- lib/types/permissions.ts — permission scope strings
- egress-shared/ — code shared between egress-gateway and egress-fw-agent
- acme/ — ACME client library (extensible)

## What I want back

### A. Source-code touchpoints
Files this phase is most likely to touch. Group as:

**New** — files that don't exist yet but the deliverables imply we'll add. Infer naming from sibling files in the same directory. Each entry: `path — ≤12-word what-for phrase`.

**Modify** — existing files whose responsibility overlaps with the deliverables. Find them by grepping for keywords from the Goal/Deliverables, looking at the doc pointers' "Key files" sections, and reading top-level service registries. Each entry: `path — ≤12-word what-for phrase`.

**Read for context** — architectural neighbours the executor should skim before writing (sibling services, the prior version of a thing being replaced, the contract a new thing must mirror). Each entry: `path — ≤12-word what-for phrase`.

Cap at ~10 paths total per group. Bias toward fewer, higher-quality picks. If you can't find anything concrete in a group, write `none` for that group — don't pad. If the *whole* phase is too vague to find anything, say so explicitly: `<unable to map — phase deliverables too vague>`. That's a useful signal back to the planner.

Also list the **directory clusters** (no extension) the phase will land in, for cases where files don't exist yet — e.g. `server/src/services/nats/`, `lib/types/`.

### B. Shared-library opportunities
Look across the touchpoints you just identified and flag anything that should land in a shared package rather than being duplicated:

1. **Types / constants the client or sidecars will eventually consume** — enums, status string sets, event payload shapes, subject names, permission strings. These belong in `lib/types/` from day one. Reference the existing `socket-events.ts` / `nats-subjects.ts` precedents in your suggestion.

2. **Code shared across the egress pair** (egress-gateway + egress-fw-agent) → `egress-shared/`. Same rule for any future Go-sidecar pair.

3. **Existing shared modules to extend rather than re-implement** — e.g. if the phase needs a Zod schema and `payload-schemas.ts` already has the registry, suggest extending it.

4. **Cross-component duplication risk** — same concept named differently in `server/` vs `client/`. Surface as "consider unifying via lib/" with both naming candidates.

For each opportunity: `<what> → <where>` with a short rationale. If nothing applies (phase is purely server-internal, no shared interest), write `none` — don't invent.

## Hard constraints

- Do NOT propose concrete edits ("change line 42 to…"). Paths + ≤12-word what-for phrases only.
- Do NOT decide. Flag opportunities; the user confirms in Phase 6.
- Do NOT pad. Empty groups stay empty. Vague phases get `<unable to map>`.
- Verify each path with `Read` or `Glob` before listing it under New/Modify/Read. New paths must have a real sibling directory.

Return a single markdown block with the two sections (A and B), nothing else.
```

### 3.5.2 Aggregating results

Collect each phase's explorer output. Hold onto two structured pieces per phase:

- `touchpoints` — the `### A. Source-code touchpoints` section verbatim.
- `sharedLibOpportunities` — the `### B. Shared-library opportunities` section verbatim.

Both render directly into the ticket body in Phase 8.

If a phase came back with `<unable to map — phase deliverables too vague>`, flag it for the Phase 6 confirmation prompt — that's the signal the user should consider tightening the deliverables *before* the ticket goes live.

### 3.5.3 Update mode

Re-run the exploration the same way on a refresh — touchpoints captured at the original seed time may have gone stale (files renamed, modules split, shared-lib precedent added since). The same fan-out, the same prompt, the same aggregation. The newly derived touchpoints + shared-lib opportunities replace whatever was in the previous body. No skip flag.

---

## Phase 4 — Detect commit-area conventions

Run `git log --oneline -30 main` and look for commit subjects matching the plan's slug or topic. Past PRs in the same project follow a pattern like:

```
feat(nats): NatsBus foundation for app-to-app messaging (Phase 1, ALT-26) (#335)
feat(nats): egress-fw-agent onto NATS (Phase 2, ALT-27) (#338)
docs(nats): tidy two leftover nits in app-integration guide (#339)
```

Extract the **area tag** (`nats`, `egress`, `monitoring`, etc.) — this becomes a hint in each issue's "Conventions" section so the executor uses the same tag. If the project is brand new and has no shipped commits yet, infer from the most-touched top-level directory or note "no prior commits — choose an area tag at execution time".

---

## Phase 5 — Pre-flight checks

Before writing anything to Linear, run the pre-flight matching the mode you detected in Phase 2.

### Create mode

1. **Project must not already exist.** Use `list_projects` (filtered to Altitude Devops) and check for a name match against the plan H1. If a project with the same name exists, **stop and tell the user**. Two possibilities:
   - The user meant **update mode** but §8 still has `ALT-_TBD_` placeholders — likely the previous seed run failed mid-way. Ask them to reconcile §8 with reality before retrying.
   - The name collides with an unrelated project — manual reconciliation only.
2. **§8 must be all placeholders.** Mode detection (Phase 2 step 7) already confirmed this, but double-check no real `ALT-NN` IDs leaked through.
3. **Repo working tree may be clean or dirty** — this skill writes both Linear *and* a small edit to the plan doc. The plan-doc edit will be staged but not committed. The user commits or amends as they choose.

### Update mode

1. **Project must already exist.** Use `list_projects` (filtered to Altitude Devops), find the project whose name matches the plan H1. If no project matches, **stop and report** — §8 has real ALT IDs but the project is gone, which is suspicious (renamed? archived? wrong plan doc?). Capture the project's URL and ID for later phases.
2. **Each §8 issue must exist in this project.** For every ALT-NN reference in §8, call `get_issue` and confirm the issue resolves and belongs to the project from step 1. Any miss = **stop and report** (likely the issue was deleted or moved; needs human reconciliation).
3. **Reconcile phase count.** Compare the number of `### Phase N` headings in §6 to the number of issues in the project. Three cases:
   - **Equal** — straightforward refresh; proceed to Phase 6.
   - **Plan has more phases than project** (phases added since seeding) — surface the extras to the user: "Plan has Phase N (`<title>`) which has no Linear issue. Create it?" If yes, treat the new phases as a small create-mode pass during Phase 8 and append their ALT-NN lines to §8 in Phase 10. If no, **stop**.
   - **Project has more issues than plan** (phases removed from plan) — surface the orphans to the user: "Linear has ALT-NN (`<title>`) which has no matching phase in the plan. Leave it alone? (auto-deletion is not supported)" The orphans are reported but never touched. If the user wants them gone they handle it manually.
4. **Repo working tree may be clean or dirty** — same rationale as create mode. §8 only gets edited if step 3 added new phases.

---

## Phase 6 — Confirm the plan with the user

Show a summary and wait for explicit "go". The summary differs by mode.

### Create mode

```
Project to create: <name>
Description: <one-line snippet>

Phases (will create N impl issues + M design tickets):
  Phase 1: <title>           [Todo]      blocked-by: —             touchpoints: 4N/3M/2R   shared-lib: 2 flagged   design: 0
  Phase 2: <title>           [Todo]      blocked-by: 1, Design#2   touchpoints: 1N/5M/1R   shared-lib: none        design: 2 [needed] → 1 paired ticket
  Phase 3: <title>           [Todo]      blocked-by: 2             touchpoints: <unable to map — phase too vague>  ⚠
  ...
  Phase 6: <title>           [Backlog]   blocked-by: 5, Design#6   touchpoints: 0N/2M/0R   shared-lib: 1 flagged    (optional, deferred)   design: 1 [needed] → 1 paired ticket

Design tickets to create (Backlog, designer-owned, not picked by execute-next-task):
  Design: Phase 2 — <title>     [Backlog]   blocks: Phase 2     items: 2 [design needed]
  Design: Phase 6 — <title>     [Backlog]   blocks: Phase 6     items: 1 [design needed]

Touchpoint counts are New/Modify/Read paths the per-phase explorer found.
Phases flagged "unable to map" mean the deliverables are too vague for the explorer
to find concrete starting points — consider tightening before seeding.

Shared-library opportunities flagged across all phases: <total>
  - Phase 1: types → lib/types/<...>.ts (mirrors socket-events.ts pattern)
  - Phase 1: payload schemas → extend server/src/services/nats/payload-schemas.ts
  - Phase 6: shared egress code → egress-shared/<...>.go
  (full per-phase list rendered into each ticket; review before confirming)

Each impl issue will reference:
  - <plan-doc-path>#phase-<N>
  - root CLAUDE.md, ARCHITECTURE.md
  - <per-component docs detected>
  - per-phase Source-code touchpoints (from Phase 3.5 explorer)
  - per-phase Shared-library opportunities (from Phase 3.5 explorer)
  - prior-art commit area: <tag>

Each design ticket will reference:
  - <plan-doc-path>#phase-<N> (same source as the paired impl phase)
  - The verbatim list of [design needed] UI items
  - A "Blocks: Phase N — <title>" pointer back to the impl ticket

Plan doc edit: replace ALT-_TBD_ in §<8> with real impl issue IDs.
Design tickets are NOT listed in §8 — they're auto-generated metadata.

Proceed?
```

Hold on confirmation if any phase is flagged `<unable to map>` — surface that to the user as "Phase N's deliverables are too vague for the explorer to find any concrete touchpoints. Tighten the deliverables in the plan, or proceed anyway and the executor will explore at run time?" The skill proceeds either way once the user picks; the flag is a signal, not a hard stop.

### Update mode

```
Project to refresh: <name>  →  <existing project URL>

Existing impl issues to refresh (M of N matched 1:1 with plan phases):
  ALT-NN  Phase 1: <title>          [In Review]    body: refresh
  ALT-NN  Phase 2: <title>          [In Progress]  body: refresh
  ALT-NN  Phase 3: <title>          [Todo]         body: refresh, title rename: "<old>" → "<new>"
  ...

Paired design tickets to refresh: <count>
  ALT-NN  Design: Phase 2 — <title>     [Backlog]   body: refresh   items now: 2 [design needed]
  ALT-NN  Design: Phase 6 — <title>     [In Progress] body: unchanged

Design tickets to create (phase newly has [design needed] items): <count>
  Design: Phase N — <title>             [Backlog]   blocks: Phase N

Design tickets orphaned (phase no longer has [design needed] items; not deleted): <count>
  ALT-NN  Design: Phase X — <title>     [<state>]   ← reported only; no auto-delete

Phases added since seeding (will create new impl issues): <count>
  Phase N: <title>           [Todo]
  ...

Orphan impl issues (in Linear but not in plan; will NOT be touched): <count>
  ALT-NN  <title>            [<state>]   ← reported only; no auto-delete

What changes per refreshed issue:
  - Body sections regenerated from current plan: Goal, Deliverables,
    Reversibility, UI changes, Done when, Verify in prod, plus any
    phase-specific subsections (Migration shape, Subjects, etc.)
  - Doc pointers re-derived from current touched-paths analysis
  - **Source-code touchpoints re-explored against current repo state**
    (files renamed since seeding will not be reflected in the old body)
  - **Shared-library opportunities re-flagged** (precedents that landed
    since seeding may have created new opportunities)
  - Smoke-test recipes re-derived
  - Conventions / Prior art re-derived

Per-phase touchpoint deltas vs. previous body:
  Phase 1: 3N/4M/2R (was 2N/3M/1R)   shared-lib: 2 flagged (was 1)
  Phase 2: 0N/3M/1R (unchanged)      shared-lib: none (was none)
  ...

What is preserved:
  - State (Todo / In Progress / In Review / Done / Backlog)
  - Assignee, cycle, estimate, labels
  - All comments (manual notes, retros, handoff comments)
  - Issue ID

Dependency edges (blocked-by) will be diffed against the current §8 graph
and added/removed as needed; correct edges are left alone.

Plan doc edit: <none, OR append new ALT-NN line(s) for added phases>.

Proceed?
```

Don't proceed without an explicit yes. Never guess "looks good, going" — the side effects (creating Linear issues, overwriting bodies, mutating the dependency graph) aren't easily reversible. Bulk body overwrites in update mode are especially easy to misinterpret if the user wasn't expecting them.

---

## Phase 7 — Create the project

*Create mode only. In update mode, skip this phase entirely — the existing project's URL and ID were captured during the Phase 5 update-mode pre-flight (step 1).*

Create the Linear project with the name from H1 and a description that **starts** with the `Plan:` line. This serves two purposes in one line: machine-readable anchor for `execute-next-task` and a clickable link for humans browsing the project in Linear's UI.

```
Plan: [<relative-path-to-plan-doc.md>](<full-https-url-to-plan-doc-on-main>)

<§1 Background paragraph 1, copied verbatim>
```

Examples:
- `Plan: [docs/planning/not-shipped/observability-otel-tracing-plan.md](https://github.com/<owner>/<repo>/blob/main/docs/planning/not-shipped/observability-otel-tracing-plan.md)`

Derive the GitHub URL by reading `git remote get-url origin` (e.g. `https://github.com/mrgeoffrich/mini-infra`) and appending `/blob/main/<relative-path>`. Don't use `./`-prefixed paths or absolute filesystem paths.

The bare-path variant (`Plan: docs/planning/...md`) is also accepted by `execute-next-task` as a legacy fallback for projects authored before this convention firmed up — but new projects use the combined format.

Capture the project's URL and ID from the response — you'll need them for Phase 9.

---

## Phase 8 — Create or refresh issues per phase

### Create mode — create one issue per phase

For each phase, in order, create a Linear issue:

**Title:** `Phase N: <title>` — exactly matching the `### Phase N — <title>` heading minus the em-dash. (`execute-next-task` matches by phase number, but exact title parity is good practice.)

**State:** `Todo` for non-optional phases, `Backlog` for optional/deferred ones. Use the canonical state names you fetched in Phase 1.

**Description body:**

```markdown
**Source:** [<plan-doc-path> §<phase-anchor>](<plan-doc-path>#phase-N)

## Goal
<copied verbatim from the phase section>

## Deliverables
<copied verbatim — preserve list nesting and inline links>

## Reversibility
<copied verbatim — classifier + rationale>

## UI changes
<copied verbatim — bullet list with [design needed] / [no design] tags, or `none`>

## Done when
<copied verbatim>

## Verify in prod
<copied verbatim — production signal or `n/a — internal only`>

<copy any other phase-specific subsections like "Migration shape", "Subjects", verbatim>

---

## Relevant docs (read before writing code)

**Repo-wide:**
- [CLAUDE.md](CLAUDE.md) — pnpm, worktree workflow, build invariants
- [ARCHITECTURE.md](ARCHITECTURE.md) — system bird's-eye view, invariants

**Component-specific (this phase touches):**
- <attached per-component CLAUDE.md / ARCHITECTURE.md links from Phase 3>

**Topic-specific:**
- <any docs/architecture/*.md links picked up at the plan-doc level>

---

## Source-code touchpoints

> Best-guess starting map produced by the per-phase explorer at seed time.
> **Use as a map, not a checklist.** Verify each path before editing — files may have been
> renamed since seeding. Add anything you find missing. The list is a head-start, not a contract.

**New** (files this phase is expected to add):
- `<path>` — <≤12-word what-for phrase>
- ...
- (or `none` if the phase only modifies existing files)

**Modify** (existing files this phase is expected to change):
- `<path>` — <≤12-word what-for phrase>
- ...
- (or `none` if the phase only adds new files)

**Read for context** (architectural neighbours to skim before writing):
- `<path>` — <≤12-word what-for phrase>
- ...
- (or `none`)

**Directory clusters this phase will land in:**
- `<dir>/` — <≤12-word what-for phrase>
- ...

<if the explorer returned `<unable to map — phase deliverables too vague>`, replace this
 whole section with that line and a one-line note: "Explorer couldn't find concrete
 starting points from the deliverables. Re-explore at execution time using the doc
 pointers above as your starting set.">

## Shared-library opportunities

> Flagged at seed time; **not auto-decisions**. Confirm which apply before lifting code
> into shared packages. Default precedents to mirror: [`lib/types/socket-events.ts`](lib/types/socket-events.ts),
> [`lib/types/nats-subjects.ts`](lib/types/nats-subjects.ts), [`server/src/services/nats/payload-schemas.ts`](server/src/services/nats/payload-schemas.ts).

- **<concept>** → `<target shared-package path>` — <one-line rationale, references precedent if applicable>
- ...
- (or `none — phase has no shared-interest surface area` if the explorer flagged nothing)

---

## Workflow

This is an execution-agent ticket — no separate planning phase. Read the docs above, then:

1. **Pre-flight.** Confirm clean working tree, on a feature branch, in a worktree path.
2. **`pnpm install`.** Fresh worktrees do not share `node_modules` with the main checkout (per root `CLAUDE.md`). Run synchronously; required before any other `pnpm` command including `pnpm worktree-env`.
3. **Spin up the dev env in the background.** Kick off `pnpm worktree-env start` with `run_in_background: true` so it warms while you work. Idempotent — safe if the env is already up.
   - <if the phase is docs-only, replace this whole bullet with: "Skip — phase is docs-only, no live smoke needed.">
4. **Read the dev env URL and admin creds from `environment-details.xml`** at the worktree root once the background command has finished, before running smoke tests.

## Smoke tests (run after build/lint/unit tests pass)

<bullets generated from Phase 3.2's smoke-recipe map for this phase's touched components.
 Examples by component:>

- **Server route changes** → `curl -H "x-api-key: <admin>" $MINI_INFRA_URL/api/<route>` and verify response shape.
- **UI changes** → invoke the `test-dev` skill on the affected page; walk the golden path.
- **Stack template changes** → `docker ps` shows the new containers, `docker logs <container>` clean.
- **NATS subject changes** → publish via `NatsBus`, confirm consumer fires; baseline with `mini-infra.system.ping`.
- ...

If none of the recipes match, the populator emits `<no recipe — confirm with user before merging>` here and the executor will surface that.

---

## Conventions

- Commit format: `<area>(<scope>): <subject> (Phase N, ALT-NN)` — area tag for this project: `<detected from Phase 4>`
- PR body must include `Closes ALT-NN` so merging the PR auto-closes this issue.
- Anything the plan section says to **defer** stays deferred — don't expand scope on the fly.
- When done, the executor leaves a structured handoff comment on this issue covering Known issues / Work deferred / Blockers / Deviations from the plan.

## Prior art

<list of relevant shipped commits from `git log` matching the project's area tag,
 most recent first, max 5>

(no prior commits yet — first phase of this feature)   <-- only if applicable
```

Capture each issue's ID (`ALT-NN`) and URL.

### Create mode — paired design tickets (Phase 8.1)

After the impl ticket is created, scan its UI changes block for items tagged `[design needed]`. **If any exist**, create a paired design ticket:

**Title:** `Design: Phase N: <title>` — same shape as the impl title with a `Design:` prefix, so they sort adjacent in any title-sorted view.

**State:** `Backlog`. Designers own these tickets; `execute-next-task` only picks from `Todo`, so `Backlog` keeps the design ticket out of the execution queue while letting designers transition through their own states normally.

**Labels:** include the `design` label resolved in Phase 1 — pass `labels: [<design-label-id>]` on the `save_issue` call. Every paired design ticket carries this label so designers can filter their queue with one chip across all projects (and the user can build a single saved view for "what's on my plate"). The `execute-next-task` picker doesn't filter on this label — it filters on state — so the label is purely for designer ergonomics.

**Description body:**

```markdown
**Source:** [<plan-doc-path> §<phase-anchor>](<plan-doc-path>#phase-N)

This design ticket was auto-generated by `plan-to-linear` from the
`[design needed]` items in Phase N's UI changes block. Once Figma frames are
signed off and linked, mark this issue Done — the impl ticket unblocks
automatically.

## Design needed

<verbatim copy of every UI-changes bullet tagged `[design needed]`, including the tag itself>

## Done when

Figma link attached to this ticket and signed off by the designer; any new
design tokens merged into the design system.

## Blocks

- [<impl-ALT-NN>](https://linear.app/altitude-devops/issue/<impl-ALT-NN>) — Phase N: <phase title>
```

Capture the design ticket's ALT-NN and URL — Phase 9 uses it as a `blocked-by` edge on the impl ticket.

**Skip the scan entirely** when the phase's UI changes block is the literal `none` or contains zero `[design needed]` items.

**Cross-phase design dedupe is out of scope.** If Phases 4 and 12 both reference the same visual treatment (e.g., the addon visual language used on multiple pages), each gets its own design ticket. Designers can mark one Done and immediately Done the duplicate — auto-deduping at seed time would require parsing and comparing the design items across phases, and that's a fragility we don't need.

### Update mode — refresh existing issue bodies

For each phase, look up the matching Linear issue by its §8 ALT-NN ID (use `get_issue`). Match by ID, **not** by title — titles can change between seed and refresh, and ID is the stable key.

For each matched issue:

1. **Render the new body** using exactly the same template shape as create mode above (Source / Goal / Deliverables / Reversibility / UI changes / Done when / Verify in prod / extra subsections / Relevant docs / **Source-code touchpoints** / **Shared-library opportunities** / Workflow / Smoke tests / Conventions / Prior art). Re-derive doc pointers from Phase 3 against the current plan and current repo state — touched paths may have shifted. Re-derive touchpoints + shared-lib opportunities from Phase 3.5 against the current repo state — files renamed since seeding will not be reflected in the old body, and new shared-lib precedents may have appeared.
2. **Compare titles.** If the plan's `### Phase N — <title>` (minus em-dash) differs from the existing issue title, update the title too. Match shape: `Phase N: <title>`.
3. **Call `save_issue`** with the existing issue ID, the new body, and (if changed) the new title. **Do not pass `state`, `assignee`, `cycle`, `estimate`, or `labels`** — leaving them out of the call preserves them.
4. **Do not delete or alter existing comments.** All retros, handoff notes, and manual comments survive untouched.

For phases newly added to the plan since seeding (detected in Phase 5 update-mode pre-flight, step 3 case "Plan has more phases than project"), create the issue using the create-mode template above with state `Todo` (or `Backlog` if optional/deferred). Append the new ALT-NN line to §8 in Phase 10.

For orphan issues (Phase 5 update-mode pre-flight, step 3 case "Project has more issues than plan"), do nothing — they were already surfaced to the user. Just remember the list for the Phase 11 report.

### Update mode — paired design ticket reconciliation

After refreshing each impl ticket, reconcile its paired design ticket against the current `[design needed]` items in the phase's UI changes block.

1. **Lookup.** Find the existing design ticket by walking the impl ticket's `blocked-by` graph and matching against issues whose title starts with `Design: Phase N` (where `N` matches the impl phase). At most one paired design ticket per phase.

2. **Reconcile against current `[design needed]` items:**
   | Plan has items? | Design ticket exists? | Action |
   |---|---|---|
   | yes | yes | Refresh design body (regenerate `## Design needed` from the current verbatim items; preserve `## Source` and `## Done when`). |
   | yes | no | Create the design ticket fresh (same template as Phase 8.1 create mode); add the design→impl `blocked-by` edge in Phase 9. |
   | no | yes | **Leave alone.** Surface as orphan in the Phase 11 report. Designers may still be working on it; auto-delete is never the right call. |
   | no | no | No-op. |

3. **State preservation** — same rules as impl tickets. Pass only `body` and (if changed) `title` to `save_issue`. State, assignee, comments survive untouched.

Capture, for the Phase 11 report:

- Which impl issues had body refreshed (all matched issues, by ID).
- Which impl issues had a title rename (and old → new).
- Which impl issues were newly created (with ALT-NN).
- The impl orphan list, unchanged.
- Design tickets refreshed (count + IDs).
- Design tickets newly created (count + IDs + which impl phase they pair).
- Design tickets orphaned (count + IDs; not deleted).

---

## Phase 9 — Set blocking relationships and design↔impl relations

Use the dependency graph you parsed in Phase 2, plus the design pairings from Phase 8.1, to compute the **desired** set of relationship edges. There are two relation types in play, and they answer different questions:

- **`blocked-by`** — hard ordering constraint. The impl ticket cannot start until its blockers are Done. This is what the `execute-next-task` picker reads.
- **`related`** (Linear's `relatedTo`) — soft "these belong together" link. Doesn't gate work; just makes the connection visible in both issues' side panels and queryable as a relation. Designers viewing a design ticket immediately see *which impl ticket consumes this design*, even after the design has shipped (and the blocked-by edge has resolved).

Compute the **desired blocked-by set** for each impl ticket as the union of:

- **Inter-phase edges from §8.** If §8 has `[blocks-by: N, M]` brackets, that's the source of truth — each phase wants a `blocked-by` edge to each listed phase. Else if prose hints exist, apply them ("Phase 1 blocks all later phases", "Phase N also blocks on Phase M"). Else default to **strictly sequential** — each phase from 2 onward is `blocked-by` the previous.
- **Design pairing edge from Phase 8.1.** If the phase has a paired design ticket, the impl ticket also gets a `blocked-by` edge to that design ticket's ALT-NN.

Compute the **desired related set** for each design↔impl pair created in Phase 8.1: a single `related` edge between the design ticket and the impl ticket. Linear treats `related` as symmetric, so adding it once on either side surfaces it on both. Add it on the design ticket pointing at the impl ticket — that mirrors the doc-style "this design is *for* that work" reading.

Optional/deferred phases still get blocked-by relationships — being in `Backlog` doesn't mean unblocked. The blocker just means "even when promoted to Todo, wait for the predecessor".

Design tickets themselves have **no `blocked-by` edges** — designers can start the moment the ticket is filed. They only carry the `related` edge to their impl ticket.

### Create mode

Add the desired edges in order via the Linear API. There's nothing to compare against — the issues were just created and have no relationships yet. The design→impl `blocked-by` edges and the design↔impl `related` edges are added in the same pass alongside the inter-phase edges.

### Update mode

Existing edges may not match the desired graph — §8 brackets may have changed since seeding. Compute and apply the delta for **both relation types** (`blocked-by` and `related`) independently:

1. **Fetch existing relationships** for each issue in the project (`get_issue` returns relations on most Linear MCP implementations; otherwise use whatever relation-listing tool is loaded). Read both relation types — `blocked-by` and `related` — into separate sets.
2. **Compute the desired edge sets** as above:
   - desired `blocked-by` set per impl ticket (inter-phase from §8 ∪ design pairing)
   - desired `related` set per design↔impl pair from Phase 8.1
3. **Apply the delta** independently per relation type:
   - **Add** edges that are desired but missing.
   - **Remove** `blocked-by` edges that exist but are no longer desired (e.g. §8 brackets changed).
   - For `related` edges: **add** when missing, **never remove**. The `related` link is cheap to keep around even if the impl ticket gets repurposed; deleting it costs context for designers, and Linear's UI lets users manually unrelate if they truly want to.
   - **Leave alone** edges that are correct.
   If the loaded MCP toolkit doesn't expose edge removal, surface the unremoved edges in the Phase 11 report and proceed — the user can clean them up manually rather than having the run fail.
4. **Cross-project edges** (issues in this project blocked by issues in *other* projects) are out of scope for this skill — leave them untouched even if §8 makes no mention of them. They were added deliberately; we won't second-guess. Same rule for cross-project `related` edges — humans add those; the skill doesn't touch them.

For phases newly created during this update run (Phase 8 update-mode tail), apply their desired edges from scratch (same as create mode for those issues).

For design tickets newly created during the Phase 8 update-mode design reconciliation (a phase newly has `[design needed]` items), add both the design→impl `blocked-by` edge and the design↔impl `related` edge from scratch. For impl tickets whose paired design ticket was just created, the impl ticket's `blocked-by` set is recomputed end-to-end (inter-phase from §8 ∪ design pairing), and the delta logic above handles add/remove/leave-alone uniformly.

---

## Phase 10 — Rewrite the plan doc's §8

### Create mode

Edit the plan doc to replace each `ALT-_TBD_` placeholder with the matching real issue ID, in order. Also update the §8 intro line to point at the new project URL if it has a project URL slot. Example diff:

```diff
-Phase issues will be created under a new "OTel Tracing" project on the Altitude Devops team and linked here once filed.
+Tracked under the [OTel Tracing](https://linear.app/altitude-devops/project/...) project on the Altitude Devops team.

-- ALT-_TBD_ — Phase 1: Tempo + OTel Collector + Grafana in monitoring stack
-- ALT-_TBD_ — Phase 2: `NatsBus` context propagation (TS + Go)
+- [ALT-41](https://linear.app/altitude-devops/issue/ALT-41) — Phase 1: Tempo + OTel Collector + Grafana in monitoring stack
+- [ALT-42](https://linear.app/altitude-devops/issue/ALT-42) — Phase 2: `NatsBus` context propagation (TS + Go)
```

Match the link format used in the existing plan docs (look at the NATS migration plan §8 — `[ALT-26](https://linear.app/altitude-devops/issue/ALT-26)`).

Do **not** commit. Leave the diff staged so the user can review and commit it themselves with the rest of any related work.

### Update mode

§8 should already have real IDs — verify they still match what's in Linear (you fetched those in Phase 5). Two cases that produce a §8 edit:

1. **Phases newly added during this run** (Phase 5 step 3, Phase 8 update-mode tail) — append a new `[ALT-NN](https://linear.app/altitude-devops/issue/ALT-NN) — Phase N: <title>[ [blocks-by: …]]` line in order. Match the link format used for the existing entries.
2. **§8 line text drifted from current titles** — if a Phase title in the plan changed (and you renamed the issue in Phase 8 update-mode), update the title text after the colon on the §8 line so the doc reads true.

Don't touch `[blocks-by: …]` brackets in §8 — the user wrote what they wanted; we apply it. If the user's intent was to change the dependency graph, they edited brackets *before* invoking the skill, and Phase 9 already applied the delta.

If neither case applies, leave §8 unchanged. Do **not** commit.

---

## Phase 11 — Report

Print a summary. Shape differs by mode.

### Create mode

```
✓ Created project: <name> — <project URL>
✓ Created N issues:
   - <ALT-NN> Phase 1: <title>           [Todo]
   - <ALT-NN> Phase 2: <title>           [Todo]
   - ...
   - <ALT-NN> Phase M: <title>           [Backlog]
✓ Set blocked-by relationships per plan ordering.
✓ Updated <plan-doc-path> §<8> with real issue IDs (uncommitted).

Next step: review the plan-doc diff, commit it, then run `execute-next-task` when you're ready to start Phase 1.
```

### Update mode

```
✓ Refreshed project: <name> — <project URL>
✓ Refreshed N issue bodies:
   - <ALT-NN> Phase 1: body refreshed
   - <ALT-NN> Phase 2: body refreshed, title rename "<old>" → "<new>"
   - <ALT-NN> Phase 3: body refreshed
   - ...
✓ Created M new issues for added phases:
   - <ALT-NN> Phase N: <title>           [Todo]
   (or "✓ No phases added since seeding.")
✓ Dependency edges: +X added, -Y removed, Z unchanged
⚠ Orphan issues (in Linear but not in plan, not auto-deleted):
   - <ALT-NN> <title>            [<state>]
   (or "✓ No orphans.")
⚠ Edges that need manual cleanup (toolkit doesn't expose removal):
   - <ALT-NN> blocked-by <ALT-NN>  ← please remove via Linear UI
   (or "✓ No manual cleanup needed.")
✓ Updated <plan-doc-path> §<8> with <added phases | no changes>.

Next step: <if §8 changed, "review and commit the plan-doc diff"; if orphans / manual edges flagged, "address them in Linear"; else "done — issues are now in sync with the plan">.
```

---

## Hard rules

### Both modes

- **Never write a pre-baked implementation plan into the issue description.** Issue descriptions carry *context* — Goal, Deliverables, Reversibility, UI changes, Done when, Verify in prod, doc pointers, source-code touchpoints, shared-library opportunities — not file-by-file change lists. The executor produces its concrete implementation against current code at execution time. The line: **paths + ≤12-word what-for phrases are fine**; concrete edits ("change line 42 to…", "wrap this call in a try/catch") are not.
- **Touchpoints are best-guess at seed time, not a contract.** The Phase 3.5 explorer produces its best guess from the deliverables; files may have been renamed since seeding, the explorer may have missed something, and the deliverables may evolve. The rendered ticket section explicitly tells the executor to verify each path and add what's missing. Never present touchpoints as exhaustive.
- **Shared-library opportunities are flags, not decisions.** The explorer surfaces candidates ("this enum will be consumed by the client → consider `lib/types/<...>.ts`"); the user confirms which apply at Phase 6 confirmation, and the executor confirms again at implementation time against current code. Never auto-promote a touchpoint into a shared package without surfacing it for confirmation first.
- **Never invent paths.** Every `New` / `Modify` / `Read` path the explorer emits must be verifiable via `Read` or `Glob` (existing) or have a real sibling directory (new). Hallucinated paths are worse than no paths — they send the executor on a snipe hunt and erode trust in the section.
- **Never invent docs.** If `egress-shared/CLAUDE.md` doesn't exist, don't link it. Verify each attached doc.
- **Never guess at convention.** If §8 has no placeholder list (create mode) or has mixed placeholders + real IDs (either mode), the H1 is missing, or no `### Phase N` headings parse — stop and report. The conventions exist for a reason.
- **Never commit the plan-doc edit.** Leave it staged. The user owns the commit.
- **Design tickets are auto-generated from `[design needed]` tags, not from explicit plan phases.** Plan authors don't write standalone "Phase N — Design: …" phases (the brainstorm-to-plan skill warns against this). Each phase whose UI changes block contains one or more `[design needed]` items gets exactly one paired design ticket; no `[design needed]` items means no design ticket. If the plan doc contains a phase whose title starts with "Design:", treat it as a regular impl phase (the user wrote it deliberately) and skip the design-pairing scan for that phase.
- **Design tickets are not listed in §8.** They're auto-generated metadata, found via Linear's `blocked-by` graph from the impl ticket. The §8 list keeps its 1:1 phase-to-line invariant; never inject design tickets into §8 (neither as siblings nor as sub-bullets).
- **Never auto-delete design tickets.** Same surface-don't-delete rule as impl tickets — designers may still be working on them, and history (Figma link comments, sign-off comments) is valuable. Phases that lose all `[design needed]` items produce orphan design tickets that get reported, never deleted.
- **Never skip optional phases.** They go in as `Backlog` so the project is complete and the §8 list reconciles 1:1.

### Create mode only

- **Never merge into an existing project.** If a project with the same name already exists, stop. Same-named projects are almost certainly the same feature — manual reconciliation only. (If the user actually wants to refresh, §8 needs real ALT IDs to flip the run into update mode.)
- **Never transition issues from their initial state.** `execute-next-task` does that. The populator only creates.

### Update mode only

- **Update mode preserves state, assignee, cycle, estimate, labels, and comments.** The skill only refreshes the issue body, title (if changed), and `blocked-by` edges. Everything else is the user's territory. Do not pass these fields to `save_issue`.
- **Update mode never deletes issues.** Phases removed from the plan since seeding produce orphan issues — surface them, never auto-delete. They may have intentional history attached (retro comments, deferred-then-cancelled context, scheduled-for-later) and removal is a deliberate human choice.
- **Update mode never deletes comments.** All prior comments — retros, handoff comments from `execute-next-task`, manual notes — survive a refresh untouched.
- **Update mode requires the same explicit confirmation as create mode** (Phase 6). Bulk body overwrites are easy to misinterpret if the user wasn't expecting them.
- **Update mode never touches cross-project edges.** A `blocked-by` edge from an issue in this project to an issue in a different project was added deliberately by a human — leave it alone even if §8 says nothing about it.
