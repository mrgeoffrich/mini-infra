---
name: address-review
description: Action the findings from a `/review` mk comment on an in-review PR. Accepts an mk issue key (`MINI-NN`), a GitHub PR number (`372` or `#372`), a branch name (`claude/mini-32`), or **no argument** (uses the current branch's PR). Resolves the input to the triple {mk issue, PR, branch}, transitions the issue back to **in_progress** and posts a brief claim comment, finds the most recent `**Review of …**` comment posted by `/review` on the issue, parses the severity-tagged findings out of it, **drops every `low` item entirely** (low isn't worth a fixup commit — calibration of severity is the line), and for each remaining `critical | high | medium` finding **validates that it's actually an issue** by reading the cited file and surrounding code before touching anything (`/review` is fallible — false positives must be dismissed with rationale, not silently fixed). Reloads the contract — ticket body (Goal / Deliverables / Done when), any `Design ready` comment from `design-task` pointing at a design doc under `docs/designs/`, the plan doc if any, and the project conventions that bear on the touched directories (root + server/ + client/ CLAUDE.md). Resumes the existing worktree at `.claude/worktrees/mini-NN` if it's still around, or recreates it from the existing branch (`git worktree add .claude/worktrees/mini-NN claude/mini-NN`, `pnpm install`, kicks off `pnpm worktree-env start` in the background) so live smoke is available. Supports an optional `--quick` flag (e.g. `/address-review MINI-NN --quick`) that **skips the worktree + dev-env spin-up** and works directly on the PR branch in the main checkout — only valid when every validated fix is no-runtime-change (comment-only edits, dead-code removal, type-only changes, or extracted helpers with unchanged behaviour); the skill **refuses quick mode mid-run** if any fix turns out to touch `client/`, a route handler, a Prisma migration, or seeded-data code, and tells the user to re-run without `--quick`. The flag is never auto-detected — must be passed explicitly. Applies a targeted fix per validated finding, runs `build / lint / unit` for the workspaces touched, **smoke-tests the changes live** against the dev env (reads the URL from `environment-details.xml` and uses a recipe tailored to what changed — playwright for UI fixes, curl for route fixes, unit-test exercise for pure server logic), and lands one **single fixup commit** (`fix(<area>): address review findings (MINI-NN)`) pushed to the existing PR branch. Never opens a new PR. Posts a structured response comment on the mk issue listing **Fixed** items (with `file:line` + commit SHA), **Dismissed** items (with rationale per false-positive), **Couldn't verify** items (when the cited file/line doesn't match what the finding describes), and a one-line **Skipped (low)** note. Transitions the issue from in_progress back to **in_review**. Use this skill whenever the user says "address the review", "action the review findings", "apply the review", "fix the review on MINI-NN", "address MINI-NN review", "fix what review flagged", "act on the review comments", "go fix what /review found", "address the comments on MINI-NN", or any equivalent ask to action a posted review. Trigger even when the user doesn't say the word "address" but is clearly asking the agent to go fix what `/review` flagged. Do NOT trigger when there's no review comment on the ticket yet (run `/review` first), when the user wants a fresh review run (use `/review`), when the changes haven't been started (use `execute-next-task`), or when the request is for design exploration (use `design-task`).
---

# Address Review

You're a **review-fixup agent**. The work has shipped, `/review` has flagged what it considers actionable, and your job is to take that review seriously: validate each finding, fix the real ones, smoke-test the changes, and push a single fixup commit. Findings tagged `low` are out of scope — calibration of severity is the line, and treating `low` as actionable would defeat the point of having severity at all.

You make changes only after **validating** each finding is real. The `/review` skill is fallible — it sometimes misreads context, flags conventions that are actually being followed a few files away, or suggests "fixes" that are worse than the code being fixed. Read the cited file before touching anything; dismiss with rationale when the finding doesn't hold up.

Issues live in `mk` (mini-kanban), the local CLI tracker bound to this repo. The `mk` skill at `.claude/skills/mk/SKILL.md` covers the CLI in detail; this skill calls into it.

---

