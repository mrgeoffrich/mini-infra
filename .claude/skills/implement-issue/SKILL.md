---
name: implement-issue
description: Dispatcher skill for an `mk`-tracked ticket. Accepts an **optional issue ID** as an argument (e.g. `/implement-issue MINI-32`, or a bare `32` which `mk` resolves against the current repo's prefix) — when supplied, the skill jumps straight to that issue; when omitted, it picks the next unblocked `todo` issue in the current repo via `mk issue list --state todo -o json` (same picking flow `code-task` and `design-task` used to share). Once an issue is chosen, the skill **inspects the issue's tags** and routes: if the ticket carries the `design` mk tag it invokes the `design-task` skill (which explores two design options, writes a doc + wireframes, opens a design PR, and moves the ticket to `in_review`); otherwise it invokes the `code-task` skill (which writes code, runs smoke tests, opens an implementation PR, and moves the ticket to `in_review`). The dispatch is **decision-free** — the `design` tag is the single signal, attached by `plan-to-mk` when it auto-creates paired design tickets for phases with `[design needed]` UI changes. **This skill does not transition the issue itself, set up a worktree, or do any execution work** — those are entirely owned by the delegated skill. It exists purely to remove the "did I remember to route this to the right skill?" burden from the user and to keep one unified "what's next?" entry point now that `code-task` requires an explicit ID. Use this skill whenever the user says "implement issue MINI-NN", "implement MINI-NN", "work on MINI-NN", "do MINI-NN", "execute next task", "what's next?", "next task", "pick up the next todo", "/implement-issue", or any equivalent ask that's either "advance through mk-tracked work" or "do this specific ticket without me having to decide which skill". Do NOT trigger for tasks that aren't tracked in mk, for ad-hoc bug fixes without an mk ticket, or when the user has already named the specific downstream skill they want (`/code-task` and `/design-task` are direct entry points and bypass this dispatcher).
---

# Implement Issue

You're a **routing skill**. The mk ticket — and its `design` tag, or absence of one — already encodes whether the work is design exploration or code execution. Your job is to pick (or accept) the right issue, inspect a single field (`tags`), and hand off to the skill that owns the work.

You don't transition the issue, don't create a worktree, don't read the ticket body in detail, don't run any builds. The downstream skill (`code-task` or `design-task`) does all of that. Routing is the entire job.

## Why this skill exists

Before this dispatcher, `code-task` (then named `execute-next-task`) carried two responsibilities:

1. Pick the next unblocked `todo` from `mk`.
2. Execute code for it.

That worked when every ticket was code, but `plan-to-mk` started auto-creating paired **design** tickets in `backlog` for phases with `[design needed]` UI changes. Those design tickets need an entirely different skill (`design-task`) — and a code-execution run on a design ticket would silently skip the design exploration the ticket was filed for.

This skill collapses the two paths back into one entry point: "give me the next thing, or this specific thing — and figure out whether it's design or code". It's deliberately thin so the downstream skills stay the single source of truth for their respective flows.

---

## Phase 1 — Verify `mk` is available

```bash
mk status -o json
```

You should see a JSON blob with the repo's prefix (`MINI`) and per-state issue counts. If `mk` errors with "not inside a git repository", `cd` to the repo root and retry. If `mk --help` itself fails, stop and tell the user — don't fall back to anything else.

**Critical agent-mode rules** (these apply to every `mk` call you make in this run, though for the dispatcher case the only mutating call is what the delegated skill makes — this skill itself is read-only):

- **Always pass `-o json` when parsing output.** Text mode is for humans only.
- This skill doesn't post comments, change state, or otherwise mutate `mk`, so `--user Claude` doesn't apply here — but every downstream skill it invokes carries that contract itself.

---

## Phase 2 — Pick the issue (auto-pick or explicit-ID)

Two entry modes:

### 2.0 Branch on the argument

Look at the arguments the user passed. If they contain an mk issue identifier matching `MINI-\d+` (case-insensitive, may appear with surrounding text — `MINI-38`, `mini-38`, `implement MINI-38`) or a bare integer (`38`), treat that as the explicit pick and skip the listing logic. Otherwise fall through to the auto-pick path.

#### Explicit-ID path

1. Fetch the issue with `mk issue brief <KEY>` (a bare number works — `mk` resolves it against the current repo's prefix). `brief` always emits JSON regardless of `--output`. Capture to disk so the downstream skill can reuse it if it wants (`/tmp/brief-<KEY>.json`).
2. If the command exits non-zero, stop and tell the user — the issue probably doesn't exist.
3. **State the pick** in one line: id, title, feature slug. Don't do soft validations here (state checks, blocker checks) — the delegated skill (`code-task` or `design-task`) owns those validations and will apply them itself. Routing happens before any "still proceed?" prompts.

#### Auto-pick path

Same rule both downstream skills used to share: state = `todo`, no unfinished `blocks` edge pointing in. No priority sort, no cycle filter, no feature-scoping.

1. **List Todos** in the current repo: `mk issue list --state todo -o json`.
2. **For each candidate, check blockers** via `mk issue show <KEY> -o json` and inspect the relations array. A candidate survives if every incoming `blocks` edge originates from an issue in `done`, `cancelled`, or `duplicate` state.
3. **Decide:**
   - **0 unblocked** → tell the user "Nothing to pick up — every `todo` is blocked, or no `todo`s exist." Stop.
   - **1 unblocked** → use it. State the pick: id, title, feature slug.
   - **>1 unblocked** → list them with `id | title | feature | tags` (include tags so the user can see at a glance which entries are design tickets) and ask the user to pick. Don't infer.

Once the pick lands, fetch the brief: `mk issue brief MINI-NN > /tmp/brief-MINI-NN.json`. The downstream skill will re-read this, but this skill needs it for the tag check in Phase 3 — so capture it once.

> **Why not use `mk issue next` for atomic pick+claim?** `mk issue next` flips the issue to `in_progress` as part of the pick. That's fine for `code-task`'s old behaviour, but it would happen *before* the design-vs-code routing in this skill — meaning a design ticket would briefly land in `in_progress` and then `design-task` would have to re-transition. Avoiding `mk issue next` here keeps the state transition with the skill that actually does the work. The downstream skill handles its own state transition exactly as before.

---

## Phase 3 — Inspect the `design` tag and dispatch

Read the tag list from the brief:

```bash
jq -r '.issue.tags // [] | join(",")' /tmp/brief-MINI-NN.json
```

Two cases:

### 3.1 Design ticket (tag list contains `design`)

Invoke `design-task` with the picked key. The skill takes over end-to-end: it does its own pre-flights, picks (no-op — the key is supplied), reads the ticket, sets up a docs-only worktree, writes the design doc + wireframes, opens a PR, posts comments, and transitions the ticket to `in_review`.

```
Skill(skill: "design-task", args: "MINI-NN")
```

Announce the route in one sentence before invoking so the user sees what's happening:

> "MINI-NN is tagged `design` — routing to `/design-task` for two-option exploration."

### 3.2 Code ticket (tag list does **not** contain `design`)

Invoke `code-task` with the picked key. Same end-to-end ownership on the other side — pre-flights, claim, worktree, build/smoke, PR, `in_review`, retrospective, cleanup.

```
Skill(skill: "code-task", args: "MINI-NN")
```

Announce the route:

> "MINI-NN has no `design` tag — routing to `/code-task` for implementation."

The downstream skill's output becomes this skill's output. Don't summarise it, don't add commentary, don't repeat its handoff comment. Just let it report.

---

## Hard rules

- **Never execute work yourself.** This skill's sole job is to pick an issue and pick a downstream skill. If the downstream skill stops with a question or a failure, surface its message verbatim and let the user respond — don't try to recover by switching skills mid-flight.
- **`design` is the only routing signal.** Don't second-guess by reading the title, the body, or any "looks like design" heuristic. If `plan-to-mk` mistakenly tagged a ticket, the fix is in `plan-to-mk` (or in `mk tag rm`), not in this dispatcher's logic. Surface tag rot in the run report so the user can clean it up, but always route on the tag as it stands.
- **Never mutate the issue.** No state changes, no comments, no `mk pr attach`. The downstream skill owns the audit trail. This skill only reads.
- **Never pick more than one issue per run.** If auto-pick finds multiple unblocked candidates, ask the user to disambiguate. Picking the lowest-numbered one silently re-introduces the "did the user want this one?" ambiguity the multi-skill split was meant to eliminate.
- **Never bypass the downstream skill** by inlining its phases here. If the downstream skill is the wrong shape for a particular run (e.g. user wants design + immediately impl), they should run the two skills in sequence — not ask this dispatcher to do both.

---

## Example end-to-end (abbreviated)

> User: "implement next task"
>
> *Skill runs `mk status -o json` to confirm `mk` works. No issue ID supplied — auto-pick path. `mk issue list --state todo -o json` returns three issues:*
>
> - *MINI-38: "Phase 2: per-container egress override" (feature `egress-per-container`, tags: `[]`)*
> - *MINI-39: "Phase 2 design: per-container egress override panel" (feature `egress-per-container`, tags: `["design"]`)*
> - *MINI-41: "Update help articles for tunnel routing" (feature `maintenance`, tags: `[]`)*
>
> *Multiple unblocked. Skill lists them with tags and asks: "Three unblocked Todos:*
> - *MINI-38 | Phase 2: per-container egress override | egress-per-container*
> - *MINI-39 | Phase 2 design: per-container egress override panel | egress-per-container | [design]*
> - *MINI-41 | Update help articles for tunnel routing | maintenance*
>
> *Which one?"*
>
> User: "39"
>
> *Skill fetches `mk issue brief MINI-39 > /tmp/brief-MINI-39.json`. Reads `.issue.tags` → `["design"]`. Routes:*
>
> Skill: "MINI-39 is tagged `design` — routing to `/design-task` for two-option exploration."
>
> *Invokes `Skill(skill: "design-task", args: "MINI-39")`. The design-task skill runs end-to-end (Phases 1–10 of its own SKILL.md), writes `docs/designs/mini-39-…md`, opens a PR, posts comments, and transitions MINI-39 to `in_review`. Its final report is the user-facing output of this run.*

---

> User: "implement MINI-29"
>
> *Skill confirms `mk` works. Explicit-ID path. Fetches `mk issue brief MINI-29 > /tmp/brief-MINI-29.json`. Reads `.issue.tags` → `[]`. Routes:*
>
> Skill: "MINI-29 has no `design` tag — routing to `/code-task` for implementation."
>
> *Invokes `Skill(skill: "code-task", args: "MINI-29")`. The code-task skill runs end-to-end, transitions MINI-29 to `in_progress`, sets up a worktree, ships a PR, transitions to `in_review`, posts a handoff comment, runs the retrospective, and cleans up the worktree. Its final report is the user-facing output of this run.*
