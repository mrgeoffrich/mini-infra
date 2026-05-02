---
name: execute-next-task
description: Execution agent. Assumes you start at the main checkout root on `main` with a clean tree. Picks the next unblocked Todo issue from the user's Linear team (Altitude Devops), reads the ticket (which was pre-populated by `plan-to-linear` with Goal/Deliverables/Done-when, per-component CLAUDE.md and ARCHITECTURE.md pointers, and phase-specific smoke tests), runs `git pull --ff-only origin main`, creates a fresh worktree at `.claude/worktrees/alt-NN` on branch `claude/alt-NN`, runs `pnpm install`, kicks off `pnpm worktree-env start --description "..."` in the background to warm the dev env, then executes the work end-to-end inside the new worktree — code changes, build/lint/unit tests, live smoke against the dev env, PR with `Closes ALT-NN`, and Linear state transitions ending in In Review with a structured handoff comment (Known issues / Work deferred / Blockers / Deviations from the plan). **Does not produce an ExitPlanMode plan** — planning happened when the ticket was created. **Does not edit the plan doc** — drift goes only in the handoff comment for a re-integration agent to fold back later. Use this skill whenever the user says "execute next task", "what's next in linear", "do the next phase", "pick up the next todo", "work on the next thing", "what should I do next", or any equivalent request to advance through a Linear-tracked migration. Do NOT trigger for one-off non-Linear tasks or for "what should I work on?" without an obvious Linear context.
---

# Execute Next Task

You're an **execution agent**. The planning has already happened — when the Linear ticket was created (by the `plan-to-linear` skill, from a phased markdown plan doc) it was populated with everything you need: Goal, Deliverables, Done when, the relevant per-component CLAUDE.md / ARCHITECTURE.md pointers, prior-art commit hints, and the conventions to follow. Your job is to read the ticket and the linked docs, set up the environment, do the work, and ship a PR. **Do not re-plan, do not stop for approval, do not produce an ExitPlanMode block.** State briefly what you're about to do (one or two sentences) before changing files so the user can interrupt if needed, then execute.

If you read the ticket and find it underspecified or contradictory, that's the only case where you stop and ask — but the populated ticket should rarely have that problem. Treat it as authoritative.

## Conventions you rely on

These conventions are maintained by the user. If they're violated for the picked task, **stop and report — never guess**.

- **One Linear project per feature**, named after the feature.
- **Project description starts with a `Plan:` line** linking to a relative path, e.g. `Plan: docs/planning/not-shipped/internal-nats-messaging-plan.md`. That path is your map.
- **Issue title format**: `Phase N: <short title>`, where `Phase N — <title>` is also a `### Phase N — <title>` heading in the plan doc.
- **Plan doc lives** in `docs/planning/not-shipped/<slug>-plan.md` while any phase is unshipped. After all phases ship it moves to `docs/planning/shipped/`.
- **Phases land in order** via `blocked-by` relationships. Phase 2 is blocked by Phase 1, etc. The skill respects that.
- **Commit / PR title format**: `feat(<area>): <description> (Phase N, ALT-NN) (#PR)` — match the most recent shipped phase in the same project.
- **PR body must include** `Closes <ALT-NN>` so merging closes the Linear issue automatically.

Reference examples in this repo: `docs/planning/not-shipped/internal-nats-messaging-plan.md`, `docs/planning/not-shipped/observability-otel-tracing-plan.md`, `docs/planning/shipped/nats-app-roles-plan.md`.

The team is hardcoded as **Altitude Devops**. (A future improvement is to read this from `.claude/linear-team.json`; not built yet.)

---

## Phase 1 — Load the Linear MCP tools

The Linear MCP tools are deferred at session start. Load the toolkit in one bulk call before doing anything else:

```
ToolSearch(query: "linear", max_results: 30)
```

You should see tools like `mcp__cd9fab4e-...__list_issues`, `__get_issue`, `__get_project`, `__list_comments`, `__save_comment`, `__save_issue`, `__list_issue_statuses`. If any of these are missing, stop and tell the user — don't fall back to anything else.

---

## Phase 2 — Find the next unblocked task

