---
name: task-to-mk
description: Turns a one-line job description into a single mk ticket in the shape `execute-next-task` expects. The skill files the issue under a persistent **Maintenance** feature (slug `maintenance`, auto-created on first run). mk is the single source of truth for maintenance tickets — `docs/planning/maintenance.md` is a static stub describing the feature, never per-task entries. Asks at most three clarifying questions before creating the ticket — one always about how to smoke-test the change (UI via `test-dev`, `curl` against a route, unit-only, or none), and up to two more only when the request is genuinely ambiguous (vague success criteria, unclear component scope, conflicting acceptance hints). Auto-detects which CLAUDE.md / ARCHITECTURE.md pointers apply from any file paths in the description and from the components named, picks an area tag for the eventual commit by reading recent `git log` on main, and sets the issue to `todo` so `execute-next-task` picks it up naturally with no other changes. Use this skill whenever the user says "create a linear task for X", "create an mk task for X", "make me a ticket to Y", "file a maintenance task to Z", "spin up a linear issue for ...", "spin up an mk issue for ...", "make a kanban ticket for ...", "track this", "task: ...", "queue up a linear todo for ...", "queue an mk todo", or any equivalent ask to scaffold a single one-off ticket without a multi-phase plan. Make sure to use it even when the user doesn't say the word "linear" or "mk" but clearly wants a tracked task that Claude can later pick up — e.g. "remember to fix the X bug later", "let's queue a ticket to clean up Y", "log a follow-up to revisit Z". Do NOT trigger when the user wants Claude to do the work right now (use the work-doing skills instead), when they're describing a multi-phase plan (use `plan-to-mk`), or when they're asking about an *existing* ticket (use `mk` directly).
---

# Task to mk

You're filing a single one-off ticket against the persistent **Maintenance** feature in this repo's `mk` (mini-kanban) tracker, in the exact shape that `execute-next-task` expects to consume. mk is the single source of truth — there is no per-task entry in any plan doc. The "Phase" wording in the issue title is a contract with `execute-next-task` (it matches by `Phase N` prefix), not a semantic claim that one-offs are sequenced — they're independent and never block each other.

## Why this skill exists

The big phased-plan flow (`plan-to-mk` → `execute-next-task`) is great for migrations and multi-phase features. For day-to-day one-offs — "fix the broken tooltip", "add a retry to the cert renewer", "drop the unused `legacy_*` columns" — it's overkill. This skill collapses the planning ceremony into a 30-second conversation: rough description in, runtime questions where there's genuine ambiguity, populated ticket out, ready to be picked up by `execute-next-task` whenever you next run it.

## Conventions

