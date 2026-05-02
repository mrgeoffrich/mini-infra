---
name: address-review
description: Action the findings from a `/review` Linear comment on an in-review PR. Accepts a Linear issue ID (`ALT-NN`), a GitHub PR number (`372` or `#372`), a branch name (`claude/alt-32`), or **no argument** (uses the current branch's PR). Resolves the input to the triple {Linear issue, PR, branch}, transitions the issue back to **In Progress** and posts a brief claim comment, finds the most recent `**Review of …**` comment posted by `/review` on the issue, parses the severity-tagged findings out of it, **drops every `low` item entirely** (low isn't worth a fixup commit — calibration of severity is the line), and for each remaining `critical | high | medium` finding **validates that it's actually an issue** by reading the cited file and surrounding code before touching anything (`/review` is fallible — false positives must be dismissed with rationale, not silently fixed). Reloads the contract — ticket body (Goal / Deliverables / Done when), any `Design ready` comment from `design-task` pointing at a design doc under `docs/designs/`, the plan doc if any, and the project conventions that bear on the touched directories (root + server/ + client/ CLAUDE.md). Resumes the existing worktree at `.claude/worktrees/alt-NN` if it's still around, or recreates it from the existing branch (`git worktree add .claude/worktrees/alt-NN claude/alt-NN`, `pnpm install`, kicks off `pnpm worktree-env start` in the background) so live smoke is available. Applies a targeted fix per validated finding, runs `build / lint / unit` for the workspaces touched, **smoke-tests the changes live** against the dev env (reads the URL from `environment-details.xml` and uses a recipe tailored to what changed — playwright for UI fixes, curl for route fixes, unit-test exercise for pure server logic), and lands one **single fixup commit** (`fix(<area>): address review findings (ALT-NN)`) pushed to the existing PR branch. Never opens a new PR. Posts a structured response comment on the Linear issue listing **Fixed** items (with `file:line` + commit SHA), **Dismissed** items (with rationale per false-positive), **Couldn't verify** items (when the cited file/line doesn't match what the finding describes), and a one-line **Skipped (low)** note. Transitions the issue from In Progress back to **In Review**. Use this skill whenever the user says "address the review", "action the review findings", "apply the review", "fix the review on ALT-NN", "address ALT-NN review", "fix what review flagged", "act on the review comments", "go fix what /review found", "address the comments on ALT-NN", or any equivalent ask to action a posted review. Trigger even when the user doesn't say the word "address" but is clearly asking the agent to go fix what `/review` flagged. Do NOT trigger when there's no review comment on the ticket yet (run `/review` first), when the user wants a fresh review run (use `/review`), when the changes haven't been started (use `execute-next-task`), or when the request is for design exploration (use `design-task`).
---

# Address Review

You're a **review-fixup agent**. The work has shipped, `/review` has flagged what it considers actionable, and your job is to take that review seriously: validate each finding, fix the real ones, smoke-test the changes, and push a single fixup commit. Findings tagged `low` are out of scope — calibration of severity is the line, and treating `low` as actionable would defeat the point of having severity at all.

You make changes only after **validating** each finding is real. The `/review` skill is fallible — it sometimes misreads context, flags conventions that are actually being followed a few files away, or suggests "fixes" that are worse than the code being fixed. Read the cited file before touching anything; dismiss with rationale when the finding doesn't hold up.

The team is hardcoded as **Altitude Devops**.

---

## Phase 1 — Load the Linear MCP tools

The Linear MCP tools are deferred at session start. Load them in one bulk call:

```
ToolSearch(query: "linear", max_results: 30)
```

You should see `__list_issues`, `__get_issue`, `__list_comments`, `__save_comment`, `__save_issue`, `__list_issue_statuses`. If any are missing, stop and tell the user — without Linear we can't read the review or post the response.

---

## Phase 2 — Resolve the input and claim

Resolve the argument to the triple {Linear issue, PR, branch}, identical to the resolution flow in `/review`. Recap of the input shapes:

- **`ALT-NN`** — fetch issue, find the PR via `attachments[]` or `gh pr list --search "ALT-NN" --state open --json number,headRefName -L 5`. Branch is the PR's `headRefName`.
- **PR number** (`^\d+$` or `^#\d+$`) — `gh pr view <N> --json number,headRefName,title,body`. Pull the Linear ID from the title's `(ALT-NN)` suffix or the `Closes ALT-NN` line in the body.
- **Branch name** — `gh pr list --head <branch> --state open --json number`, then pull the Linear ID like the PR-number flow.
- **No argument** — `git rev-parse --abbrev-ref HEAD` for the branch, `gh pr view --json number,title,body,headRefName` for the PR, and pull the Linear ID from the branch (`claude/alt-NN`) or PR body. If the current branch is `main` or has no open PR, stop and ask.

If the resolution is ambiguous (multiple matching PRs, branch with no PR, ticket with no `Closes` link in any open PR), stop and ask. Don't guess past these.

