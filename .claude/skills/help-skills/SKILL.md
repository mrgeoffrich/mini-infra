---
name: help-skills
description: Explains the standard Mini Infra workflow and which skill to reach for at each step — brainstorm → plan → execute → review → ship — plus the worktree and diagnostic helpers that wrap around it. Use this skill whenever the user asks "what's the workflow", "which skill do I use for X", "how do I work on a feature/task", "what skills do I have", "remind me of the flow", "help me with skills", "what's next", "where am I in the process", or any equivalent ask for a workflow refresher or a pointer to the right skill. Also use it when the user is mid-flow and seems unsure which skill comes next (e.g. they just finished a review and ask "now what?"). Do **not** trigger for questions about Claude Code itself (slash commands, hooks, MCP) — those go to claude-code-guide — and do **not** trigger when the user has already named the specific skill they want to run.
---

# Help — Skills Workflow

This skill is a **map**, not an executor. It tells the user (or you) which skill to reach for at each step of the standard Mini Infra workflow. When in doubt, print the relevant section verbatim — the user is asking for a reminder, not a re-derivation.

The workflow has two entry points (planned features vs. one-off maintenance) that converge on the same execute → review → ship loop, with worktree and diagnostic helpers wrapping around it.

---

## The standard flow

```
                  ┌─ planned feature ─────────────────────────┐
                  │                                           │
  brainstorming ──▶ brainstorm-to-plan ──▶ (plan-to-mk) ──┐   │
                                                          │   │
                  ┌─ one-off maintenance task ─────────┐  │   │
                  │                                    │  │   │
                  │           task-to-mk ──────────────┘  │   │
                  │                                       ▼   │
                  │                              ┌──── mk ticket(s) ────┐
                  │                              │                      │
                  │                       design-task            execute-next-task
                  │                              │                      │
                  │                              ▼                      ▼
                  │                       (issue → in_review)   (issue → in_review)
                  │                              │                      │
                  │                              └──────────┬───────────┘
                  │                                         ▼
                  │                                      review
                  │                                         │
                  │                                         ▼
                  │                                  address-review  (loop)
                  │                                         │
                  │                                         ▼
                  │                                      ship-it  (issue → done)
                  │
                  └─ wrapping the active task: setup-worktree / finish-worktree
                                                diagnose-dev (when something's broken in the worktree)
```

---

## Step-by-step — when to use which skill

### 1. Planning a feature (multi-phase work)

- **`brainstorming`** — open-ended ideation. Optional; just chatting to Claude works too. Use this when the shape of the work isn't clear yet.
- **`brainstorm-to-plan`** — turns the brainstorm (a scratch markdown file or in-conversation notes) into a phased planning document under `docs/planning/`. This is the bridge from "vibes" to "tickets".

