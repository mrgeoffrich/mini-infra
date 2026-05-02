---
name: finish-worktree
description: Tears down a finished agent worktree — `cd`s back to the repo root, runs `pnpm worktree-env delete <slug> --force` to wipe the per-worktree VM/distro and registry entry, then `git worktree remove .claude/worktrees/<slug>` to remove the directory and git's tracking. The remote branch is left untouched (the PR points at it). Takes a slug or Linear issue ID as the argument (e.g. `/finish-worktree alt-32` or `/finish-worktree ALT-32`). This skill is the cleanup half of `execute-next-task` (Phase 14) extracted so it can be invoked manually after any worktree-based flow finishes — `fix-and-validate`, ad-hoc bugfixes, design exploration, anything where the worktree's purpose is over and the slot should be freed for the next run. Use this skill whenever the user says "finish worktree", "clean up worktree", "tear down worktree", "remove worktree", "done with worktree", "delete worktree alt-NN", "wrap up the alt-NN worktree", or any equivalent ask to dispose of a finished worktree. Do **not** trigger when there's still active work in the worktree, when the PR hasn't been opened yet, or when the run failed — leaving the worktree alive is the right answer in those cases. The skill itself defensively checks for uncommitted changes, unpushed commits, and missing PR before destroying anything, and stops to ask if it sees any of those.
---

# Finish Worktree

This is a **cleanup skill**, not an execution agent. It tears down a finished agent worktree and frees the VM/distro slot. It's the cleanup half of `execute-next-task` (Phase 14) carved out so any worktree-based flow can dispose of its worktree at the end.

The worktree's purpose is to host the build + smoke for some piece of work. Once the PR is open and review has moved to GitHub, the worktree is dead weight — it's holding a Colima profile / WSL2 distro slot, and `pnpm worktree-env list` clutters up. This skill removes it.

The remote branch is **left alone** — that's where the PR points; it must remain.

## Arguments

The skill takes one required argument:

- **`<slug-or-issue-id>`** — either the worktree slug (`alt-32`) or the Linear issue ID it was created from (`ALT-32`). The skill normalises both to the slug `alt-NN` (lowercase). Accepts surrounding text containing the pattern.

If no argument is supplied, **stop and ask**. The skill never auto-picks "the most recent worktree" — that's the kind of guess that ends with someone's WIP being deleted.

---

## Phase 1 — Resolve and validate the target

Normalise the argument to a slug:

- `ALT-32` → `alt-32`
- `alt-32` → `alt-32`
- `pick up alt-32 please` → `alt-32` (extract the pattern)

Then check that the worktree actually exists:

```bash
git worktree list
```

The output should contain `.claude/worktrees/<slug>` on branch `claude/<slug>`. If it doesn't:

- **Worktree directory missing but branch exists** → maybe `git worktree remove` already ran but `pnpm worktree-env delete` didn't. Surface that and offer to run only the env-delete half.
- **Neither exists** → the cleanup has already happened (or the slug is wrong). Tell the user and stop.

---

## Phase 2 — Defensive checks

The hard rule from `execute-next-task` is *only run cleanup on the success path*. The skill can't fully verify "success" from outside the run, but it can catch the obvious mistakes — uncommitted changes, unpushed commits, missing PR — that mean the worktree shouldn't be destroyed yet.

