# Plan-doc spec backfill — todo

The [`PLANNING.md`](PLANNING.md) spec was extended (2026-05-02) to require three new per-phase fields:

- **Reversibility** — `safe` / `feature-flagged` / `forward-only` / `destructive` + one-line rationale.
- **UI changes** — bullet list with `[design needed]` / `[no design]` tags, or the literal `none`.
- **Verify in prod** — production signal, or `n/a — internal only`.

All in-flight plans pre-date the spec change. Pick one off the list below and backfill — every phase needs all three fields.

The structural value of doing this isn't just "make the spec happy." It surfaces:
- **Designer dependencies** — `grep -r "\[design needed\]" docs/planning/` becomes the live designer-todo list across all in-flight plans.
- **Rollback gaps** — Reversibility forces a per-phase answer to "what if this breaks in prod?" Several plans implicitly assume `safe` and would be `forward-only` on inspection.
- **Outcome vs deliverable confusion** — Verify-in-prod separates "the code does the right thing in CI" from "the goal materialised after rollout."

---

## Status

- [x] **[service-addons-plan](not-shipped/service-addons-plan.md)** (6 phases) — done.

## Priority 1 — UI is bunched late; designer can't see the work without reading the whole plan

These plans split UI from backend in ways that hide design dependencies. Backfilling forces the per-phase UI line, which exposes the back-loading. Worth a 5-minute think *before* backfilling about whether to shift UI work earlier in the phasing — if not, the backfilled lines will read "Phases 1-3: `none`. Phase 4: 12 items `[design needed]`" and the designer becomes the critical path.

- [ ] **[auth-proxy-sidecar-plan](not-shipped/auth-proxy-sidecar-plan.md)** (4 PRs) — PRs 1–3 are backend; PR 4 ships the entire admin UI.
- [ ] **[dns-providers-plan](not-shipped/dns-providers-plan.md)** (5 phases) — Phases 1–2 build the framework with no affordances; Phase 4 lands the `/dns-providers` page. Phase 3 also sneaks in Socket.IO events without a UI call-out.

## Priority 2 — UI is buried in deliverables, code blocks, or background prose

Real UI work is mentioned but in places a designer scanning for the UI block would miss.

- [ ] **[observability-otel-tracing-plan](not-shipped/observability-otel-tracing-plan.md)** (6 phases) — Phase 6's "new Grafana dashboard panel set" is mentioned but not framed as user-facing work. Phases 1, 5 already clear.
- [ ] **[unified-backups-plan](not-shipped/unified-backups-plan.md)** (5 phases) — Phase 1 ships two distinct UIs (bootstrap surface + admin Backups page) but only one is in the deliverable bullets.

(`native-heap-profiling` was moved to `docs/architecture/` — it's a how-to, not a phased plan, so the spec doesn't apply.)

## Priority 3 — UI articulation is fine; just rote backfill of Reversibility + Verify-in-prod

UI lines will mostly be `none` or copy-from-existing. The rate-limiter is writing the Reversibility classifier and Verify-in-prod signal honestly.

- [ ] **[vault-oidc-plan](not-shipped/vault-oidc-plan.md)** (3 stages) — Stage 1 UI is clear; Stages 2–3 backend-only (`UI changes: none`).
- [ ] **[job-pool-service-type-plan](not-shipped/job-pool-service-type-plan.md)** (5 phases) — UI is clear (events page, Run-now affordance reuse).

(`internal-nats-messaging-plan` and `worktree-egress-subnet-allocation` shipped and moved to `shipped/` — no need to backfill.)

---

## Per-phase template to paste

Insert between **Deliverables** and **Done when** in each phase:

```
Reversibility: <safe | feature-flagged | forward-only | destructive> — <one-line rationale>

UI changes:
- <user-visible change — page/screen + what changes + what user sees> [design needed]
- <user-visible change> [no design]
- (or the literal word `none` if this phase ships nothing user-visible)
```

Then after **Done when**:

```
Verify in prod: <production signal that confirms the Goal materialised> (or `n/a — internal only`)
```

See [service-addons-plan](not-shipped/service-addons-plan.md) Phase 1 for a worked example.

---

## Notes

- **Already-seeded plans:** every plan in the list except `native-heap-profiling` is already seeded to Linear. The new sections won't auto-propagate to existing Linear issues. Decide per-plan whether to manually update the issue body, or accept the doc as source-of-truth and let the Linear ticket stay as a frozen snapshot.
- **Strict-sequential plans don't need `[blocks-by]` brackets** in the phase tracking list — the omitted-bracket form means strict sequential. Most plans here are strict sequential and need no change.
- **Delete this file** once the list is empty.
