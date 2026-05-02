# Service Addons — `JobPool` service type for triggered one-shot containers

**Status:** planned, not implemented. Phased rollout — each phase is a separate Linear issue.
**Builds on:** the existing `Pool` service type and stack-template injection plumbing ([`PoolConfig`](../../../lib/types/stacks.ts), [`pool-spawner.ts`](../../../server/src/services/stacks/pool-spawner.ts), `PoolInstance`, [`pool-instance-reaper.ts`](../../../server/src/services/stacks/pool-instance-reaper.ts), [`pool-socket-emitter.ts`](../../../server/src/services/stacks/pool-socket-emitter.ts)), and the NATS migration shipped through #346 — see [internal-nats-messaging-plan.md](internal-nats-messaging-plan.md) §6 Phase 4 and the deferred-work comment on ALT-29.
**Excludes:** all other one-shot patterns (volume inspection, ACME challenge runners, ad-hoc Alpine probes). Only `pg-az-backup` and `restore-executor` migrate in this project; the rest evaluate against the abstraction once it's stable.

---

## 1. Background

Mini Infra has four service types today: `Stateful`, `StatelessWeb`, `AdoptedWeb`, and `Pool`. All of them get stack-managed plumbing — NATS credential injection, Vault AppRole binding, environment-aware container/network naming, structured plan/apply events, draft/publish template versioning. One-shot containers like `pg-az-backup` and `restore-executor` get **none** of it. They're spawned through bespoke executors that re-roll their own env assembly, network resolution, and queue management.

ALT-29 (NATS migration Phase 4) made this gap concrete: container-side NATS publishing was deferred from the original plan because [`NatsCredentialInjector`](../../../server/src/services/nats/nats-credential-injector.ts) only knows how to inject into stack-template-defined services. The pg-az-backup container can't publish its own progress events over NATS today; the server has to mediate by parsing stdout. That deferred deliverable sits at the centre of this plan.

The addon framing: `JobPool` is a new service type that takes Pool's existing spawn/inject/track machinery and re-points it at containers that *exit* rather than *idle*. The terminator changes from "idle timer" to "exit code"; trigger sources move from "HTTP route" to "cron, NATS request, or manual"; everything else — `dynamicEnv` resolution, network attachment, `PoolInstance` lifecycle tracking, Socket.IO emission — is reused unchanged. Once it's in place, a one-shot becomes a stack-template service like any other, and pg-az-backup picks up live NATS publishing for free.

This plan also generalizes the per-domain JetStream history stream (`BackupHistory` from ALT-29) into a per-pool pattern, so that future job pools each get their own durable history without bespoke wiring.

## 2. Goals

1. **One-shot containers become stack services.** A new `JobPool` service type sits in the same template that defines any other stack, with the same dynamicEnv / networks / Vault / NATS plumbing.
2. **Mini Infra owns the trigger registries.** Cron and NATS-request triggers are reconciled at apply time. Operators declare `triggers[]` on a JobPool service; the server registers schedules and subscriptions accordingly.
3. **Exit drives lifecycle.** A new exit watcher converts container exit (0 vs non-zero) into `completed` / `failed` history events and frees the concurrency slot promptly. Pool's idle reaper stays as the safety net for stuck-starting and run-away jobs.
4. **Per-pool durable history.** Each JobPool gets its own JetStream stream (`JobHistory-<stack>-<service>`). The bespoke `BackupHistory` stream from ALT-29 retires.
5. **`pg-az-backup` and `restore-executor` migrate.** The first proves the abstraction works end-to-end and closes ALT-29's deferred container-side NATS publishing. The second proves the abstraction generalizes beyond a single domain.

## 3. Non-goals

- **Replacing Pool.** JobPool is a peer service type, not a Pool successor. Pool's "long-running, killed when idle" model has its own users (warmed compute, request-routed replicas) — they're different shapes and stay separate.
- **External-app triggering.** `JobPoolConfig.managedBy` is reserved on the type for a future where another stack triggers a backup, but mini-infra is the only spawner in v1. No token-routing, no app-side SDK.
- **A generic addon framework.** This plan ships exactly one new service type. "Service Addons" is a framing for future additions, not infrastructure to enable them.
- **Persistent run queue.** When `maxConcurrent` is hit, the trigger fails fast. Cron emits a `run_skipped` event; NATS-request replies with an error; manual HTTP returns 429. No second-chance retry queue at the dispatcher level (in-job retries via `onFailure.retries` are in scope).
- **Cross-host job distribution.** Single managed host, same as the rest of Mini Infra. No leader election, no remote workers.
- **Migrating non-backup one-shots.** Volume inspection, ACME runners, and any other ad-hoc one-shot stays on its current path. They re-evaluate after the abstraction has settled.

