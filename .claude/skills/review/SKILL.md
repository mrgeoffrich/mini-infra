---
name: review
description: Independent code-review skill for an mk-tracked PR. Accepts an mk issue key (`MINI-NN`), a GitHub PR number (`372` or `#372`), a branch name (`claude/mini-32`), or **no argument** (reviews the current branch's open PR). Resolves the input to the triple {mk issue, PR, branch}, reads the ticket as the contract — Goal / Deliverables / Done when, plus any **Design ready** comment from `design-task` pointing at a design doc under `docs/designs/` — pulls `gh pr diff <PR>`, reads the project conventions that bear on the touched directories (root CLAUDE.md always; server/CLAUDE.md when `server/` files change; client/CLAUDE.md when `client/` files change; per-component pointers from the ticket's "Relevant docs"; ICONOGRAPHY.md when UI changes), and reviews the diff for **bugs and logic errors** (off-by-one, null-deref, race conditions, broken control flow, swapped arguments, error-swallowing `try/catch`), **security** (injection, secret leakage, auth bypass, OWASP-top-10 patterns), **convention violations** (raw `dockerode` vs `DockerService.getInstance()`, raw `docker.pull()` vs `pullImageWithAutoAuth()`, raw socket strings vs `Channel.*`/`ServerEvent.*`, missing `userId` on config-service mutations, polling when a socket is connected, missing task-tracker registry entries for new long-running ops, `any`-typed code), **duplication** (logic that was inlined when an existing helper or shared type would have done, types duplicated client-side and server-side instead of pulled from `@mini-infra/types`), **drift from the contract** (deliverables that didn't land, scope creep that wasn't asked for, design doc's recommendation not followed), and **dead code / debug leftovers** (commented blocks, `console.log`, unused imports, narration-style comments). Posts a single structured comment on the mk issue with severity-labelled findings (`critical | high | medium | low`), an empty review when the diff is fine, and a closing one-liner verdict. **Makes no code changes** — auto-fixing was deliberately separated from this skill so a fix-up pass can be done by hand or by a different skill afterwards. **Does not check test coverage** — that's a separate concern. **Does not check doc-artefact drift** beyond a one-line pointer; `api-change-check` owns that sweep. Use this skill whenever the user says "review MINI-NN", "review PR 372", "review the current branch", "review my PR", "code review for MINI-NN", "have a look at the changes for MINI-NN", "what's wrong with this PR", "any bugs in MINI-32", "did I break anything", "would you ship this", or any equivalent ask to get an independent pair of eyes on a change. Trigger even when the user doesn't say the word "review" but is clearly asking for one. Do NOT trigger for ad-hoc "look at this code" without an mk issue or PR / branch reference, for tasks about producing changes (use `execute-next-task` or `fix-and-validate` for that), or for design exploration (use `design-task`).
---

# Review

You're a **code-review agent**. The mk ticket says what was supposed to ship; the PR diff says what actually shipped. Your job is to read both and surface anything that looks wrong — bugs, logic errors, security holes, convention violations, duplication, drift from the contract, dead code — as a single structured comment on the mk issue.

You make **no code changes**. The findings are for the user (or a separate fix-up skill) to act on later. Empty findings is a great result — don't pad with low-severity nits to look thorough.

Issues live in `mk` (mini-kanban), the local CLI tracker bound to this repo. The `mk` skill at `.claude/skills/mk/SKILL.md` covers the CLI in detail; this skill calls into it.

---

## Phase 1 — Confirm `mk` is available

`mk` is a local binary, not an MCP server — there's nothing to load. Sanity-check it before starting:

```bash
mk status -o json
```

This should print the current repo, prefix (expected `MINI`), and counts. If `mk` errors with "not inside a git repository", `cd` to the repo root and retry. If the binary isn't installed, stop and tell the user — without `mk` we can't read the contract or post the deliverable.

All `mk` reads in this skill use `-o json` for stable parsing. All mutations pass `--user Claude` so the audit log attributes the change correctly.

---

## Phase 2 — Resolve the input to {mk issue, PR, branch}

The skill needs all three: the **issue** is the contract, the **PR** is the diff, the **branch** is the ref. Resolve them by argument shape.

**`MINI-NN`** (matches `MINI-\d+` case-insensitive, surrounding text fine):
1. `mk issue show MINI-NN -o json`. If it errors with "issue not found", stop.
2. Find the PR: read `prs[]` (or equivalent) from the JSON — `design-task` and `execute-next-task` attach the PR via `mk pr attach` when they ship. If the issue has no attached PR, fall back to `gh pr list --search "MINI-NN" --state open --json number,headRefName,title -L 5` and take the most recent open match. If multiple match and the choice isn't obvious, list them and ask.
3. The PR's `headRefName` is the branch.

**PR number** (matches `^\d+$` or `^#\d+$`): `gh pr view <N> --json number,headRefName,title,body`. Pull the mk key from the PR title (the `(MINI-NN)` suffix the project's commit convention uses) or the `Closes MINI-NN` line in the body. If neither is present, ask which mk issue this PR belongs to — don't guess.

**Branch name** (anything else looking like a ref, e.g. `claude/mini-32`): `gh pr list --head <branch> --state open --json number`. Pull the mk key from the branch (`claude/mini-NN` → `MINI-NN`) or the PR body, same as the PR-number flow.

**No argument**: resolve from the current shell.
- `git rev-parse --abbrev-ref HEAD` — current branch.
- `gh pr view --json number,title,body,headRefName` from inside the worktree — finds the PR for that branch.
- Pull the mk key from the branch (`claude/mini-NN` → `MINI-NN`) or the PR body.
- If the current branch is `main` or has no open PR, stop and ask which target to review.

**State the resolved triple before proceeding** so the user can intercept if the resolution is wrong:

> Reviewing MINI-NN ("<ticket title>") — PR #N, branch `<branch>`.

---

## Phase 3 — Read the contract

The mk ticket is the contract. Fetch it with `mk issue show MINI-NN -o json` and pull these from the issue body:

- **Goal** — what outcome the work is supposed to achieve
- **Deliverables** — the concrete things that have to exist
- **Done when** — the testable acceptance criterion
- **Source** — plan-doc anchor, if present
- **Relevant docs** — per-component CLAUDE.md / ARCHITECTURE.md pointers

Then skim `mk comment list MINI-NN -o json` for two things:

1. **A `**Design ready (PR open):**` comment from `design-task`** — pointer to a design doc under `docs/designs/<id>-<slug>.md`. If you find one, the doc's **Recommendation** + **Key abstractions** + **File / component sketch** + **States, failure modes & lifecycle** sections are part of the contract. Drift between the design doc's recommendation and the actual diff is a finding worth flagging at `medium` or `high` depending on how load-bearing the divergence is.

   Read the doc. If the design PR has merged, it's on `main`; if still open, fetch via `gh pr view <design-PR> --json headRefName -q .headRefName`, then `git fetch origin <branch> && git show origin/<branch>:docs/designs/<filename>.md`.

2. **Any `execute-next-task` handoff comment** — has sections like "Deviations from the spec" and "Work deferred". These name choices the executor consciously made; if you flag something the handoff already explained as a deliberate deviation, mention that you saw the explanation rather than restating the finding as if it weren't disclosed.

If the parent feature has a `Plan:` line in its description (`mk feature show <slug> -o json` for the feature linked from the issue), and the ticket's **Source** points at a `### Phase N` section in that plan doc, read the matching section as supplemental context. The ticket body still wins on what specifically was supposed to ship.

---

## Phase 4 — Pull the diff

```bash
gh pr diff <PR-number> > /tmp/review-<PR>.diff
```

Capture it on disk so it's stable across re-reads. Then capture the changed-files list — Phase 5 needs it:

```bash
gh pr view <PR-number> --json files -q '.files[].path' | sort -u > /tmp/review-<PR>.files
```

Don't rely on the local working tree — fetch from origin so the review covers exactly what's on the PR. If the PR has multiple commits, the diff is the *combined* diff vs main; that's the right unit of review.

---

## Phase 5 — Read the project conventions that bear on the diff

The skill should not review against generic best-practice — it should review against **what this codebase says is right**. Read CLAUDE.md files based on which directories the diff touches.

- **Always** — root [CLAUDE.md](CLAUDE.md). pnpm + worktree workflow, the Critical Coding Patterns block (`pullImageWithAutoAuth`, `DockerService.getInstance()`, `ConfigurationServiceFactory`, `Channel.*`/`ServerEvent.*`, no `any`).
- **Any `server/` change** — [server/CLAUDE.md](server/CLAUDE.md) (service wrappers, audit trail with `userId`, Socket.IO emission patterns, schema rules).
- **Any `client/` change** — [client/CLAUDE.md](client/CLAUDE.md) (TanStack Query data-fetching, no polling when socket connected, `useSocketChannel`/`useSocketEvent` lifecycle, task-tracker registry, `useOperationProgress` hook).
- **Any sidecar change** (`update-sidecar/`, `agent-sidecar/`, `egress-gateway/`, `egress-fw-agent/`) — local conventions doc if one exists.
- **Per-component pointers** the ticket lists under "Relevant docs" — read them, they were chosen because they apply.
- **UI changes** — [claude-guidance/ICONOGRAPHY.md](claude-guidance/ICONOGRAPHY.md). Naming icons by Tabler convention and using the listed glyphs is a real rule the codebase follows.

Don't read every CLAUDE.md in the repo — only the ones the diff touches. A `docs/`-only diff doesn't need server/ conventions loaded.

---

## Phase 6 — Review the diff

Walk the diff and apply the checklist below. Be honest and concise — the reviewer's job is to flag **what's actually wrong**, not to demonstrate thoroughness. Empty findings is the right answer when the diff is fine; don't pad.

### What to flag

**Bugs and logic errors.** This is the highest-value category — name them clearly and cite the line. Off-by-one, null-deref, race conditions, wrong loop bounds, swapped arguments, broken control flow, branches that can never trigger, conditions that are tautologically true / false, error-swallowing `try/catch` blocks, typos that compile but mean the wrong thing, missing `await` on a Promise-returning call, missing cleanup in a `finally`, `Promise.all` over an array of side effects when sequencing matters, accidental shared state across requests, time-of-check / time-of-use windows.

**Security.** Injection (SQL, command, prompt, HTML), secret leakage (logged credentials, hardcoded tokens, secrets in error messages, secrets in git history), auth bypass (missing auth check, wrong scope, role escalation), OWASP-top-10 patterns. Be specific. "This looks insecure" is not a finding; "this concatenates `req.body.name` into a `LIKE` clause without parameterising" is.

**Convention violations** (codebase-specific, from Phase 5's reading):
- Raw `dockerode` calls instead of `DockerService.getInstance()` wrappers.
- Raw `docker.pull()` instead of `DockerExecutorService.pullImageWithAutoAuth()`.
- Raw socket-event strings (`io.emit("foo:bar")`) instead of `Channel.*` / `ServerEvent.*` constants from `lib/types/socket-events.ts`.
- Mutating config services without the `userId` parameter (audit trail rule).
- Frontend polling with `refetchInterval` when a socket channel is connected.
- New long-running operation without a task-tracker registry entry in `client/src/lib/task-type-registry.ts`.
- `any` types where a real type was straightforward — flag at `medium` if it masks a real signature, `low` if it's a one-off escape hatch.

**Duplication.** Logic inlined when an existing helper / service / hook in the same component would have done. Types or constants duplicated client-side and server-side instead of pulled from `@mini-infra/types`. Same for `egress-shared/` between the egress gateway and agent. New utility code that pattern-matches an existing utility somewhere else in the repo.

**Drift from the contract.**
- Deliverables in the ticket that aren't in the diff.
- Things in the diff that aren't in any Deliverable / Done-when (scope creep).
- If a design doc was posted, the **Recommendation** says which option was picked — implementing the *other* option is a finding. Specific failure-mode wording, configured-state strategy, or named abstractions in the doc that the diff doesn't follow are also findings.
- "Done when" criterion that the diff visibly fails to satisfy.

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
- **`high`** — a real bug or convention violation that will bite the next person to read the code or use the feature. Wrong default value, missing `userId` on a config mutation, polling racing with socket invalidation, a code path that throws on the happy path, a deliverable from the ticket that didn't land.
- **`medium`** — a real issue that's not yet biting anyone. Duplicated logic that should be extracted, drift from the design doc on a non-critical detail, dead code that's not load-bearing, an `any` that masks a real signature, a convention violation that's narrow in blast radius.
- **`low`** — minor cleanup. Leftover `console.log`, unused import, comment that just narrates the code, typo in a string the user might never see. Group these together at the end of the comment.

If you have to debate `medium` vs `low`, default to `low`.

---

## Phase 7 — Format and post the mk comment

The comment is the deliverable. One comment per review run, posted on the mk issue.

Write the body to a temp file, then post:

```bash
mk comment add MINI-NN --as Claude --user Claude --body-file /tmp/review-MINI-NN.md
```

`--as Claude` is the comment author (mandatory on every `mk comment add`). `--user Claude` is the audit-log actor (mandatory for every agent-driven mutation). `mk comment add` requires the body via `--body-file <path>` or `--body -` from stdin — there's no inline editor, and `--body "two\nlines"` does not interpret `\n`.

Template — omit a section that's empty rather than write "None.":

```markdown
**Review of [`<PR title>`](<PR URL>)** — <N> finding(s).

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
**Review of [`<PR title>`](<PR URL>)** — no findings.

<one-sentence summary of the diff>.

Looks ready to ship.
```

Don't pad an empty review with low-priority "I noticed an unused import" findings. Empty really is the best result.

---

## Phase 8 — Final report to the user

Tight summary in chat:

```
Review posted on MINI-NN (<finding count> finding(s)).

Breakdown: <C> critical, <H> high, <M> medium, <L> low.
<one-line top finding if there is one — "Highest-severity: SQL injection in server/src/services/foo.ts:142.">

Run /review again after fixes land to re-check.
```

If empty:

```
Review posted on MINI-NN (no findings).
Looks ready to ship.
```

That's the run.

---

## Hard rules

- **Make no code changes.** The skill reads, reviews, and writes one mk comment. It does not edit files, run `git add`, commit, push, or open / merge / close PRs. Auto-fixing was deliberately separated out of this flow.
- **Be honest about empty.** If the diff is fine, post an empty review. Padding produces noise that makes future reviews easier to ignore.
- **Calibrate severity.** Critical means "breaks production" — everything else is below that. A spurious `critical` finding burns trust and makes the user re-derive whether to take the next one seriously.
- **Don't flag what you didn't read.** If a hunk is too noisy to follow without reading the whole file, read the whole file. Findings based on incomplete reading are worse than findings on a smaller set you actually understood.
- **Cite file + line, always.** `<file>:<line>` notation; the user copies it straight into their editor. A finding without a path is not actionable.
- **One comment per run.** Don't post multiple comments for one review. If you re-run after fixes, post a fresh comment — don't edit the previous one.
- **Always pass `--user Claude` on `mk` mutations and `--as Claude` on `mk comment add`.** Without `--user`, the audit log silently attributes the change to whichever OS user the agent runs under — useless history.
- **Always pass `-o json` when parsing `mk` output.** Text mode is for humans only.
- **Never run `mk` outside a git repo** — it hard-errors. `cd` to the repo first.
- **Stop on missing inputs.** No mk key, no PR, ambiguous resolution → stop and ask. Don't guess past these.
- **Never produce an ExitPlanMode block.** This is a review skill; the mk comment is the deliverable.

---

## Example

> User: `/review MINI-32`
>
> *Skill runs `mk status -o json` to confirm the binary is wired up and the repo prefix is `MINI`. Resolves: MINI-32 ("Phase 4: pg-az-backup progress + result events"), PR #412, branch `claude/mini-32`. Confirms: "Reviewing MINI-32 — PR #412, branch `claude/mini-32`."*
>
> *Phase 3: `mk issue show MINI-32 -o json`. Goal: emit progress + result events for pg-az-backup. Deliverables: three new socket events, task-tracker registry entry, server emitter. `mk comment list MINI-32 -o json` shows no design comment on this ticket — backend-only work. One handoff comment from execute-next-task notes the optional retry-on-transient-failure deliverable was deferred to a follow-up.*
>
> *Phase 4: `gh pr diff 412 > /tmp/review-412.diff`. 7 files changed, mostly under `server/src/services/backup/` plus one update to `client/src/lib/task-type-registry.ts`.*
>
> *Phase 5: reads root CLAUDE.md, server/CLAUDE.md, and client/CLAUDE.md. Notes the `Channel.*`/`ServerEvent.*` constants rule and the task-tracker pattern.*
>
> *Phase 6: walks the diff. Finds:*
> - **High** — `server/src/services/backup/backup-progress-emitter.ts:47` — emitter swallows error when `db.event.create` fails (`console.error` then returns), so failed inserts never surface; project pattern is to log + throw and let the caller decide.
> - **Medium** — `server/src/services/backup/backup-executor.ts:208` — duplicates the step-name normalisation already at `cert-issuance/cert-issuance-executor.ts:412`; should be extracted into `server/src/services/operation-step.ts`.
> - **Low** — leftover `console.log("emitter wired up")` in `backup-progress-emitter.ts:12`.
>
> *Phase 7: writes the comment body to `/tmp/review-MINI-32.md`, then `mk comment add MINI-32 --as Claude --user Claude --body-file /tmp/review-MINI-32.md`. Three sections (High / Medium / Low), closing line "Looks ready to ship after the high finding is addressed."*
>
> Skill: "Review posted on MINI-32 (3 findings). Breakdown: 0 critical, 1 high, 1 medium, 1 low. Highest-severity: error swallowing in `backup-progress-emitter.ts:47`. Run /review again after fixes land to re-check."
