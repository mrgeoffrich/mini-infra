# Stacks & Applications — Remaining Work (P3 / P4 / P5)

*Written 2026-07-14, immediately after the P0–P2 fix series. Companion to [stacks-applications-ux-critique.md](stacks-applications-ux-critique.md).*

## Where we are

The critique's P0–P2 recommendations shipped as three stacked PRs (merge in order):

- **#510 (P0)** — apply failures persist `error`; op-lock guards + 30-min TTL; honest Stop (`POST /stacks/:id/stop`) with Stop/Remove/Delete tiers; Code view merge-preserve; real soft-archive; blast-radius delete.
- **#511 (P1)** — `POST /stacks/:id/upgrade` + `templateVersionId` FK; `templateUpdateAvailable` surfaced everywhere; "Save & deploy" config loop; tag updates flow through the template; global `/stacks` + `/stacks/:id` pages; explicit `GET /api/stacks` source filter; persisted `drifted` via post-plan marking; `StackStatusBadge` tooltips; needs-attention rollup (client).
- **#512 (P2)** — live `STACK_STATUS` socket events; `rotateOnUpgrade` inputs dialog; "Already up to date" feedback; `POST /stacks/:id/revert-pending` (discard pending changes); terminology pass incl. application-context error translation; template version diff + publish summary + rollback + "used by N stacks"; system templates read-only; Install dialog with parameters/input values.

What follows is everything still open, organized into three passes. **P3 is correctness debt and truth-telling** — the status system still lies in a few specific ways, one latent unit bug is user-visible, and the docs/verification debt from shipping three big PRs statically. **P4 completes the installed-instance model** — history, arbitrary versions, multi-environment. **P5 is strategic bets.** Sizes: S (≤½ day), M (1–2 days), L (multi-day).

---

## P3 — Correctness debt & truth-telling

### 3.1 `synced` can lie: started-then-crashed containers *(M)*
A service that starts and immediately dies leaves the stack `synced` with zero running containers — acknowledged in the code itself (`server/src/services/stacks/stack-container-manager.ts:314`, "started, then immediately crashed" cases). The status badge says everything is fine while the app is down.

**Approach:** event-driven, not polling. `DockerService` already streams container events with registration hooks (`onContainerEvent` / `onContainerChange`, see server/CLAUDE.md). Add a listener that maps `die`/`exited` events on managed-stack containers (identified by the `mini-infra.*` labels) to a stack-status re-evaluation: flip `synced → error` (or a new `degraded` attention reason) and emit the now-live `STACK_STATUS` event. This is the piece that makes the P2 live-status work fully honest.

### 3.2 Drift detection is still on-demand only *(M)*
`drifted` is persisted only when someone opens a plan (`stacks-validation-routes.ts` post-plan marking, P1). A stack can drift (container replaced/edited out-of-band) and read `synced` for weeks if nobody views its plan.

**Approach:** reuse the 3.1 event listener for the cheap signal (container config changes fire Docker events) plus a low-frequency background sweep (e.g. hourly) that computes definition-hash comparisons per stack — the hash machinery already exists in `stack-plan-computer.ts` and is cheap (label read vs stored hash, no full plan needed). Emit `STACK_STATUS` on flips. Rate-limit and skip stacks with in-flight operations (the op-lock is checkable).

### 3.3 Healthcheck `startPeriod` unit inconsistency — **confirmed live bug** *(M)*
The same stored `healthcheck.startPeriod` value is interpreted as **milliseconds** in the deploy wait path (`stack-state-machine-context.ts:153-157` — comment says "(ms)") but as **seconds** in every container-create path, where it's multiplied by 1e9 into nanoseconds for Docker (`stack-container-manager.ts:192`, `pool-spawner.ts:350-353`, `pool-addon-sidecar.ts:162-165` — `interval`/`timeout` too). A user entering `30000` (ms, per the app UI) gets a Docker StartPeriod of 30,000 **seconds** (~8.3 hours); a user entering `30` gets a 30 ms deploy wait.

