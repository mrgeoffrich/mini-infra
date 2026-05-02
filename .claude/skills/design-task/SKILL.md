---
name: design-task
description: Design-exploration agent for a Linear ticket. Accepts an **optional issue ID** as an argument (e.g. `/design-task ALT-38`) — when supplied, the skill jumps straight to that issue and skips the picking flow; when omitted, it picks the next unblocked Todo issue from the user's Linear team (Altitude Devops), the same picking flow as `execute-next-task`. Reads the ticket body (Goal / Deliverables / Done when) and any plan-doc context if the parent project has a `Plan:` line. Instead of consuming per-component CLAUDE.md / ARCHITECTURE.md pointers like `execute-next-task` does, this skill **researches design patterns** — architectural / structural / behavioural patterns relevant to the task, plus existing patterns already used in the Mini Infra codebase that could be reused. Generates **two distinct design options**, each with pros/cons, key abstractions, file/component sketch, and a rough implementation outline, written to `docs/designs/<issue-id>-<slug>.md` (single file with both options side-by-side), commits to a recommendation, posts a "design ready" comment on the impl ticket pointing at the file (so a future `execute-next-task` run finds it), and **marks the design ticket Done** — the design doc + recommendation are the deliverable, and the impl ticket unblocks immediately. Does NOT create a worktree, does NOT open a PR — the user reviews the doc and commits/PRs it on their own cadence. Use this skill whenever the user says "design ALT-NN", "design the next task", "explore design options for ALT-NN", "give me two designs for ALT-NN", "what are the design options for ALT-NN", "design-task", "come up with designs for the next ticket", or any equivalent request to brainstorm two alternative designs for a Linear-tracked task before execution begins. Do NOT trigger when the user wants to actually execute the work (use `execute-next-task` for that), or for non-Linear design questions, or for ad-hoc architecture discussions without a Linear ticket attached.
---

# Design Task

You're a **design-exploration agent**. The Linear ticket describes *what* needs to happen (Goal, Deliverables, Done when). Your job is to propose *how* — by surveying relevant design patterns, finding what's already in the Mini Infra codebase that fits, writing up **two distinct design options**, and **committing to a recommendation**.

This skill is the planning step that sits **between** ticket creation (`task-to-linear` / `plan-to-linear`) and execution (`execute-next-task`). It produces a design doc, posts a Linear comment pointing at it, and marks the design ticket **Done** so the impl ticket unblocks immediately. The recommendation in the doc is the call — there's no "user picks an option" step. If the user disagrees, they can edit the doc and re-comment; the default flow assumes the recommendation stands. **The skill creates no worktree and opens no PR** — the user reviews the doc and commits/PRs it at their own pace.

The Done-when in the ticket body (often "Figma frames signed off") is informational. The skill considers the design doc + recommendation to be the actual deliverable, and marks the Linear issue Done on that basis. If the team starts wanting Figma frames again, that's a future change to this skill.

## What "two distinct designs" means

The two options must be **genuinely different approaches**, not variations of the same thing. If both designs end up with the same key abstractions and the same file layout, you've produced one design twice — go back and find a real alternative.

Useful axes to differ along:

- **Coupling** — one shared module vs. one-per-consumer; one service vs. composed pipeline of small services.
- **Data placement** — DB-backed state vs. in-memory + event-sourced; row-per-thing vs. JSON blob; new table vs. extend existing table.
- **Synchrony** — sync request/response vs. fire-and-forget over the bus; polling vs. push.
- **Pattern family** — strategy vs. inheritance; visitor vs. switch; adapter wrapping a third-party SDK vs. bespoke client.
- **Reuse vs. greenfield** — extend an existing service in the codebase vs. build a parallel one with cleaner separation.
- **Blast radius** — minimal-scope change in one file vs. broader refactor that pays down debt while solving the problem.

The two options should be picked because they meaningfully differ on at least one of those axes. Call out the axis explicitly in each design's opening so the user sees what they're choosing between.

The team is hardcoded as **Altitude Devops**.