- **Repo**: scoped automatically by `mk` from the current git toplevel. Always `cd` to the repo root before invoking `mk`.
- **Feature**: `Maintenance` (slug `maintenance`) — single, persistent, auto-created on first run.
- **Feature description**: starts with `Plan: [docs/planning/maintenance.md](<github-blob-url>)`. The doc is a static stub describing the feature — `execute-next-task` reads it as supplemental context but tolerates missing per-phase entries (it does, since the loosened flow). Don't edit it from this skill.
- **Phase numbering**: monotonic, scoped to the maintenance feature. Read it from mk (issue titles in the Maintenance feature), incrementing the highest existing `Phase N`. The plan doc is *not* consulted for numbering.
- **Issue title**: `Phase N: <title>` — same pattern `plan-to-mk` writes, so `execute-next-task` matches by phase number.
- **Issue state**: `todo` (default — don't gate behind backlog).
- **Blocks/blocked-by**: never set. One-offs are independent.

If any of these conventions ever stops being true (Maintenance feature deleted, plan-doc stub overwritten with phase entries, the `mk` binary missing), **stop and ask** — don't paper over silently.

---

## Phase 1 — Confirm `mk` is available

`mk` is a local CLI — no MCP loading needed. Confirm it's installed and the current cwd is a tracked repo:

```bash
mk --help >/dev/null 2>&1 || { echo "mk not installed"; exit 1; }
mk status -o json
```

`mk status` prints the current repo's prefix and quick stats. The prefix should be `MINI` for this repo — if it's something else, surface it; the user may be in the wrong cwd. Outside any git repo, `mk` hard-errors with "not inside a git repository" — `cd` to the repo root before running anything else in this skill.

State names (`todo`, `in_progress`, `in_review`, `done`, `cancelled`, `backlog`, `duplicate`) are fixed by `mk` — no need to fetch a vocabulary.

---

## Phase 2 — Ensure the Maintenance feature exists

This phase is **idempotent** — on every run, after the first, it's a fast no-op. The skill no longer touches `docs/planning/maintenance.md`; the doc is a static stub describing the feature, maintained by humans separately.

```bash
mk feature show maintenance -o json
```

**If it doesn't exist** (the call exits non-zero), create it. Build the feature description starting with the `Plan:` line, write it to a temp file, then create:

```bash
cat <<EOF > /tmp/maintenance-feature.md
Plan: [docs/planning/maintenance.md](<github-blob-url>)

Catch-all feature for one-off maintenance and follow-up tickets filed via the
\`task-to-mk\` skill. Tasks are independent — they don't block each other and
don't have to ship in numerical order.
EOF

mk feature add "Maintenance" --slug maintenance \
  --description-file /tmp/maintenance-feature.md \
  --user Claude
```

Build the GitHub URL from `git remote get-url origin` + `/blob/main/docs/planning/maintenance.md`. Don't use absolute filesystem paths or `./`-prefixed relative paths — they break the link in renderers.

Capture the feature slug (`maintenance`) — you'll use it on `mk issue add --feature maintenance` later.

**If it does exist**, parse the JSON and verify the `Plan:` line in the description still points at `docs/planning/maintenance.md`. If it's been edited to point somewhere else, **stop and ask** — that's a corruption signal worth surfacing rather than fixing silently.

**Don't scaffold or modify the plan doc.** If `docs/planning/maintenance.md` is missing on disk, that's a separate problem for a human to handle (it's expected to exist as a stub) — the skill doesn't auto-create it.

---

## Phase 3 — Parse the user's request

The user has handed you a job description. It can be one line or a paragraph; it can be precise or hand-wavy. Your job in this phase is to extract whatever's already there and notice the gaps — without writing anything yet.

Pull out (or note as missing):

1. **Title** — a short imperative phrase. Usually you can infer it from the request's first clause; if not, ask.
2. **Goal** — one sentence. What does success look like?
3. **Deliverables** — concrete things that change (files, behaviours, UI flows). Often the user implies these by naming components.
4. **Done-when** — testable outcome. *How will we know it's actually fixed?* This is the most commonly missing piece in casual requests.
5. **Component scope** — which top-level dirs are touched. Use the same map `plan-to-mk` uses (see Phase 5 below).
6. **Smoke-test approach** — UI flow via `test-dev`, `curl` against a route, unit-only, or none. Always confirmed in Phase 4.
7. **Area tag for the eventual commit** — `nats`, `egress`, `monitoring`, `docs`, etc. Auto-derived from `git log --oneline -30 main` against the touched components if the description doesn't pin it.

Build a tiny internal scratchpad of what's filled in and what's a gap. **Don't ask anything yet** — Phase 4 is one batched round of clarifying questions, not a back-and-forth.

---

## Phase 4 — Ask at most three clarifying questions

The skill's contract with the user is: at most three questions, batched into a single message, then it goes and creates the ticket. Don't ping-pong. Don't ask things you can derive from the codebase or from `git log`. Don't ask things the user already answered in their request.

The three slots:

### Slot 1 — Smoke-test approach (always asked)

Even if the user wrote "test it via the UI", confirm it. The smoke approach gates which CLAUDE.md docs the ticket attaches and what shape the "Smoke tests" section ends up — getting it wrong here means the executor either over-tests or skips a check it should have run. Phrase it as a multiple choice so the user just picks:

> **Smoke test:** how should the executor verify this?
> - **(a)** UI flow via the `test-dev` skill — driving the dev env in a browser
> - **(b)** Backend route check via `curl` against `environment-details.xml`
> - **(c)** Unit / build / lint only — no live env needed
> - **(d)** Docs-only — skip live smoke, build pass is enough
> - **(e)** Something else *(describe)*

Default-pick the one that matches the touched components if the answer is obvious — but still ask, because the user often has a stronger opinion than the rough heuristic.

### Slots 2 and 3 — Ambiguity probes (only when needed)

Skip these slots entirely if the request is already crisp. Padding with questions for their own sake just trains the user to ignore the skill.

Reach for them when there's genuine ambiguity in one of these directions:

- **Vague success criteria** — *"clean up the sidebar"* — what's the testable end state? "Sidebar shows N items max" vs "sidebar has no horizontal scroll" vs "the dead links are gone" all imply very different work.
- **Unclear component scope** — *"fix the cert renewer"* — server-side `acme/`? Client-side UI? The sidecar that triggers it? You can usually narrow this from the description, but if two possibilities are equally likely, ask.
- **Conflicting hints** — the user says "small fix" but also describes touching three components. Ask which one is the actual scope.
- **Missing area tag** — only if `git log` doesn't disambiguate. Most cases it will.

Phrase ambiguity questions as **closed questions with concrete options** when you can — it's faster for the user than free-form. e.g. "Is this for the server-side `acme/` library or the client-side certificate UI?"

If the request is already crisp on every dimension that matters, the entire Phase 4 message is just slot 1 — the smoke-test multiple choice.

After the user answers, you have everything you need. Move to Phase 5.

---

## Phase 5 — Detect components, doc pointers, and area tag

This is the same logic `plan-to-mk` uses, narrowed to a single phase. Run it once for the touched components you identified in Phase 3 (or the user clarified in Phase 4).

### 5.1 Component → docs map

| Top-level dir touched | Docs to attach |
|---|---|
| `server/` | `server/CLAUDE.md`, `server/ARCHITECTURE.md` |
| `client/` | `client/CLAUDE.md`, `client/ARCHITECTURE.md` |
| `lib/` | `lib/CLAUDE.md` |
| `acme/` | `acme/CLAUDE.md` |
| `egress-gateway/` | `egress-gateway/CLAUDE.md` |
| `egress-fw-agent/` | `egress-fw-agent/CLAUDE.md` |
| `egress-shared/` | `egress-shared/CLAUDE.md` |
| `update-sidecar/` | `update-sidecar/CLAUDE.md` |
| `agent-sidecar/` | `agent-sidecar/CLAUDE.md` |
| `pg-az-backup/` | `pg-az-backup/CLAUDE.md` |
| `deployment/`, `scripts/`, `docs/`, root configs only | (no extra; root docs cover it) |

`Read` or `ls` each candidate file before adding — if a component's CLAUDE.md doesn't exist yet, drop it from the list rather than linking a 404.

**Always include** the root `CLAUDE.md` and `ARCHITECTURE.md`.

If the request mentions a topic-specific doc (`docs/architecture/internal-messaging.md` for NATS work, etc.), add that too.

### 5.2 Smoke recipe

Map the smoke-test answer from Phase 4 + touched components to the recipe that goes in the ticket's "Smoke tests" section. Reuse `plan-to-mk`'s table — same rules, single phase:

| Touched | Recipe to write |
|---|---|
| `client/src/`, `client/public/` (UI smoke) | "Invoke the `test-dev` skill walking the affected user flow in the dev environment." |
| `server/src/routes/` (curl smoke) | "Hit the affected endpoint(s) with `curl` against the URL in `environment-details.xml`. Use the admin API key from `//admin/apiKey` in the same file." |
| `server/src/services/` (no route change) | "Watch server logs (`grep '\"subcomponent\":\"<name>\"' logs/app.*.log`) for the relevant subcomponent, or drive it from a route that already exists." |
| `server/templates/` | "`docker ps` shows the new containers, `docker logs <container>` shows no errors." |
| `egress-gateway/`, `egress-fw-agent/`, `egress-shared/` | "Container builds, starts, dev egress page shows it healthy." |
| Server NATS subjects | "Publish via `NatsBus`, confirm the consumer fires; baseline with `mini-infra.system.ping`." |
| `update-sidecar/`, `agent-sidecar/` | "`cd <dir> && npm test`. Live smoke is component-specific." |
| `pg-az-backup/` | "Trigger a backup from the dev UI; confirm the run completes." |
| `lib/types/` only | "No live smoke — types compiling = pass." |
| Docs-only (`docs/`, README, SKILL.md) | "No live smoke — build/lint is enough. Skip the backgrounded `pnpm worktree-env start`." |

If the user picked "(e) Something else" in Phase 4, write their description verbatim as the recipe.

### 5.3 Area tag

```bash
git log --oneline -30 main
```

Scan for `<area>(<scope>):` prefixes on commits that touched the same components. Pick the most-used tag. If two are tied (e.g. `feat(nats)` and `fix(nats)` both common), use the one matching the verb of the new task — `feat` for additions, `fix` for bug fixes, `docs` for doc-only, etc. — but the *area* in parens is what matters for grouping (`nats`, `egress`, `docs`).

If no recent commits matched the touched components, write `<choose at execution time>` and the executor will pick.

---

## Phase 6 — Determine the next phase number

mk is the source of truth. List issues in the Maintenance feature, including all states (closed tickets still occupy phase numbers):

```bash
mk issue list --feature maintenance \
  --state todo,in_progress,in_review,done,cancelled,backlog,duplicate \
  -o json
```

Parse the JSON, find the highest `Phase N` in the issue titles, increment by one.

If no maintenance tickets exist yet, next is `Phase 1`.

The plan doc is *not* consulted here — it's a static stub and contains no per-phase entries.

---

## Phase 7 — Confirm with the user

Show a one-screen summary and wait for an explicit yes. The mk write is reversible (`mk issue rm`), but it leaves an audit-log trail and the no-confirmation cost of getting it wrong is higher than a one-line round-trip with the user.

```
About to file:

  Feature:    Maintenance (slug: maintenance)
  Issue:      Phase <N>: <title>
  State:      todo
  Smoke:      <UI / curl / unit-only / docs-only / custom>
  Area tag:   <tag> (commit format: <area>(<scope>): ... (Phase N, MINI-NN))
  Components: <list of detected dirs>
  Docs:       <list of CLAUDE.md / ARCHITECTURE.md links to attach>

Proceed?
```

Don't proceed without an explicit yes. "lgtm", "go", "yes", "ship it" all count. Anything ambiguous → ask again.

---

## Phase 8 — Create the mk issue

Issue title: `Phase <N>: <title>`.

State: `todo`.

Description body — same shape `plan-to-mk` writes, so `execute-next-task` reads it without special-casing. The first line points at the maintenance plan doc (the feature stub) — `execute-next-task` will tolerate the lack of a per-phase anchor under the loosened flow.

Write the body to a temp file first (long markdown can't go inline through `--description`):

```bash
cat <<'EOF' > /tmp/mini-task-body.md
**Source:** [docs/planning/maintenance.md](docs/planning/maintenance.md) — Maintenance feature (one-off ticket, no per-phase doc entry)

## Goal

<from Phase 3, clarified in Phase 4>

## Deliverables

<from Phase 3, clarified in Phase 4 — preserve list nesting>

## Done when

<from Phase 3, clarified in Phase 4>

---

## Relevant docs (read before writing code)

**Repo-wide:**
- [CLAUDE.md](CLAUDE.md) — pnpm, worktree workflow, build invariants
- [ARCHITECTURE.md](ARCHITECTURE.md) — system bird's-eye view, invariants

**Component-specific (this task touches):**
- <attached per-component CLAUDE.md / ARCHITECTURE.md links from Phase 5.1>

**Topic-specific:**
- <any docs/architecture/*.md links the user mentioned, if any>

---

## Workflow

This is an execution-agent ticket — no separate planning phase. Read the docs above, then:

1. **Pre-flight.** Confirm clean working tree, on a feature branch, in a worktree path.
2. **`pnpm install`.** Fresh worktrees do not share `node_modules` with the main checkout (per root `CLAUDE.md`). Run synchronously; required before any other `pnpm` command including `pnpm worktree-env`.
3. **Spin up the dev env in the background.** Kick off `pnpm worktree-env start` with `run_in_background: true` so it warms while you work.
   <if smoke is docs-only or unit-only, replace this bullet with: "Skip — no live smoke needed.">
4. **Read the dev env URL and admin creds from `environment-details.xml`** at the worktree root once the background command has finished, before running smoke tests.

## Smoke tests (run after build/lint/unit tests pass)

- <recipe from Phase 5.2>

---

## Conventions

- Commit format: `<area>(<scope>): <subject> (Phase <N>, MINI-NN)` — area tag for this task: `<tag from Phase 5.3>`.
- PR body must include `Closes MINI-NN` so the merging human can manually transition the ticket to `done`.
- This is a one-off ticket — no blocks/blocked-by relationships, no follow-up phases. If the work expands, file a separate ticket.
- When done, the executor leaves a structured handoff comment on this issue covering Known issues / Work deferred / Blockers / Deviations.

## Prior art

<list of relevant shipped commits from `git log` matching the area tag, most recent first, max 3>

(no prior commits matching the area tag yet)   <-- only if applicable
EOF

mk issue add "Phase <N>: <title>" \
  --feature maintenance \
  --state todo \
  --description-file /tmp/mini-task-body.md \
  --user Claude \
  -o json
```

Capture the issue's `MINI-NN` ID and (if you want a clickable reference) the local key — there's no remote URL, since `mk` is a local tracker.

---

## Phase 9 — Report

Print a tight summary:

```
✓ Created Phase <N>: <title>
   <MINI-NN>  (run `mk issue show <MINI-NN>` to view)
✓ Smoke approach: <UI / curl / unit-only / docs-only / custom>

Next steps:
  - run `execute-next-task MINI-NN` when you're ready to pick this up,
    or `execute-next-task` to take whatever's next in the queue
```

The skill makes no working-tree changes — `docs/planning/maintenance.md` is a stub maintained by humans, not by this skill. There's nothing to stage or commit.

---

## Hard rules

These are non-negotiable. If you find yourself wanting to break one, stop and ask the user instead.

- **Never ask more than three clarifying questions in Phase 4.** One smoke-test slot + at most two ambiguity probes. If you find yourself wanting a fourth, the request is too big for a one-off — suggest the user run `plan-to-mk` against a quick markdown plan instead.
- **Never edit `docs/planning/maintenance.md`.** It's a static stub describing the Maintenance feature. Per-task data lives in mk only.
- **Never set blocks/blocked-by relationships** between maintenance tickets. They're independent. If a one-off genuinely blocks another one-off, both should probably live in a small phased plan, not in maintenance.
- **Never silently fix a corrupted Maintenance feature.** If the feature's `Plan:` line points somewhere other than `docs/planning/maintenance.md`, stop. (Phase numbering drift between mk and the doc is no longer a concern — the doc is a stub and isn't consulted for numbering.)
- **Never write a multi-phase ticket.** This skill creates exactly one mk issue per run. If the user describes work that's clearly multiple phases, suggest `plan-to-mk`.
- **Never invent docs.** Each `Relevant docs` link must `Read`-resolve. If `egress-shared/CLAUDE.md` doesn't exist, drop it from the attach list.
- **Never transition the issue out of `todo`.** That's `execute-next-task`'s job. The skill only creates.
- **Never skip Phase 7's confirmation.** mk writes are user-visible side effects (and audit-logged) — confirm before, not after.
- **Always pass `--user Claude` on every mutating `mk` command.** The audit log records the actor; without it the entry attributes to the OS user.
- **Always pass `-o json` on reads you parse.** Text output is for humans and can shift.

---

## Example end-to-end (abbreviated)

> User: "task: the cert renewer doesn't retry transient cloudflare 429s. file a maintenance ticket to add a small backoff."
>
> *Skill confirms `mk` is installed (`mk status`). Maintenance feature exists already; `mk issue list --feature maintenance` shows the highest existing `Phase N` is `Phase 12`. Skill parses the request: title "Add retry-with-backoff to cert renewer on Cloudflare 429"; component scope clearly `acme/` and probably `server/src/services/certificates/`; smoke-test approach not stated; goal/done-when implicit but extractable. Area tag from `git log`: `acme` is most recent for `acme/` changes.*
>
> Skill: "Quick check before I file —
>
> **Smoke test:** how should the executor verify this?
> - (a) UI flow via `test-dev`
> - (b) `curl` against a route
> - (c) Unit / build / lint only
> - (d) Docs-only
> - (e) Something else
>
> (No other ambiguities — request is clear.)"
>
> User: "(c)"
>
> *Skill computes: smoke is unit-only, docs to attach are root CLAUDE.md, root ARCHITECTURE.md, server/CLAUDE.md, server/ARCHITECTURE.md, acme/CLAUDE.md (verified to exist). Phase number is 13. Area tag `acme`.*
>
> Skill: "About to file:
>
>   Feature:    Maintenance (slug: maintenance)
>   Issue:      Phase 13: Add retry-with-backoff to cert renewer on Cloudflare 429
>   State:      todo
>   Smoke:      Unit / build / lint only
>   Area tag:   acme
>   Components: acme/, server/src/services/certificates/
>   Docs:       CLAUDE.md, ARCHITECTURE.md, server/CLAUDE.md, server/ARCHITECTURE.md, acme/CLAUDE.md
>
> Proceed?"
>
> User: "go"
>
> *Skill writes the body to a temp file and runs `mk issue add "Phase 13: …" --feature maintenance --state todo --description-file /tmp/mini-task-body.md --user Claude -o json`. Captures `MINI-47`. No plan-doc edits — the doc is a stub.*
>
> Skill: "✓ Created Phase 13: Add retry-with-backoff to cert renewer on Cloudflare 429
>    MINI-47  (run `mk issue show MINI-47` to view)
> ✓ Smoke approach: Unit / build / lint only
>
> Next steps:
>   - run `execute-next-task MINI-47` when you're ready to pick this up,
>     or `execute-next-task` to take whatever's next in the queue"