(After `brainstorm-to-plan`, the plan doc gets seeded into `mk` as a feature plus one ticket per phase via `plan-to-mk`. That handoff is implicit in the flow but lives outside this skill's scope — if the user asks about it, point them at `plan-to-mk`.)

### 2. One-off maintenance task (single ticket, no plan doc)

- **`task-to-mk`** — turns a one-line job description into a single mk ticket under the persistent **Maintenance** feature. Use this for bugfixes, small chores, anything that doesn't need a phased plan.

### 3. Working a ticket

Both flows below leave the issue in **`in_review`** when they finish, ready for the review loop.

- **`design-task`** — for design work. Researches patterns, produces two design options with wireframes under `docs/designs/`, opens a PR for the design artefacts, and posts a "design ready" comment on the ticket.
- **`execute-next-task`** — for coding work. Picks the next unblocked todo (or jumps to a specified `MINI-NN`), executes end-to-end inside a worktree (code → build/lint/unit → live smoke → PR with `Closes MINI-NN`), and transitions the issue to `in_review`.

### 4. Review loop

- **`review`** — independent code review of the PR for an mk ticket. Reads the ticket as the contract, pulls the diff, checks bugs / security / convention violations / duplication, and posts a severity-tagged review comment on the ticket.
- **`address-review`** — the other side of the loop. Reads the most recent `/review` comment, drops `low`-severity findings, validates each `critical`/`high`/`medium` finding before fixing (false positives get dismissed with rationale), applies targeted fixes, runs build/lint/unit, and pushes. Transitions the issue back to `in_progress` while the work happens. Pass `--quick` (e.g. `/address-review MINI-NN --quick`) for trivial fixes — works directly on the PR branch in the main checkout, skips the worktree + dev-env spin-up, and falls back to build/lint/unit as the smoke. Quick mode is only valid when every fix is no-runtime-change (comment / dead-code / type-only / extracted-helper / pure-docs); the skill refuses mid-run if anything touches `client/`, a route handler, a migration, or seeded data.

Loop `review` ↔ `address-review` until the review is clean.

### 5. Shipping

- **`ship-it`** — squash-merges the PR for an `in_review` ticket and transitions the issue to `done`. Pre-flights mergeability and CI status; refuses to merge into a broken state. Leaves the local worktree alone — that's `finish-worktree`'s job.

---

## Wrapping skills (used during a task)

These wrap around `design-task` / `execute-next-task` rather than being a workflow step in their own right:

- **`setup-worktree`** — scaffolds a fresh git worktree from main with `pnpm install` and a backgrounded `pnpm worktree-env start`. `execute-next-task` calls this internally; use it directly for ad-hoc work that needs an isolated worktree without the full execute loop.
- **`finish-worktree`** — tears down a finished worktree: deletes the per-worktree VM/distro and removes the worktree dir. Run this **after** `ship-it`, never before — and never when the work is unfinished or the PR isn't merged. The remote branch is left alone (the PR points at it).
- **`test-dev`** — runs a set of tests against the current worktree's dev environment using `playwright-cli`. Use it to smoke-test a feature before opening a PR, or any time the user asks for the change to be exercised in the running stack. Tracks issues found and reports them at the end; stops early on a show-stopper.
- **`diagnose-dev`** — diagnoses issues in the dev environment running on a worktree. Trigger when the user mentions something is broken "in dev" — don't use it for production issues.

---

## General tooling skills

These aren't workflow steps — they're general-purpose tools the workflow skills (and you) reach for as needed:

- **`mk`** — the local issue tracker that ships with the repo. Anything that creates, reads, updates, or organises tickets/features/tags/blocks/PR-attachments goes through `mk`. Prefer it over GitHub Issues for any work tracked in this repo. Most workflow skills above (`task-to-mk`, `plan-to-mk`, `design-task`, `execute-next-task`, `review`, `address-review`, `ship-it`) call `mk` under the hood; reach for it directly when you need to inspect or tweak ticket state outside one of those flows.
- **`playwright-cli`** — browser automation: navigation, form filling, screenshots, web testing, data extraction. `test-dev` builds on top of it; reach for it directly for ad-hoc browser interactions or one-off scraping/automation tasks.

---

## Quick decision tree

When the user asks "what do I do next?", figure out where they are:

| Where they are | What to suggest |
|---|---|
| Has an idea, no shape yet | `brainstorming` (or just chat), then `brainstorm-to-plan` |
| Has a plan doc, no tickets | `plan-to-mk` (out of scope — point at it) |
| Has a one-off chore | `task-to-mk` |
| Has a ticket, needs a design | `design-task` |
| Has a ticket, ready to code | `execute-next-task` |
| PR open, ticket `in_review` | `review` |
| Review posted with findings | `address-review` (add `--quick` for trivial / no-runtime-change fixes) |
| Review is clean | `ship-it` |
| PR merged, worktree still around | `finish-worktree` |
| Something's broken in the worktree | `diagnose-dev` |

---

## Notes

- The skill list above is curated — these are the skills that form the **normal workflow** plus the general tooling that supports it. Other skills exist (e.g. `update-ui-artifacts`, `refactor-large-file`, `session-retrospective`, `api-change-check`) but they're either auxiliary or used opportunistically rather than as steps in the standard flow. Don't list them unless the user asks about them specifically.
- If the user asks about a skill that isn't in this map, read its `SKILL.md` from `.claude/skills/<name>/SKILL.md` rather than guessing.
- Keep responses focused on what the user actually asked. If they ask "how do I ship?", just describe `ship-it` and the immediate prerequisites — don't dump the whole flow on them.