## 4. The `JobPool` service type

A new branch of the `StackTemplateService` discriminated union, alongside `Stateful` / `StatelessWeb` / `AdoptedWeb` / `Pool`. Type-shape contract — the literal type names and field names below are the contract; everything else is implementation choice.

```ts
// lib/types/stacks.ts — added to the StackTemplateService union
export interface JobPoolConfig {
  /** Hard cap on simultaneous in-flight runs. `null` = unlimited. */
  maxConcurrent: number | null;

  /** Reserved — name of a caller service that holds the spawn token. Unused in v1. */
  managedBy: string | null;

  /** Triggers declared by the template. At least one required. */
  triggers: JobPoolTrigger[];

  /** Per-pool JetStream history stream config. */
  history: { retainDays: number; maxBytes?: string };

  /** Safety: kill a runaway run after N seconds. Replaces Pool's idle timer. */
  killAfterSeconds?: number | null;

  /** In-job retry policy on non-zero exit. Optional. */
  onFailure?: { retries: number; backoff: "fixed" | "exponential" };
}

export type JobPoolTrigger =
  | { kind: "cron"; schedule: string; timezone?: string; name: string }
  | { kind: "nats-request"; subject: string; ackWithRunId: boolean; name: string }
  | { kind: "manual"; name: string };
```

Each trigger carries a `name` so history events and skipped-run logs can attribute the run ("ran from `nightly-prod` cron", "skipped because `manual` trigger hit cap").

The `manual` trigger is implicit — every JobPool gets a `POST /api/stacks/:stackId/job-pools/:serviceName/run` endpoint regardless. Declaring it in `triggers[]` is for UI labeling.

## 5. Triggers and the trigger registries

Three trigger sources, all converging on a single `runJobPool(ctx)` entry point inside the server.

### 5.1 Trigger sources

- **Cron.** A new singleton `JobPoolCronRegistry` queries all applied JobPool services with `triggers[kind=='cron']` and registers each with `node-cron`. On apply, the registry refreshes for the affected stack — adding new schedules, removing deleted ones, restarting changed ones.
- **NATS request.** A second singleton `JobPoolNatsRegistry` hosts responders. On apply, it diffs declared `nats-request` subjects against current subscriptions; subscribes new, unsubscribes removed. Replaces the bespoke per-domain responder pattern (`mini-infra.backup.run` from ALT-29 moves under this registry).
- **Manual.** HTTP POST route, available for every JobPool unconditionally. Body is a free-form JSON object forwarded as a `JOB_PAYLOAD` env var to the container. Schema validation deferred to a follow-up.

### 5.2 The shared spawn path

All three converge on:

```ts
async function runJobPool(ctx: {
  stackId: string;
  serviceName: string;
  trigger: { kind: "cron" | "nats-request" | "manual"; name: string };
  payload?: Record<string, unknown>;
}): Promise<{ runId: string } | { error: string }>
```

`runJobPool` checks the cap against `(starting | running)` `PoolInstance` rows for that pool, fails fast with a structured reason if at cap, otherwise creates a row and delegates to the existing `spawnPoolInstance()` — which already does NATS+Vault credential injection, network attachment, and event emission. **This is the entire reuse story.**

### 5.3 Fail-fast contract

| Trigger | Cap-hit response |
|---|---|
| cron | Skip the run; emit `mini-infra.<pool>.run-skipped` event with `{ reason: "concurrency_cap", triggerName, scheduledAt }`. |
| nats-request | Reply `{ error: "concurrency_cap_reached", maxConcurrent }`. No `PoolInstance` row created. |
| manual HTTP | `429 Too Many Requests` with the same payload as the NATS reply. |

## 6. Phased rollout

Phases land in order — each phase blocks all subsequent phases. Phases 1-3 are pure infrastructure (no behavior change for existing one-shots); Phase 4 is the first migration; Phase 5 is the second.

### Phase 1 — `JobPool` type + spawn handler

**Goal:** the type exists, validates, persists, and can be spawned via direct API call. No triggers yet, no exit watcher yet.

Deliverables:
- `JobPoolConfig` and `JobPoolTrigger` added to `lib/types/stacks.ts`, exported from the package.
- `StackTemplateService` discriminated union gains the `JobPool` branch with a `jobPoolConfig?: JobPoolConfig | null` field on `StackTemplateServiceInfo`.
- Server-side validators: at least one trigger; cron schedule parseable; NATS subject conforming to the existing prefix allowlist; `maxConcurrent >= 1` or `null`.
- Apply handler is a stub `no-op` (matching `Pool` today) — config persists on the `StackService` row but no orchestration runs at apply.
- A `runJobPool()` entry point that delegates to `spawnPoolInstance()` and tracks via `PoolInstance` rows. No trigger sources yet — only a direct internal call (used in tests) and a stub manual HTTP route returning `501` until Phase 3.
- Unit tests: validation, type narrowing, `runJobPool` cap-check logic.