## Phase 1 — Confirm `mk` is available

`mk` is a local binary, not an MCP server — there's nothing to load. Sanity-check it before starting:

```bash
mk status -o json
```

This should print the current repo, prefix (expected `MINI`), and counts. If `mk` errors with "not inside a git repository", `cd` to the repo root and retry. If the binary isn't installed, stop and tell the user — without `mk` we can't read the review or post the response.

All `mk` reads in this skill use `-o json` for stable parsing. All mutations pass `--user Claude` so the audit log attributes the change correctly, and every `mk comment add` also passes `--as Claude` (the comment author).

---

## Phase 2 — Resolve the input and claim

Resolve the argument to the triple {mk issue, PR, branch}, identical to the resolution flow in `/review`. Recap of the input shapes:

- **`MINI-NN`** — `mk issue brief MINI-NN > /tmp/brief-MINI-NN.json` (same call Phase 3/4 reuse — capture once, reuse). Find the PR in `.pull_requests[]`, or fall back to `mk pr list MINI-NN -o json` to enumerate attached PRs explicitly. If none are attached, try `gh pr list --search "MINI-NN" --state open --json number,headRefName -L 5`. Branch is the PR's `headRefName`.
- **PR number** (`^\d+$` or `^#\d+$`) — `gh pr view <N> --json number,headRefName,title,body`. Pull the mk key from the title's `(MINI-NN)` suffix or the `Closes MINI-NN` line in the body.
- **Branch name** — `gh pr list --head <branch> --state open --json number`, then pull the mk key like the PR-number flow (or read it directly off the branch name `claude/mini-NN` → `MINI-NN`).
- **No argument** — `git rev-parse --abbrev-ref HEAD` for the branch, `gh pr view --json number,title,body,headRefName` for the PR, and pull the mk key from the branch (`claude/mini-NN`) or PR body. If the current branch is `main` or has no open PR, stop and ask.

If the resolution is ambiguous (multiple matching PRs, branch with no PR, ticket with no `Closes` link in any open PR), stop and ask. Don't guess past these.