**Approach:** pick one unit (recommend **seconds**, matching Docker's own mental model), declare it on the shared type in `lib/types`, convert at exactly one seam (a small `healthcheckToDocker()` helper), audit the client form labels/placeholders, and migrate/normalize stored values (a one-time sweep over stack services + template services; values ≥ 1000 are almost certainly ms). Add unit tests pinning both paths. This predates the UX work but lives in the same schema surface — do it before anything else touches healthchecks.

### 3.4 Needs-attention rollup is client-only *(S)*
The P1/P2 rollup (`client/src/lib/stack-attention.ts`) folds drift + NATS drift + error + update-available into one signal — but only in the browser. API consumers (the agent sidecar, API-key integrations) still have to reimplement the logic.

**Approach:** compute the same rollup server-side in `serializeStack()` (`needsAttention: { level, reasons[] }`), have the client consume it instead of computing locally. NATS drift is already fetched on stack GET; keep list-endpoint cost in check by computing the cheap parts on lists and the full set on detail.

### 3.5 Vestige cleanup *(S)*
- **`removed` status + `removedAt`:** still never written (critique §5). Decide now — recommend **removing** both: every guard that checks `removedAt IS NULL` is always-true, and destroy hard-deletes. If soft-delete tombstones are ever wanted they belong in P4's history work. Small migration + guard cleanup.
- **`useRedeployApplication`:** dead code (`client/src/hooks/use-applications.ts:447`, zero callers) — delete.
- **Tunnel cleanup TODO:** `stack-resource-reconciler.ts:612` ("Tunnel cleanup when tunnel service is ready") — destroyed stacks with tunnel ingress leave tunnel config behind. The tunnel service has existed for a while; implement the cleanup or re-scope the TODO with a reason.

### 3.6 Docs, agent manifest, and API changelog *(M)*
The user-facing docs predate the entire overhaul:
- `client/src/user-docs/applications/{application-management,host-stacks,stack-templates}.md` describe the pre-P0 world — no `/stacks` page, no Upgrade/"Save & deploy"/Discard-pending/Stop-vs-Remove tiers, no rollback or archive semantics. The agent sidecar answers questions from these files, so it currently gives stale guidance.
- The new pages (`/stacks`, `/stacks/:id`, the Install/Rotate/rollback dialogs) have **no `data-tour` attributes**, so the agent's `highlight_element` tool can't point at them. Add attributes and run `pnpm generate:ui-manifest`; update `docs-questions.yaml`.
- **API changelog note:** `GET /api/stacks` scoped queries now return all sources unless `source` is passed (changed in #511) — external API-key callers relying on the old implicit system-only behaviour must add `source=system`. Document in whatever passes for release notes.

### 3.7 Live E2E validation pass *(M)*
All three PRs were verified with builds + unit/integration tests only — no browser run. Before calling the series done, exercise the headline flows in a worktree environment (`pnpm worktree-env start`, then the `test-dev` skill / Playwright): upgrade with parameters and `rotateOnUpgrade` inputs, Save & deploy end-to-end, revert-pending on an addon-bearing stack (the #512 review caught a synthetic-sidecar restore bug in exactly this area — the class of bug static tests miss), Stop → Deploy cycle, template rollback + badge behaviour, live status flips reaching open pages. Expect to find small integration seams; budget for fixes.

### 3.8 Upgrade-dialog handoff polish *(S)*
Noted in the P2 report: the upgrade→apply chain resolves when apply *starts*, and `RotateInputsDialog` closes on that ACK. Make the handoff explicit — closing toast/inline note pointing at the task tracker ("Deploying — follow progress in the tracker") so the user isn't left wondering whether anything happened.

---

## P4 — Completing the installed-instance model

### 4.1 Stack definition history + rollback-to-any-deployment *(L)*
Today a stack has a version counter, a single `lastAppliedSnapshot`, and deployment history rows. `revert-pending` can only restore the *last* applied state; there is no timeline of what the definition was at each deployment and no "roll back to the version that worked on Tuesday".

**Approach:** persist the applied snapshot per deployment (check whether `StackDeployment` — schema ~1473 — can simply gain a `snapshot` JSON column written from the same `buildAppliedSnapshot()` call; that avoids a new model entirely). Then `/stacks/:id` gets a real version timeline (deployment + definition + template version at the time) and a "Restore this version" action reusing the revert-pending machinery (with the same synthetic-sidecar filtering — see #512's `be644f3`). Retention policy for snapshot bloat (keep last N).

### 4.2 Upgrade/downgrade to a *chosen* template version *(M)*
`POST /upgrade` only targets `currentVersion`. After a template rollback, stacks on a newer version show no badge and can't move (documented P2 choice: `templateUpdateAvailable` is strictly `current > installed`).

**Approach:** optional `targetVersionId` on the upgrade endpoint (must be a published version of the stack's template); version picker on the stack detail's upgrade flow; change the indicator to "installed ≠ current" with direction shown ("newer than current" after a rollback). The FK from P1 makes this clean.

### 4.3 Graphical authoring for `inputs` and `requires` *(M)* — and a decision on vault/NATS *(L if built)*
The four API-only template sections remain unauthorable in the UI (Code view preserves but can't edit them, P0). `inputs` and `requires` are small, well-schema'd, and high-leverage (prerequisites drive the banner UX; inputs drive install/rotate dialogs) — build simple section editors for those two, mirroring `template-parameters-section.tsx`.

For **vault/NATS**: either extend the YAML codec to full round-trip (so the Code view becomes the editor — cheaper, keeps one editing surface) or accept they stay API-only and say so in the authoring UI. Recommend the codec route; dedicated graphical editors for NATS accounts/streams/exports are a project of their own and probably not worth it.

### 4.4 Template version `archived` status: implement or remove *(S)*
Still dead (nothing writes it; the sidebar's archived section is unreachable — critique §6). With rollback now existing, archiving old versions has a real use (declutter + block instantiation/upgrade targets). Implement: an "Archive version" action on non-current published versions (server already rejects instantiating archived versions), or delete the enum value. Recommend implementing — it's small now that the sidebar and rollback plumbing exist.

### 4.5 Multi-environment applications *(L)*
The application UI assumes one `primaryStack` (`pickPrimaryService`, card status, detail header). The model underneath supports one template instantiated into several environments, but the UX collapses them.

**Approach:** application detail gains a per-environment deployments panel (one row per stack: environment, status, installed version, actions), the deploy flow gets an environment picker, and card status aggregates honestly ("2 environments · 1 needs attention"). This is the foundation for P5's promotion flows — worth designing them together.

### 4.6 Ad-hoc stack creation UI *(M)*
`POST /api/stacks` (templateless stacks) has zero UI — such stacks appear on the new `/stacks` page but can only be born via API. Add "Create stack" on `/stacks`: from-template (reuse the P2 Install dialog) and from-scratch (reuse the template services editor components against a stack definition). Alternatively, deliberately drop ad-hoc stacks and make templates the only path — but then say so and guard the API accordingly. Decide; don't leave it half-supported.

### 4.7 Blue-green visibility *(M)*
StatelessWeb deploys run the blue-green state machine (`server/src/services/haproxy/blue-green-update-state-machine.ts`) with events, but the stack detail shows nothing about it beyond generic task steps. Surface the phase (deploying green / health check / switching / draining blue) and the rollback events on `/stacks/:id` during a deploy — the events already exist; this is mostly presentation.

---

## P5 — Strategic bets

### 5.1 Docker-compose import *(L)*
`compose.yml → template draft` (services, networks, volumes, env, healthchecks mapped onto the template schema; unsupported keys reported, not silently dropped — the Code-view lesson). This is the single biggest adoption lever for the whole stacks feature: most self-hosters arrive holding a compose file.

### 5.2 Template export/import *(M, after 4.3)*
Once the YAML codec round-trips fully, exporting a template version as a file and importing it on another Mini Infra instance is nearly free — and opens the door to a shared community catalog later. Guard imports (system-source stripping, prefix-allowlist interactions for NATS subjects).

### 5.3 Environment promotion flows *(L, after 4.5)*
"Promote what's in staging to production": upgrade the production stack to the exact template version installed in staging, with a diff preview and confirmation. Builds directly on 4.2 (targeted versions) + 4.5 (multi-environment) — by then it's mostly UX.

### 5.4 Client bundle code-splitting *(M)*
Single ~4 MB chunk today (Vite warns on every build). Route-level lazy imports (`React.lazy` per top-level page in `routes.tsx`) would cut initial load substantially; the new `/stacks` pages and template editor are natural split points. Pre-existing debt, but the UI surface grew across P0–P2, so it's getting worse.

### 5.5 NATS surface consolidation *(M)*
`stack-template-schemas.ts` / the NATS apply orchestrator still carry "legacy vs new" dual code paths from the in-flight NATS migration (noted in the original server review). Finish the migration and delete the legacy path before more features stack on top of it.

### 5.6 Durable operation locks *(explicitly deferred)*
The in-memory lock (with P0's TTL) is correct for a single-process server. DB-backed locks only matter if Mini Infra ever runs multi-process — YAGNI today; recorded here so nobody rediscovers it as a "bug".

---

## Suggested sequencing

| Pass | Theme | Items | Rough size |
|---|---|---|---|
| P3 | Truth-telling + debt | 3.1–3.8 | ~1.5–2 weeks |
| P4 | Model completion | 4.1–4.7 | ~2–3 weeks |
| P5 | Strategic bets | 5.1–5.5 (pick by appetite) | per-item |

Within P3, do **3.3 (healthcheck units) first** — it's a live correctness bug independent of the UX series — then 3.1/3.2 together (they share the Docker-event listener), then 3.7 (E2E) last so it validates everything above it. P4's 4.1 and 4.2 are the highest-value user-facing items and can ship independently; 4.5 should be designed alongside 5.3 even if promotion ships much later.