Done when: a stack template with a JobPool service applies cleanly, the service row carries `jobPoolConfig`, and an integration test calls `runJobPool()` directly to spawn + observe a `PoolInstance` row reach `running`.

### Phase 2 — Exit watcher and per-pool history streams

**Goal:** container exit becomes a first-class lifecycle event, and history is durable.

Subjects:
- `mini-infra.job-pool.<stackId>.<serviceName>.completed` (evt, JetStream `JobHistory-<stack>-<service>`).
- `mini-infra.job-pool.<stackId>.<serviceName>.failed` (evt, same stream).
- `mini-infra.job-pool.<stackId>.<serviceName>.run-skipped` (evt, plain pub/sub — observability for cap-hit scheduled runs).

Deliverables:
- A `JobPoolExitWatcher` that subscribes to the existing Docker event stream and finalizes `PoolInstance` rows on container `die` events. Sets `status` to `completed` or `failed` based on exit code, writes `exitCode` and `finishedAt`, frees the concurrency slot.
- Per-pool JetStream stream creation, wired through the **operator path** in `system-nats-bootstrap.ts` (per ALT-29's handoff: the live-bus path can't create regular streams). Stream naming: `JobHistory-<stackId-suffix>-<serviceName>`, kept under NATS's name-length limits.
- `JobPoolConfig.history` config drives `max-bytes` and `max-age`.
- New Socket.IO events on `Channel.POOLS`: `JOB_POOL_RUN_COMPLETED`, `JOB_POOL_RUN_FAILED`, `JOB_POOL_RUN_SKIPPED` (added to `lib/types/socket-events.ts`).
- Pool reaper extension: kill instances that exceed `killAfterSeconds`, mark them `failed` with `errorMessage: "killed: exceeded killAfterSeconds"`.
- Retry handling: if `onFailure.retries > 0` and exit was non-zero, schedule a retry through `runJobPool` after the configured backoff.

Done when: a JobPool service completes a successful run end-to-end (exit 0 → `completed` event published to JetStream → Socket.IO event fanned out), a deliberate failure produces a `failed` event with the right exit code, and a runaway job killed by `killAfterSeconds` surfaces as `failed`.

### Phase 3 — Trigger registries

**Goal:** declarative cron and NATS-request triggers reconciled at apply time. Manual HTTP route activated.

Deliverables:
- `JobPoolCronRegistry` singleton: loads all JobPool services with cron triggers at boot, registers with `node-cron`, exposes a `refresh(stackId)` method called from the apply handler.
- `JobPoolNatsRegistry` singleton: subscribes to declared `nats-request` subjects, diffs on apply, replies with `{ runId }` or `{ error }`.
- JobPool apply handler stops being a no-op: calls `cronRegistry.refresh(stackId)` and `natsRegistry.refresh(stackId)`. Also runs a credential dry-run resolution to fail apply fast if a `dynamicEnv` binding is misconfigured.
- Manual HTTP route activated: `POST /api/stacks/:stackId/job-pools/:serviceName/run` with optional JSON body forwarded as `JOB_PAYLOAD` env var. Returns `runId` or `429` on cap.
- All three triggers go through `runJobPool()` and emit `run-skipped` on cap.
- Drift detection: definition hash for JobPool services includes `triggers[]`, `history`, `killAfterSeconds`, `onFailure`. Excludes the running-or-not state of instances (oscillation, not drift).

Done when: a fresh worktree with a JobPool template + cron trigger applies, the cron fires on schedule, the run completes, and history replays after a server restart. Manual HTTP and NATS-request triggers both spawn against the same pool with correct trigger attribution in the history events.

### Phase 4 — `pg-az-backup` migration

**Goal:** convert `pg-az-backup` to a JobPool. Close ALT-29's deferred container-side NATS publishing. Delete the bespoke executor and scheduler.

