---
name: plan-to-linear
description: Reads a phased markdown planning document under `docs/planning/` and populates Linear with a matching project plus one issue per phase. Each issue carries the phase's Goal / Deliverables / Done when, the relevant per-component CLAUDE.md and ARCHITECTURE.md pointers (server vs client vs lib vs go sidecars), a Workflow section (worktree pre-flight, `pnpm install`, background `pnpm worktree-env start`), phase-specific smoke-test recipes derived from which directories the phase touches, prior-art commit references, and the commit/PR conventions — enough context that the `execute-next-task` skill can execute the issue without re-planning the high-level scope. Rewrites the plan doc's Linear-tracking section to replace `ALT-_TBD_` placeholders with the real issue IDs. Finally posts a session retrospective comment on Phase 1's issue capturing meta-feedback about the run itself (ambiguities resolved, workflow friction, suggestions) — this is the feedback loop that improves the skill and the plan-doc conventions over time. Use this skill whenever the user says "populate linear from plan", "create the linear tickets", "plan to linear", "scaffold linear from this plan", "turn this plan into linear issues", or any equivalent request to seed Linear from an existing markdown plan. Do NOT trigger for one-off issue creation, for plans that aren't phased, or when the user asks to *modify* an existing project's issues.
---

# Plan to Linear

You're seeding Linear with a project and per-phase issues from an existing markdown planning document. The output is a populated Linear project that the companion skill `execute-next-task` can pick up phase by phase, with each ticket carrying enough context that the executor can plan against current code state without re-doing the high-level scoping.

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

You need at minimum: `list_issues`, `get_issue`, `list_projects`, `get_project`, `save_project`, `save_issue`, `save_comment`, `list_issue_statuses`. If any are missing, stop and tell the user.

Also fetch the team's issue statuses once (`list_issue_statuses` for Altitude Devops) — you'll need the canonical names for `Todo` and `Backlog`. Different teams capitalise / name them differently.

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
   - The **UI changes** block — bullet list with `[design needed]` / `[no design]` tags, or the literal `none`. Surface a count of `[design needed]` items per phase in the Phase 6 confirmation prompt so the user can spot phases that should be deferred pending design.
   - The **Done when** line.
   - The **Verify in prod** line (production signal or `n/a — internal only`).
   - Any other phase-specific subsections (e.g. "Migration shape", "Subjects", "Subjects:") — keep verbatim.
   - File paths mentioned in any of the above (anything matching `[\w-]+/[\w/.-]+\.\w+` or markdown links to repo paths). Used in Phase 3.

   If a phase is missing any of the six required parts, **stop and report which phase / which field**. Do not silently fill in defaults — the convention is the convention. (Older pre-spec plans that genuinely have no UI/Reversibility/Verify lines are the one exception: ask the user whether to seed anyway with empty placeholders, or pause to backfill the plan first.)
4. **Plan-doc-level architecture references** — any links to `docs/architecture/*.md` anywhere in the doc. Surface them to every phase as background.
5. **Linear-tracking section** — confirm a placeholder list exists with the same number of phases as you found. If the count doesn't match, **stop and report** — the doc and §8 are out of sync.
6. **Ordering** — preferred is `[blocks-by: N, M]` brackets on each §8 line; parse them first. If no brackets are present anywhere in §8, fall back to prose hints elsewhere in the doc ("phases land in order", "Phase 1 blocks all later phases", "Phase N also blocks on Phase M"). If neither brackets nor prose are present, default to **strictly sequential** (each phase blocked by the previous). If both brackets and prose are present, brackets win — log it and continue.

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

Before writing anything to Linear:

1. **Project must not already exist.** Use `list_projects` (filtered to Altitude Devops) and check for a name match. If a project with the same name exists, **stop**. Don't merge into an existing project — that's a manual decision.
2. **§8 must have placeholders.** The plan doc's Linear-tracking section must contain `ALT-_TBD_` (or `ALT-TBD`, or similar) entries to fill in. If the entries are already real ALT-NN values, **stop** — the doc looks already populated.
3. **Repo working tree may be clean or dirty** — this skill writes both Linear *and* a small edit to the plan doc. The plan-doc edit will be staged but not committed. The user commits or amends as they choose.

---

## Phase 6 — Confirm the plan with the user

Show a summary and wait for explicit "go":

```
Project to create: <name>
Description: <one-line snippet>

Phases (will create N issues):
  Phase 1: <title>           [Todo]      blocked-by: —
  Phase 2: <title>           [Todo]      blocked-by: Phase 1
  Phase 3: <title>           [Todo]      blocked-by: Phase 2
  ...
  Phase 6: <title>           [Backlog]   blocked-by: Phase 5    (optional)

Each issue will reference:
  - <plan-doc-path>#phase-<N>
  - root CLAUDE.md, ARCHITECTURE.md
  - <per-component docs detected>
  - prior-art commit area: <tag>

Plan doc edit: replace ALT-_TBD_ in §<8> with real issue IDs.

Proceed?
```

Don't proceed without an explicit yes. Never guess "looks good, going" — the side effects (creating Linear issues) aren't easily reversible.

---

## Phase 7 — Create the project

Create the Linear project with the name from H1 and a description that **starts** with the `Plan:` line. This serves two purposes in one line: machine-readable anchor for `execute-next-task` and a clickable link for humans browsing the project in Linear's UI.

```
Plan: [<relative-path-to-plan-doc.md>](<full-https-url-to-plan-doc-on-main>)

<§1 Background paragraph 1, copied verbatim>
```

Examples:
- `Plan: [docs/planning/not-shipped/observability-otel-tracing-plan.md](https://github.com/<owner>/<repo>/blob/main/docs/planning/not-shipped/observability-otel-tracing-plan.md)`

