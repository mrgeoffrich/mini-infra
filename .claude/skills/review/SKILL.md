---
name: review
description: Independent code-review skill for a GitHub PR. Accepts a GitHub PR number (`372` or `#372`), a branch name (`claude/tunnel-retry`), or **no argument** (reviews the current branch's open PR). Resolves the input to {PR, branch}, pulls `gh pr diff <PR>`, reads the project conventions that bear on the touched directories (root CLAUDE.md always; server/CLAUDE.md when `server/` files change; client/CLAUDE.md when `client/` files change; ICONOGRAPHY.md when UI changes), and reviews the diff for **bugs and logic errors** (off-by-one, null-deref, race conditions, broken control flow, swapped arguments, error-swallowing `try/catch`), **security** (injection, secret leakage, auth bypass, OWASP-top-10 patterns), **convention violations** (raw `dockerode` vs `DockerService.getInstance()`, raw `docker.pull()` vs `pullImageWithAutoAuth()`, raw socket strings vs `Channel.*`/`ServerEvent.*`, missing `userId` on config-service mutations, polling when a socket is connected, missing task-tracker registry entries for new long-running ops, `any`-typed code), **duplication** (logic that was inlined when an existing helper or shared type would have done, types duplicated client-side and server-side instead of pulled from `@mini-infra/types`), **drift from the PR description** (stated goals that didn't land, scope creep that wasn't mentioned), and **dead code / debug leftovers** (commented blocks, `console.log`, unused imports, narration-style comments). Posts a single structured comment on the PR (via `gh pr comment`) with severity-labelled findings (`critical | high | medium | low`), an empty review when the diff is fine, and a closing one-liner verdict. **Makes no code changes** — auto-fixing was deliberately separated from this skill so a fix-up pass can be done by hand or by a different skill afterwards. **Does not check test coverage** — that's a separate concern. **Does not check doc-artefact drift** beyond a one-line pointer; `api-change-check` owns that sweep. Use this skill whenever the user says "review PR 372", "review the current branch", "review my PR", "code review for this branch", "have a look at the changes", "what's wrong with this PR", "did I break anything", "would you ship this", or any equivalent ask to get an independent pair of eyes on a change. Trigger even when the user doesn't say the word "review" but is clearly asking for one. Do NOT trigger for ad-hoc "look at this code" without a PR / branch reference, or for tasks about producing changes.
---

# Review

You're a **code-review agent**. The PR diff says what shipped, and the PR title/description say what it was supposed to do. Your job is to read both and surface anything that looks wrong — bugs, logic errors, security holes, convention violations, duplication, drift from the stated intent, dead code — as a single structured comment on the PR.

You make **no code changes**. The findings are for the user (or a separate fix-up pass) to act on later. Empty findings is a great result — don't pad with low-severity nits to look thorough.

---

## Phase 1 — Resolve the input to {PR, branch}

Resolve by argument shape.

**PR number** (matches `^\d+$` or `^#\d+$`): `gh pr view <N> --json number,headRefName,title,body`.

**Branch name** (anything else looking like a ref, e.g. `claude/tunnel-retry`): `gh pr list --head <branch> --state open --json number,headRefName,title,body`. If no open PR is found for that branch, stop and ask.

**No argument**: resolve from the current shell.
- `git rev-parse --abbrev-ref HEAD` — current branch.
- `gh pr view --json number,title,body,headRefName` from inside the worktree — finds the PR for that branch.
- If the current branch is `main` or has no open PR, stop and ask which target to review.

**State the resolved target before proceeding** so the user can intercept if the resolution is wrong:

> Reviewing PR #N ("<PR title>") — branch `<branch>`.

---

## Phase 2 — Read the stated intent

The PR title and body are the contract — whatever goal, deliverables, or acceptance criteria the author wrote there. Read `.title` and `.body` from Phase 1's `gh pr view`/`gh pr list` output.

If the PR body links to a design doc under `docs/designs/`, read it — its **Recommendation** and **Key abstractions** sections are part of the contract. Drift between the design doc's recommendation and the actual diff is a finding worth flagging at `medium` or `high` depending on how load-bearing the divergence is.

If the PR body or title is thin (no stated goal beyond a one-line summary), that's fine — just review the diff on its own merits without inventing a contract that isn't there.

---

## Phase 3 — Pull the diff

```bash
gh pr diff <PR-number> > /tmp/review-<PR>.diff
```

Capture it on disk so it's stable across re-reads. Then capture the changed-files list — Phase 4 needs it:

```bash
gh pr view <PR-number> --json files -q '.files[].path' | sort -u > /tmp/review-<PR>.files
```

Don't rely on the local working tree — fetch from origin so the review covers exactly what's on the PR. If the PR has multiple commits, the diff is the *combined* diff vs main; that's the right unit of review.

---

## Phase 4 — Read the project conventions that bear on the diff

The skill should not review against generic best-practice — it should review against **what this codebase says is right**. Read CLAUDE.md files based on which directories the diff touches.

- **Always** — root [CLAUDE.md](CLAUDE.md). pnpm + worktree workflow, the Critical Coding Patterns block (`pullImageWithAutoAuth`, `DockerService.getInstance()`, `ConfigurationServiceFactory`, `Channel.*`/`ServerEvent.*`, no `any`).
- **Any `server/` change** — [server/CLAUDE.md](server/CLAUDE.md) (service wrappers, audit trail with `userId`, Socket.IO emission patterns, schema rules).
- **Any `client/` change** — [client/CLAUDE.md](client/CLAUDE.md) (TanStack Query data-fetching, no polling when socket connected, `useSocketChannel`/`useSocketEvent` lifecycle, task-tracker registry, `useOperationProgress` hook).
- **Any sidecar change** (`update-sidecar/`, `agent-sidecar/`, `egress-gateway/`, `egress-fw-agent/`) — local conventions doc if one exists.
- **UI changes** — [claude-guidance/ICONOGRAPHY.md](claude-guidance/ICONOGRAPHY.md). Naming icons by Tabler convention and using the listed glyphs is a real rule the codebase follows.

Don't read every CLAUDE.md in the repo — only the ones the diff touches. A `docs/`-only diff doesn't need server/ conventions loaded.

---

## Phase 5 — Review the diff

Walk the diff and apply the checklist below. Be honest and concise — the reviewer's job is to flag **what's actually wrong**, not to demonstrate thoroughness. Empty findings is the right answer when the diff is fine; don't pad.

### What to flag

**Bugs and logic errors.** This is the highest-value category — name them clearly and cite the line. Off-by-one, null-deref, race conditions, wrong loop bounds, swapped arguments, broken control flow, branches that can never trigger, conditions that are tautologically true / false, error-swallowing `try/catch` blocks, typos that compile but mean the wrong thing, missing `await` on a Promise-returning call, missing cleanup in a `finally`, `Promise.all` over an array of side effects when sequencing matters, accidental shared state across requests, time-of-check / time-of-use windows.

**Security.** Injection (SQL, command, prompt, HTML), secret leakage (logged credentials, hardcoded tokens, secrets in error messages, secrets in git history), auth bypass (missing auth check, wrong scope, role escalation), OWASP-top-10 patterns. Be specific. "This looks insecure" is not a finding; "this concatenates `req.body.name` into a `LIKE` clause without parameterising" is.

**Convention violations** (codebase-specific, from Phase 4's reading):
- Raw `dockerode` calls instead of `DockerService.getInstance()` wrappers.
- Raw `docker.pull()` instead of `DockerExecutorService.pullImageWithAutoAuth()`.
- Raw socket-event strings (`io.emit("foo:bar")`) instead of `Channel.*` / `ServerEvent.*` constants from `lib/types/socket-events.ts`.
- Mutating config services without the `userId` parameter (audit trail rule).
- Frontend polling with `refetchInterval` when a socket channel is connected.
- New long-running operation without a task-tracker registry entry in `client/src/lib/task-type-registry.ts`.
- `any` types where a real type was straightforward — flag at `medium` if it masks a real signature, `low` if it's a one-off escape hatch.

**Duplication.** Logic inlined when an existing helper / service / hook in the same component would have done. Types or constants duplicated client-side and server-side instead of pulled from `@mini-infra/types`. Same for `egress-shared/` between the egress gateway and agent. New utility code that pattern-matches an existing utility somewhere else in the repo.

**Drift from the stated intent.**
- Things the PR title/body says it does that aren't in the diff.
- Things in the diff that aren't mentioned in the PR title/body (scope creep) — only worth flagging if it's substantial, not every incidental touch-up.
- If a design doc was linked, the **Recommendation** says which option was picked — implementing the *other* option is a finding.

**Dead code / debug leftovers.** `console.log`. Commented-out blocks (delete them — git remembers). Unused imports / exports / types. `// TODO: remove this` left in. Half-finished implementations referenced from production code. Empty `if` branches. Functions that are defined but never called.

**Comment quality.** The codebase rule is "default to no comments unless WHY is non-obvious." A comment that just narrates what the next line does is a finding. A comment that references a removed PR / ticket / function is a finding. Multi-paragraph docstrings are a finding.

### What NOT to flag

- **Style nits the linter would catch.** The project has Prettier + ESLint; trust them.
- **"Could be cleaner"** without a concrete bug or convention violation. Personal taste is not a finding.
- **Missing tests.** Test coverage is explicitly out of scope for this skill — the user asked for `/review` to focus on bugs / logic / security / conventions, not coverage.
- **Hypothetical future-extensibility.** Today's diff for today's contract; the project's CLAUDE.md actively discourages designing for hypothetical future requirements.
- **Backwards-compatibility shims and feature flags.** The CLAUDE.md says "don't use feature flags or backwards-compatibility shims when you can just change the code." Don't request them.
- **Missing tests for new behaviour, error handling for impossible cases, validation for non-boundary inputs.** All explicitly discouraged by root CLAUDE.md.
- **Doc-artefact drift.** That's `api-change-check`'s territory. If the diff touches API routes or `lib/types/permissions.ts`, mention it as a one-line pointer in the final comment's "Out of scope" section — don't enumerate every missing doc bullet.

### Severity calibration

Use `critical | high | medium | low` honestly. Calibration matters more than total finding count.

- **`critical`** — would break production or leak data on first run. SQL injection, auth bypass, infinite loop on a hot path, a migration that drops data, a credential committed to the repo. If you flag `critical`, the rationale must be airtight; spurious `critical` burns trust faster than any other miscalibration.
- **`high`** — a real bug or convention violation that will bite the next person to read the code or use the feature. Wrong default value, missing `userId` on a config mutation, polling racing with socket invalidation, a code path that throws on the happy path, a stated deliverable that didn't land.
- **`medium`** — a real issue that's not yet biting anyone. Duplicated logic that should be extracted, drift from the design doc on a non-critical detail, dead code that's not load-bearing, an `any` that masks a real signature, a convention violation that's narrow in blast radius.
- **`low`** — minor cleanup. Leftover `console.log`, unused import, comment that just narrates the code, typo in a string the user might never see. Group these together at the end of the comment.

If you have to debate `medium` vs `low`, default to `low`.

---

## Phase 6 — Format and post the PR comment

The comment is the deliverable. One comment per review run, posted on the PR.

```bash
gh pr comment <PR-number> --body-file /tmp/review-<PR>.md
```

Template — omit a section that's empty rather than write "None.":

```markdown
**Review of `<PR title>`** — <N> finding(s).

<one-sentence summary of the diff: shape of the work and rough size, e.g. "Adds the new `tailscale` connected-service settings page (one new page, two new shared primitives, ~600 lines across client/ and server/).">

### Critical
- **<short imperative title>** — `<file>:<line>`.
  <1–3 sentences: what's wrong, why it matters, what the fix looks like.>

### High
- **<title>** — `<file>:<line>`.
  <…>

### Medium
- **<title>** — `<file>:<line>`.
  <…>

### Low
<one short paragraph or compact list, e.g. "Unused import in `foo.ts:12`. Stray `console.log` in `bar.ts:88`. Comment at `baz.ts:34` narrates the code rather than a non-obvious why.">

### Out of scope (run separately)
- API routes / permissions changed in this diff — run `/api-change-check` for the doc-artefact sweep.
- <other deferred concerns, if any>

---

_<one-line verdict: "Looks ready to ship after the two `high` findings are addressed." or "Empty review — nothing to do." Don't manufacture a verdict if the bar is somewhere between; one short honest sentence.>_
```

Empty review:

```markdown
**Review of `<PR title>`** — no findings.

<one-sentence summary of the diff>.

Looks ready to ship.
```

Don't pad an empty review with low-priority "I noticed an unused import" findings. Empty really is the best result.

---

## Phase 7 — Final report to the user

Tight summary in chat:

```
Review posted on PR #N (<finding count> finding(s)).

Breakdown: <C> critical, <H> high, <M> medium, <L> low.
<one-line top finding if there is one — "Highest-severity: SQL injection in server/src/services/foo.ts:142.">

Run /review again after fixes land to re-check.
```

If empty:

```
Review posted on PR #N (no findings).
Looks ready to ship.
```

That's the run.

---

## Hard rules

- **Make no code changes.** The skill reads, reviews, and writes one PR comment. It does not edit files, run `git add`, commit, push, or open / merge / close PRs. Auto-fixing was deliberately separated out of this flow.
- **Be honest about empty.** If the diff is fine, post an empty review. Padding produces noise that makes future reviews easier to ignore.
- **Calibrate severity.** Critical means "breaks production" — everything else is below that. A spurious `critical` finding burns trust and makes the user re-derive whether to take the next one seriously.
- **Don't flag what you didn't read.** If a hunk is too noisy to follow without reading the whole file, read the whole file. Findings based on incomplete reading are worse than findings on a smaller set you actually understood.
- **Cite file + line, always.** `<file>:<line>` notation; the user copies it straight into their editor. A finding without a path is not actionable.
- **One comment per run.** Don't post multiple comments for one review. If you re-run after fixes, post a fresh comment — don't edit the previous one.
- **Stop on missing inputs.** No PR, ambiguous resolution → stop and ask. Don't guess past these.
- **Never produce an ExitPlanMode block.** This is a review skill; the PR comment is the deliverable.

---

## Example

> User: `/review 412`
>
> *Skill runs `gh pr view 412 --json number,headRefName,title,body`. Resolves: PR #412 ("Phase 4: pg-az-backup progress + result events"), branch `claude/pg-backup-events`. Confirms: "Reviewing PR #412 — branch `claude/pg-backup-events`."*
>
> *Phase 2: reads the PR body. States the goal — emit progress + result events for pg-az-backup — and lists three deliverables: new socket events, task-tracker registry entry, server emitter. No linked design doc.*
>
> *Phase 3: `gh pr diff 412 > /tmp/review-412.diff`. 7 files changed, mostly under `server/src/services/backup/` plus one update to `client/src/lib/task-type-registry.ts`.*
>
> *Phase 4: reads root CLAUDE.md, server/CLAUDE.md, and client/CLAUDE.md. Notes the `Channel.*`/`ServerEvent.*` constants rule and the task-tracker pattern.*
>
> *Phase 5: walks the diff. Finds:*
> - **High** — `server/src/services/backup/backup-progress-emitter.ts:47` — emitter swallows error when `db.event.create` fails (`console.error` then returns), so failed inserts never surface; project pattern is to log + throw and let the caller decide.
> - **Medium** — `server/src/services/backup/backup-executor.ts:208` — duplicates the step-name normalisation already at `cert-issuance/cert-issuance-executor.ts:412`; should be extracted into `server/src/services/operation-step.ts`.
> - **Low** — leftover `console.log("emitter wired up")` in `backup-progress-emitter.ts:12`.
>
> *Phase 6: writes the comment body to `/tmp/review-412.md`, then `gh pr comment 412 --body-file /tmp/review-412.md`. Three sections (High / Medium / Low), closing line "Looks ready to ship after the high finding is addressed."*
>
> Skill: "Review posted on PR #412 (3 findings). Breakdown: 0 critical, 1 high, 1 medium, 1 low. Highest-severity: error swallowing in `backup-progress-emitter.ts:47`. Run /review again after fixes land to re-check."