Run these checks from the worktree directory (`cd .claude/worktrees/<slug>` first, then `cd` back when you're done with the checks):

1. **Uncommitted changes?**

   ```bash
   git status --porcelain
   ```

   Any output means there's work that would be lost. **Stop and surface the changes.** Ask the user whether to proceed (they may have intentionally abandoned the work) or abort so they can salvage it.

2. **Unpushed commits?**

   ```bash
   git log @{u}..HEAD --oneline 2>/dev/null || git log --oneline
   ```

   The first form lists commits ahead of the upstream. If the branch has no upstream (never pushed), the fallback lists every commit on the branch — also a stop signal. Either way, surface what's unpushed and ask before proceeding.

3. **PR open?**

   ```bash
   gh pr view --json url,state -q '.url + " (" + .state + ")"' 2>/dev/null
   ```

   If `gh` returns no PR, the work probably hasn't been shipped yet. Surface that and ask before proceeding. (`gh pr view` from inside the worktree finds the PR for the current branch.)

If all three checks pass, proceed silently to Phase 3. If any check fails, the skill **stops and asks** rather than auto-proceeding — the cost of getting this wrong (lost work, deleted branch with unpushed commits) is much higher than the cost of one extra confirmation.

---

## Phase 3 — Tear down

Run from the **repo root** (not the worktree — you can't delete the worktree you're standing in):

```bash
cd <repo-root>                                      # back out of the worktree
pnpm worktree-env delete <slug> --force             # wipes VM/distro + registry entry
git worktree remove .claude/worktrees/<slug>        # removes the directory + git's tracking
```

`<repo-root>` is the directory containing the `.claude/worktrees/` folder (the main checkout). `--force` skips the interactive confirmation that `pnpm worktree-env delete` would otherwise prompt for.

The two commands do different things and both are needed:

- **`pnpm worktree-env delete`** wipes the runtime — runs `docker compose down -v` against the worktree's project, deletes the per-worktree VM/distro (Colima profile on macOS, WSL2 distro on Windows), and removes the entry from `~/.mini-infra/worktrees.yaml`.
- **`git worktree remove`** removes the working-tree directory and clears git's internal tracking of it.

Skipping the first leaves a dead VM/distro slot. Skipping the second leaves a stale `.claude/worktrees/<slug>` directory and a `git worktree list` entry that points at nothing.

If `git worktree remove` complains that the directory is "dirty" or has untracked files (which means Phase 2's checks missed something), **stop**. Don't auto-pass `--force` to git — investigate first; it usually means a build artifact or local config the user might want.

---

## Phase 4 — Report

State what was cleaned up:

```
✓ Cleaned up worktree .claude/worktrees/<slug> and the dev-env VM.
  Branch claude/<slug> remains on the remote (PR points at it).
```

If review feedback later requires changes on the same branch, the user (or another skill) can recreate the worktree from the same branch:

```bash
git fetch origin claude/<slug>
git worktree add .claude/worktrees/<slug> claude/<slug>
cd .claude/worktrees/<slug>
pnpm install
pnpm worktree-env start
```

Mention this in the report only if it seems relevant (e.g. the user is mid-review-cycle); otherwise the simple "cleaned up" line is enough.

---

## Hard rules

- **Never run cleanup on a failure path.** If smoke failed, the PR didn't open, the work isn't shipped, or the user is mid-investigation, leave the worktree alive. Phase 2's defensive checks catch the obvious cases; if the user invokes the skill anyway and confirms past a warning, that's their call.
- **Never delete the remote branch.** The PR points at it. Cleanup is local-only (worktree dir + VM/distro + registry entry).
- **Never delete a worktree you're standing in.** `cd` to the repo root before running `git worktree remove`. Otherwise git refuses and you waste a turn diagnosing.
- **Never auto-pick a worktree to delete.** The skill needs an explicit slug or issue ID. Guessing "the latest one" is how WIP gets nuked.
- **Never pass `--force` to `git worktree remove` automatically.** If git refuses because the worktree is dirty, that's signal — investigate, don't override.
- **Never produce an ExitPlanMode block.** This is a cleanup skill, not a planning skill.

---

## Example

> User: `/finish-worktree ALT-29`
>
> *Skill normalises to slug `alt-29`. Runs `git worktree list`, sees `.claude/worktrees/alt-29` on `claude/alt-29`.*
>
> *Skill `cd`s into the worktree and runs the three defensive checks: `git status --porcelain` (clean), `git log @{u}..HEAD --oneline` (no unpushed commits), `gh pr view` (PR #412 open). All clear.*
>
> *Skill `cd`s back to the repo root. Runs `pnpm worktree-env delete alt-29 --force`, then `git worktree remove .claude/worktrees/alt-29`.*
>
> Skill: "✓ Cleaned up worktree `.claude/worktrees/alt-29` and the dev-env VM. Branch `claude/alt-29` remains on the remote (PR #412 points at it)."

> User: `/finish-worktree alt-58`
>
> *Skill normalises (already a slug). Worktree exists. Defensive checks: `git status --porcelain` returns `M server/src/foo.ts`. **Stop.***
>
> Skill: "Worktree `alt-58` has uncommitted changes:
>
> ```
> M server/src/foo.ts
> ```
>
> Cleaning up will lose them. Proceed anyway, or do you want to handle them first?"
