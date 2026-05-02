---
name: setup-worktree
description: Sets up a fresh git worktree — pre-flights main, pulls latest, creates the worktree at `.claude/worktrees/<slug>` on branch `claude/<slug>`, runs `pnpm install`, and (by default) kicks off `pnpm worktree-env start` in the background to warm the dev VM/distro. Takes an optional Linear issue ID as the argument (e.g. `/setup-worktree ALT-32`); when omitted, generates a random `adjective-animal` slug (e.g. `swift-otter`) for ad-hoc work that isn't tracked in Linear. Pass `--no-env` to skip the dev-env spin-up — useful for docs-only changes or when the caller doesn't need a running stack. This skill is the worktree-prep half of `execute-next-task` (Phases 4 through 6) extracted so it can be reused by other skills (e.g. `fix-and-validate`, ad-hoc bugfix flows) and called directly by the user when they want a worktree without the full execute-end-to-end loop. Use this skill whenever the user says "set up a worktree", "setup a worktree for ALT-NN", "create a worktree", "spin up a worktree", "new worktree for ALT-NN", "worktree for ALT-NN", "make me a worktree", or any equivalent ask to scaffold a fresh agent worktree from main. Do **not** trigger when the user is already inside a worktree and wants to keep working there, or when they want the full execute-next-task flow (which already calls this internally).
---

# Setup Worktree

This is a **scaffolding skill**, not an execution agent. It gets a fresh worktree from `main` ready for work — pre-flights, pulls, creates the worktree and branch, installs deps, and (by default) warms the dev environment in the background — then hands control back to the caller. It does **not** read Linear tickets, do code changes, or open PRs.

It's the worktree-prep half of `execute-next-task` (Phases 4–6) carved out so other flows can reuse it: `fix-and-validate` for issue-driven bugfixes, ad-hoc "fix this thing" sessions, design-doc PR flows, anything that needs an isolated worktree without the full execute-end-to-end loop.

## Arguments

The skill takes one optional argument and two optional flags:

- **`<ALT-NN>`** (optional) — the Linear issue ID this worktree is for. When supplied, the slug is `alt-NN` (lowercased) and the branch is `claude/alt-NN`. Accepts `ALT-32`, `alt-32`, or surrounding text containing the pattern. **When omitted**, the skill generates a random `adjective-animal` slug (e.g. `swift-otter`, `bold-lynx`) for ad-hoc work that isn't tracked in a ticket.
- **`--no-env`** (optional) — skip Phase 4 (the `pnpm worktree-env start` background warm-up). Use this when the caller knows the change is docs-only or when they explicitly don't want a running dev stack.
- **`--description "<short summary>"`** (optional) — pass-through to `pnpm worktree-env start`. If omitted, the skill tries to fetch the Linear issue title (when an `ALT-NN` was supplied and the Linear MCP is loaded) and derives a ≤10-word description from it. If neither is available, prompt the user once for one — `pnpm worktree-env start` requires a description on first run for a new worktree.

---

## Phase 1 — Pre-flight on main

The skill assumes you start at the **main checkout root**, on `main`, with a clean tree. The first job is to confirm that and pull the latest. (This phase is identical to Phase 4 of `.claude/skills/execute-next-task/SKILL.md` — see there for the full reasoning.)

```bash
pwd
git rev-parse --abbrev-ref HEAD
git status
```

Required state:

- **`pwd` is the repo root**, not under `.claude/worktrees/`. If you're already in a worktree, exit to the root and re-run.
- **Branch is the repo's default** (usually `main`; confirm with `git symbolic-ref refs/remotes/origin/HEAD --short` if unsure).
- **Working tree is clean** — no uncommitted changes.

If any of these fail, **stop with a clear message**. Don't auto-stash, auto-checkout, or guess — the user's WIP elsewhere matters more than this skill's convenience.

Then update main:

```bash
git pull --ff-only origin main
```

`--ff-only` means a stale local main with non-pushed commits surfaces as an error rather than being silently merged. If it fails, stop and tell the user.

---

## Phase 2 — Create the worktree

Derive the worktree slug:

