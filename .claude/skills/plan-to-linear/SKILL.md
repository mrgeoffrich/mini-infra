---
name: plan-to-linear
description: Reads a phased markdown planning document under `docs/planning/` and populates Linear with a matching project plus one issue per phase. Each issue carries the phase's Goal / Deliverables / Done when, the relevant per-component CLAUDE.md and ARCHITECTURE.md pointers (server vs client vs lib vs go sidecars), prior-art commit references, and the conventions an executor needs — enough context that the `execute-next-task` skill can pick up the issue and start work without re-planning the high-level scope. Also rewrites the plan doc's Linear-tracking section to replace `ALT-_TBD_` placeholders with the real issue IDs. Use this skill whenever the user says "populate linear from plan", "create the linear tickets", "plan to linear", "scaffold linear from this plan", "turn this plan into linear issues", or any equivalent request to seed Linear from an existing markdown plan. Do NOT trigger for one-off issue creation, for plans that aren't phased, or when the user asks to *modify* an existing project's issues.
---

# Plan to Linear

You're seeding Linear with a project and per-phase issues from an existing markdown planning document. The output is a populated Linear project that the companion skill `execute-next-task` can pick up phase by phase, with each ticket carrying enough context that the executor can plan against current code state without re-doing the high-level scoping.

## What the plan doc looks like

Reference examples in this repo:
- `docs/planning/not-shipped/internal-nats-messaging-plan.md` — fully populated.
- `docs/planning/not-shipped/observability-otel-tracing-plan.md` — has `ALT-_TBD_` placeholders waiting for this skill.
- `docs/planning/shipped/nats-app-roles-plan.md` — same shape, already shipped.

The conventions you depend on (also documented in `execute-next-task/SKILL.md`):

- **H1** (`# <feature title>`) is the Linear project name.
- **§1 Background** — first paragraph is the project description body.
- **A "Phased rollout" section** (usually §6) with `### Phase N — <title>` subsections. Each phase has **Goal**, **Deliverables**, and **Done when** lines (sometimes with extra subsections like "Migration shape").
- **A Linear-tracking section** (usually §8) with a placeholder list:
  ```
  - ALT-_TBD_ — Phase 1: <title>
  - ALT-_TBD_ — Phase 2: <title>
  ```
  This list is the contract — the skill writes back into it.
- **Phase ordering** — the plan text says "phases land in order" or "Phase 1 blocks all later phases" or similar. Translate that to `blocked-by` relationships.
- **Optional / deferred phases** — marked in the heading or first line ("optional", "deferred", "(optional, deferred)"). They go into Linear as `Backlog`, not `Todo`.

If the doc doesn't follow this shape, **stop and report**. Don't guess.

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
   - The **Done when** line.
   - Any other phase-specific subsections (e.g. "Migration shape", "Subjects", "Subjects:") — keep verbatim.
   - File paths mentioned in any of the above (anything matching `[\w-]+/[\w/.-]+\.\w+` or markdown links to repo paths). Used in Phase 3.
4. **Plan-doc-level architecture references** — any links to `docs/architecture/*.md` anywhere in the doc. Surface them to every phase as background.
5. **Linear-tracking section** — confirm a placeholder list exists with the same number of phases as you found. If the count doesn't match, **stop and report** — the doc and §8 are out of sync.
6. **Ordering hints** — scan for phrases like "phases land in order", "Phase 1 blocks all later phases", "Phase N also blocks on Phase M". Use these to build the `blocked-by` graph in Phase 5. If no hints exist, default to **strictly sequential** (each phase blocked by the previous).

---

## Phase 3 — Map touched components to per-component docs

For each phase, look at the file paths you extracted. Group them by top-level directory and attach the relevant CLAUDE.md / ARCHITECTURE.md pointers. The map for this repo:

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

This step is the difference between Reading 1 and Reading 2 of the populator design: the executor doesn't get a pre-baked plan, it gets pointers to exactly the right convention files for the components it'll touch.

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

Create the Linear project with the name from H1 and a description that **starts** with the `Plan:` line — this is the anchor `execute-next-task` looks for:

```
Plan: <relative-path-to-plan-doc.md>

<§1 Background paragraph 1, copied verbatim>
```

The relative path is from the repo root, e.g. `docs/planning/not-shipped/observability-otel-tracing-plan.md`. Don't use `./`-prefixed paths or absolute paths.

Capture the project's URL and ID from the response — you'll need them for Phase 9.

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

## Done when
<copied verbatim>

<copy any other phase-specific subsections like "Migration shape", "Subjects", verbatim>

---

## Relevant docs (read before planning)

**Repo-wide:**
- [CLAUDE.md](CLAUDE.md) — pnpm, worktree workflow, build invariants
- [ARCHITECTURE.md](ARCHITECTURE.md) — system bird's-eye view, invariants

**Component-specific (this phase touches):**
- <attached per-component CLAUDE.md / ARCHITECTURE.md links from Phase 3>

**Topic-specific:**
- <any docs/architecture/*.md links picked up at the plan-doc level>

---

## Conventions

- Commit format: `<area>(<scope>): <subject> (Phase N, ALT-NN)` — area tag for this project: `<detected from Phase 4>`
- PR body must include `Closes ALT-NN` so merging closes this issue.
- Anything the plan section says to **defer** stays deferred — don't expand scope.

## Prior art

<list of relevant shipped commits from `git log` matching the project's area tag,
 most recent first, max 5>

(no prior commits yet — first phase of this feature)   <-- only if applicable
```

Capture each issue's ID (`ALT-NN`) and URL.

---

## Phase 9 — Set blocking relationships

For each phase in order from 2 onward, add a `blocked-by` relationship to the previous phase using the Linear API. If the plan-doc text specified extra blockers (e.g. "Phase 5 also blocks on Phase 4"), add those too.

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

## Phase 11 — Report

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

Next step: review the plan-doc diff, commit it, then run `execute-next-task` when you're ready to start Phase 1.
```

---

## Hard rules

- **Never merge into an existing project.** If a project with the same name already exists, stop. Same-named projects are almost certainly the same feature — manual reconciliation only.
- **Never write a pre-baked implementation plan into the issue description.** Issue descriptions carry *context* — Goal, Deliverables, Done when, doc pointers — not file-by-file change lists. Implementation plans live in the executor's ExitPlanMode at execution time, against current code.
- **Never invent docs.** If `egress-shared/CLAUDE.md` doesn't exist, don't link it. Verify each attached doc.
- **Never guess at convention.** If §8 has no placeholder list, the H1 is missing, or no `### Phase N` headings parse — stop and report. The conventions exist for a reason.
- **Never commit the plan-doc edit.** Leave it staged. The user owns the commit.
- **Never transition issues from their initial state.** `execute-next-task` does that. The populator only creates.
- **Never skip optional phases.** They go in as `Backlog` so the project is complete and the §8 list reconciles 1:1.