**Optional `--quick` flag.** The argument may include `--quick` after the issue/PR/branch ref (e.g. `/address-review MINI-NN --quick`, or `/address-review --quick` with no other arg — order doesn't matter). Quick mode skips the worktree + dev-env spin-up (Phase 5 takes the abbreviated path) and falls back to build/lint/unit as the smoke (Phase 8 skips the channel-by-channel recipes). It's only valid when every validated finding's fix is in a no-runtime-change shape — comment-only edits, dead-code removal, type-only changes, or extracted helpers with unchanged behaviour. If any fix touches `client/`, a route handler under `server/src/routes/`, a Prisma migration, or seeded-data code, the skill **refuses quick mode mid-run** in Phase 8 and tells the user to re-run without `--quick`. The flag is never auto-detected; it must be passed explicitly. Note in chat which mode the run is using before proceeding.

State the resolved triple before proceeding:

> Addressing review on MINI-NN ("<title>") — PR #N, branch `<branch>`. (quick mode: yes/no)

### 2.1 Mark the issue in_progress and post a claim comment

The issue should currently be in **in_review** (that's the state `execute-next-task` left it in). The fixes are real work, so flip it back to in_progress before touching code — symmetric with the rest of the project's flow:

```bash
mk issue state MINI-NN in_progress --user Claude

printf 'Addressing review findings. Validating each item before applying — full summary will follow once the fixup commit lands.\n' \
  | mk comment add MINI-NN --as Claude --user Claude --body -
```

Don't move past Phase 2 until both succeeded. If `mk issue state` errors (state name drift, issue doesn't exist), surface and stop — fixing in the wrong board state defeats the audit trail.

---

## Phase 3 — Read the review comment and parse findings

Bulk-fetch the issue + comments in one call with `mk issue brief` — this replaces the legacy `mk comment list` + per-doc `mk doc show` + `mk feature show` dance, and the same brief feeds Phase 4's contract reload too:

```bash
mk issue brief MINI-NN > /tmp/brief-MINI-NN.json
```

`mk issue brief` always emits JSON regardless of `--output`. The shape: `.issue`, `.feature` (may be null), `.documents[]` (each with `filename`, `type`, `content`, `linked_via`), `.comments[]`, `.relations.{incoming,outgoing}[]`, `.pull_requests[]`, `.warnings[]`.

Iterate `.comments[]` and look for entries whose `body` starts with `**Review of [` — that's the canonical opener `/review` uses. If there are multiple (someone re-ran `/review` after a previous fixup), use the **most recent** one (sort by `created_at` descending). If there are none, stop and tell the user — the skill needs a review to action.

Parse the findings out of the comment body. The structure is:

```markdown
**Review of [<PR title>](<PR URL>)** — N finding(s).

<one-line summary>

### Critical
- **<title>** — `<file>:<line>`.
  <prose>

### High
- **<title>** — `<file>:<line>`.
  <prose>

### Medium
- **<title>** — `<file>:<line>`.
  <prose>

### Low
<one paragraph or short list>

### Out of scope (run separately)
- <pointer>
```

For each `### Critical`, `### High`, `### Medium` section, enumerate the bullet points into a structured list of `{ severity, title, file, line, detail }`. **Drop the entire `### Low` section without parsing it** — even if it's enumerated as bullets, those items don't get acted on. The "Out of scope" section is also dropped (it's already pointers to other skills).

If the review comment is the empty-review form (`— no findings`), there's nothing to do. Post a one-liner on the mk issue noting that, transition the issue back to in_review, and exit. Don't pretend to have done work.

State the parse result so the user can intercept:

> Found N actionable findings (X critical, Y high, Z medium). Skipping W low.

---

## Phase 4 — Reload the contract

Same shape as `execute-next-task` Phase 3 — the executor needs the ticket as the contract before judging whether a finding is real. The brief from Phase 3 already has everything the contract reload needs in one read; reuse it:

1. **Pull the issue body sections** from `.issue.description` in the brief: **Goal / Deliverables / Done when / Relevant docs / Smoke tests**. These define what the PR was supposed to do — a "drift from the contract" finding is only real if the actual ticket says so.
2. **Read the linked mk docs from the brief.** `.documents[]` already contains the *content* of every doc linked to the issue and to the parent feature — no follow-up `mk doc show` calls needed. Each doc carries `linked_via` (e.g. `["issue"]`, `["feature/<slug>"]`, or both) so you can distinguish:
   - **`linked_via` contains `"issue"`, type `designs`** → the design doc from `design-task`. Its **Recommendation** + **Key abstractions** + **States, failure modes & lifecycle** sections are what "drift from the design doc" findings are validated against.
   - **`linked_via` contains `"feature/<slug>"`, type `project_in_planning` / `project_complete`** → the plan doc snapshot. Supplemental context for the larger arc.

   ```bash
   jq -r '.documents[] | "==== " + .filename + " (type=" + .type + ", linked_via=" + (.linked_via | join(",")) + ") ====\n" + .content + "\n"' /tmp/brief-MINI-NN.json
   ```

   **Backward-compat fallback:** if no design-typed doc is linked, iterate `.comments[]` from the brief looking for `**Design ready (PR open):**` and read the doc from disk (on `main` if the design PR merged, otherwise via `gh pr view <design-PR> --json headRefName -q .headRefName` then `git show origin/<branch>:<path>`). Older tickets that pre-date the doc-link mechanism only have the comment.
3. **Read the project conventions** for the directories the *findings* cite (not the directories the diff touches — those are usually a superset). Root [CLAUDE.md](CLAUDE.md) always; [server/CLAUDE.md](server/CLAUDE.md) if any finding cites `server/`; [client/CLAUDE.md](client/CLAUDE.md) if any cites `client/`; [claude-guidance/ICONOGRAPHY.md](claude-guidance/ICONOGRAPHY.md) if a UI finding cites a missing/wrong icon.

Don't skip the contract reload. A finding like "this `any` type is unjustified" is real iff the project's "no `any`" rule applies — and you'll judge that wrong without rereading the convention doc.

---

## Phase 5 — Set up the worktree

The PR's branch (`claude/<slug>`) already exists on the remote. The worktree at `.claude/worktrees/<slug>` may or may not still be around — `execute-next-task` Phase 14 / `/finish-worktree` tear it down on the success path, so for a recently-shipped ticket it's likely gone.

**Quick mode (`--quick` flag passed in Phase 2):** skip the worktree entirely and work in the **main checkout** on the PR branch. From the main checkout root:

```bash
# Pre-flight: tree must be clean (no uncommitted edits, no untracked files in tracked dirs)
git status --porcelain    # must be empty; if not, stop and ask before clobbering work

git fetch origin
git checkout claude/<slug>
git pull --ff-only origin claude/<slug>
```

No `pnpm install` (the main checkout's `node_modules` is already warm); no `pnpm worktree-env start`. Phase 8 will classify each fix and **refuse quick mode mid-run** if any of them touches a runtime surface. Remember to `git checkout main` (or the user's prior branch) at the end of the run — Phase 11's report should remind the user explicitly. Then skip the rest of Phase 5 and proceed to Phase 6.

If `git checkout claude/<slug>` fails because of local edits the pre-flight missed, stop and surface — don't `--force`.

For the **default (worktree) mode**, two cases:

**Worktree still alive** (`.claude/worktrees/<slug>` is in `git worktree list`):

```bash
cd .claude/worktrees/<slug>
git fetch origin
git pull --ff-only origin claude/<slug>     # ensure up to date with the remote
```

**Worktree torn down** (recreate it from the existing branch — note: `git worktree add` *without* `-b` attaches to an existing branch instead of creating a new one):

```bash
git fetch origin claude/<slug>
git worktree add .claude/worktrees/<slug> claude/<slug>
cd .claude/worktrees/<slug>
pnpm install                                                # required — worktrees don't share node_modules
pnpm worktree-env start --description "address review for MINI-NN" &   # background; live smoke needs the dev env up
```

The dev env needs to be up because Phase 8 runs **live smoke against the changes**. Backgrounding `worktree-env start` lets you proceed with Phase 6's reads + edits while the VM/distro warms.

If `pnpm install` fails or `pnpm worktree-env start` errors out, stop. Don't paper over with `--force` — the gates exist for a reason.

---

## Phase 6 — Validate each finding and apply fixes

For each finding from Phase 3 (already filtered to non-low), do this in order:

### 6.1 Read the cited file

Open the file at the cited line, then read enough surrounding context (often the whole function, sometimes the whole file) to judge whether the finding is real. Don't decide based on the finding's prose alone — the prose is `/review`'s read of the code, and you're double-checking that read.

### 6.2 Decide

Pick one of three:

- **Real and actionable** → apply a fix. Often the finding's `detail` suggests one; use it if it's good, write a better one if not (the project's CLAUDE.md is explicit that an over-engineered fix is worse than the original code). Add the finding to a `fixed` list with the file:line, what was changed, and a one-line `why` so Phase 9's commit body and Phase 10's response comment can quote it.

- **False positive — finding doesn't hold up** → dismiss. Add to a `dismissed` list with the file:line, what `/review` said, and **why it doesn't apply** (one or two sentences — "the convention is followed by the wrapper at line 142", "the test helper intentionally bypasses this", "the suggested fix would break X"). Don't apply a "fix" you don't believe in.

- **Couldn't verify** → the cited file/line doesn't exist, or the code at that location bears no resemblance to what the finding describes, or the prose is too vague to validate. Add to a `couldnt_verify` list with what `/review` cited and what's actually there. Don't fix and don't dismiss — flag the mismatch in the response comment so the human reviewer can decide.

### 6.3 Apply, don't batch

Apply each fix as you go rather than collecting them all and patching at the end. Re-reading the file between findings catches the case where two findings touch the same location — fixing them in series ensures the second one sees the first one's edit.

For findings that span multiple files (e.g. "this duplicated logic should be extracted to a shared helper"), do the extraction as a single fix and reference both old call sites in the `fixed` entry.

### 6.4 Don't accidentally over-scope

The temptation is real: while reading a file you'll spot adjacent issues `/review` didn't flag. **Don't fix them in this skill.** This skill addresses the review; out-of-scope cleanup belongs in a separate ticket and a separate run. Note the additional issues in your scratchpad and surface them in the Phase 11 final report so the user can decide.

---

## Phase 7 — Build / lint / unit gates per touched workspace

Run the same gates `execute-next-task` runs, scoped to the workspaces the fixes touched. From the worktree root:

- **Server changes:** `pnpm --filter mini-infra-server build && pnpm --filter mini-infra-server lint && pnpm --filter mini-infra-server test`
- **Client changes:** `pnpm --filter mini-infra-client build && pnpm --filter mini-infra-client lint`
- **Lib / shared types changes:** `pnpm build:lib`
- **Sidecar changes:** `cd <sidecar-dir> && npm test && npm run build`, then `cd` back to the worktree root.

If any gate fails, **fix it before continuing** — don't paper over. Often the failure is the symptom of a fix that wasn't quite right; back up and rethink rather than weakening the assertion.

For pure-docs fixes (no source files changed) the gate set may collapse to nothing — that's fine. The smoke step (Phase 8) still applies for any user-visible behaviour change.

---

## Phase 8 — Live smoke the changes against the dev env

This step is **required**. The fixup commit shouldn't push without verifying the changes actually work. Build/lint/unit pass means the code compiles and the unit suite is green — it does **not** mean the fix is correct against the running app. Pick the channel(s) based on what was fixed; if a fix spans surfaces, hit all of them.

### 8.0 Quick-mode runtime-surface check (only if `--quick` was passed)

Before running any smoke recipes, classify each entry in the `fixed` list by file path:

- **No-runtime-change shapes (allowed under `--quick`):** comment-only edits, dead-code removal (unreachable code, unused imports/exports, unused variables), type-only changes (TypeScript types that don't change runtime behaviour), pure refactors that extract a helper without altering its body. Pure-docs files (`docs/**`, `*.md`) also count.
- **Runtime-surface shapes (refused under `--quick`):** any path under `client/`, any route handler under `server/src/routes/`, any Prisma migration under `server/prisma/migrations/`, any seeded-data code (`server/src/seed/`, `server/src/services/seed*`), any sidecar source, any stack-template definition.

If **any** fix is in the runtime-surface bucket, **refuse quick mode**:

1. Surface what would be reset: `git log --oneline origin/claude/<slug>..HEAD` and `git status --porcelain`.
2. Reset the working tree: `git restore --source=origin/claude/<slug> --staged --worktree -- .` for uncommitted edits, or `git reset --hard origin/claude/<slug>` if commits were made (state the SHA being discarded so the user can recover from reflog if needed).
3. Tell the user, naming the offending file: "Fix at `<file>` touches a runtime surface (`<which bucket>`) — quick mode requires every fix to be no-runtime-change. Re-run without `--quick` to spin up the worktree and dev env." Don't push, don't comment on mk, don't transition state.

If **every** fix is in the no-runtime-change bucket, skip the channel-by-channel recipes below — Phase 7's build/lint/unit gates are the smoke for quick mode. Note this explicitly in the Phase 10 smoke line.



**Validation channels available in the worktree dev env:**

1. **Browser** via `playwright-cli` (or the `test-dev` skill that wraps it) — **mandatory** for any fix that touches `client/` or otherwise changes user-visible behaviour. Type-check + lint is **not** a substitute. URL comes from `environment-details.xml`.
2. **API** via `curl` against the URL in `environment-details.xml`, with the admin key from `//admin/apiKey`. Best for route-only fixes or asserting response shape/status.
3. **Server logs** — `grep '"subcomponent":"<name>"' logs/app.*.log`, or `docker logs mini-infra-<worktree>-server` — for boot-time / scheduled / background-emit fixes that don't surface through a route.
4. **Container state** — `docker ps`, `docker logs <container>`, `docker exec <container> …` for stack-template, sidecar, and infra-container fixes. The dev env is a real Docker host; poke directly.
5. **Full env rebuild** — `pnpm worktree-env delete <slug> --force && pnpm worktree-env start` blows the VM/distro away and provisions a fresh one. Use when the fix changed seeded data, migrations, or first-boot reconciliation; a warm env won't replay those paths.

**Recipe by fix shape:**

1. **Read the dev env URL from `environment-details.xml`** at the worktree root:

   ```bash
   MINI_INFRA_URL=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml)
   ```

2. **UI-side fixes (anything in `client/`)** — **mandatory** browser smoke via `playwright-cli` (or invoke `test-dev`). Walk the user flow that exercises the fixed surface; check that the bug `/review` flagged is no longer reproducible. If the fix was a button-disabled rule, click the button. If the fix was an empty-state placeholder, clear the input. Match the verification to the fix. Build + lint passing does not count.

3. **Route / API fixes** — `curl` against the relevant endpoint, with auth if needed. Verify the response shape, status code, side-effects. If the fixed route is consumed by an existing UI page, also drive that page via `playwright-cli` so the wire-up is exercised end-to-end.

   ```bash
   curl -fsSL "$MINI_INFRA_URL/api/<route>" -H "x-api-key: $(xmllint --xpath 'string(//admin/apiKey)' environment-details.xml)" | jq .
   ```

4. **Server-service fixes (no route change)** — if the service is invoked from an existing route, hit that route. If it runs at boot or on a schedule, watch the server logs for the relevant subcomponent (`grep '"subcomponent":"<name>"' logs/app.*.log`, or `docker logs mini-infra-<worktree>-server`). Re-run the targeted unit test as well (`pnpm --filter mini-infra-server exec vitest run <file>`) — if no unit test covers the fixed path, write a focused one as part of this fixup commit.

5. **Stack-template / infra-container fixes** — apply the affected stack from the dev UI (drive via `playwright-cli`) or via the API, then confirm `docker ps` shows the new containers in the expected state and `docker logs <container>` is clean. For destructive template changes, do a full rebuild (`pnpm worktree-env delete <slug> --force && pnpm worktree-env start`) so first-boot reconciliation is exercised.

6. **Pure server logic / library changes (no surface)** — re-run the unit test that covers the fixed path (`pnpm --filter mini-infra-server exec vitest run <file>`) and assert it now exercises the new behaviour. If no unit test covers it, write a focused one as part of this fixup commit — the codebase rule is "don't add tests for impossible cases", but a fix that lacks any verification is a different problem.

7. **Migration / seeded-data fixes** — apply the migration locally (`pnpm --filter mini-infra-server exec prisma migrate dev` then `prisma migrate status`) and check the resulting schema matches the intent. For destructive migrations, also do a full env rebuild and re-validate the affected feature through its primary channel (browser/API). If the fix was about migration safety, additionally run a load simulation appropriate to the table size.

If the smoke fails, the fix is wrong. Iterate — re-read the code, refine the fix, re-smoke. Don't push something the smoke disagreed with.

For findings whose fix has no observable runtime behaviour change (e.g. "extract this helper for DRY"), the smoke is the build + unit gates from Phase 7. State that explicitly when you decide it's the case so the user sees you considered it.

---

## Phase 9 — Single fixup commit and push

One commit for the whole fixup. Title and body:

```
fix(<area>): address review findings (MINI-NN)

- <one bullet per fixed finding: short imperative, file:line>
- <…>

Co-Authored-By: <as configured>
```

The `<area>` matches the area tag of the original implementation commit (run `git log --oneline claude/<slug>` if you need to remind yourself). The bullets are pulled from the `fixed` list you built in Phase 6.

Push to the existing branch:

```bash
git push origin claude/<slug>
```

Don't open a new PR. The original PR's diff updates automatically.

If the push fails (someone else has pushed to the branch in the meantime, or you've gotten the wrong branch), stop and surface the conflict — don't `--force`. The user resolves.

---

## Phase 10 — Post the response comment and transition back to in_review

Single response comment on the mk issue, structured to mirror the original review's structure so reviewers can scan diff against finding. Write the body to a temp file, then:

```bash
mk comment add MINI-NN --as Claude --user Claude --body-file /tmp/address-review-MINI-NN.md
mk issue state MINI-NN in_review --user Claude
```

Template — omit a section that's empty rather than write "None.":

```markdown
**Addressed review** — fixup commit `<short-SHA>` (<short hyperlink to commit on the PR>).

### Fixed
- **<finding title>** — `<file>:<line>` → fixed in `<short-SHA>`.
  <one-sentence summary of what changed and why.>
- <…>

### Dismissed (false positives)
- **<finding title>** — `<file>:<line>`.
  <one or two sentences: what `/review` said, why it doesn't apply.>
- <…>

### Couldn't verify
- **<finding title>** — `/review` cited `<file>:<line>` but <what's actually there / what's missing>. Flagging for a human reviewer.
- <…>

### Skipped (low)
<W finding(s) at `low` severity were not actioned per the project rule that low-severity items don't earn a fixup commit.>

---

_Smoke: <one-line description of how the changes were verified — e.g. "Playwright walked the Tailscale settings form; the empty-tags ACL block now renders the placeholder text instead of broken JSON.">_

<!-- In quick mode (Phase 8.0 passed), use this form instead: -->
<!-- _Smoke: build/lint/unit only — quick mode (no runtime-surface fixes)._ -->

```

Post the comment, then move the issue back to **in_review** so the board reflects that the PR is awaiting another review pass. If `mk issue state` errors, surface and stop — the fixup commit is already on the remote, so the work isn't lost; the user can move the state manually.

---

## Phase 11 — Final report to the user

Tight summary in chat:

```
Addressed review on MINI-NN: <commit URL>.

Fixed: <F>. Dismissed: <D>. Couldn't verify: <C>. Skipped (low): <L>.
<one-line: e.g. "All real findings addressed; one false positive in `foo.ts:42` (the convention is followed by the wrapper)."  or "Pushed fix for the SQL injection finding; the duplication finding turned out to be a false positive — see mk comment for details.">

<If Phase 6.4 surfaced out-of-scope issues you noticed but didn't fix:>
Out-of-scope issues spotted during the run (not fixed; consider a separate ticket):
- <file:line — short description>
- <…>

<If quick mode was used:>
Note: ran in quick mode — main checkout is currently on `claude/<slug>`. Run `git checkout main` (or your prior branch) when you're done.
```

That's the run.

---

## Hard rules

- **Never act on `low` items.** They're filtered out before validation. Calibration of severity is the line; loosening that line eats the calibration.
- **Always validate before fixing.** Read the cited file at the cited line; if the finding doesn't hold up, dismiss it with rationale. The skill applies fixes; it does not re-implement what `/review` literally said the fix should be without sanity-checking it.
- **Always smoke-test the changes.** Phase 8 is required. A fix that builds and lints isn't verified — runtime behaviour has to be exercised somehow before push. **Quick-mode exception:** when `--quick` was passed in Phase 2 *and* every fix is no-runtime-change (comment-only / dead-code / type-only / extracted-helper / pure-docs), Phase 7's build+lint+unit gates count as the smoke. The skill **refuses quick mode mid-run** in Phase 8.0 if any fix turns out to touch a runtime surface — that's a hard rule, not a heuristic. Quick mode is never auto-detected.
- **One fixup commit, no `--force`.** A single `fix(<area>): address review findings (MINI-NN)` commit on the existing branch. Don't squash in earlier commits. Don't force-push.
- **Never open a new PR.** The fixup belongs on the existing PR. The diff updates automatically when the branch updates.
- **Symmetric state flow.** The issue moves todo → in_progress → in_review → in_progress (this skill, Phase 2.1) → in_review (Phase 10). Don't skip either transition. The board has to reflect what's actually happening.
- **Don't accidentally over-scope.** Cleanups you spot but `/review` didn't flag belong in a separate ticket. Note them in the final report; don't bundle them into this fixup commit.
- **Always pass `--user Claude` on `mk` mutations and `--as Claude` on `mk comment add`.** Without `--user`, the audit log silently attributes the change to whichever OS user the agent runs under — useless history.
- **Always pass `-o json` when parsing `mk` output.** Text mode is for humans only.
- **Never run `mk` outside a git repo** — it hard-errors. `cd` to the repo first.
- **Stop on missing inputs.** No review comment found, ambiguous PR resolution, no mk key resolvable from the input → stop and ask.
- **Never produce an ExitPlanMode block.** This is an action skill; the fixup commit + mk comment are the deliverables.

---

## Example end-to-end

> User: `/address-review MINI-32`
>
> *Skill runs `mk status -o json` to confirm the binary is wired up and the repo prefix is `MINI`. Resolves: MINI-32 ("Phase 4: pg-az-backup progress + result events"), PR #412, branch `claude/mini-32`. Confirms: "Addressing review on MINI-32 — PR #412, branch `claude/mini-32`."*
>
> *Phase 2.1: `mk issue state MINI-32 in_progress --user Claude` + claim comment via `mk comment add MINI-32 --as Claude --user Claude --body -`.*
>
> *Phase 3: `mk comment list MINI-32 -o json`. Most recent `**Review of …**` comment shows 4 findings: 1 high (error swallowing in `backup-progress-emitter.ts:47`), 1 medium (duplicated step-name normalisation in `backup-executor.ts:208`), 1 low (`console.log` leftover), 1 medium ("missing `userId` on the new metric-emit row"). Drops the low. Three to validate.*
>
> *Phase 4: re-reads MINI-32 ticket body via `mk issue show`, server/CLAUDE.md (server-side findings), root CLAUDE.md (audit-trail rule for the `userId` finding). No design comment on this ticket — backend-only work.*
>
> *Phase 5: `.claude/worktrees/mini-32` was torn down by `/finish-worktree` after the original PR shipped. Skill recreates: `git fetch origin claude/mini-32`, `git worktree add ...`, `pnpm install`, backgrounded `pnpm worktree-env start`.*
>
> *Phase 6:*
> - **High — error swallowing in `backup-progress-emitter.ts:47`** → reads the file. Real. Replaces the silent `console.error` with a log + throw, with the calling site already wrapping in a try/catch as the convention requires. Adds to `fixed`.
> - **Medium — duplicated step-name normalisation** → reads both call sites. Real. Extracts to `server/src/services/operation-step.ts` as `normaliseStepName(input: string): string`, updates both call sites. Adds to `fixed`.
> - **Medium — missing `userId` on metric-emit row** → reads the file. The row is being inserted by a scheduled job, not a user-initiated mutation; the project's audit-trail rule explicitly applies to user-initiated config changes, not background jobs. Dismisses with that rationale. Adds to `dismissed`.
>
> *Phase 7: `pnpm --filter mini-infra-server build && lint && test`. All green.*
>
> *Phase 8: dev env URL read from `environment-details.xml`. Server fix has unit-test coverage (rerun `pnpm --filter mini-infra-server exec vitest run src/services/backup/__tests__/backup-progress-emitter.test.ts` — passes, with the new error-throw branch exercised). For the duplication fix, the build + lint gates from Phase 7 are the smoke.*
>
> *Phase 9: commits `fix(backup): address review findings (MINI-32)` with the two fixed bullets, pushes.*
>
> *Phase 10: posts the response comment on MINI-32 via `mk comment add` with three sections (Fixed: 2; Dismissed: 1 with the user-vs-job rationale; Skipped (low): 1). `mk issue state MINI-32 in_review --user Claude`.*
>
> Skill: "Addressed review on MINI-32: <commit URL>. Fixed: 2. Dismissed: 1. Couldn't verify: 0. Skipped (low): 1. The high finding (error swallowing) and one medium (duplication) are now fixed. The other medium turned out to be a false positive — the audit-trail rule applies to user-initiated mutations, not the background job in question."