State the resolved triple before proceeding:

> Addressing review on ALT-NN ("<title>") — PR #N, branch `<branch>`.

### 2.1 Mark the issue In Progress and post a claim comment

The issue should currently be in **In Review** (that's the state `execute-next-task` left it in). The fixes are real work, so flip it back to In Progress before touching code — symmetric with the rest of the project's flow:

```
save_issue(id: <ALT-NN>, state: "In Progress")
save_comment(issue_id: <ALT-NN>, body: "Addressing review findings. Validating each item before applying — full summary will follow once the fixup commit lands.")
```

Don't move past Phase 2 until both succeeded. If `save_issue` errors (workspace permission, state name drift), surface and stop — fixing in the wrong board state defeats the audit trail.

---

## Phase 3 — Read the review comment and parse findings

`list_comments(issueId: <ALT-NN>)` and look for comments whose body starts with `**Review of [` — that's the canonical opener `/review` uses. If there are multiple (someone re-ran `/review` after a previous fixup), use the **most recent** one. If there are none, stop and tell the user — the skill needs a review to action.

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

If the review comment is the empty-review form (`— no findings`), there's nothing to do. Post a one-liner on the Linear issue noting that, transition the issue back to In Review, and exit. Don't pretend to have done work.

State the parse result so the user can intercept:

> Found N actionable findings (X critical, Y high, Z medium). Skipping W low.

---

## Phase 4 — Reload the contract

Same shape as `execute-next-task` Phase 3 — the executor needs the ticket as the contract before judging whether a finding is real:

1. **Fetch the issue body** and pull out **Goal / Deliverables / Done when / Relevant docs / Smoke tests**. These define what the PR was supposed to do — a "drift from the contract" finding is only real if the actual ticket says so.
2. **Skim prior comments** for a `**Design ready (PR open):**` pointer from `design-task`. If found, read the design doc under `docs/designs/<id>-<slug>.md` (on `main` if the design PR has merged, on the design branch otherwise — `gh pr view <design-PR> --json headRefName -q .headRefName` then `git show origin/<branch>:<path>`). The doc's **Recommendation** + **Key abstractions** + **States, failure modes & lifecycle** sections are part of the contract; findings that allege "drift from the design doc" are validated against this.
3. **If the parent project has a `Plan:` line**, read the matching `### Phase N` section as supplemental context. The ticket body still wins on what specifically had to ship.
4. **Read the project conventions** for the directories the *findings* cite (not the directories the diff touches — those are usually a superset). Root [CLAUDE.md](CLAUDE.md) always; [server/CLAUDE.md](server/CLAUDE.md) if any finding cites `server/`; [client/CLAUDE.md](client/CLAUDE.md) if any cites `client/`; [claude-guidance/ICONOGRAPHY.md](claude-guidance/ICONOGRAPHY.md) if a UI finding cites a missing/wrong icon.

Don't skip the contract reload. A finding like "this `any` type is unjustified" is real iff the project's "no `any`" rule applies — and you'll judge that wrong without rereading the convention doc.

---

## Phase 5 — Set up the worktree

The PR's branch (`claude/<slug>`) already exists on the remote. The worktree at `.claude/worktrees/<slug>` may or may not still be around — `execute-next-task` Phase 14 / `/finish-worktree` tear it down on the success path, so for a recently-shipped ticket it's likely gone.

Two cases:

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
pnpm worktree-env start --description "address review for ALT-NN" &   # background; live smoke needs the dev env up
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

This step is **required**. The fixup commit shouldn't push without verifying the changes actually work. Pick the recipe based on what was fixed:

1. **Read the dev env URL from `environment-details.xml`** at the worktree root:

   ```bash
   MINI_INFRA_URL=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml)
   ```

2. **UI-side fixes** — use the `playwright-cli` skill to drive the change in a browser. Walk the user flow that exercises the fixed surface; check that the bug `/review` flagged is no longer reproducible. If the fix was a button-disabled rule, click the button. If the fix was an empty-state placeholder, clear the input. Match the verification to the fix.

3. **Route / API fixes** — `curl` against the relevant endpoint, with auth if needed. Verify the response shape, status code, side-effects.

   ```bash
   curl -fsSL "$MINI_INFRA_URL/api/<route>" -H "..." | jq .
   ```

4. **Pure server logic / library changes** — re-run the unit test that covers the fixed path (`pnpm --filter mini-infra-server exec vitest run <file>`) and assert it now exercises the new behaviour. If no unit test covers it, write a focused one as part of this fixup commit — the codebase rule is "don't add tests for impossible cases", but a fix that lacks any verification is a different problem.

5. **Migration fixes** — apply the migration locally (`pnpm --filter mini-infra-server exec prisma migrate dev`) and check that the resulting schema matches the intent. If the fix was about migration safety, additionally run a load simulation appropriate to the table size.

If the smoke fails, the fix is wrong. Iterate — re-read the code, refine the fix, re-smoke. Don't push something the smoke disagreed with.

For findings whose fix has no observable runtime behaviour change (e.g. "extract this helper for DRY"), the smoke is the build + unit gates from Phase 7. State that explicitly when you decide it's the case so the user sees you considered it.

---

## Phase 9 — Single fixup commit and push

One commit for the whole fixup. Title and body:

```
fix(<area>): address review findings (ALT-NN)

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

## Phase 10 — Post the response comment and transition back to In Review

Single response comment on the Linear issue, structured to mirror the original review's structure so reviewers can scan diff against finding:

```
save_comment(issue_id: <ALT-NN>, body: <see template>)
save_issue(id: <ALT-NN>, state: "In Review")
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
```

Post the comment, then move the issue back to **In Review** so the board reflects that the PR is awaiting another review pass. If `save_issue` errors, surface and stop — the fixup commit is already on the remote, so the work isn't lost; the user can move the state manually.

---

## Phase 11 — Final report to the user

Tight summary in chat:

```
Addressed review on ALT-NN: <commit URL>.

Fixed: <F>. Dismissed: <D>. Couldn't verify: <C>. Skipped (low): <L>.
<one-line: e.g. "All real findings addressed; one false positive in `foo.ts:42` (the convention is followed by the wrapper)."  or "Pushed fix for the SQL injection finding; the duplication finding turned out to be a false positive — see Linear comment for details.">

<If Phase 6.4 surfaced out-of-scope issues you noticed but didn't fix:>
Out-of-scope issues spotted during the run (not fixed; consider a separate ticket):
- <file:line — short description>
- <…>
```

That's the run.

---

## Hard rules

- **Never act on `low` items.** They're filtered out before validation. Calibration of severity is the line; loosening that line eats the calibration.
- **Always validate before fixing.** Read the cited file at the cited line; if the finding doesn't hold up, dismiss it with rationale. The skill applies fixes; it does not re-implement what `/review` literally said the fix should be without sanity-checking it.
- **Always smoke-test the changes.** Phase 8 is required. A fix that builds and lints isn't verified — runtime behaviour has to be exercised somehow before push.
- **One fixup commit, no `--force`.** A single `fix(<area>): address review findings (ALT-NN)` commit on the existing branch. Don't squash in earlier commits. Don't force-push.
- **Never open a new PR.** The fixup belongs on the existing PR. The diff updates automatically when the branch updates.
- **Symmetric state flow.** The issue moves Todo → In Progress → In Review → In Progress (this skill, Phase 2.1) → In Review (Phase 10). Don't skip either transition. The board has to reflect what's actually happening.
- **Don't accidentally over-scope.** Cleanups you spot but `/review` didn't flag belong in a separate ticket. Note them in the final report; don't bundle them into this fixup commit.
- **Stop on missing inputs.** No review comment found, ambiguous PR resolution, no Linear ID resolvable from the input → stop and ask.
- **Never produce an ExitPlanMode block.** This is an action skill; the fixup commit + Linear comment are the deliverables.

---

## Example end-to-end

> User: `/address-review ALT-32`
>
> *Skill loads Linear MCP. Resolves: ALT-32 ("Phase 4: pg-az-backup progress + result events"), PR #412, branch `claude/alt-32`. Confirms: "Addressing review on ALT-32 — PR #412, branch `claude/alt-32`."*
>
> *Phase 2.1: `save_issue(state: "In Progress")` + claim comment.*
>
> *Phase 3: `list_comments`. Most recent `**Review of …**` comment shows 4 findings: 1 high (error swallowing in `backup-progress-emitter.ts:47`), 1 medium (duplicated step-name normalisation in `backup-executor.ts:208`), 1 low (`console.log` leftover), 1 medium ("missing `userId` on the new metric-emit row"). Drops the low. Three to validate.*
>
> *Phase 4: re-reads ALT-32 ticket body, server/CLAUDE.md (server-side findings), root CLAUDE.md (audit-trail rule for the `userId` finding). No design comment on this ticket — backend-only work.*
>
> *Phase 5: `.claude/worktrees/alt-32` was torn down by `/finish-worktree` after the original PR shipped. Skill recreates: `git fetch origin claude/alt-32`, `git worktree add ...`, `pnpm install`, backgrounded `pnpm worktree-env start`.*
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
> *Phase 9: commits `fix(backup): address review findings (ALT-32)` with the two fixed bullets, pushes.*
>
> *Phase 10: posts the response comment on ALT-32 with three sections (Fixed: 2; Dismissed: 1 with the user-vs-job rationale; Skipped (low): 1). Moves ALT-32 to In Review.*
>
> Skill: "Addressed review on ALT-32: <commit URL>. Fixed: 2. Dismissed: 1. Couldn't verify: 0. Skipped (low): 1. The high finding (error swallowing) and one medium (duplication) are now fixed. The other medium turned out to be a false positive — the audit-trail rule applies to user-initiated mutations, not the background job in question."