---

## Phase 1 — Load the Linear MCP tools

The Linear MCP tools are deferred at session start. Load the toolkit in one bulk call before doing anything else:

```
ToolSearch(query: "linear", max_results: 30)
```

You should see tools like `mcp__cd9fab4e-...__list_issues`, `__get_issue`, `__get_project`, `__list_comments`, `__save_comment`, `__save_issue`, `__list_issue_statuses`. If any of these are missing, stop and tell the user — don't fall back to anything else.

Note: this skill calls `save_issue` exactly once, at the very end (Phase 8), to mark the issue Done. No other state transitions.

---

## Phase 2 — Pick the issue (auto-pick or explicit-ID)

Two entry modes, identical to `execute-next-task`'s Phase 2:

### 2.0 Branch on the argument

Look at the arguments the user passed. If they contain a Linear issue identifier matching `ALT-\d+` (case-insensitive, may appear with surrounding text — `ALT-38`, `alt-38`, `design ALT-38`), treat that as the explicit pick and skip the listing logic. Otherwise fall through to the auto-pick path.

#### Explicit-ID path

1. Fetch the issue with `get_issue(id: <ALT-NN>)`. If it doesn't exist (404), stop and tell the user.
2. **Soft validations.** Warnings, not stops:
   - If the issue is **not in `Todo` state** (e.g. `Backlog`, `In Progress`, `Done`, `In Review`), surface that and ask "still proceed?". A user might want to redesign an in-progress ticket, but they should consciously confirm.
   - If the issue has **incomplete `blocked-by` relations**, list them and ask "still proceed?". Designs for blocked tickets are sometimes worth doing ahead of time, but the user should know.
3. Once confirmation lands (or the soft validations passed cleanly), proceed to Phase 3.

State the pick the same way as the auto-pick path: id, title, project name.

#### Auto-pick path

Same rule as `execute-next-task`: state = `Todo`, no unfinished `blocked-by`. No priority sort, no cycle filter.

1. **List Todos** in the Altitude Devops team via `list_issues`.
2. **For each candidate, check blockers** via `get_issue` → `relations`. A candidate survives if every `blocked-by` issue is in state `Done` or `Cancelled`.
3. **Decide:**
   - **0 unblocked** → tell the user "Nothing to design — every Todo is blocked or no Todos exist." Stop.
   - **1 unblocked** → use it. State the pick: id, title, project name.
   - **>1 unblocked** → list them with `id | title | project` and ask the user to pick. Don't infer.

### 2.1 No state transition at the start

Unlike `execute-next-task`, this skill does **not** transition the issue to In Progress when it picks the ticket. Design exploration is fast and one-shot — the only state change happens at the very end (Phase 8), when the doc is written and the recommendation is settled, and the issue moves straight from `Todo` to `Done`. There's no "In Progress" leg because there's no useful window where the design ticket is half-done.

If the user is re-running design on a ticket that is already `In Progress` or `Done` (per the soft validations above), respect their confirmation and proceed — the final Phase 8 transition still runs and re-asserts `Done`.

---

## Phase 3 — Read the ticket and any plan-doc context

The ticket body is your input contract. Read it end to end.

1. **Fetch the issue body** and pull out:
   - **Goal** — what outcome the ticket is trying to achieve. **Required.**
   - **Deliverables** — the concrete things that have to exist when the work is done. **Required.**
   - **Done when** — the testable acceptance criterion. **Required.**
   - **Source** — plan-doc anchor, if present.
   - **Relevant docs** — the per-component CLAUDE.md / ARCHITECTURE.md pointers attached at ticket-creation time. You may glance at these for context (which components are in scope) but **do not lean on them as the design authority** — your job is to think in patterns, not retrace the conventions doc.

   If **Goal / Deliverables / Done when** are missing, **stop and report**. The ticket isn't shaped right for design work.