Derive the GitHub URL by reading `git remote get-url origin` (e.g. `https://github.com/mrgeoffrich/mini-infra`) and appending `/blob/main/<relative-path>`. Don't use `./`-prefixed paths or absolute filesystem paths.

The bare-path variant (`Plan: docs/planning/...md`) is also accepted by `execute-next-task` as a legacy fallback for projects authored before this convention firmed up — but new projects use the combined format.

Capture the project's URL and ID from the response — you'll need them for Phase 9 and the retrospective in Phase 11.

---

## Phase 8 — Create one issue per phase

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

---

## Phase 9 — Set blocking relationships

Use the dependency graph you parsed in Phase 2:

- If §8 has `[blocks-by: N, M]` brackets, that's the source of truth — add a `blocked-by` edge to each listed phase.
- Else if prose hints exist, apply them ("Phase 1 blocks all later phases", "Phase N also blocks on Phase M").
- Else default to **strictly sequential** — each phase from 2 onward is `blocked-by` the previous.

Add the edges in order via the Linear API.

Optional/deferred phases still get blocked-by relationships — being in `Backlog` doesn't mean unblocked. The blocker just means "even when promoted to Todo, wait for the predecessor".

---

## Phase 10 — Rewrite the plan doc's §8

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

---

## Phase 11 — Session retrospective

Leave a single comment on **Phase 1's issue** capturing meta-feedback about the run: ambiguities you had to resolve, friction in the skill or the conventions, and concrete suggestions. This is the feedback loop — read accumulated retrospectives to spot patterns and improve the skill (or the plan-doc convention) over time.

**Crucially this is *meta*** — about how the skill ran, not about the *contents* of the tickets. If you want to flag something about a phase's deliverables, that belongs in the ticket itself or in a code-review pass on the eventual PR.

Use this template. Omit any section that genuinely has nothing to report — don't pad with "N/A" or invent observations. If the entire run was uneventful, the comment is one line: "No notable friction this run."

```markdown
### Session notes — `plan-to-linear` retrospective

*Meta: about how the skill ran, not the work itself. Drop a code-review pass on the ticket content separately if you want to comment on deliverables.*

**Ambiguities resolved**
- <plan-doc § / file path>: <what was unclear> → <judgment call I made>
- ...

**Workflow friction**
- <observation about the skill, the MCP roundtrips, the plan-doc shape, or the codebase context the skill relied on>
- ...

**Suggestions** *(tag with `skill:`, `convention:`, or `project:` so they're greppable)*
- skill: <improvement to the skill prompt or its phases>
- convention: <improvement to the plan-doc / Linear conventions>
- project: <improvement to this specific project's setup>
- ...

**What worked well** *(optional, short bullets)*
- ...
```

Examples of *good* meta-feedback (concrete, actionable, about the loop):
- `convention: Phase 4 had no "Migration shape" subsection — copying it forward to the ticket left a thin Goal/Deliverables-only body. Either the convention should require it for non-trivial phases or the skill should infer it.`
- `skill: When the plan doc's §8 list and the §6 phase headings disagree on count, the skill stops with "out of sync" but doesn't surface the diff. Print both lists side by side.`
- `project: No prior commits matching the area tag yet — area-tag detection fell back to "no prior commits" branch. Worked, but a hint in the plan doc would have been faster than scanning git log.`

Examples of *bad* meta-feedback (about the work, not the loop) — don't include these:
- ❌ `Phase 4 deliverables look thin. Should add a deliverable for log redaction.` — that's a code review, not retrospective.
- ❌ `The plan is good and the phasing makes sense.` — content compliment, not workflow.

Echo the comment to the user in the chat when reporting (Phase 12) so they don't have to switch contexts to read it.

---

## Phase 12 — Report

Print a summary:

```
✓ Created project: <name> — <project URL>
✓ Created N issues:
   - <ALT-NN> Phase 1: <title>           [Todo]
   - <ALT-NN> Phase 2: <title>           [Todo]
   - ...
   - <ALT-NN> Phase M: <title>           [Backlog]
✓ Set blocked-by relationships per plan ordering.
✓ Updated <plan-doc-path> §<8> with real issue IDs (uncommitted).
✓ Posted session retrospective to <Phase 1 ALT-NN URL>.

Next step: review the plan-doc diff, commit it, then run `execute-next-task` when you're ready to start Phase 1.
```

---

## Hard rules

- **Never merge into an existing project.** If a project with the same name already exists, stop. Same-named projects are almost certainly the same feature — manual reconciliation only.
- **Never write a pre-baked implementation plan into the issue description.** Issue descriptions carry *context* — Goal, Deliverables, Done when, doc pointers — not file-by-file change lists. The executor produces its concrete implementation against current code at execution time.
- **Never put work-content critique in the retrospective comment.** Phase 11 is meta-only — about how the skill ran. Comments about whether deliverables are right, whether the plan is good, or whether the phasing makes sense belong in a code-review pass on the eventual PR, not as plan-to-linear retrospective.
- **Never fabricate retrospective content.** If the run was clean, the comment is "No notable friction this run." Padding with invented friction defeats the feedback loop.
- **Never invent docs.** If `egress-shared/CLAUDE.md` doesn't exist, don't link it. Verify each attached doc.
- **Never guess at convention.** If §8 has no placeholder list, the H1 is missing, or no `### Phase N` headings parse — stop and report. The conventions exist for a reason.
- **Never commit the plan-doc edit.** Leave it staged. The user owns the commit.
- **Never transition issues from their initial state.** `execute-next-task` does that. The populator only creates.
- **Never skip optional phases.** They go in as `Backlog` so the project is complete and the §8 list reconciles 1:1.
