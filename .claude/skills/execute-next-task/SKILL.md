---
name: execute-next-task
description: Execution agent. Assumes you start at the main checkout root on `main` with a clean tree. Accepts an **optional issue ID** as an argument (e.g. `/execute-next-task ALT-32`) — when supplied, the skill jumps straight to that issue and skips the picking flow; when omitted, it picks the next unblocked Todo issue from the user's Linear team (Altitude Devops). Handles two ticket flavours uniformly — phased plan-doc tickets (populated by `plan-to-linear` from a markdown plan in `docs/planning/`) and standalone tickets (populated by `task-to-linear`, or filed by hand) that may have no plan-doc entry. The ticket body — Goal / Deliverables / Done-when / Relevant docs / Smoke tests — is the contract; the plan doc, when one exists, is supplemental context. Marks the issue **In Progress as soon as it's picked** (so the Linear board reflects who's working on it before any setup runs), then runs `git pull --ff-only origin main`, creates a fresh worktree at `.claude/worktrees/alt-NN` on branch `claude/alt-NN`, runs `pnpm install`, kicks off `pnpm worktree-env start --description "..."` in the background to warm the dev env, then executes the work end-to-end inside the new worktree — code changes, build/lint/unit tests, live smoke against the dev env, PR with `Closes ALT-NN`, and a final transition to In Review with a structured handoff comment (Known issues / Work deferred / Blockers / Deviations). On the success path it then spawns a Sonnet subagent that runs the `session-retrospective` skill (passing the parent session ID and the Linear issue ID), which creates a new "retro"-tagged Linear issue in the Backlog referencing the original, and **cleans up the worktree** (`pnpm worktree-env delete <slug>` + `git worktree remove`) so the VM/distro slot is freed; on any failure the worktree is left alive for investigation. **Does not produce an ExitPlanMode plan** — planning happened when the ticket was created. **Does not edit the plan doc** — drift goes only in the handoff comment for a re-integration agent to fold back later. Use this skill whenever the user says "execute next task", "what's next in linear", "do the next phase", "pick up the next todo", "work on the next thing", "what should I do next", "execute ALT-NN", "work on ALT-NN", or any equivalent request to advance through Linear-tracked work. Do NOT trigger for non-Linear tasks or for "what should I work on?" without an obvious Linear context.
---

# Execute Next Task

You're an **execution agent**. The planning has already happened — when the Linear ticket was created (by the `plan-to-linear` skill, from a phased markdown plan doc) it was populated with everything you need: Goal, Deliverables, Done when, the relevant per-component CLAUDE.md / ARCHITECTURE.md pointers, prior-art commit hints, and the conventions to follow. Your job is to read the ticket and the linked docs, set up the environment, do the work, and ship a PR. **Do not re-plan, do not stop for approval, do not produce an ExitPlanMode block.** State briefly what you're about to do (one or two sentences) before changing files so the user can interrupt if needed, then execute.

If you read the ticket and find it underspecified or contradictory, that's the only case where you stop and ask — but the populated ticket should rarely have that problem. Treat it as authoritative.

## Conventions you rely on

These conventions are maintained by the user. If they're violated for the picked task, **stop and report — never guess**.

There are two ticket flavours, and both are handled by the same flow. The shape of each is:

**Phased plan-doc tickets** (created by `plan-to-linear` from a markdown plan):

- One Linear project per feature, named after the feature.
- Project description starts with a `Plan:` line linking to a relative path, e.g. `Plan: docs/planning/not-shipped/internal-nats-messaging-plan.md`. That path is the map.
- Issue title format: `Phase N: <short title>`, where `Phase N — <title>` is also a `### Phase N — <title>` heading in the plan doc.
- Plan doc lives in `docs/planning/not-shipped/<slug>-plan.md` while any phase is unshipped. After all phases ship it moves to `docs/planning/shipped/`.
- Phases land in order via `blocked-by` relationships. Phase 2 is blocked by Phase 1, etc. The skill respects that.

**Standalone tickets** (created by `task-to-linear`, or filed by hand):

- Live under the persistent `Maintenance` project (or any project without a strict per-feature plan doc).
- Project description may have a `Plan:` line pointing to a shared evergreen doc (e.g. `docs/planning/maintenance.md`), or no `Plan:` line at all.
- Issue title may follow `Phase N: <short title>` (the `task-to-linear` convention) but isn't required to.
- The matching `### Phase N` section in the plan doc is **best-effort** — the doc may have no entry at all (legitimate when the ticket was filed directly in Linear, or when the doc has been pruned). The ticket body remains the contract either way.
- No `blocked-by` chain — these are independent.

What's true for **both** flavours, and is non-negotiable:

- The ticket body carries **Goal / Deliverables / Done when / Relevant docs / Smoke tests** sections. That's the contract you execute against.
- Commit / PR title format: `feat(<area>): <description> (Phase N, ALT-NN) (#PR)` — match the most recent shipped commit in the same project (or, for one-offs, the most recent commit touching the same component).
- PR body must include `Closes <ALT-NN>` so merging closes the Linear issue automatically.

Reference examples in this repo: `docs/planning/not-shipped/internal-nats-messaging-plan.md`, `docs/planning/not-shipped/observability-otel-tracing-plan.md`, `docs/planning/shipped/nats-app-roles-plan.md`, and the standalone `docs/planning/maintenance.md`.

The team is hardcoded as **Altitude Devops**. (A future improvement is to read this from `.claude/linear-team.json`; not built yet.)

---

## Phase 1 — Load the Linear MCP tools

The Linear MCP tools are deferred at session start. Load the toolkit in one bulk call before doing anything else:

```
ToolSearch(query: "linear", max_results: 30)
```

You should see tools like `mcp__cd9fab4e-...__list_issues`, `__get_issue`, `__get_project`, `__list_comments`, `__save_comment`, `__save_issue`, `__list_issue_statuses`. If any of these are missing, stop and tell the user — don't fall back to anything else.

---

## Phase 2 — Find the next unblocked task and claim it

The skill has two entry modes:

- **Auto-pick mode** (no argument supplied) — list Todos, filter by blocker state, pick the single unblocked candidate or ask the user to disambiguate.
- **Explicit-ID mode** (an `ALT-NN` was passed as the argument, e.g. `/execute-next-task ALT-32`) — jump straight to that issue, skipping the listing/filtering. The user has already chosen.

### 2.0 Branch on the argument

Look at the arguments the user passed to the skill. If the args contain a Linear issue identifier matching `ALT-\d+` (case-insensitive, may appear with surrounding text — e.g. `ALT-32`, `alt-32`, `pick up ALT-32`), treat that as the explicit pick and **skip the listing logic entirely**. Otherwise fall through to the auto-pick path.

#### Explicit-ID path

1. Fetch the issue with `get_issue(id: <ALT-NN>)`. If it doesn't exist (404), stop and tell the user.
2. **Soft validations.** These produce warnings, not stops — when the user names an explicit ID, they're overriding the heuristics on purpose:
   - If the issue is **not in `Todo` state** (e.g. `Backlog`, `In Progress`, `Done`), surface that to the user and ask "still proceed?" — useful for resuming a session that was interrupted, but not silently auto-resuming work the user might not realise was already shipped.
   - If the issue has **incomplete `blocked-by` relations**, list them and ask "still proceed?". Don't auto-skip — sometimes the dependency was already done in a way Linear didn't capture.
3. Once you have user confirmation (or the soft validations all passed), proceed to Phase 2.1.

State the pick the same way as the auto-pick path: id, title, project name.

#### Auto-pick path

The picking rule is **deliberately simple** — there is no priority sort, no cycle filter, no last-updated heuristic. Just: state = `Todo`, no unfinished `blocked-by`. The user maintains ordering through Linear's blocking relationships (where they exist; standalone tickets in the Maintenance project have none).

1. **List Todos** in the Altitude Devops team. Use the `list_issues` tool with `state` = `Todo` (or whatever the team's "Todo" status maps to — fetch the team's issue statuses first if you're unsure).
2. **For each candidate, check blockers.** Use `get_issue` to read its `relations` / blockers. A candidate survives if every `blocked-by` issue it has is in state `Done` or `Cancelled`. An issue with no blockers automatically survives.
3. **Decide:**
   - **0 unblocked candidates** → tell the user "Nothing to do — every Todo is blocked or no Todos exist." Stop.
   - **1 unblocked candidate** → use it. State the pick: id, title, project name.
   - **>1 unblocked candidates** → list them with `id | title | project` and ask the user to pick one. Don't infer — ask.

### 2.1 Mark it In Progress immediately

Once you have a single issue in hand — **before** reading the ticket body, before pre-flight, before anything else — flip its state and post a brief "claimed" comment. This signals on the Linear board that the work is now owned, prevents a parallel session or human reviewer from picking up the same ticket, and gives the user a timestamp for when the agent started.

```
save_issue(id: <issue-id>, state: "In Progress")
save_comment(issue_id: <issue-id>, body: "Claimed by Claude. Reading ticket and preparing the worktree — full setup details will follow once the worktree is up.")
```

Use the canonical "In Progress" name for this team (fetch via `list_issue_statuses` if you didn't already in Phase 1). The state transition is idempotent — re-running the skill on the same issue is harmless.

If, in any later phase, the skill stops with a hard-fail (malformed ticket, dirty tree, worktree collision, etc.), **leave the issue In Progress** and surface the failure to the user. Don't auto-roll-back to Todo — the user decides whether to retry, hand off, or revert state manually.

Don't move to Phase 3 until the issue is In Progress with the claim comment posted.

---

## Phase 3 — Read the ticket and linked docs

The Linear ticket body is your contract. Read it end to end and treat it as authoritative. The plan doc, when one exists and matches, is supplemental context — useful for understanding how the phase fits into a larger arc — but the ticket is what you execute against.

1. **Fetch the issue body.** Look for the standard sections written by `plan-to-linear` / `task-to-linear`:
   - **Source** — the plan-doc path and phase anchor (may be absent on hand-filed tickets).
   - **Goal**, **Deliverables**, **Done when** — the work to do. **Required.**
   - **Relevant docs** — the per-component CLAUDE.md / ARCHITECTURE.md pointers, plus any topic-specific architecture docs.
   - **Smoke tests** — what to run at the end to validate.
   - **Conventions** — commit/PR format, area tag, deferrals.

   If **Goal / Deliverables / Done when** are missing, **stop and report** — the ticket wasn't populated correctly. Don't paper over it. The other sections are nice-to-have; their absence is a soft signal, not a stop condition.

2. **Try to fetch the parent project's `Plan:` line.** Use `get_project` to read the project description. The skill accepts three forms:
   - `Plan: [docs/planning/.../<slug>.md](https://github.com/.../blob/main/...)` — combined (preferred; what `plan-to-linear` and `task-to-linear` write today)
   - `Plan: docs/planning/.../<slug>.md` — bare path (legacy fallback)
   - `**Plan doc:** [docs/planning/.../<slug>.md](https://...)` — also accepted as a legacy fallback for projects authored before the convention firmed up

   Extract the **relative path** if any form matches. **No `Plan:` line is fine** — that's a legitimate state for projects whose tickets are self-contained (e.g. the `Maintenance` project). Don't stop; just note "no plan doc" in your internal scratchpad and skip step 3.

   If a `Plan:` line is present but its path conflicts with the ticket's **Source** section (the ticket cites a different doc), **stop** — that's a corruption signal worth surfacing.

3. **If a plan doc was located, read its matching `### Phase N` section** — best-effort. Three sub-cases:
   - **Section present and consistent with the ticket** → use it as supplemental context. If the ticket and the doc have drifted, side with the **ticket body** (it's the executable contract) and capture the drift in your handoff comment (Phase 12) so a re-integration agent can fold it back later.
   - **Section missing entirely** → not fatal. The plan doc may have been pruned, or the ticket was filed directly in Linear and the doc never recorded it. Note it in your scratchpad and proceed with the ticket body alone.
   - **Plan doc itself missing on disk** → same as above. Proceed.

4. **Read every doc the ticket lists under "Relevant docs."** Don't skim — these were chosen because they're the conventions you must follow. The ticket points at them so you don't have to guess what's relevant.

5. **Skim prior comments for a designer hand-off.** Call `list_comments(issueId: <ALT-NN>)` and look for a comment from the `design-task` skill — its body starts with `**Design ready (PR open):**` or `**Design ready:**` and links to a design PR plus a doc path under `docs/designs/`. If you find one:
   - **Expect a design doc + sibling SVG wireframes from the designer.** The doc lives at `docs/designs/<design-issue-id>-<slug>.md`; option-A and option-B wireframes (when the ticket has a UI surface) live next to it as `<base>-option-a.svg` / `<base>-option-b.svg`. The doc commits to a recommendation (Option A or B) — that recommendation is the design contract for fields the ticket body leaves under-specified (component layout, file/component sketch, key abstractions, named error wording, configured-state lifecycle).
   - **Find the files.** If the design PR has merged (the design ticket auto-closes via its `Closes <design-ALT>` line), the doc + SVGs are on `main` and you read them at the relative path. If the design PR is still open, fetch it (`gh pr checkout <design-PR>` is overkill — instead read the file at the design branch via `gh pr view <design-PR> --json headRefName -q .headRefName`, then `git fetch origin <branch> && git show origin/<branch>:docs/designs/<filename>.md`). If the design PR is open and you can't find the file, **stop and ask** — the ticket says design exists but the artefact doesn't, which is a contradiction worth surfacing rather than guessing past.
   - **Read the doc end-to-end before any code changes.** Pay particular attention to: the **Recommendation** (which option won), the **Key abstractions** + **File / component sketch** (these name files and types the implementation should produce), the **Implementation outline** (a rough order of operations), and the **States, failure modes & lifecycle** section if present (specific error categories and wording the executor should follow verbatim, plus per-field reversibility classifications). The **Open questions** section names choices the design didn't resolve — flag those in your handoff comment (Phase 12) if you ended up making a call on one.
   - **No designer comment found** → fine. The ticket either had no UI surface, the design phase was skipped, or the design pre-dates this convention. Proceed without.

6. **Read prior art** — `git log --oneline -20 main` plus any commits matching the project's area tag from the ticket. Shipped commits tell you the commit subject style and the rough size of a phase/task PR.

---

## Phase 4 — Set up the worktree (delegated to `setup-worktree`)

The pre-flight, pull, worktree creation, `pnpm install`, and the backgrounded `pnpm worktree-env start` are all owned by the **`setup-worktree`** skill (its own SKILL.md is the single source of truth for the mechanics). Invoke it via the `Skill` tool with the picked Linear issue ID:

```
Skill(skill: "setup-worktree", args: "<ALT-NN>")
```

If the picked phase is **docs-only** (only touches `docs/`, a README, or a SKILL.md — no smoke tests will need a running env), pass `--no-env` so the skill skips the dev-env spin-up:

```
Skill(skill: "setup-worktree", args: "<ALT-NN> --no-env")
```

When the skill returns successfully, you'll be `cd`ed into `.claude/worktrees/<slug>`, dependencies installed, and the env warming in the background (or skipped). The current working directory is the worktree for the rest of this run; the slug is `alt-<NN>` (lowercase) and the branch is `claude/<slug>`.

If `setup-worktree` stops — dirty tree, non-default branch, worktree/branch collision, `pnpm install` failure — surface the failure and stop. Don't auto-recover. The issue is already In Progress from Phase 2.1; leave it that way per the hard rule on auto-rollback (the user decides whether to retry, hand off, or revert state).

---

## Phase 7 — Post the worktree details to Linear

The state transition already happened in Phase 2.1 (right after the pick) — at this point the issue is In Progress and there's a "claimed" comment. Now that the worktree exists, the env-startup is backgrounded, and `pnpm install` has finished, post a follow-up comment with the concrete details so anyone reading the ticket knows where the work is happening:

```
save_comment(issue_id: <issue-id>, body: "Worktree ready.\n- Worktree: <path>\n- Branch: <branch>\n- Env startup: backgrounded (`pnpm worktree-env start`)")
```

If the phase is **docs-only** and the dev-env spin-up was skipped (you passed `--no-env` to `setup-worktree`), drop the env-startup line.

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

## Phase 10 — Commit and push

Smoke tests passed. Commit the implementation and push the branch so the work is safely on the remote before the PR is opened. Code review is a separate concern — the user runs the `/review` skill against the PR or Linear ticket on their own cadence after this phase ships.

### 10.1 Commit the implementation

Match the most recent shipped commit format from the same project (or, for one-offs, the most recent commit touching the same component). Typical:

```
feat(<area>): <short description> (Phase N, ALT-NN)
```

The area tag (`nats`, `egress`, `monitoring`, `docs`, etc.) follows what previous commits used. Commit body:

```
<one or two paragraphs explaining what changed and why,
 in the same voice as recent commits on main>

Co-Authored-By: <as configured>
```

Stage and commit. Don't push yet — keep all of 10.1's commits local until 10.2 so a single push lands them together.

### 10.2 Push the branch

```bash
git push -u origin claude/<slug>
```

`-u` sets upstream so subsequent `git push` calls are bare. The work is now safe on the remote.

---

## Phase 11 — Open the PR

The branch is committed and pushed. Now create the PR:

```bash
gh pr create --title "<commit subject from Phase 10.1>" --body @- <<'EOF'
## Summary
- <1-3 bullets describing the change>

## Test plan
- [<checklist item>]

Closes ALT-NN
EOF
```

PR title matches the implementation commit's subject. PR body must:

- Have a Summary section (1–3 bullets) describing the change.
- Have a Test plan section (markdown checklist).
- **Include `Closes ALT-NN` on its own line** so merging the PR auto-closes the Linear issue.
- Match the format used in recent PRs on this repo (look at `gh pr list --limit 5` for tone).

---

## Phase 12 — Mark the issue In Review and leave a structured handoff comment

Move the issue to `In Review` (canonical state name from Phase 1's status fetch) and post a single structured comment summarising the run. The comment is the handoff to the human reviewer — and, when a plan doc was loaded, to the future re-integration agent that will fold drift back into it — so it captures everything the PR diff doesn't show. **The plan doc itself is read-only for this skill** (see hard rules); drift goes here.

```
save_issue(id: <issue-id>, state: "In Review")
save_comment(issue_id: <issue-id>, body: <handoff comment, see template below>)
```

Use this template. Omit any section that genuinely has nothing to report — don't pad with "N/A" or "none". If every section is empty, the comment is just the PR link.

```markdown
**PR:** <PR_URL>

## Known issues
<failing tests you couldn't fix in scope, brittleness you noticed but didn't address, anything the reviewer should be aware of when looking at the diff. One bullet each.>

## Work deferred
<deliverables from the ticket that were scoped down, or follow-ups identified along the way that should become their own issues. Reference the ticket / plan-doc line that says they can be deferred if applicable.>

## Blockers
<things that stopped you finishing some part of the work — missing credentials, an upstream bug in another component, a dependency on infrastructure that isn't there. Empty if nothing blocked you.>

## Deviations from the spec
<places where what you shipped diverges from the ticket's Deliverables or Done-when (and, if a plan doc was loaded in Phase 3, from its `### Phase N` section). For each: what the spec said, what you shipped, why. When a plan doc is in play, this section is also the input a re-integration agent uses to fold the drift back into the doc — keep it precise. **Omit this section entirely** when there's no spec drift to report.>
```

If Phase 3 found no plan doc (standalone ticket), the handoff still uses this template — the "Deviations from the spec" wording covers both cases. There's just no re-integration agent involvement to plan for; the comment is purely for the human reviewer.

Then report the PR URL to the user wrapped in a `<pr-created>` tag on its own line so any UI integrations can render a card.

The point of this comment is that the next person (human or agent) opens the Linear issue and sees the full state of what shipped without having to read the diff or guess. If it's empty across the board, that's a great sign — but don't fabricate content to fill it.

---

## Phase 13 — Post a session retrospective to Linear (success path only)

After the handoff comment is posted but before worktree cleanup, kick off a session retrospective. The `session-retrospective` skill creates a **new** "retro"-tagged Linear issue in the Backlog, linked back to the issue you just shipped — so retros accumulate as their own searchable list with their own lifecycle, separate from the contract-style handoff comment on the original ticket. Future runs of this skill (and the user, scanning retros over time) can mine that trail for lessons.

If anything earlier in the run failed and the skill stopped, this phase doesn't fire — there's no successful run to retrospect on, and the human will be debugging the failure directly. Only the success path reaches Phase 13.

### 13.1 Capture the parent session ID

The retrospective skill takes the session ID as an explicit parameter rather than reading `$CLAUDE_SESSION_ID`, because it's invoked from a subagent and a subagent's `$CLAUDE_SESSION_ID` points at its own (effectively empty) session, not the parent's. Capture your own session ID here so you can pass it through:

```bash
echo "$CLAUDE_SESSION_ID"
```

Hold onto the value alongside the picked Linear issue ID (`ALT-NN` from Phase 2). These two are the parameters Phase 13.2 passes to the subagent.

### 13.2 Spawn a Sonnet subagent that invokes the skill

Use the `Agent` tool with `subagent_type: general-purpose` and `model: sonnet`. Sonnet is the right tier — by this point the parent context is huge (full task history, code reads, tool results), and Opus on top of that just to summarize JSONL is wasteful. Sonnet handles the analysis comfortably, and the heavy lifting (JSONL reads, MCP calls) stays scoped to the subagent so it doesn't bloat the parent thread. Only the new retro issue's URL flows back across the subagent boundary.

Prompt the subagent (substitute the captured session ID and the Linear issue ID):

```
Invoke the session-retrospective skill with these parameters:

  --session-id <PARENT_SESSION_ID>     (the parent's session ID captured in Phase 13.1)
  --linear-issue <ALT-NN>              (the Linear issue this run was working on)

The skill will:
  1. Run scripts/get-session.sh <PARENT_SESSION_ID> to fetch the parent JSONL.
  2. Analyze it and generate retrospective markdown per the skill's Output Format.
  3. Create a NEW Linear issue in the Altitude Devops team's Backlog, tagged "retro",
     titled "Retro: <ALT-NN> — <original-issue-title>", with a Source link back to
     <ALT-NN> at the top of the description.
  4. After the retro issue is created, link it to <ALT-NN> using Linear's `relatedTo`
     relation (via `save_issue` on the new retro issue with a `relations` entry of
     type `related` targeting <ALT-NN>'s issue ID). This creates a first-class
     "Related" edge between the two issues so anyone viewing <ALT-NN> in Linear sees
     the retro in the side panel, not just buried in the description body. The
     in-body Source link stays — it survives if the relation is later deleted, and
     it's the clickable target most readers reach for first — but the relation is
     the structured, queryable link.

Return ONLY the new retro issue's URL. Do NOT return the markdown body.
```

The skill itself owns the Linear posting (team / state / label resolution, `save_issue`) — the parent doesn't need to do anything else with the result.

### 13.3 Relay the retro issue URL in the run report

When the subagent returns the URL, append it to your final run report so the user can navigate to it directly. The structured handoff comment (Phase 12) and the retro issue (Phase 13) are deliberately separate Linear records — the handoff is the contract for the human reviewer of the PR; the retro is meta-feedback about the run itself, with a different audience and shelf-life.

### 13.4 Failure handling

The retrospective is a feedback loop, not a gate. If the subagent fails — script can't find the session, the `retro` label doesn't exist in Linear, the subagent returns garbage instead of a URL, the Linear MCP errors — **don't block cleanup**. Note the failure in the run report and continue to Phase 14. A broken or hollow retro issue is worse than no retro issue.

---

## Phase 14 — Clean up the worktree (success path only, delegated to `finish-worktree`)

**Only run this if every previous phase succeeded** — build/lint/unit passed, smoke passed, the PR is open, the issue is In Review, the handoff comment posted. If anything failed or stopped earlier, **skip this phase entirely** and leave the worktree alive so the user can investigate. The retrospective phase (13) is best-effort and doesn't gate this — a failed retrospective still counts as a successful run.

The worktree's purpose is to host the build + smoke for this phase. Once the PR is open and in review, the work that needs the dev env is over — review happens in GitHub on the diff, not in the worktree. Tear it down to free the VM/distro slot and keep `pnpm worktree-env list` tidy.

The mechanics (cd back to root, `pnpm worktree-env delete`, `git worktree remove`, defensive checks for uncommitted/unpushed work) are owned by the **`finish-worktree`** skill. Invoke it with the slug from Phase 4:

```
Skill(skill: "finish-worktree", args: "<slug>")
```

The skill `cd`s back to the repo root, runs `pnpm worktree-env delete <slug> --force`, then `git worktree remove .claude/worktrees/<slug>`. The remote `claude/<slug>` branch stays untouched — that's where the PR points; it must remain.

If `finish-worktree`'s defensive checks flag uncommitted changes, unpushed commits, or a missing PR, that's a real signal — something went wrong earlier in this run. Don't push past the warning; surface it to the user and stop. Cleanup can be retried after the discrepancy is resolved.

If review feedback arrives later and the worktree needs to come back, the user can recreate it from the same branch — `finish-worktree`'s SKILL.md walks through that case.

Append a final line to the run report:

```
✓ Cleaned up worktree .claude/worktrees/<slug> and the dev-env VM.
```

**Macos users** who run the bulk `pnpm worktree-env cleanup` command (or installed the hourly launchd agent) can rely on that to clean merged-PR worktrees on a schedule and skip this phase by interrupting the skill before it runs. For Windows / WSL2 users without an equivalent agent, this phase is the cleanup mechanism.

---

## Hard rules

These are non-negotiable. If you find yourself wanting to break one, stop and ask the user instead.

- **Never produce an ExitPlanMode block.** This is an execution agent. Planning happened when the ticket was created (in `plan-to-linear` for phased tickets, in `task-to-linear` for standalone ones, or by the user filing it directly).
- **Never run Phase 14 (cleanup) on a failure path.** If smoke failed, the PR didn't open, the In Review transition didn't go through, or you stopped to ask the user mid-phase — leave the worktree alive. The user needs it to investigate. Cleanup is the *reward* for a fully successful run. (Phase 13, the retrospective, also only runs on the success path, but a failure inside Phase 13 itself does not block Phase 14 — the retrospective is best-effort.)
- **Never edit the plan doc.** When a plan doc was loaded in Phase 3, the doc under `docs/planning/` is read-only for this skill. If your implementation drifts from the spec, capture the drift in the handoff comment (Phase 12 — Deviations from the spec section). A separate re-integration agent will fold those notes back into the plan doc; don't pre-empt that. (When no plan doc was loaded, this rule is vacuous — there's nothing to edit.)
- **Never auto-roll-back the In Progress transition.** Phase 2.1 marks the issue In Progress before any other work begins. If the run later hard-fails, leave it In Progress and report — don't quietly flip it back to Todo. The user decides whether to retry, hand off, or revert state.
- **Never merge PRs** — even if checks pass and the PR looks great. Merging is a human decision.
- **Never create new Linear issues** or split phases on the fly. If scope is too big for one phase, stop and report — splitting is a planning decision, not an execution decision.
- **Never override the ticket's Deferrals.** If the ticket (or its plan-doc section, when one exists) says "Defer X to follow-up", that X is deferred. Don't quietly include it because it seemed easy.
- **Never `git checkout main`, `git stash`, or create a new branch outside the delegated worktree flow.** Worktree creation is owned by `setup-worktree` (Phase 4) and cleanup by `finish-worktree` (Phase 14); this skill does no other branch manipulation. Once inside the worktree, you stay on `claude/<slug>` until cleanup.
- **Never skip pre-flight checks** by running on `main` or with a dirty tree. `setup-worktree` enforces this — if it stops, surface the failure.
- **Never use `--no-verify` or skip hooks.** If a hook fails, investigate.
- **Never guess at the contract.** If the ticket has no Goal/Deliverables/Done-when sections, **stop and report** — the ticket wasn't populated correctly. (A missing `Plan:` line on the project, or a missing `### Phase N` section in the plan doc, is *not* a stop condition under the looser flow — see Phase 3 for the rules.)

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
> *Skill immediately marks ALT-29 In Progress and posts a "Claimed by Claude. Reading ticket and preparing the worktree…" comment (Phase 2.1) so the Linear board reflects the claim before any setup runs.*
>
> *Skill fetches ALT-29 + parent project. Project description: `Plan: [docs/planning/not-shipped/internal-nats-messaging-plan.md](https://github.com/...)`. Skill reads the ticket body (Goal, Deliverables, Done when, Relevant docs, Smoke tests). The plan-doc resolves and its `### Phase 4` section matches the ticket — read as supplemental context. Reads each linked CLAUDE.md / ARCHITECTURE.md. Reads `git log` for `Phase 1`/`Phase 2`/`Phase 3` shipped commits to learn the area tag (`nats`) and PR title shape.*
>
> *Phase 4: invokes `Skill(setup-worktree, args: "ALT-29")`. The setup-worktree skill pre-flights main, runs `git pull --ff-only origin main`, creates the worktree at `.claude/worktrees/alt-29` on `claude/alt-29`, runs `pnpm install` synchronously, then backgrounds `pnpm worktree-env start --description "Phase 4 — pg-az-backup progress + result events"` (description derived from the Linear title). Returns control with cwd = the worktree. Skill posts the worktree-details follow-up comment on ALT-29.*
>
> Skill: "Implementing Phase 4 — adding `mini-infra.backup.run` request handler and JetStream `BackupHistory` stream. Touching `server/src/services/backup/backup-executor.ts` first, then `server/src/services/nats/payload-schemas.ts`, then the boot sequence."
>
> *Implements. Runs build/lint/unit tests. Backgrounded env is up by now — runs the ticket's smoke test (publish a test backup-run request, confirm the consumer side fires).*
>
> *Phase 10: commits with `feat(nats): pg-az-backup progress + result events (Phase 4, ALT-29)`, pushes the branch with `-u`. Code review is left to a separate `/review` run that the user kicks off after the PR is open.*
>
> *Phase 11: opens PR with the implementation commit's title and `Closes ALT-29` in the body.*
>
> *Phase 12: marks ALT-29 In Review. Posts the handoff comment: PR URL, plus a Deviations section noting that the optional retry-on-transient-failure deliverable was deferred to a follow-up issue per the plan doc's wording. The plan doc itself is left untouched; the re-integration agent will fold the Deviations back later. Reports the PR URL.*
>
> *Phase 13: captures `$CLAUDE_SESSION_ID` (the parent session), spawns a `general-purpose` subagent on Sonnet, and tells it to invoke the `session-retrospective` skill with `--session-id <parent-id> --linear-issue ALT-29`. The skill loads the Linear MCP, runs `scripts/get-session.sh` against the parent JSONL, generates retrospective markdown, resolves the Altitude Devops team / Backlog state / `retro` label, and creates a new issue `ALT-42 — Retro: ALT-29 — Phase 4: pg-az-backup progress + result events` with the markdown body and a Source link back to ALT-29. Then adds a `relatedTo` relation between ALT-42 and ALT-29 so both issues show the link in their Linear side panel. Subagent returns the URL of ALT-42; skill appends it to the run report.*
>
> *Phase 14: every prior phase succeeded, so the skill invokes `Skill(finish-worktree, args: "alt-29")`. The finish-worktree skill verifies the tree is clean, the branch is fully pushed, and the PR exists; then `cd`s back to the repo root, runs `pnpm worktree-env delete alt-29 --force` and `git worktree remove .claude/worktrees/alt-29`. Reports cleanup done. The `claude/alt-29` branch stays on the remote (the PR points at it).*