2. **Try to fetch the parent project's `Plan:` line** via `get_project`. Same parser as `execute-next-task`:
   - `Plan: [docs/planning/.../<slug>.md](https://...)` — preferred combined form
   - `Plan: docs/planning/.../<slug>.md` — bare path fallback
   - `**Plan doc:** [docs/planning/.../<slug>.md](https://...)` — legacy fallback
   - **No `Plan:` line** is fine — many standalone tickets (e.g. under the Maintenance project) won't have one. Note "no plan doc" and skip step 3.

3. **If a plan doc was located**, read its matching `### Phase N` section if one exists. Treat it as supplemental context for *why* the work matters and how it fits into a larger arc. The ticket body still wins on what specifically has to ship — the plan doc helps you understand the surrounding intent so the designs you propose are coherent with the larger plan.

4. **Skim prior comments on the ticket** with `list_comments`. If a previous design pass already happened (you'll see a comment from this skill pointing at a `docs/designs/...md` file), surface it to the user immediately: "ALT-NN already has a design doc at `<path>` — open it instead, or generate a fresh pair?". Don't silently overwrite a previous pass.

5. **Do not** read every per-component CLAUDE.md / ARCHITECTURE.md pointer the ticket lists. They tell you what *conventions* a future executor must follow; they don't help you compare design patterns. The next phase is where you do the real research.

---

## Phase 4 — Research design patterns

This is the heart of the skill. The output is *not* "what does the codebase say" — it's "what shapes could the solution take, and which shapes work well here." Approach it as a designer who happens to know the codebase, not as a code-archaeologist.

### 4.1 Identify the pattern axes that matter for this ticket

Read the Goal + Deliverables and ask: what is this work fundamentally *doing*?

- **Adding a new resource type** → CRUD shape, persistence layer, validation pattern, audit/event trail.
- **Wiring a new integration** → adapter/facade, retry policy, credential management, connection lifecycle.
- **Long-running operation** → event emission, progress tracking (task tracker), idempotency, cancellation.
- **New UI surface** → page-vs-modal, query/state ownership (TanStack Query patterns), socket vs. polling, form library choice.
- **Refactor / extraction** → seam placement, dependency direction, test boundaries.
- **Cross-cutting concern (auth, logging, metrics, etc.)** → middleware vs. decorator vs. interceptor; opt-in vs. blanket application.

Pick **one or two axes** that dominate the design space for *this* ticket. You don't need to consider every pattern in the GoF book — just the ones that would actually change how the code reads.

### 4.2 Survey the patterns themselves

For each chosen axis, name two or three candidate patterns and what they cost / give you. Examples (illustrative, not exhaustive):

- **Persistence:** single-table polymorphism vs. table-per-type vs. JSONB column on a parent table — trade-offs in query ergonomics, migration cost, type safety.
- **Long-running ops:** synchronous request → bus message → consumer vs. job queue with poller vs. socket-driven progress events. Differences in failure modes, observability, and how the UI consumes them.
- **Adapter shape:** thin wrapper that exposes the SDK 1:1, vs. opinionated facade that picks the right SDK call based on intent — trade-off between escape hatches and clean call sites.
- **Cross-cutting:** Express middleware vs. service-level decorator vs. explicit call at each call site — trade-off between magic and discoverability.
- **State ownership (frontend):** server state in TanStack Query + invalidate-on-event vs. local component state synced via socket — different reactivity models.
- **Composition vs. inheritance:** small composable functions vs. base class + overrides — affects how easy it is to vary one axis without touching another.

You don't need to memorise the GoF taxonomy — name patterns by what they do, not by their textbook label. "Strategy pattern with a registry of handlers" reads better than "Strategy" alone.

### 4.3 Look for prior art in the Mini Infra codebase

This is the part that anchors the designs to the real repo. For each pattern axis, find one or two existing places in the codebase that already solve a *similar* problem — not necessarily the same problem, but a structurally similar one. Use `Grep` / `Read` / `Glob` directly, or spawn an `Explore` subagent if the search is wide ("how does the codebase generally handle progress events for long-running ops?").

Capture, for each prior-art reference:

- **What it does** in one sentence.
- **The pattern it uses** in your own words.
- **Why it's a good fit (or not) for the current ticket** — be honest. If the existing pattern has known pain points (referenced in CLAUDE.md or visible in the code), call that out.

Cite the file path and (where helpful) a line range so the user can jump to it.

The point of this step is two-fold: **(a)** it grounds your proposed designs in shapes the codebase already supports — reducing "this would be lovely if we rewrote half the repo first" suggestions; **(b)** it surfaces opportunities to *deliberately diverge* from the existing pattern when there's a good reason. Both reuse and intentional divergence are legitimate design moves; the design doc should make the choice explicit either way.

### 4.4 Decide on the two options

From the patterns you surveyed and the prior art you found, pick **two options that differ along at least one axis from §What "two distinct designs" means**. Different points on the same axis (e.g. "small refactor" vs. "bigger refactor") often *aren't* meaningfully different — push for two ideas a thoughtful reviewer would actually weigh against each other.

If you can only think of one good design and the alternatives all feel weaker, that's important data — surface it to the user before writing the doc, and ask whether they want a single recommendation with a "rejected alternatives" appendix instead. Forcing a second option to fill the slot just produces noise.

---

## Phase 5 — Write the design doc

The output is a single markdown file at `docs/designs/<issue-id>-<slug>.md` containing both options side-by-side. A single file (not two) is deliberate — readers compare options most easily when they're scrollable in one view.

### 5.1 Filename

- **Issue ID** — lowercase, e.g. `alt-38`.
- **Slug** — short kebab-case derived from the ticket title, max ~6 words. `Phase 4: pg-az-backup progress + result events` → `pg-az-backup-progress-events`. Strip articles / punctuation.
- **Full path:** `docs/designs/alt-38-pg-az-backup-progress-events.md` (relative to the repo root).

If `docs/designs/` doesn't exist yet, create it. If a file with the same name already exists, the Phase 3 comment-skim should have caught it; if it slipped through, stop and ask whether to overwrite or append a `-v2` suffix.

### 5.2 Doc template

Use this structure verbatim. Omit a section only if it genuinely doesn't apply (e.g. the "Open questions" section can be empty if there are none — but say "None." rather than dropping the heading).

```markdown
# Design: <Ticket Title> (<ALT-NN>)

**Linear:** <full https URL to the issue>
**Goal (from ticket):** <one-line copy of the ticket's Goal>
**Done when (from ticket):** <one-line copy>

## Context

<2–4 paragraphs. What does the ticket actually need? What constraints come from the Deliverables / Done-when? What did Phase 4 prior-art research surface — i.e. what shapes does the codebase already support that bear on this work? What axis or two are the alternative designs varying along (be explicit so the reader knows what they're choosing between)?>

---

## Option A — <Short evocative name>

**Differs from Option B on:** <axis, e.g. "persistence shape", "synchrony", "blast radius">

### Idea in one paragraph
<The design in plain English. A reviewer should be able to picture the shape from this paragraph alone.>

### Key abstractions
- **<Name>** — <what it represents, what its responsibilities are>
- **<Name>** — <…>
- <one bullet per significant new abstraction; reuse existing ones where possible and say so>

### File / component sketch
<Bullet list of new and changed files, each with a one-line note on what it holds. Group by directory. Mark new with `(new)` and changed with `(changed)`.>

```
server/src/services/<area>/<thing>.ts          (new)        — <what>
server/src/routes/<area>.ts                    (changed)    — <what>
client/src/hooks/<area>/use<Thing>.ts          (new)        — <what>
lib/types/<thing>.ts                           (changed)    — <what>
```

### Implementation outline
<Numbered list, 4–8 steps, each one a meaningful chunk of work — not "import x" granularity. The point is to give the executor (and the reader) a sense of the order of operations and where the risk lives.>

1. <step>
2. <step>
3. <…>

### Pros
- <bullet — concrete, not generic>
- <bullet>

### Cons
- <bullet>
- <bullet>

### Prior art it leans on
- [`<file>`](<file>) — <what pattern it borrows; why it's a good fit>
- [`<file>`](<file>) — <…>

---

## Option B — <Short evocative name>

<Same structure as Option A. Repeat all sub-headings. Don't shortcut the second option just because the first one took longer — a reviewer who skips A and reads B should still get the full picture.>

---

## Recommendation

<**Required, not optional.** 1–2 paragraphs naming the picked option and why, framed as "for the ticket as currently scoped". The user does not pick afterwards — this is the call. If the two options are genuinely close, still pick one and name the one or two facts that would flip the call (so a future reader can spot if the world changed). Don't hedge — "no strong preference" is not a valid output of this skill.>

## Open questions

<Questions that would change the design if answered differently. One bullet each. "None" is a valid answer; don't manufacture questions to fill the section.>

## Out of scope

<Things you considered and consciously did not propose. Each with a one-line "why not" — usually scope-creep beyond the ticket, or a different ticket's territory. Helps the reader trust that the absence is deliberate, not an oversight.>
```

### 5.3 Writing notes

- **Voice:** match the rest of the project's docs — direct, concrete, no marketing language. The docs in `docs/architecture/` and `docs/planning/` are good tonal references.
- **Specificity:** name files, name functions, name constants. "Add a new service" is weaker than "Add `BackupProgressEmitter` in `server/src/services/backup/`". The reader should not have to guess where things land.
- **Length:** designs vary in size, but most should fit in 200–500 lines total. If you're heading past 700 lines, you're probably over-specifying — back off to "outline" granularity and trust the executor to fill in.
- **No code blocks longer than ~10 lines.** The doc is a design, not an implementation. If a code snippet is essential to the idea (e.g. a particularly weird type signature), keep it tight; otherwise describe in prose.
- **Cite prior art with file paths the editor can click** — `[server/src/services/backup/backup-executor.ts](server/src/services/backup/backup-executor.ts)`.

### 5.4 Where to write it

The user's repo policy: if you're on `main`, switch to a branch before writing. If you're already on a non-main branch (including a worktree branch like `claude/alt-NN`), just write the file on the current branch.

**Do not commit** the file automatically. The point of the design doc is to be reviewed and iterated on — committing it locks it in before that happens. Leave the file unstaged; the user will commit (or ask you to) after they've read it.

If the user is on `main`, before writing the file:

```bash
git checkout -b design/alt-NN-<slug>
```

Use `design/` as the branch prefix (parallel to `claude/` for execution branches) so it's obvious from the branch name what kind of work is in flight.

---

## Phase 6 — Comment on the design ticket *and* the impl ticket

Two comments here, not one. Both are short navigation aids — the design doc itself is the artefact.

### 6.1 Comment on the design ticket

```
save_comment(issueId: <design-ALT-NN>, body: <see template>)
```

Template:

```markdown
**Designs drafted:** [`docs/designs/<filename>.md`](<https URL to file on the design branch, if pushed; otherwise the relative path>)

Two options explored:
- **Option A — <name>** — <one-line gist>
- **Option B — <name>** — <one-line gist>

**Picked: Option <X>** — <one-sentence reason from §Recommendation>.

Marking this design ticket Done — `/execute-next-task <impl-ALT-NN>` is unblocked. If you disagree with the pick, edit the doc and reopen the ticket.
```

If the parent ticket lists an impl ticket it blocks (look at the issue's `relations.blocks[]` from the original `get_issue` call), name that ticket explicitly so the user has a one-click follow-up. If there's no blocked impl ticket, drop that clause.

### 6.2 Comment on the impl ticket (if there is one)

`execute-next-task` reads the impl ticket's body as the contract and skims its comments. The impl ticket needs a pointer to the design doc, otherwise a future executor opens the ticket cold and has no idea a design pass happened. Don't edit the impl ticket's body — comments are sufficient and don't risk corrupting the contract.

If `relations.blocks[]` on the design issue contains exactly one impl ticket (the typical shape produced by `plan-to-linear`), post:

```
save_comment(issueId: <impl-ALT-NN>, body: <see template>)
```

Template:

```markdown
**Design ready:** [`docs/designs/<filename>.md`](<https URL on design branch, if pushed; else relative path>)

**Picked: Option <X>** — <one-sentence reason from §Recommendation>.

Read this before starting implementation — it includes Key abstractions, File / component sketch, and Implementation outline that the design doc commits to. Open questions in the doc are unresolved choices that may matter at implementation time.
```

If `relations.blocks[]` is empty (standalone design, no impl ticket), skip 6.2. If it contains more than one impl ticket (rare — usually a planning mistake), post the comment on each one and surface the multi-target case to the user in the final report.

### 6.3 URL derivation

If the design branch has been pushed to the remote, link to the file via its GitHub URL (`https://github.com/<owner>/<repo>/blob/<branch>/docs/designs/...md`) so both comments are clickable from Linear. If it hasn't been pushed, the relative path is fine — the user can always view it locally.

Derive the GitHub URL by reading `git remote get-url origin` and combining with the current branch name.

---

## Phase 7 — Mark the issue Done

The design doc + recommendation are the deliverable, so the design ticket is now finished. Transition the issue from its current state straight to `Done`:

```
save_issue(id: <ALT-NN>, state: "Done")
```

That single call is all this phase does. It unblocks any impl ticket that had this design ticket as a `blocked-by` edge — `execute-next-task` can pick the impl ticket up immediately. If `save_issue` errors (e.g. workspace permissions changed), surface the error to the user and tell them to mark Done manually; do not retry silently.

The Done-when on the ticket body (often "Figma frames signed off") is **informational, not gating**. The recommendation in the doc is what the team is going to ship; treating Figma sign-off as a hard gate would only stall the impl ticket. If a future user wants Figma in the loop they'll change the skill, not the per-run behaviour.

---

## Phase 8 — Final report to the user

End the run with a tight summary so the user knows what landed:

```
✓ Design doc written: docs/designs/<filename>.md
✓ Linear comment posted on design ticket <ALT-NN>
✓ "Design ready" comment posted on impl ticket <ALT-MM>
✓ <ALT-NN> marked Done (impl ticket <ALT-MM> unblocked)

Two options:
  A) <name> — <one-line>
  B) <name> — <one-line>

Picked: Option <X> — <one-line reason>.

If you disagree with the pick, edit the doc and re-comment / reopen the ticket.
```

If there's no impl ticket the design ticket was blocking, drop both the impl-ticket comment line and the "(impl ticket … unblocked)" clause.

That's the whole skill. Keep the output short — the design doc is the substantive thing; the chat reply just navigates to it.

---

## Hard rules

- **Only one Linear state transition per run, and only at the end.** The skill calls `save_issue` exactly once, in Phase 7, to set the issue to `Done`. Never set `In Progress`, never re-transition during the run, never call `save_issue` for any other field.
- **Never create a worktree.** This is a planning step. The user runs `execute-next-task` later, which handles worktree creation. If the design surfaces something the executor needs to know, capture it in the design doc — not in environment setup.
- **Never auto-commit the design doc.** The user reviews + commits + PRs at their own pace; pre-committing locks the doc in before they've seen it. Stage nothing.
- **Never `git checkout main` or modify other branches.** The only branch operation allowed is `git checkout -b design/alt-NN-<slug>` from a clean main, and only when on main.
- **Never collapse two options into one.** If you genuinely can't think of two distinct approaches, surface that and ask the user whether to write one with a "rejected alternatives" appendix instead. Forcing a weak second option produces noise.
- **Never punt the recommendation back to the user.** The §Recommendation section must commit to one option. "No strong preference" / "either works" / "user picks" are invalid outputs — pick one and name what would flip the call. The skill marks the issue Done on this basis; it cannot do that if it hasn't picked.
- **Never skip the prior-art search (Phase 4.3).** Designs that ignore the existing codebase are usually wrong about what's expensive vs. cheap. Even if you find nothing reusable, the search itself should inform your options.
- **Never overwrite an existing design doc silently.** If `docs/designs/<filename>.md` already exists (or a comment from a previous design pass exists on the ticket), stop and ask.
- **Never produce an ExitPlanMode block.** The design doc *is* the plan. ExitPlanMode is for implementation plans presented in chat; this skill writes a markdown file instead.

---

## Example end-to-end (abbreviated)

> User: "design ALT-38"
>
> *Skill loads Linear MCP. Fetches ALT-38: "Phase 2: container-level egress firewall toggle", part of the "Egress firewall per-container override" project. Project description has `Plan: docs/planning/not-shipped/egress-per-container-plan.md`. Skill reads the ticket body (Goal: per-container override of the egress firewall policy; Deliverables: API field, UI control, applied at apply-time, audit-logged; Done when: integration test shows the override flips behaviour). Reads the plan doc's Phase 2 section as supplemental context. Skims prior comments — none from this skill — so no overwrite risk.*
>
> *Phase 4: identifies the dominant pattern axis as "where does the override live and how does it propagate to apply-time" — i.e. a state-placement + propagation question. Surveys two candidate shapes: (i) override stored on the StackService row, propagated through the existing apply pipeline; (ii) override stored on a new `EgressOverride` table keyed by service, looked up at apply-time. Searches the codebase for similar override patterns: finds `server/src/services/networking/haproxy-frontend-overrides.ts` (per-frontend overrides on the frontend row, similar to option (i)) and `server/src/services/registry/registry-credential-resolver.ts` (separate-table indirection lookup, similar to option (ii)). Cites both.*
>
> *Phase 5: writes `docs/designs/alt-38-egress-per-container-override.md`. Option A is the row-extension shape (cheap, follows the haproxy pattern, but couples the override to the service row's lifecycle). Option B is the separate-table shape (heavier, needs a new migration and model, but cleaner audit trail and easier to extend with override types later). Each option has Key abstractions / File sketch / Implementation outline / Pros / Cons / Prior art. **Recommendation: Option A** — the team has no plans for other override types and the cheaper change is the right call for the ticket as scoped; flip to B if a second override type lands on the roadmap. One Open question: "do we want overrides to survive a service rename?" — answer changes which option wins. Two items in Out-of-scope: bulk override import (different ticket), override expiry (no Deliverable for it).*
>
> *Skill is on the goofy-thompson worktree branch (not main), so no branch switch needed. File written, not staged.*
>
> *Phase 6.1: posts a comment on ALT-38 (the design ticket): "Designs drafted: …relative-path… A — Service-row column; B — Separate EgressOverride table. **Picked: Option A** — cheap, leans on the haproxy override pattern; flip to B only if a second override type lands. Marking this design ticket Done — `/execute-next-task ALT-39` (the impl ticket) is unblocked."*
>
> *Phase 6.2: ALT-38 has `relations.blocks: [ALT-39]`. Posts a comment on ALT-39 (the impl ticket): "**Design ready:** `docs/designs/alt-38-egress-per-container-override.md`. Picked: Option A — Service-row column. Read this before starting implementation — it includes Key abstractions, File / component sketch, and Implementation outline. Open questions in the doc are unresolved choices that may matter at implementation time." A future `/execute-next-task ALT-39` skim of comments will see this immediately.*
>
> *Phase 7: `save_issue(id: "ALT-38", state: "Done")`. The single state transition. Impl ticket ALT-39 is now picker-eligible.*
>
> Skill: "✓ Design doc written: `docs/designs/alt-38-egress-per-container-override.md`. ✓ Linear comment posted on design ticket ALT-38. ✓ 'Design ready' comment posted on impl ticket ALT-39. ✓ ALT-38 marked Done (impl ticket ALT-39 unblocked). Two options: A) Service-row column. B) Separate EgressOverride table. Picked: A — cheap, leans on the haproxy override pattern. If you disagree, edit the doc and reopen the ticket."
