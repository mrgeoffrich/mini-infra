---
name: execute-next-task
description: Picks the next unblocked Todo issue from the user's Linear team (Altitude Devops), reads the parent project's linked markdown plan doc, plans the work, and on user approval executes it end-to-end — worktree check, code changes, verification, PR with `Closes ALT-NN`, and Linear state transitions. Use this skill whenever the user says "execute next task", "what's next in linear", "do the next phase", "pick up the next todo", "work on the next thing", "what should I do next", or any equivalent request to advance through a Linear-tracked migration. Do NOT trigger for one-off non-Linear tasks or for "what should I work on?" without an obvious Linear context.
---

# Execute Next Task

You're picking up the next chunk of an in-flight Linear-tracked feature in Mini Infra. The features are codified as markdown plan docs under `docs/planning/` with phased rollouts; each phase is a Linear issue. Your job is to find the next phase ready to work on, plan it concretely against the plan doc, and on user approval execute it end-to-end through to a PR in review.

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

## Phase 3 — Resolve the plan doc and the matching phase section

Once you have the issue:

1. **Fetch the parent project** (`get_project`). Read its description.
2. **Find the `Plan:` line.** It should be one of the first lines and look like `Plan: docs/planning/not-shipped/<slug>-plan.md`. If absent, **stop** and tell the user the project description is missing the convention.
3. **Read the plan doc.** Confirm it exists at the cited path.
4. **Locate the matching phase section.** From the issue title `Phase N: <short title>`, find the `### Phase N — <something>` heading in the plan doc. The titles don't have to match exactly word-for-word — the phase number is the key. If no `### Phase N` heading exists, **stop** and tell the user the plan doc is out of sync.
5. **Read the matching section in full** — Goal, Deliverables, Done when. These three are your contract.
6. **Read prior art** — `git log --oneline -20 main` plus any commits whose message contains the project's earlier phases (e.g. `Phase 1, ALT-26`). The shipped phases tell you the commit format, the area-tag style, and the rough size of a phase PR for this project.

If anything in this phase fails, stop and report — never guess your way through.

---

## Phase 4 — Plan and seek approval

Produce a concrete implementation plan keyed to the phase's **Deliverables** and **Done when** lines from the plan doc.

The plan must include:

- A list of files you intend to create or modify.
- The verification commands you'll run at the end (build / lint / test / browser test as relevant).
- Any deviation from the plan doc you're proposing, **with reasoning**. (Plans drift; honesty about that is what keeps the doc useful.)
- An explicit note about anything the plan section says to defer — those stay deferred.

Surface the plan via `ExitPlanMode` and wait for user approval. Do not start writing code before approval.

---

## Phase 5 — Pre-flight checks

Before executing:

```bash
git status
git rev-parse --abbrev-ref HEAD
```

Required state:

- **A clean working tree** — no uncommitted changes.
- **A feature branch** — not `main` (or whatever the repo's default branch is, check `git remote show origin`).
- **You're in a worktree path** — `pwd` should match the worktree root the user is operating in.

If any of these fail, **stop with a clear message**. Do not auto-stash, auto-create a branch, or run `pnpm worktree-env start`. The repo's worktree workflow is a separate concern (root `CLAUDE.md`); duplicating it here causes pain.

---

## Phase 6 — Mark the issue In Progress

```
save_issue(id: <issue-id>, state: "In Progress")
save_comment(issue_id: <issue-id>, body: "Started by Claude.\n- Worktree: <path>\n- Branch: <branch>")
```

Fetch the team's issue statuses first if you don't already know the canonical name (`In Progress` vs `In progress` etc. — use whatever the team has).

---

## Phase 7 — Execute

Implement per the approved plan, following the repo's coding conventions:

- Root `CLAUDE.md` — package manager (pnpm), worktree workflow, build invariants, the "always run from project root" rule.
- `server/CLAUDE.md` — `DockerService.getInstance()`, `ConfigurationServiceFactory`, never raw `dockerode`, all mutations carry `userId`, `Channel.*` / `ServerEvent.*` constants for Socket.IO.
- `client/CLAUDE.md` — TanStack Query owns server state, no polling when socket is connected, task tracker pattern.

Rules of taste:

- Edit existing files in preference to creating new ones.
- Don't add features, refactor surrounding code, or introduce abstractions beyond what the phase requires.
- Don't add error handling for scenarios that can't happen.
- Default to no comments. Only add a comment when the *why* is non-obvious.

Refer back to the plan doc's "Deliverables" list as you go — those are the things that have to be true at the end. If the work is bigger than the phase scoped, **stop and ask** — never silently expand scope or split phases on the fly.

---

## Phase 8 — Verify

At minimum, run the verification commands you listed in Phase 4. Typical:

```bash
pnpm build:lib                              # if lib/ changed (always required if so)
pnpm --filter mini-infra-server build       # if server/ changed
pnpm --filter mini-infra-server test        # if server/ changed
pnpm --filter mini-infra-server lint        # if server/ changed
pnpm --filter mini-infra-client build       # if client/ changed
pnpm --filter mini-infra-client test        # if client/ tests changed
```

For the Go components (`egress-gateway/`, `egress-fw-agent/`, `egress-shared/`):

```bash
go build ./...
go test ./...
```

For UI changes the user expects browser testing. **Do not re-implement what `test-dev` does** — invoke that skill, or tell the user it's the next step. Same for `diagnose-dev` if a runtime check is needed.

If something fails, fix it before continuing. Don't paper over with `--no-verify`, `--skip-tests`, or weakened assertions.

---

## Phase 9 — Update the plan doc if reality drifted

If your implementation diverged meaningfully from the plan doc — extra deliverable shipped, planned deliverable deferred, an unforeseen risk discovered — edit the plan doc in the same PR to reflect what actually happened. The plan doc is the lasting artefact; the issue closes when the PR merges.

If you didn't drift, leave the doc alone.

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

## Phase 11 — Mark the issue In Review

```
save_issue(id: <issue-id>, state: "In Review")
save_comment(issue_id: <issue-id>, body: "PR opened: <PR_URL>")
```

Then report the PR URL to the user wrapped in a `<pr-created>` tag on its own line so any UI integrations can render a card.

---

## Hard rules

These are non-negotiable. If you find yourself wanting to break one, stop and ask the user instead.

- **Never merge PRs** — even if checks pass and the PR looks great. Merging is a human decision.
- **Never create new Linear issues** or split phases on the fly. If scope is too big for one phase, stop and report — splitting is a planning decision, not an execution decision.
- **Never override plan-doc conventions.** If the plan section says "Defer X to follow-up", that X is deferred. Don't quietly include it because it seemed easy.
- **Never run `pnpm worktree-env start` yourself.** Worktree lifecycle is the user's responsibility; this skill assumes the worktree is already up.
- **Never skip pre-flight checks** by running on `main` or with a dirty tree. Stop and ask.
- **Never use `--no-verify` or skip hooks.** If a hook fails, investigate.
- **Never guess at conventions.** If the project description has no `Plan:` line, or the plan doc has no matching `### Phase N` heading, **stop and report**. The conventions exist so the skill can rely on them; bypassing them silently breaks the next run.

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
> *Skill fetches ALT-29 + parent project. Project description: `Plan: docs/planning/not-shipped/internal-nats-messaging-plan.md`. Skill reads §6 Phase 4 — Goal, Deliverables, Done when. Reads `git log` for `Phase 1`/`Phase 2`/`Phase 3` shipped commits to learn the area tag (`nats`) and PR title shape.*
>
> *Skill produces a plan keyed to the deliverables, surfaces via ExitPlanMode. User approves.*
>
> *Skill runs pre-flight, marks ALT-29 In Progress, comments. Implements per the plan. Runs verification. Drift check on plan doc — none. Commits with `feat(nats): pg-az-backup progress + result events (Phase 4, ALT-29)`. Opens PR with `Closes ALT-29`. Marks ALT-29 In Review, comments PR URL. Reports.*