The picking rule is **deliberately simple** — there is no priority sort, no cycle filter, no last-updated heuristic. Just: state = `Todo`, no unfinished `blocked-by`. The user maintains ordering through Linear's blocking relationships.

1. **List Todos** in the Altitude Devops team. Use the `list_issues` tool with `state` = `Todo` (or whatever the team's "Todo" status maps to — fetch the team's issue statuses first if you're unsure).
2. **For each candidate, check blockers.** Use `get_issue` to read its `relations` / blockers. A candidate survives if every `blocked-by` issue it has is in state `Done` or `Cancelled`. An issue with no blockers automatically survives.
3. **Decide:**
   - **0 unblocked candidates** → tell the user "Nothing to do — every Todo is blocked or no Todos exist." Stop.
   - **1 unblocked candidate** → use it. State the pick: id, title, project name.
   - **>1 unblocked candidates** → list them with `id | title | project` and ask the user to pick one. Don't infer — ask.

Don't move to Phase 3 until you have exactly one issue in hand.

---

## Phase 3 — Read the ticket and linked docs

The Linear ticket is your contract. Read it end to end and treat it as authoritative.

1. **Fetch the issue body.** Look for the standard sections written by `plan-to-linear`:
   - **Source** — the plan-doc path and phase anchor.
   - **Goal**, **Deliverables**, **Done when** — the work to do.
   - **Relevant docs** — the per-component CLAUDE.md / ARCHITECTURE.md pointers, plus any topic-specific architecture docs.
   - **Smoke tests** — what to run at the end to validate.
   - **Conventions** — commit/PR format, area tag, deferrals.
2. **Fetch the parent project** (`get_project`) and find the **`Plan:` line** in its description. The skill accepts three forms:
   - `Plan: [docs/planning/.../<slug>-plan.md](https://github.com/.../blob/main/...)` — combined (preferred; what `plan-to-linear` writes today)
   - `Plan: docs/planning/.../<slug>-plan.md` — bare path (legacy fallback)
   - `**Plan doc:** [docs/planning/.../<slug>-plan.md](https://...)` — also accepted as a legacy fallback for projects authored before the convention firmed up

   Extract the **relative path** in all cases. If the project description has none of these, **stop** with a clear "no `Plan:` line in project description" message.

   Confirm the path resolves to the same plan doc the ticket cites in its **Source** section. If they disagree, **stop** — that's a corruption signal.
3. **Read the plan doc's matching `### Phase N` section.** The ticket has the same content but the plan doc is the source of truth — if they've drifted, side with the doc and capture the drift in your handoff comment (Phase 11).
4. **Read every doc the ticket lists under "Relevant docs."** Don't skim — these were chosen because they're the conventions you must follow. The ticket points at them so you don't have to guess what's relevant.
5. **Read prior art** — `git log --oneline -20 main` plus any commits matching the project's area tag from the ticket. Shipped phases tell you the commit subject style and the rough size of a phase PR.

If the ticket is missing the Goal / Deliverables / Done when sections, or the project description has no `Plan:` line, **stop and report** — the ticket wasn't populated correctly. Don't paper over it.

---

## Phase 4 — Pre-flight on main

The skill assumes you start at the **main checkout root**, on `main`, with a clean tree. The first job is to confirm that and pull the latest.

```bash
pwd
git rev-parse --abbrev-ref HEAD
git status
```

Required state:

- **`pwd` is the repo root**, not under `.claude/worktrees/`. If you're already in a worktree, you don't need this skill — exit to the root and re-run.
- **Branch is the repo's default** (usually `main`; confirm with `git symbolic-ref refs/remotes/origin/HEAD --short` if you need to be sure).
- **Working tree is clean** — no uncommitted changes.

If any of these fail, **stop with a clear message**. Don't auto-stash, auto-checkout, or guess.

Then update main:

```bash
git pull --ff-only origin main
```

Use `--ff-only` so a stale local main with non-pushed commits surfaces as an error instead of being merged silently. If it fails, stop and tell the user.

---

## Phase 5 — Create the worktree

Derive the worktree slug from the picked Linear issue ID:

- **Slug**: `alt-<NN>` (lowercase). For `ALT-29`, slug is `alt-29`.
- **Worktree path**: `.claude/worktrees/<slug>` — relative to the repo root. (The repo's existing convention puts worktrees here; root `CLAUDE.md` walks through the layout.)
- **Branch**: `claude/<slug>` — namespaces it as agent-created, matching the other `claude/...` branches.

Create the worktree off the freshly-pulled main:

```bash
git worktree add .claude/worktrees/<slug> -b claude/<slug>
cd .claude/worktrees/<slug>
```

`cd` into it for the rest of the skill. Every later step runs from this directory.

If the directory or branch already exists, **stop and ask** — don't auto-resume someone else's worktree, and don't reuse a stale branch name silently. The user's `pnpm worktree-env delete` (root `CLAUDE.md`) is the right tool to clean up first.

---

## Phase 6 — Set up the environment (in parallel with starting work)

This phase runs **before** marking In Progress so the env is warming while you read more code and start writing.

### 6.1 Install dependencies

Fresh worktrees do not share `node_modules` with the main checkout (per root `CLAUDE.md`). Always run:

```bash
pnpm install
```

This is required before any other `pnpm` command including `pnpm worktree-env` (which runs through `tsx`, which lives in `node_modules`). Run it synchronously — you need it to finish before anything else.

### 6.2 Spin up the dev environment in the background

`pnpm worktree-env start` takes a few minutes the first time, building the per-worktree VM/distro. Kick it off in the background **now** so it's ready when smoke tests need it later. Use the `Bash` tool's `run_in_background: true` and capture the shell id:

```bash
pnpm worktree-env start --description "<short summary, ≤10 words>"
```

Derive the description from the Linear issue title (truncate to ≤10 words; the CLI requires it on first run). Don't wait for it. Move on to the work; you'll check the status before running smoke tests in Phase 9. The command is idempotent — safe to re-run.

If the phase is **docs-only** (e.g. only touches `docs/`, a README, or a SKILL.md), skip 6.2 — no smoke tests will need a running env.

---

## Phase 7 — Mark the issue In Progress

```
save_issue(id: <issue-id>, state: "In Progress")
save_comment(issue_id: <issue-id>, body: "Started by Claude.\n- Worktree: <path>\n- Branch: <branch>\n- Env startup: backgrounded")
```

Fetch the team's issue statuses first if you don't already know the canonical name (`In Progress` vs `In progress` etc. — use whatever the team has).

---

## Phase 8 — Execute

Before writing any file, **state in one or two sentences** what you're about to do — file pointers and the rough order. This is for visibility, not approval; don't wait for a response. If the user wants to redirect they'll interrupt.

Then implement, following the conventions from the docs the ticket pointed at. Common ones:

- Root `CLAUDE.md` — package manager (pnpm), worktree workflow, "always run from project root", build invariants.
- `server/CLAUDE.md` — `DockerService.getInstance()`, `ConfigurationServiceFactory`, never raw `dockerode`, all mutations carry `userId`, `Channel.*` / `ServerEvent.*` constants for Socket.IO.
- `client/CLAUDE.md` — TanStack Query owns server state, no polling when socket is connected, task tracker pattern.
- The component-specific CLAUDE.md / ARCHITECTURE.md files the ticket listed.

Rules of taste:

- Edit existing files in preference to creating new ones.
- Don't add features, refactor surrounding code, or introduce abstractions beyond what the phase requires.
- Don't add error handling for scenarios that can't happen.
- Default to no comments. Only add a comment when the *why* is non-obvious.

Refer back to the ticket's **Deliverables** list as you go — those are the things that have to be true at the end. If the work is bigger than the phase scoped, **stop and ask** — never silently expand scope or split phases on the fly.

---

## Phase 9 — Verify with smoke tests

The ticket's **Smoke tests** section tells you specifically what to run for this phase. Use it as the spec; the layered checklist below is the default if the ticket says "standard smoke" or doesn't specify.

### 9.1 Build / lint / unit tests (always)

```bash
pnpm build:lib                              # if lib/ changed (always required if so)
pnpm --filter mini-infra-server build       # if server/ changed
pnpm --filter mini-infra-server test        # if server/ changed
pnpm --filter mini-infra-server lint        # if server/ changed
pnpm --filter mini-infra-client build       # if client/ changed
pnpm --filter mini-infra-client test        # if client/ tests changed
```

For Go components (`egress-gateway/`, `egress-fw-agent/`, `egress-shared/`):

```bash
go build ./...
go test ./...
```

For sidecars that use npm rather than pnpm (`update-sidecar/`, `agent-sidecar/`):

```bash
cd update-sidecar && npm install && npm run build && npm test && cd ..
```

### 9.2 Live smoke against the dev env

Once 9.1 passes, **wait for the backgrounded `pnpm worktree-env start` to finish** (or confirm `environment-details.xml` is current and the env is healthy). Then run the phase-specific smoke from the ticket:

- **UI changes** → invoke the `test-dev` skill on the affected user flow. Don't re-implement what `test-dev` does.
- **Server route changes** → hit the affected endpoint(s) via `curl` against the URL in `environment-details.xml`, or `diagnose-dev` if a runtime check is needed.
- **Stack template changes** (`server/templates/`) → confirm the affected stack reconciles cleanly: check `docker ps`, look for the new containers, tail logs briefly.
- **Go sidecar changes** → confirm the container builds, starts, and the affected egress page in dev shows it healthy.
- **NATS-subject changes** → publish a test message via the bus and verify the consumer side picks it up. The smoke ping (`mini-infra.system.ping`) is a good baseline that the bus is alive.
- **Docs-only changes** → skip live smoke; build + lint is enough.

### 9.3 Report

If everything passes, move on. If anything fails, **fix it before continuing** — don't paper over with `--no-verify`, `--skip-tests`, or weakened assertions. If a fix isn't obvious, stop and surface the failure with full output.

---

## Phase 10 — Commit and open the PR

Match the most recent shipped phase's commit format from the same project. Typical:

```
feat(<area>): <short description> (Phase N, ALT-NN)
```

The area tag (`nats`, `egress`, `monitoring`, `docs`, etc.) follows what previous phases used in the same project.

Commit body:

```
<one or two paragraphs explaining what changed and why,
 in the same voice as recent commits on main>

Co-Authored-By: <as configured>
```

Push the branch, then `gh pr create`. PR title matches the commit title. PR body must:

- Have a Summary section (1–3 bullets) describing the change.
- Have a Test plan section (markdown checklist).
- **Include `Closes ALT-NN` on its own line** so merging the PR auto-closes the Linear issue.
- Match the format used in recent PRs on this repo (look at `gh pr list --limit 5` for tone).

---

## Phase 11 — Mark the issue In Review and leave a structured handoff comment

Move the issue to `In Review` (canonical state name from Phase 1's status fetch) and post a single structured comment summarising the run. The comment is the handoff to the human reviewer — and to the future re-integration agent that will fold drift back into the plan doc — so it captures everything the PR diff doesn't show. **The plan doc itself is read-only for this skill** (see hard rules); drift goes here.

```
save_issue(id: <issue-id>, state: "In Review")
save_comment(issue_id: <issue-id>, body: <handoff comment, see template below>)
```

Use this template verbatim. Omit any section that genuinely has nothing to report — don't pad with "N/A" or "none". If every section is empty, the comment is just the PR link.

```markdown
**PR:** <PR_URL>

## Known issues
<failing tests you couldn't fix in scope, brittleness you noticed but didn't address, anything the reviewer should be aware of when looking at the diff. One bullet each.>

## Work deferred
<deliverables from the phase that were scoped down, or follow-ups identified along the way that should become their own issues. Reference the plan-doc line that says they can be deferred if applicable.>

## Blockers
<things that stopped you finishing some part of the work — missing credentials, an upstream bug in another component, a dependency on infrastructure that isn't there. Empty if nothing blocked you.>

## Deviations from the plan
<places where what you shipped diverges from the plan doc's Deliverables or Done-when. For each: what the plan said, what you shipped, why. The plan doc itself stays untouched — a re-integration agent will fold these notes back into the doc later.>
```

Then report the PR URL to the user wrapped in a `<pr-created>` tag on its own line so any UI integrations can render a card.

The point of this comment is that the next person (human or agent) opens the Linear issue and sees the full state of what shipped without having to read the diff or guess. If it's empty across the board, that's a great sign — but don't fabricate content to fill it.

---

## Hard rules

These are non-negotiable. If you find yourself wanting to break one, stop and ask the user instead.

- **Never produce an ExitPlanMode block.** This is an execution agent. Planning happened in `plan-to-linear` when the ticket was created.
- **Never edit the plan doc.** The plan doc under `docs/planning/` is read-only for this skill. If your implementation drifts from the plan, capture the drift in the handoff comment (Phase 11 — Deviations from the plan section). A separate re-integration agent will fold those notes back into the plan doc; don't pre-empt that.
- **Never merge PRs** — even if checks pass and the PR looks great. Merging is a human decision.
- **Never create new Linear issues** or split phases on the fly. If scope is too big for one phase, stop and report — splitting is a planning decision, not an execution decision.
- **Never override plan-doc conventions.** If the plan section says "Defer X to follow-up", that X is deferred. Don't quietly include it because it seemed easy.
- **Never `git checkout main`, `git stash`, or create a new branch.** Worktree lifecycle is the user's responsibility — this skill assumes the worktree is already up. (`pnpm install` and the backgrounded `pnpm worktree-env start` are the *only* environment setup the skill performs, and only inside the existing worktree.)
- **Never skip pre-flight checks** by running on `main` or with a dirty tree. Stop and ask.
- **Never use `--no-verify` or skip hooks.** If a hook fails, investigate.
- **Never guess at conventions.** If the project description has no `Plan:` line, or the ticket has no Goal/Deliverables/Done-when sections, **stop and report**. The conventions exist so the skill can rely on them; bypassing them silently breaks the next run.

---

## Example end-to-end (abbreviated)

> User: "execute next task"
>
> *Skill loads Linear MCP, lists Todos in Altitude Devops. Three Todos: ALT-29, ALT-31, ALT-34. ALT-29 is blocked by ALT-28 (Done). ALT-31 is blocked by ALT-30 (Todo). ALT-34 has no blockers. Two unblocked candidates: ALT-29, ALT-34.*
>
> Skill: "Two unblocked Todos:
> - `ALT-29 | Phase 4: pg-az-backup progress + result events | Internal NATS Messaging`
> - `ALT-34 | Phase 1: Tempo + OTel Collector + Grafana | OTel Tracing`
>
> Which one?"
>
> User: "ALT-29"
>
> *Skill fetches ALT-29 + parent project. Project description: `Plan: [docs/planning/not-shipped/internal-nats-messaging-plan.md](https://github.com/...)`. Skill reads the ticket body (Goal, Deliverables, Done when, Relevant docs, Smoke tests). Reads each linked CLAUDE.md / ARCHITECTURE.md. Reads `git log` for `Phase 1`/`Phase 2`/`Phase 3` shipped commits to learn the area tag (`nats`) and PR title shape.*
>
> *Pre-flight: pwd is the repo root, branch is main, tree clean. Runs `git pull --ff-only origin main`. Creates worktree: `git worktree add .claude/worktrees/alt-29 -b claude/alt-29`, then `cd` into it. Runs `pnpm install` synchronously, then kicks off `pnpm worktree-env start --description "Phase 4 — pg-az-backup progress + result events"` in the background. Marks ALT-29 In Progress, comments worktree path + branch.*
>
> Skill: "Implementing Phase 4 — adding `mini-infra.backup.run` request handler and JetStream `BackupHistory` stream. Touching `server/src/services/backup/backup-executor.ts` first, then `server/src/services/nats/payload-schemas.ts`, then the boot sequence."
>
> *Implements. Runs build/lint/unit tests. Backgrounded env is up by now — runs the ticket's smoke test (publish a test backup-run request, confirm the consumer side fires).*
>
> *Commits with `feat(nats): pg-az-backup progress + result events (Phase 4, ALT-29)`. Opens PR with `Closes ALT-29` in the body. Marks ALT-29 In Review. Posts the handoff comment: PR URL, plus a Deviations section noting that the optional retry-on-transient-failure deliverable was deferred to a follow-up issue per the plan doc's wording — the plan doc itself is left untouched, the re-integration agent will fold this back later. Reports the PR URL.*
