---
name: ship-it
description: Squash-merges the PR for an `mk` issue that's sitting in `in_review` and transitions the issue to `done`. Accepts an `mk` issue key (`MINI-NN`), a bare number (`32`, resolved against the current repo's prefix), or **no argument** (uses the current branch's open PR — same fallback shape as `address-review`). Reads `mk issue brief` to find the attached PR, pre-flights `gh pr view` to confirm the PR is mergeable, has no `CHANGES_REQUESTED` review, and that the status-check rollup is green; if anything is red the skill stops and surfaces what's failing rather than forcing a merge into a broken state. Runs `gh pr merge --squash --delete-branch` (the squash subject defaults to the PR title and the body picks up `Closes MINI-NN` from the PR description so the audit trail stays tidy), then `mk issue state MINI-NN done --user Claude` and posts a brief merge-record comment with the merge commit SHA + PR URL on the mk issue. The remote branch is deleted as part of the merge; the local worktree is left alone — the report ends with a hint to run `/finish-worktree mini-NN` next so worktree cleanup stays a deliberate separate step. Use this skill whenever the user says "ship MINI-NN", "ship it", "merge MINI-NN", "squash and merge MINI-NN", "land the PR for MINI-NN", "merge and close MINI-NN", "ship the PR", or any equivalent ask to land a reviewed PR and close out its mk ticket. Do **not** trigger when the issue is in `in_progress` (work isn't done yet — use `address-review` or push more commits), `done` (already shipped), or `backlog`/`todo` (no PR to merge); in those cases the skill stops and asks rather than guessing. Do **not** trigger for non-mk PRs — use `gh pr merge` directly for those.
---

# Ship It

This skill takes a reviewed PR over the finish line: squash-merge on GitHub, then transition the `mk` issue from `in_review` to `done` with a merge-record comment. It's the bookend to `code-task` (which leaves the issue in `in_review` once the PR is open) and the inverse of `address-review` (which pulls the issue back to `in_progress` to apply review feedback).

The hard guarantee: **the merge and the mk transition happen together, or neither happens**. Drift between GitHub and `mk` is the whole reason this skill exists — humans forget to flip the state after merging, and then the board lies about what's done.

The remote branch is **deleted** as part of `gh pr merge --delete-branch`. After a squash-merge the branch is dead weight; cleaning it up in the same step keeps `gh pr list` honest. The local worktree is left alone — `/finish-worktree mini-NN` is a separate concern with its own defensive checks (uncommitted work, unpushed commits), and chaining it here would let "ship the PR" silently nuke a directory the user might still be using.

## Arguments

The skill accepts one optional argument:

- **`<issue-key | number | nothing>`** — `MINI-32`, a bare `32` (resolved against the current repo's prefix), or no argument at all.

Resolution rules, in order:

1. **Explicit `MINI-NN`** → use it directly.
2. **Bare number** → prefix with the current repo's `mk` prefix (run `mk repo show -o json` once and take `.prefix`).
3. **No argument** → look at the current branch. If it matches `claude/mini-NN`, derive `MINI-NN` from it. Otherwise stop and ask — the skill never auto-picks "the most recent in_review issue" because shipping the wrong PR is unrecoverable.

Accept surrounding text containing the pattern: `ship MINI-32 please` → `MINI-32`.

---

## Phase 1 — Load the issue and find the PR

Run `mk issue brief` once and reuse the result throughout the skill. Single read; everything you need (issue, state, attached PRs) is in there.

```bash
mk issue brief MINI-NN > /tmp/brief-MINI-NN.json
```

From the brief, pull:

- `.issue.state` — must be `in_review` (Phase 2 enforces this).
- `.issue.title` — used in the report.
- `.pull_requests[]` — list of attached PR URLs.

**No PR attached?** Fall back to `gh pr list --search "MINI-NN" --state open --json number,url,headRefName,title -L 5` to discover unattached PRs. If exactly one matches, use it and offer to attach it via `mk pr attach` after the merge succeeds. If zero match, stop — there's nothing to ship; ask the user whether the work is actually finished. If multiple match, list them and ask which.

**Multiple PRs attached?** Stop and ask which to merge. Don't guess based on "most recent" — sometimes an earlier PR is the canonical one and a later one is a spike.

Convert the chosen PR URL to a PR number for `gh` calls: extract the trailing `/pull/<N>` segment, or just pass the URL directly to `gh pr view <URL>` which `gh` accepts.

---

## Phase 2 — Validate state and PR readiness

Two gates: the `mk` state, and GitHub's view of the PR.

### Gate 1 — Issue state must be `in_review`

```bash
state=$(jq -r '.issue.state' /tmp/brief-MINI-NN.json)
```

- `in_review` → proceed.
- `in_progress` → stop. The work isn't reviewed yet. Surface this and suggest the user push more commits / get review first, or use `address-review` if a `/review` comment is waiting.
- `done` → stop. Already shipped. Read the recent comments and the PR's `mergedAt` to confirm; tell the user.
- `backlog` / `todo` → stop. There's nothing to ship — no PR has been opened yet.
- `cancelled` / `duplicate` → stop. The issue is closed for a reason other than completion; merging would contradict the closure.

In every non-`in_review` case, surface what's there and ask before proceeding. The skill does not silently transition through other states — that's how a `done` issue gets re-merged or a `cancelled` ticket gets accidentally shipped.

### Gate 2 — PR must be mergeable, green, and approved

```bash
gh pr view <PR-URL-or-number> --json \
  number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName,url \
  > /tmp/pr-MINI-NN.json
```

Check, in order:

- `.state == "OPEN"` — if `MERGED`, the merge already happened; jump to Phase 4 and just transition the mk issue. If `CLOSED` (and not merged), stop and ask — closing without merging usually means the work was abandoned.
- `.isDraft == false` — drafts aren't ready. Stop and ask whether to mark ready first.
- `.mergeable == "MERGEABLE"` — `CONFLICTING` means rebase needed; `UNKNOWN` means GitHub is still computing (retry once after a few seconds, then surface). Stop on either.
- `.reviewDecision != "CHANGES_REQUESTED"` — outstanding change requests block the merge. Stop and list which reviewers requested changes.
- `.statusCheckRollup` — every check must have `conclusion == "SUCCESS"` (or `state == "SUCCESS"` for legacy commit statuses). Pending checks (`status == "IN_PROGRESS"` or `conclusion == null`) also block — wait or stop. Failures (`FAILURE`, `TIMED_OUT`, `CANCELLED`) are hard stops; list the failing check names so the user knows what to fix.

A note on `reviewDecision == "REVIEW_REQUIRED"`: this means the repo's branch protection requires approval and none has been recorded. Don't auto-override — surface it and ask. The user may know the protection is advisory, or may want to nudge a reviewer.

If any gate fails, stop and report what's blocking. Don't pass `--admin` to `gh pr merge` to bypass branch protection unless the user explicitly asks for it — that's a "shoot yourself in the foot" flag and should never be a default.

---

## Phase 3 — Squash and merge

With both gates green, run the merge:

```bash
gh pr merge <PR-URL-or-number> --squash --delete-branch
```

Notes on the flags:

- **`--squash`** — collapses the branch into a single commit on `main`. The squash subject defaults to the PR title; the squash body defaults to the PR description. The PR description should already include `Closes MINI-NN` (every skill that opens a PR is supposed to add this), so the merge commit on `main` will carry it forward — useful for `git log` archaeology even though `mk` doesn't watch GitHub events.
- **`--delete-branch`** — deletes the remote branch. After a squash-merge the original commits aren't reachable from `main` anyway, so leaving the branch is just clutter. Local branches and worktrees are untouched — that's `finish-worktree`'s job.

`gh pr merge` is interactive by default when stdin is a TTY; with `--squash` and `--delete-branch` both supplied it runs non-interactively. If `gh` returns a non-zero exit, **stop** — don't retry blindly. Common failures:

- "Pull Request is not mergeable" → branch protection / status check changed between Phase 2 and now (race). Re-run Phase 2's `gh pr view`, surface the new state.
- "merge commit cannot be created" → conflicts. Stop; the user has to rebase.
- "API rate limit exceeded" → wait and let the user retry.

After a successful merge, capture the merge commit SHA for the mk comment in Phase 4:

```bash
merge_sha=$(gh pr view <PR-URL-or-number> --json mergeCommit -q '.mergeCommit.oid')
```

If the SHA comes back empty, fall back to whatever `gh pr merge` printed to stderr/stdout — but the `gh pr view` shape is the reliable source.

---

## Phase 4 — Transition the issue to `done` and record the merge

Two `mk` calls. Order matters: state transition first (so the board reflects reality immediately), then the comment (so the audit log records the merge alongside the state change). Both use the JSON payload form (the agent-preferred surface — strict-decoded, dry-runnable; schemas at `mk schema show issue.state` and `mk schema show comment.add`):

```bash
mk issue state --user Claude --json '{"key":"MINI-NN","state":"done"}'
```

Then write a brief merge-record comment to a temp file and post it via `jq -n --rawfile` so the markdown stays out of inline-JSON escape soup. Keep it terse — the PR diff is the real record; this is just a pointer.

```bash
cat <<EOF > /tmp/merge-MINI-NN.md
Merged via squash to \`main\`.

- PR: <PR-URL>
- Merge commit: \`<merge-sha>\`
- Branch \`<headRefName>\` deleted on remote.
EOF

jq -n \
  --rawfile body /tmp/merge-MINI-NN.md \
  '{issue_key:"MINI-NN", author:"Claude", body:$body}' \
  | mk comment add --user Claude --json -
rm /tmp/merge-MINI-NN.md
```

If the PR was discovered via `gh pr list` (i.e. not previously attached to the mk issue), also attach it now so the issue's `pull_requests[]` reflects what shipped:

```bash
mk pr attach --user Claude --json '{"issue_key":"MINI-NN","url":"<PR-URL>"}'
```

If either `mk` call fails after the merge succeeded, **don't try to undo the merge** — that's not recoverable. Surface the failure to the user with the exact `mk` command that failed so they can re-run it manually. The merge is the source of truth; the mk state is the bookkeeping that has to catch up.

---

## Phase 5 — Report

State what shipped, link the merge, and hint at the next step:

```
✓ Shipped MINI-NN — "<issue title>"
  PR <PR-URL> squash-merged to main as <short-sha>.
  Branch <headRefName> deleted on remote.
  mk issue MINI-NN moved in_review → done.

Next: `/finish-worktree mini-NN` to tear down the local worktree + dev-env VM.
```

Mention the `/finish-worktree` hint only if a worktree actually exists (`git worktree list | grep .claude/worktrees/mini-NN`). If the work was done outside the worktree flow, drop that line — there's nothing to clean up.

---

## Hard rules

- **Never merge an issue that isn't `in_review`.** Other states mean the work isn't ready, is already done, or was cancelled. Stop and ask.
- **Never bypass branch protection.** Don't pass `--admin` to `gh pr merge` unless the user explicitly asks for it. If the protection is wrong, fix the protection.
- **Never force-merge over failing CI.** Failing checks are signal. The user can override after diagnosing, but the default must be stop-and-surface.
- **Never undo a merge to repair a mk failure.** If the GitHub merge succeeded but `mk issue state` failed, the merge stands and the user re-runs the mk command manually. Reverting a merge to "keep the systems in sync" is far more destructive than a temporary state mismatch.
- **Never auto-pick "the most recent in_review issue" when no argument is given.** Fall back to the current branch only; otherwise stop and ask. Shipping the wrong PR is unrecoverable.
- **Never auto-run `/finish-worktree`.** Suggest it in the report. The worktree may still hold uncommitted local edits the user wants; `finish-worktree`'s defensive checks exist for a reason and shouldn't be sidestepped.
- **Never produce an ExitPlanMode block.** This is an action skill, not a planning skill.

---

## Examples

> User: `/ship-it MINI-29`
>
> *Skill resolves `MINI-29` directly. Runs `mk issue brief MINI-29` — state is `in_review`, one PR attached: `https://github.com/owner/mini-infra/pull/412`.*
>
> *Phase 2: `gh pr view 412 --json …` returns `state=OPEN`, `isDraft=false`, `mergeable=MERGEABLE`, `reviewDecision=APPROVED`, all checks `SUCCESS`. Both gates green.*
>
> *Phase 3: `gh pr merge 412 --squash --delete-branch` succeeds. Merge SHA `a3f1b29`.*
>
> *Phase 4: `mk issue state --user Claude --json '{"key":"MINI-29","state":"done"}'`. Posts merge-record comment via `jq -n --rawfile body /tmp/merge-MINI-29.md '{issue_key:"MINI-29",author:"Claude",body:$body}' | mk comment add --user Claude --json -`.*
>
> Skill: "✓ Shipped MINI-29 — "Add NATS app role allowlist enforcement". PR #412 squash-merged to main as `a3f1b29`. Branch `claude/mini-29` deleted on remote. mk issue MINI-29 moved in_review → done. Next: `/finish-worktree mini-29` to tear down the local worktree + dev-env VM."

> User: `/ship-it 58`
>
> *Skill reads `mk repo show -o json` → prefix `MINI` → resolves to `MINI-58`. `mk issue brief MINI-58` — state is **`in_progress`**.*
>
> Skill: "MINI-58 is `in_progress`, not `in_review`. The work doesn't look ready to ship yet — push the remaining commits and transition to in_review first, or run `/address-review MINI-58` if a `/review` comment is waiting. Want me to look at what's left?"

> User: `/ship-it`
>
> *No argument. Current branch is `claude/mini-31` → derives `MINI-31`. `mk issue brief` — state `in_review`, PR #418 attached.*
>
> *Phase 2: `gh pr view` shows `statusCheckRollup` has one `FAILURE` — `ci / build-server`. Stop.*
>
> Skill: "MINI-31's PR (#418) has a failing check: `ci / build-server` (FAILURE). I'll skip the merge — fix the check or override and re-run if you know it's a flake. Want me to pull the failing logs?"