Deliverables:
- A new system stack template `pg-az-backup` (or rename of the existing one) with a single `JobPool` service. `dynamicEnv` declares `NATS_CREDS`, `NATS_URL`, `AZURE_SAS_URL`, the existing `POSTGRES_*` vars. `triggers[]` carries one `cron` per scheduled backup and one `nats-request` on `mini-infra.backup.run`.
- The `pg-az-backup` container's `run.sh` (or new companion) publishes `mini-infra.backup.progress.<runId>` directly over NATS using the injected creds, replacing the server-mediated bridge.
- Server-side: [`backup-executor.ts`](../../../server/src/services/backup/backup-executor.ts) deletes the in-memory queue and the bespoke `mini-infra.backup.run` responder. [`backup-scheduler.ts`](../../../server/src/services/backup/backup-scheduler.ts) deletes; cron handling moves to `JobPoolCronRegistry`.
- `BackupHistory` JetStream stream retires; backup history reads from the per-pool `JobHistory-<...>-pg-az-backup` stream. UI events page query updates accordingly.
- The existing "Run now" UI affordance routes to the manual HTTP trigger.
- Backwards compatibility: the existing backup configuration UI (`BackupConfiguration` rows) keeps its shape; cron strings flow into the JobPool template's `triggers[]` at apply time. No user-visible UX change.

Done when: scheduled backups still run, manual "Run now" still works, the events page still shows live progress + completed/failed entries, and the bespoke executor + scheduler are deleted from the codebase. A killed backup container surfaces as `failed` via the exit watcher.

### Phase 5 — `restore-executor` migration

**Goal:** prove the abstraction generalizes by converting the second one-shot.

Deliverables:
- Convert [`restore-executor`](../../../server/src/services/restore-executor/) to a JobPool template. Manual trigger only — no cron. Restore parameters (target backup ID, target database) flow through the manual trigger's `JOB_PAYLOAD`.
- Restore container reads `JOB_PAYLOAD` directly; existing `BackupValidator.validateBackupFile()` runs in the container or server-side as appropriate.
- Delete the bespoke restore executor.
- Likely shakes out missing pieces in the manual-trigger payload story — surface them in the handoff comment for a follow-up.

Done when: a restore initiated from the UI completes against a real backup, lands as a `completed` event in the per-pool history, and the bespoke restore executor is deleted.

## 7. Risks & open questions

- **Stream creation path.** ALT-29's handoff flagged that the live-bus path can't create regular JetStream streams (only KV). Phase 2's per-pool stream creation goes through the operator-path control-plane seeder. Confirm this generalizes when streams are created on apply rather than at boot — may need to extend `system-nats-bootstrap.ts` to react to apply events, not just startup.
- **Stream-name length.** `JobHistory-<stackId>-<serviceName>` can exceed NATS's stream-name limits for long stack IDs. Phase 2 needs a deterministic shortening (e.g. hash suffix when over 32 chars).
- **Credential dry-run at apply time.** The Phase 3 dry-run may surface latent misconfigurations in existing stacks when their templates are first re-applied post-upgrade. Document the failure mode in release notes.
- **Manual trigger payload schema.** v1 ships free-form JSON forwarded as one env var. If two JobPools end up with very different payload shapes, schema declaration on `JobPoolTrigger` becomes the next ask. Out of scope for this plan.
- **Concurrency cap migration.** pg-az-backup currently enforces a global cap of 2 in `backup-executor`; under JobPool it becomes per-pool. If we ever run two backup pools (e.g., per-environment), they each get their own 2-slot cap. Document the behavior change in Phase 4's release notes.
- **Drift semantics for JobPool with `nats-request` triggers.** A subscription in the registry that's missing in the template means drift. Subscription unsubscribe-on-apply must be ordered before subscribe-on-apply within a refresh cycle to avoid a window with duplicate handlers.
- **Cron firing during in-flight apply.** If a cron trigger fires while the stack is mid-apply, the registry may briefly hold a stale schedule. Acceptable for v1 (worst case: one missed beat); add a per-stack apply mutex if it shows up in practice.
- **Running-or-not is not drift.** The plan-and-apply flow needs to ignore "no instance running" as a steady state. Verify that the existing definition-hash already excludes `dynamicEnv` and that no new fields slip into the hash that would oscillate per-run.

## 8. Linear tracking

Tracked under the [Service Addons](https://linear.app/altitude-devops/project/service-addons-jobpool-service-type-for-triggered-one-shot-containers-31f632f8c571) project on the Altitude Devops team. Phases land in order — each phase blocks the next.

- [ALT-33](https://linear.app/altitude-devops/issue/ALT-33) — Phase 1: `JobPool` type + spawn handler
- [ALT-34](https://linear.app/altitude-devops/issue/ALT-34) — Phase 2: Exit watcher and per-pool history streams
- [ALT-35](https://linear.app/altitude-devops/issue/ALT-35) — Phase 3: Trigger registries
- [ALT-36](https://linear.app/altitude-devops/issue/ALT-36) — Phase 4: `pg-az-backup` migration
- [ALT-37](https://linear.app/altitude-devops/issue/ALT-37) — Phase 5: `restore-executor` migration