- **If `ALT-NN` was supplied**: slug is `alt-<NN>` (lowercase). For `ALT-29`, slug is `alt-29`.
- **If `ALT-NN` was omitted**: pick a random `<adjective>-<animal>` slug, e.g. `swift-otter`, `bold-lynx`, `quiet-heron`, `merry-badger`. Keep both words short (≤8 chars each), all lowercase, single hyphen separator, no digits. State the chosen slug to the user up-front so they can `cd` to it later.
- **Worktree path**: `.claude/worktrees/<slug>` — relative to the repo root. (The repo's existing convention puts worktrees here; root `CLAUDE.md` walks through the layout.)
- **Branch**: `claude/<slug>` — namespaces it as agent-created, matching the other `claude/...` branches.

Before creating, **collision-check** the chosen slug — for either flavour, but it matters most for the random one:

```bash
ls .claude/worktrees/<slug> 2>/dev/null
git rev-parse --verify --quiet refs/heads/claude/<slug>
```

If either exists:

- **Random slug**: silently regenerate (different adjective/animal pair) and re-check. Up to ~3 attempts, then stop and ask.
- **Linear-derived slug**: stop and ask — don't auto-resume someone else's worktree, and don't reuse a stale branch silently. The user's `pnpm worktree-env delete <slug>` (root `CLAUDE.md`) is the right tool to clean up first; or, if there's actual work on the existing branch, the user may want to `cd` into the existing worktree and continue rather than recreate.

Create the worktree off the freshly-pulled main:

```bash
git worktree add .claude/worktrees/<slug> -b claude/<slug>
cd .claude/worktrees/<slug>
```

`cd` into it for the rest of the skill — every later step runs from this directory.

---

## Phase 3 — Install dependencies

Fresh worktrees do not share `node_modules` with the main checkout (per root `CLAUDE.md`). Always run:

```bash
pnpm install
```

This is required before any other `pnpm` command — including `pnpm worktree-env` itself, which runs through `tsx` (which lives in `node_modules`). Run synchronously; you need it to finish before Phase 4 can use the CLI.

If `pnpm install` fails, stop and surface the output. Don't paper over with `--force` or `--shamefully-hoist` — figure out why.

---

## Phase 4 — Spin up the dev environment in the background (skip if `--no-env`)

If the caller passed `--no-env`, **skip this phase entirely** and proceed to Phase 5. State that explicitly so the user knows the env wasn't started.

Otherwise, kick off the dev env in the background. `pnpm worktree-env start` takes a few minutes the first time, building the per-worktree VM/distro — backgrounding it lets the caller get on with code reads / file edits while the env warms. Use the `Bash` tool's `run_in_background: true`:

```bash
pnpm worktree-env start --description "<short summary, ≤10 words>"
```

Pick the description in this order:

1. If the caller passed `--description "..."`, use it verbatim.
2. Otherwise, if `ALT-NN` was supplied and the Linear MCP is loaded, fetch the issue title with `mcp__claude_ai_Linear__get_issue` and truncate to ≤10 words.
3. Otherwise (random-slug flow, or Linear lookup unavailable), prompt the user once for a description.

Don't wait for the background task to finish — the caller will check on it (or use the smoke-test phase of whichever flow invoked this skill). The command is idempotent and safe to re-run.

---

## Phase 5 — Report and hand back

State the final scaffolding result so the caller knows where it is:

- Worktree path: `.claude/worktrees/<slug>`
- Branch: `claude/<slug>`
- `pnpm install` status: done
- Env startup: backgrounded *(or "skipped — `--no-env`" if Phase 4 was skipped)*
- Current working directory: the worktree

The skill's job ends here. The caller (another skill or the user) takes it from this state.

---

## Hard rules

These mirror the rules in `execute-next-task` for the same reasons:

- **Never run on a dirty tree or a non-default branch.** Phase 1 stops; don't auto-stash or auto-checkout to make it work.
- **Never reuse an existing worktree directory or branch silently.** If `.claude/worktrees/<slug>` or `claude/<slug>` already exists, stop and ask. The right cleanup is `pnpm worktree-env delete <slug>` and (if needed) `git worktree remove`, then re-run.
- **Never `git checkout main`, `git stash`, or create a branch outside the worktree convention.** Worktree lifecycle is the user's responsibility — the skill's only environment side-effects are `pnpm install` and the optional backgrounded `pnpm worktree-env start`, both inside the new worktree.
- **Never skip `pnpm install`.** Worktrees do not share `node_modules`. Skipping breaks every subsequent `pnpm` command, including the `worktree-env` CLI itself.
- **Never wait for `pnpm worktree-env start` synchronously.** It takes minutes; backgrounding is the whole point. (If the caller genuinely needs the env up before continuing, that's the caller's problem to solve via Bash status checks.)
- **Never produce an ExitPlanMode block.** This is a scaffolding skill, not a planning skill.

---

## Example

> User: `/setup-worktree ALT-47`
>
> *Skill runs `pwd`, `git rev-parse --abbrev-ref HEAD`, `git status`. Repo root, on `main`, clean.*
>
> *Skill runs `git pull --ff-only origin main`. Already up to date.*
>
> *Skill runs `git worktree add .claude/worktrees/alt-47 -b claude/alt-47`, then `cd .claude/worktrees/alt-47`.*
>
> *Skill runs `pnpm install` synchronously. Done in 12s.*
>
> *Skill calls `mcp__claude_ai_Linear__get_issue(id: "ALT-47")` to get the title — "Phase 2: tunnel reconciler retry budget" — and truncates to "tunnel reconciler retry budget".*
>
> *Skill runs `pnpm worktree-env start --description "tunnel reconciler retry budget"` in the background.*
>
> Skill: "Worktree ready at `.claude/worktrees/alt-47` on branch `claude/alt-47`. `pnpm install` done. Dev env warming in the background. Working directory is the worktree."

> User: `/setup-worktree ALT-58 --no-env`
>
> *Skill runs Phases 1–3 as above, then skips Phase 4.*
>
> Skill: "Worktree ready at `.claude/worktrees/alt-58` on branch `claude/alt-58`. `pnpm install` done. Dev env startup skipped (`--no-env`). Working directory is the worktree."

> User: `/setup-worktree`
>
> *No `ALT-NN` supplied — skill picks a random slug `bold-lynx`, runs `ls .claude/worktrees/bold-lynx` and `git rev-parse --verify --quiet refs/heads/claude/bold-lynx` — neither exists.*
>
> *Skill runs Phase 1 pre-flight, then `git worktree add .claude/worktrees/bold-lynx -b claude/bold-lynx` and `cd` into it.*
>
> *Skill runs `pnpm install` synchronously.*
>
> *No Linear ID and no `--description`, so skill prompts: "What's this worktree for? (≤10 words for the dev env description)". User answers "spike on haproxy reload latency".*
>
> *Skill runs `pnpm worktree-env start --description "spike on haproxy reload latency"` in the background.*
>
> Skill: "Worktree ready at `.claude/worktrees/bold-lynx` on branch `claude/bold-lynx`. `pnpm install` done. Dev env warming in the background. Working directory is the worktree."
