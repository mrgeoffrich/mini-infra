---
name: execute-next-task
description: Execution agent. Assumes you start at the main checkout root on `main` with a clean tree. Accepts an **optional issue ID** as an argument (e.g. `/execute-next-task MINI-32`, or a bare `32` which `mk` resolves against the current repo's prefix) — when supplied, the skill jumps straight to that issue and skips the picking flow; when omitted, it picks the next unblocked `todo` issue in the current repo via `mk issue list --state todo -o json`. Handles two ticket flavours uniformly — phased plan-doc tickets (populated by `plan-to-mk` from a markdown plan in `docs/planning/`) and standalone tickets (populated by `task-to-mk`, or filed by hand) that may have no plan-doc entry. The ticket body — Goal / Deliverables / Done-when / Relevant docs / Smoke tests — is the contract; the plan doc, when one exists, is supplemental context. Marks the issue **`in_progress` as soon as it's picked** (so the mk board reflects who's working on it before any setup runs), then runs `git pull --ff-only origin main`, creates a fresh worktree at `.claude/worktrees/mini-NN` on branch `claude/mini-NN`, runs `pnpm install`, kicks off `pnpm worktree-env start --description "..."` in the background to warm the dev env, then executes the work end-to-end inside the new worktree — code changes, build/lint/unit tests, live smoke against the dev env, PR with `Closes MINI-NN`, and a final transition to `in_review` with a structured handoff comment (Known issues / Work deferred / Blockers / Deviations). On the success path it then spawns a Sonnet subagent that runs the `session-retrospective` skill (passing the parent session ID and the mk issue ID), which creates a new "retro"-tagged mk issue in `backlog` referencing the original, and **cleans up the worktree** (`pnpm worktree-env delete <slug>` + `git worktree remove`) so the VM/distro slot is freed; on any failure the worktree is left alive for investigation. **Does not produce an ExitPlanMode plan** — planning happened when the ticket was created. **Does not edit the plan doc** — drift goes only in the handoff comment for a re-integration agent to fold back later. Use this skill whenever the user says "execute next task", "what's next", "do the next phase", "pick up the next todo", "work on the next thing", "what should I do next", "execute MINI-NN", "work on MINI-NN", or any equivalent request to advance through mk-tracked work. Do NOT trigger for tasks that aren't tracked in mk or for "what should I work on?" without an obvious mk context.
---

# Execute Next Task

You're an **execution agent**. The planning has already happened — when the mk ticket was created (by the `plan-to-mk` skill, from a phased markdown plan doc) it was populated with everything you need: Goal, Deliverables, Done when, the relevant per-component CLAUDE.md / ARCHITECTURE.md pointers, prior-art commit hints, and the conventions to follow. Your job is to read the ticket and the linked docs, set up the environment, do the work, and ship a PR. **Do not re-plan, do not stop for approval, do not produce an ExitPlanMode block.** State briefly what you're about to do (one or two sentences) before changing files so the user can interrupt if needed, then execute.

If you read the ticket and find it underspecified or contradictory, that's the only case where you stop and ask — but the populated ticket should rarely have that problem. Treat it as authoritative.

## Conventions you rely on

These conventions are maintained by the user. If they're violated for the picked task, **stop and report — never guess**.

There are two ticket flavours, and both are handled by the same flow. The shape of each is:

**Phased plan-doc tickets** (created by `plan-to-mk` from a markdown plan):

- One mk feature per high-level feature, slug derived from the feature name.
- Feature description starts with a `Plan:` line linking to a relative path, e.g. `Plan: docs/planning/not-shipped/internal-nats-messaging-plan.md`. That path is the map.
- Issue title format: `Phase N: <short title>`, where `Phase N — <title>` is also a `### Phase N — <title>` heading in the plan doc.
- Plan doc lives in `docs/planning/not-shipped/<slug>-plan.md` while any phase is unshipped. After all phases ship it moves to `docs/planning/shipped/`.
- Phases land in order via `blocks` relations. Phase 2 is blocked by Phase 1, etc. The skill respects that.

**Standalone tickets** (created by `task-to-mk`, or filed by hand):

- Live under the persistent `maintenance` feature (or any feature without a strict per-feature plan doc), or with no feature at all.
- Feature description (when there is one) may have a `Plan:` line pointing to a shared evergreen doc (e.g. `docs/planning/maintenance.md`), or no `Plan:` line at all.
- Issue title may follow `Phase N: <short title>` (the `task-to-mk` convention) but isn't required to.
- The matching `### Phase N` section in the plan doc is **best-effort** — the doc may have no entry at all (legitimate when the ticket was filed directly via `mk`, or when the doc has been pruned). The ticket body remains the contract either way.
- No `blocks` chain — these are independent.

What's true for **both** flavours, and is non-negotiable:

- The ticket body carries **Goal / Deliverables / Done when / Relevant docs / Smoke tests** sections. That's the contract you execute against.
- Commit / PR title format: `feat(<area>): <description> (Phase N, MINI-NN) (#PR)` — match the most recent shipped commit in the same feature (or, for one-offs, the most recent commit touching the same component).
- PR body must include `Closes MINI-NN` so merging closes the mk issue automatically. (`mk` does not auto-flip state on PR merge — you transition to `in_review` explicitly in Phase 12; the `Closes` line is for the human reviewer's audit trail and any future GitHub-Issues mirror.)

Reference examples in this repo: `docs/planning/not-shipped/internal-nats-messaging-plan.md`, `docs/planning/not-shipped/observability-otel-tracing-plan.md`, `docs/planning/shipped/nats-app-roles-plan.md`, and the standalone `docs/planning/maintenance.md`.

There is no team concept — `mk` auto-scopes by the current repo (the `cwd`'s git toplevel). The repo's prefix in this checkout is **MINI**; verify with `mk status` if you're ever unsure.

---

## Phase 1 — Verify `mk` is available and confirm the repo

The `mk` skill is auto-discovered as a project skill. Before doing anything else, confirm the binary is available and that `cwd` resolves to the right repo:

```bash
mk status -o json
```

You should see a JSON blob with the repo's prefix (`MINI`) and per-state issue counts. If `mk` errors with "not inside a git repository", `cd` to the repo root and retry. If `mk --help` itself fails, stop and tell the user — don't fall back to anything else.

**Critical agent-mode rules** (these apply to every `mk` call you make in this run):

- **Always pass `--user Claude` on every mutating command** (`mk issue add`, `mk issue state`, `mk issue edit`, `mk comment add`, `mk tag add`, `mk link`, `mk pr attach`). Without it the audit log silently attributes the change to the current user.
- **Always pass `--as Claude` on `mk comment add`** — required by the binary.
- **Always pass `-o json` when parsing output.** Text mode is for humans only.
- **Always pass long text via `--description-file <path>` / `--body-file <path>` / `--body -` (stdin).** There is no inline editor; inline `\n` is not interpreted.

---

## Phase 2 — Find the next unblocked task and claim it

The skill has two entry modes:

- **Auto-pick mode** (no argument supplied) — list `todo` issues, filter by blocker state, pick the single unblocked candidate or ask the user to disambiguate.
- **Explicit-ID mode** (a `MINI-NN` was passed as the argument, e.g. `/execute-next-task MINI-32`, or a bare `32`) — jump straight to that issue, skipping the listing/filtering. The user has already chosen.

### 2.0 Branch on the argument

Look at the arguments the user passed to the skill. If the args contain an mk issue identifier matching `MINI-\d+` (case-insensitive, may appear with surrounding text — e.g. `MINI-32`, `mini-32`, `pick up MINI-32`) or a bare integer (`32`), treat that as the explicit pick and **skip the listing logic entirely**. Otherwise fall through to the auto-pick path.

#### Explicit-ID path

1. Fetch the issue with `mk issue show <KEY> -o json` (a bare number works — `mk` resolves it against the current repo's prefix). If it doesn't exist, the command exits non-zero — stop and tell the user.
2. **Soft validations.** These produce warnings, not stops — when the user names an explicit ID, they're overriding the heuristics on purpose:
   - If the issue is **not in `todo` state** (e.g. `backlog`, `in_progress`, `done`), surface that to the user and ask "still proceed?" — useful for resuming a session that was interrupted, but not silently auto-resuming work the user might not realise was already shipped.
   - If the issue has **incomplete `blocks` relations pointing in** (i.e. another open issue blocks this one), list them and ask "still proceed?". The JSON from `mk issue show` exposes both directions of the relation — look for any `blocks`-typed edge whose other side is in a non-terminal state (`backlog`, `todo`, `in_progress`, `in_review`). Don't auto-skip — sometimes the dependency was already done in a way the relation didn't capture.
3. Once you have user confirmation (or the soft validations all passed), proceed to Phase 2.1.

State the pick the same way as the auto-pick path: id, title, feature slug.

#### Auto-pick path

The picking rule is **deliberately simple** — there is no priority sort, no cycle filter, no last-updated heuristic. Just: state = `todo`, no unfinished `blocks` edge pointing in. The user maintains ordering through `mk` blocking relationships (where they exist; standalone tickets in the `maintenance` feature have none).

1. **List Todos** in the current repo with `mk issue list --state todo -o json`.
2. **For each candidate, check blockers.** Use `mk issue show <KEY> -o json` to read its relations. The JSON exposes both sides of every relation — a candidate is unblocked if every incoming `blocks` edge originates from an issue in `done`, `cancelled`, or `duplicate` state. An issue with no incoming `blocks` edges automatically survives.
3. **Decide:**
   - **0 unblocked candidates** → tell the user "Nothing to do — every `todo` is blocked or no `todo`s exist." Stop.
   - **1 unblocked candidate** → use it. State the pick: id, title, feature slug.
   - **>1 unblocked candidates** → list them with `id | title | feature` and ask the user to pick one. Don't infer — ask.

### 2.1 Mark it `in_progress` immediately

Once you have a single issue in hand — **before** reading the ticket body, before pre-flight, before anything else — flip its state and post a brief "claimed" comment. This signals on the mk board that the work is now owned, prevents a parallel session or human reviewer from picking up the same ticket, and gives the user a timestamp for when the agent started.

```bash
mk issue state MINI-NN in_progress --user Claude

printf 'Claimed by Claude. Reading ticket and preparing the worktree — full setup details will follow once the worktree is up.\n' \
  | mk comment add MINI-NN --as Claude --user Claude --body -
```

The state transition is idempotent — re-running the skill on the same issue is harmless.

If, in any later phase, the skill stops with a hard-fail (malformed ticket, dirty tree, worktree collision, etc.), **leave the issue `in_progress`** and surface the failure to the user. Don't auto-roll-back to `todo` — the user decides whether to retry, hand off, or revert state manually.

Don't move to Phase 3 until the issue is `in_progress` with the claim comment posted.

---

## Phase 3 — Read the ticket and linked docs

The mk ticket body is your contract. Read it end to end and treat it as authoritative. The plan doc, when one exists and matches, is supplemental context — useful for understanding how the phase fits into a larger arc — but the ticket is what you execute against.

1. **Fetch the issue body** with `mk issue show MINI-NN -o json` and look for the standard sections written by `plan-to-mk` / `task-to-mk`:
   - **Source** — the plan-doc path and phase anchor (may be absent on hand-filed tickets). Stored as a relative path in the ticket body — there's no separate "Source" link field on the issue, just text in the description.
   - **Goal**, **Deliverables**, **Done when** — the work to do. **Required.**
   - **Relevant docs** — the per-component CLAUDE.md / ARCHITECTURE.md pointers, plus any topic-specific architecture docs.
   - **Smoke tests** — what to run at the end to validate.
   - **Conventions** — commit/PR format, area tag, deferrals.

   If **Goal / Deliverables / Done when** are missing, **stop and report** — the ticket wasn't populated correctly. Don't paper over it. The other sections are nice-to-have; their absence is a soft signal, not a stop condition.

2. **Try to fetch the parent feature's `Plan:` line.** If the issue's JSON exposes a `feature` slug, run `mk feature show <slug> -o json` and read its description. The skill accepts three forms:
   - `Plan: [docs/planning/.../<slug>.md](https://github.com/.../blob/main/...)` — combined (preferred; what `plan-to-mk` and `task-to-mk` write today)
   - `Plan: docs/planning/.../<slug>.md` — bare path (legacy fallback)
   - `**Plan doc:** [docs/planning/.../<slug>.md](https://...)` — also accepted as a legacy fallback for features authored before the convention firmed up

   Extract the **relative path** if any form matches. **No `Plan:` line is fine** — that's a legitimate state for features whose tickets are self-contained (e.g. the `maintenance` feature). Don't stop; just note "no plan doc" in your internal scratchpad and skip step 3.

   If a `Plan:` line is present but its path conflicts with the ticket's **Source** section (the ticket cites a different doc), **stop** — that's a corruption signal worth surfacing.

3. **If a plan doc was located, read its matching `### Phase N` section** — best-effort. Three sub-cases:
   - **Section present and consistent with the ticket** → use it as supplemental context. If the ticket and the doc have drifted, side with the **ticket body** (it's the executable contract) and capture the drift in your handoff comment (Phase 12) so a re-integration agent can fold it back later.
   - **Section missing entirely** → not fatal. The plan doc may have been pruned, or the ticket was filed directly via `mk` and the doc never recorded it. Note it in your scratchpad and proceed with the ticket body alone.
   - **Plan doc itself missing on disk** → same as above. Proceed.

4. **Read every doc the ticket lists under "Relevant docs."** Don't skim — these were chosen because they're the conventions you must follow. The ticket points at them so you don't have to guess what's relevant.

5. **Fetch every mk doc linked to the issue and to the parent feature.** This is how `design-task` and `plan-to-mk` deliver supplemental context (design exploration with recommendation; plan-doc snapshot for the larger arc). The link is the machine-readable contract — read all of them.

   ```bash
   # Issue-level docs (designs, ad-hoc references attached by hand)
   ISSUE_DOCS=$(mk issue show MINI-NN -o json | jq -r '.documents[]?.document_filename')

   # Feature-level docs (plan doc, vendor refs, architecture pointers)
   FEATURE_SLUG=$(mk issue show MINI-NN -o json | jq -r '.issue.feature_slug // empty')
   FEATURE_DOCS=""
   if [ -n "$FEATURE_SLUG" ]; then
     FEATURE_DOCS=$(mk feature show "$FEATURE_SLUG" -o json | jq -r '.documents[]?.document_filename')
   fi

   # Read each one (no metadata, just content):
   for doc in $ISSUE_DOCS $FEATURE_DOCS; do
     echo "==== $doc ===="
     mk doc show "$doc" --raw
   done
   ```

   **What you'll typically find:**
   - **Issue-linked, type `designs`** → the design doc from `design-task`. Its **Recommendation** + **Key abstractions** + **File / component sketch** + **States, failure modes & lifecycle** sections are part of the contract. Its **Open questions** section names choices the design didn't resolve — flag those in your Phase 12 handoff comment if you ended up making a call on one.
   - **Feature-linked, type `project_in_planning` / `project_complete`** → the plan doc snapshot. This is a synchronised mirror of the on-disk plan doc — same content as reading `docs/planning/.../<slug>-plan.md` directly. Use it as supplemental context for the larger arc; the ticket body still wins on what specifically has to ship.

   **SVG wireframes are also linked as `designs`-typed docs** (filenames end in `.svg`). Normal case: by the time this skill runs the design PR has merged and the SVGs are already in the worktree at `docs/designs/<filename>-option-a.svg` etc. — just read them. Edge case: if the SVG is linked in mk but missing from disk (executor was unblocked manually before the design PR merged, or the SVG was excluded from the design commit by accident), materialise it from mk before reading. The mk doc filename mirrors the on-disk path with `/` → `-` (e.g. `docs-designs-mini-38-foo-option-a.svg` ↔ `docs/designs/mini-38-foo-option-a.svg`):

   ```bash
   for doc in $ISSUE_DOCS $FEATURE_DOCS; do
     case "$doc" in
       docs-*.svg)
         # Reverse the `/` → `-` translation that --from-path applied. Only the first
         # two dashes are slashes (docs-<type>-…); the rest of the filename can contain
         # legitimate dashes (e.g. `option-a`).
         on_disk=$(echo "$doc" | sed -E 's|^docs-([^-]+)-|docs/\1/|')
         if [ ! -f "$on_disk" ]; then
           mkdir -p "$(dirname "$on_disk")"
           mk doc show "$doc" --raw > "$on_disk"
         fi
         ;;
     esac
   done
   ```

   That regex is correct for every path mk's `--from-path` derivation produces today (one nesting level under `docs/`, e.g. `docs/designs/...`). If a future doc lives deeper, broaden the pattern.

   **No documents linked** → fine. Skip step 5b unless step 5b finds a stale-but-informative comment from a pre-`mk-doc` design pass.

5b. **Backward-compat fallback: skim prior comments for a designer hand-off.** Older design passes (before the doc-link mechanism was wired up) only posted a comment without linking the doc to mk. Call `mk comment list MINI-NN -o json` and look for a comment whose body starts with `**Design ready (PR open):**` or `**Design ready:**` and links to a doc path under `docs/designs/`. If you find one **and** step 5 returned no design-typed doc, treat it as the design contract:
   - If the design PR has merged, the doc + SVGs are on `main` — read at the relative path from the worktree.
   - If the design PR is still open, fetch via `gh pr view <design-PR> --json headRefName -q .headRefName`, then `git fetch origin <branch> && git show origin/<branch>:docs/designs/<filename>.md`.
   - If the comment exists but you can't locate the file via either path, **stop and ask** — the ticket claims design exists but the artefact is missing, which is a contradiction worth surfacing.

   If step 5 already returned a design-typed doc, the comment is purely informational — the linked doc is authoritative.

6. **Read prior art** — `git log --oneline -20 main` plus any commits matching the feature's area tag from the ticket. Shipped commits tell you the commit subject style and the rough size of a phase/task PR.

---

## Phase 4 — Set up the worktree (delegated to `setup-worktree`)

The pre-flight, pull, worktree creation, `pnpm install`, and the backgrounded `pnpm worktree-env start` are all owned by the **`setup-worktree`** skill (its own SKILL.md is the single source of truth for the mechanics). Invoke it via the `Skill` tool with the picked mk issue ID:

```
Skill(skill: "setup-worktree", args: "MINI-NN")
```

If the picked phase is **docs-only** (only touches `docs/`, a README, or a SKILL.md — no smoke tests will need a running env), pass `--no-env` so the skill skips the dev-env spin-up:

```
Skill(skill: "setup-worktree", args: "MINI-NN --no-env")
```

When the skill returns successfully, you'll be `cd`ed into `.claude/worktrees/<slug>`, dependencies installed, and the env warming in the background (or skipped). The current working directory is the worktree for the rest of this run; the slug is `mini-NN` (lowercase) and the branch is `claude/<slug>`.

If `setup-worktree` stops — dirty tree, non-default branch, worktree/branch collision, `pnpm install` failure — surface the failure and stop. Don't auto-recover. The issue is already `in_progress` from Phase 2.1; leave it that way per the hard rule on auto-rollback (the user decides whether to retry, hand off, or revert state).

---

## Phase 7 — Post the worktree details to the mk ticket

The state transition already happened in Phase 2.1 (right after the pick) — at this point the issue is `in_progress` and there's a "claimed" comment. Now that the worktree exists, the env-startup is backgrounded, and `pnpm install` has finished, post a follow-up comment with the concrete details so anyone reading the ticket knows where the work is happening:

```bash
cat <<'EOF' > /tmp/worktree-comment.md
Worktree ready.
- Worktree: <path>
- Branch: <branch>
- Env startup: backgrounded (`pnpm worktree-env start`)
EOF

mk comment add MINI-NN --as Claude --user Claude --body-file /tmp/worktree-comment.md
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

Smoke tests passed. Commit the implementation and push the branch so the work is safely on the remote before the PR is opened. Code review is a separate concern — the user runs the `/review` skill against the PR or mk ticket on their own cadence after this phase ships.

### 10.1 Commit the implementation

Match the most recent shipped commit format from the same feature (or, for one-offs, the most recent commit touching the same component). Typical:

```
feat(<area>): <short description> (Phase N, MINI-NN)
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
git push -u origin claude/mini-NN
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

Closes MINI-NN
EOF
```

PR title matches the implementation commit's subject. PR body must:

- Have a Summary section (1–3 bullets) describing the change.
- Have a Test plan section (markdown checklist).
- **Include `Closes MINI-NN` on its own line** so the PR has a clean reference back to the mk issue.
- Match the format used in recent PRs on this repo (look at `gh pr list --limit 5` for tone).

Once the PR URL is back from `gh pr create`, attach it to the issue:

```bash
mk pr attach MINI-NN <PR_URL> --user Claude
```

This gives `mk issue show` and `mk pr list MINI-NN` a clickable link back to the work — useful for the human reviewer and for any future agent that picks up follow-up work on this ticket.

---

## Phase 12 — Mark the issue `in_review` and leave a structured handoff comment

Move the issue to `in_review` and post a single structured comment summarising the run. The comment is the handoff to the human reviewer — and, when a plan doc was loaded, to the future re-integration agent that will fold drift back into it — so it captures everything the PR diff doesn't show. **The plan doc itself is read-only for this skill** (see hard rules); drift goes here.

```bash
mk issue state MINI-NN in_review --user Claude

# Write the handoff to a temp file (long text must come from --body-file or stdin)
cat <<'EOF' > /tmp/handoff.md
**PR:** <PR_URL>

## Known issues
<…>

## Work deferred
<…>

## Blockers
<…>

## Deviations from the spec
<…>
EOF

mk comment add MINI-NN --as Claude --user Claude --body-file /tmp/handoff.md
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

The point of this comment is that the next person (human or agent) opens the mk issue and sees the full state of what shipped without having to read the diff or guess. If it's empty across the board, that's a great sign — but don't fabricate content to fill it.

---

## Phase 13 — Post a session retrospective to mk (success path only)

After the handoff comment is posted but before worktree cleanup, kick off a session retrospective. The `session-retrospective` skill creates a **new** "retro"-tagged mk issue in `backlog`, linked back to the issue you just shipped — so retros accumulate as their own searchable list with their own lifecycle, separate from the contract-style handoff comment on the original ticket. Future runs of this skill (and the user, scanning retros over time) can mine that trail for lessons.

If anything earlier in the run failed and the skill stopped, this phase doesn't fire — there's no successful run to retrospect on, and the human will be debugging the failure directly. Only the success path reaches Phase 13.

### 13.1 Capture the parent session ID

The retrospective skill takes the session ID as an explicit parameter rather than reading `$CLAUDE_SESSION_ID`, because it's invoked from a subagent and a subagent's `$CLAUDE_SESSION_ID` points at its own (effectively empty) session, not the parent's. Capture your own session ID here so you can pass it through:

```bash
echo "$CLAUDE_SESSION_ID"
```

Hold onto the value alongside the picked mk issue ID (`MINI-NN` from Phase 2). These two are the parameters Phase 13.2 passes to the subagent.

### 13.2 Spawn a Sonnet subagent that invokes the skill

Use the `Agent` tool with `subagent_type: general-purpose` and `model: sonnet`. Sonnet is the right tier — by this point the parent context is huge (full task history, code reads, tool results), and Opus on top of that just to summarize JSONL is wasteful. Sonnet handles the analysis comfortably, and the heavy lifting (JSONL reads, `mk` calls) stays scoped to the subagent so it doesn't bloat the parent thread. Only the new retro issue's key flows back across the subagent boundary.

Prompt the subagent (substitute the captured session ID and the mk issue ID):

```
Invoke the session-retrospective skill with these parameters:

  --session-id <PARENT_SESSION_ID>     (the parent's session ID captured in Phase 13.1)
  --issue <MINI-NN>                    (the mk issue this run was working on)

The skill will:
  1. Run scripts/get-session.sh <PARENT_SESSION_ID> to fetch the parent JSONL.
  2. Analyze it and generate retrospective markdown per the skill's Output Format.
  3. Create a NEW mk issue in the current repo's `backlog` state, tagged "retro",
     titled "Retro: <MINI-NN> — <original-issue-title>", with a reference back to
     <MINI-NN> at the top of the description. Use:
       mk issue add "<title>" --description-file <path> --state backlog \
         --tag retro --user Claude
  4. After the retro issue is created, link it to <MINI-NN> using `mk link`:
       mk link <new-retro-key> relates-to <MINI-NN> --user Claude
     This creates a first-class `relates-to` edge between the two issues so
     anyone viewing <MINI-NN> via `mk issue show` sees the retro under
     Relations, not just buried in the description body. The in-body reference
     stays — it survives if the relation is later deleted, and it's the most
     scannable form for a human reading the description — but the relation is
     the structured, queryable link.

Return ONLY the new retro issue's key (e.g. MINI-42). Do NOT return the markdown body.
```

The skill itself owns the mk posting (state / tag / `mk issue add`) — the parent doesn't need to do anything else with the result.

### 13.3 Relay the retro issue key in the run report

When the subagent returns the key, append it to your final run report so the user can navigate to it directly (`mk issue show MINI-42`). The structured handoff comment (Phase 12) and the retro issue (Phase 13) are deliberately separate mk records — the handoff is the contract for the human reviewer of the PR; the retro is meta-feedback about the run itself, with a different audience and shelf-life.

### 13.4 Failure handling

The retrospective is a feedback loop, not a gate. If the subagent fails — script can't find the session, the `mk` binary errors, the subagent returns garbage instead of a key — **don't block cleanup**. Note the failure in the run report and continue to Phase 14. A broken or hollow retro issue is worse than no retro issue.

---

## Phase 14 — Clean up the worktree (success path only, delegated to `finish-worktree`)

**Only run this if every previous phase succeeded** — build/lint/unit passed, smoke passed, the PR is open, the issue is `in_review`, the handoff comment posted. If anything failed or stopped earlier, **skip this phase entirely** and leave the worktree alive so the user can investigate. The retrospective phase (13) is best-effort and doesn't gate this — a failed retrospective still counts as a successful run.

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
Cleaned up worktree .claude/worktrees/<slug> and the dev-env VM.
```

**Macos users** who run the bulk `pnpm worktree-env cleanup` command (or installed the hourly launchd agent) can rely on that to clean merged-PR worktrees on a schedule and skip this phase by interrupting the skill before it runs. For Windows / WSL2 users without an equivalent agent, this phase is the cleanup mechanism.

---

## Hard rules

These are non-negotiable. If you find yourself wanting to break one, stop and ask the user instead.

- **Never produce an ExitPlanMode block.** This is an execution agent. Planning happened when the ticket was created (in `plan-to-mk` for phased tickets, in `task-to-mk` for standalone ones, or by the user filing it directly).
- **Never run Phase 14 (cleanup) on a failure path.** If smoke failed, the PR didn't open, the `in_review` transition didn't go through, or you stopped to ask the user mid-phase — leave the worktree alive. The user needs it to investigate. Cleanup is the *reward* for a fully successful run. (Phase 13, the retrospective, also only runs on the success path, but a failure inside Phase 13 itself does not block Phase 14 — the retrospective is best-effort.)
- **Never edit the plan doc.** When a plan doc was loaded in Phase 3, the doc under `docs/planning/` is read-only for this skill. If your implementation drifts from the spec, capture the drift in the handoff comment (Phase 12 — Deviations from the spec section). A separate re-integration agent will fold those notes back into the plan doc; don't pre-empt that. (When no plan doc was loaded, this rule is vacuous — there's nothing to edit.)
- **Never auto-roll-back the `in_progress` transition.** Phase 2.1 marks the issue `in_progress` before any other work begins. If the run later hard-fails, leave it `in_progress` and report — don't quietly flip it back to `todo`. The user decides whether to retry, hand off, or revert state.
- **Never merge PRs** — even if checks pass and the PR looks great. Merging is a human decision.
- **Never create new mk issues** or split phases on the fly. If scope is too big for one phase, stop and report — splitting is a planning decision, not an execution decision.
- **Never override the ticket's Deferrals.** If the ticket (or its plan-doc section, when one exists) says "Defer X to follow-up", that X is deferred. Don't quietly include it because it seemed easy.
- **Never `git checkout main`, `git stash`, or create a new branch outside the delegated worktree flow.** Worktree creation is owned by `setup-worktree` (Phase 4) and cleanup by `finish-worktree` (Phase 14); this skill does no other branch manipulation. Once inside the worktree, you stay on `claude/<slug>` until cleanup.
- **Never skip pre-flight checks** by running on `main` or with a dirty tree. `setup-worktree` enforces this — if it stops, surface the failure.
- **Never use `--no-verify` or skip hooks.** If a hook fails, investigate.
- **Never call `mk` without `--user Claude` on a mutating command, or without `--as Claude` on `mk comment add`.** The audit log silently falls back to `geoff` otherwise — useless attribution for agent-driven runs.
- **Never guess at the contract.** If the ticket has no Goal/Deliverables/Done-when sections, **stop and report** — the ticket wasn't populated correctly. (A missing `Plan:` line on the feature, or a missing `### Phase N` section in the plan doc, is *not* a stop condition under the looser flow — see Phase 3 for the rules.)

---

## Example end-to-end (abbreviated)

> User: "execute next task"
>
> *Skill runs `mk status -o json` to confirm the binary works and the prefix is `MINI`. Lists `todo` issues with `mk issue list --state todo -o json`. Three results: MINI-29, MINI-31, MINI-34. For each, runs `mk issue show <KEY> -o json` and inspects relations. MINI-29 has an incoming `blocks` from MINI-28 (state: `done`) — unblocked. MINI-31 has an incoming `blocks` from MINI-30 (state: `todo`) — blocked. MINI-34 has no incoming `blocks` edges — unblocked. Two unblocked candidates: MINI-29, MINI-34.*
>
> Skill: "Two unblocked Todos:
> - `MINI-29 | Phase 4: pg-az-backup progress + result events | internal-nats-messaging`
> - `MINI-34 | Phase 1: Tempo + OTel Collector + Grafana | otel-tracing`
>
> Which one?"
>
> User: "MINI-29"
>
> *Skill runs `mk issue state MINI-29 in_progress --user Claude` and posts a "Claimed by Claude. Reading ticket and preparing the worktree…" comment via `mk comment add MINI-29 --as Claude --user Claude --body -` (Phase 2.1) so the mk board reflects the claim before any setup runs.*
>
> *Skill fetches MINI-29 with `mk issue show MINI-29 -o json` + parent feature with `mk feature show internal-nats-messaging -o json`. Feature description: `Plan: [docs/planning/not-shipped/internal-nats-messaging-plan.md](https://github.com/...)`. Skill reads the ticket body (Goal, Deliverables, Done when, Relevant docs, Smoke tests). The feature has one linked mk doc — `docs-planning-not-shipped-internal-nats-messaging-plan.md` (type `project_in_planning`); the skill fetches it via `mk doc show … --raw` and reads its `### Phase 4` section as supplemental context. The issue itself has no linked docs (no design phase for this ticket). Reads each linked CLAUDE.md / ARCHITECTURE.md. Skims comments via `mk comment list MINI-29 -o json` — no designer hand-off. Reads `git log` for `Phase 1`/`Phase 2`/`Phase 3` shipped commits to learn the area tag (`nats`) and PR title shape.*
>
> *Phase 4: invokes `Skill(setup-worktree, args: "MINI-29")`. The setup-worktree skill pre-flights main, runs `git pull --ff-only origin main`, creates the worktree at `.claude/worktrees/mini-29` on `claude/mini-29`, runs `pnpm install` synchronously, then backgrounds `pnpm worktree-env start --description "Phase 4 — pg-az-backup progress + result events"` (description derived from the mk title). Returns control with cwd = the worktree. Skill posts the worktree-details follow-up comment on MINI-29 via `mk comment add … --body-file`.*
>
> Skill: "Implementing Phase 4 — adding `mini-infra.backup.run` request handler and JetStream `BackupHistory` stream. Touching `server/src/services/backup/backup-executor.ts` first, then `server/src/services/nats/payload-schemas.ts`, then the boot sequence."
>
> *Implements. Runs build/lint/unit tests. Backgrounded env is up by now — runs the ticket's smoke test (publish a test backup-run request, confirm the consumer side fires).*
>
> *Phase 10: commits with `feat(nats): pg-az-backup progress + result events (Phase 4, MINI-29)`, pushes the branch with `-u`. Code review is left to a separate `/review` run that the user kicks off after the PR is open.*
>
> *Phase 11: opens PR with the implementation commit's title and `Closes MINI-29` in the body. Then runs `mk pr attach MINI-29 <PR_URL> --user Claude`.*
>
> *Phase 12: runs `mk issue state MINI-29 in_review --user Claude`. Posts the handoff comment via `mk comment add MINI-29 --as Claude --user Claude --body-file /tmp/handoff.md`: PR URL, plus a Deviations section noting that the optional retry-on-transient-failure deliverable was deferred to a follow-up issue per the plan doc's wording. The plan doc itself is left untouched; the re-integration agent will fold the Deviations back later. Reports the PR URL.*
>
> *Phase 13: captures `$CLAUDE_SESSION_ID` (the parent session), spawns a `general-purpose` subagent on Sonnet, and tells it to invoke the `session-retrospective` skill with `--session-id <parent-id> --issue MINI-29`. The skill verifies `mk` works in the current repo, runs `scripts/get-session.sh` against the parent JSONL, generates retrospective markdown, and creates a new issue via `mk issue add "Retro: MINI-29 — Phase 4: pg-az-backup progress + result events" --description-file /tmp/retro.md --state backlog --tag retro --user Claude`. Then `mk link MINI-42 relates-to MINI-29 --user Claude` so both issues show the link in their Relations section. Subagent returns `MINI-42`; skill appends it to the run report.*
>
> *Phase 14: every prior phase succeeded, so the skill invokes `Skill(finish-worktree, args: "mini-29")`. The finish-worktree skill verifies the tree is clean, the branch is fully pushed, and the PR exists; then `cd`s back to the repo root, runs `pnpm worktree-env delete mini-29 --force` and `git worktree remove .claude/worktrees/mini-29`. Reports cleanup done. The `claude/mini-29` branch stays on the remote (the PR points at it).*
