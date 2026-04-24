# Pool Phase 2 — Async spawn, task tracker, Socket.IO, heartbeat

**Parent spec:** [stack-service-pools-plan.md](stack-service-pools-plan.md). Prereq: [Phase 1](pool-phase-1-data-model-and-api.md) is merged.

**Goal:** spawn returns immediately; the long-running container work happens as a tracked background task with Socket.IO progress events. Add the heartbeat endpoint.

## Work items

### 1. Task tracker types — `client/src/lib/`

1.1. `task-tracker-types.ts` — add `"pool-spawn"` to the `TaskType` union.

1.2. `task-type-registry.ts` — add a `"pool-spawn"` entry in `TASK_TYPE_REGISTRY`:
- Follow the `stack-destroy` shape (`stepEvent: null`) — pool spawn has only two observable transitions (`starting → running` or `starting → error`), not a multi-step flow.
- Label, icon, and channel bindings per the existing pattern.

### 2. Socket.IO events — `lib/types/socket-events.ts`

2.1. Add five `ServerEvent` constants with their `"pool:instance:*"` string values:
- `POOL_INSTANCE_STARTING`
- `POOL_INSTANCE_STARTED`
- `POOL_INSTANCE_FAILED`
- `POOL_INSTANCE_IDLE_STOPPED` (emitter wired in Phase 3; declare here to keep typing coherent)
- `POOL_INSTANCE_STOPPED`

2.2. Add typed signatures to `ServerToClientEvents` with the payload shapes from the spec.

2.3. Emitter helper (new): `server/src/services/stacks/pool-socket-emitter.ts` with `emitPoolInstanceStarting/Started/Failed/Stopped` — one standalone function per event, each wrapped in try/catch, following the `container-socket-emitter.ts` pattern.

### 3. Async spawn in the POST handler

3.1. Refactor the `POST /` handler in `stacks-pool-routes.ts`:
- Validate inputs + service type + `maxInstances` synchronously.
- Insert `PoolInstance` row with `status: starting`.
- Emit `POOL_INSTANCE_STARTING`.
- Call `registerTask()` to create a `pool-spawn` task entry.
- Kick off an async background function (no `await` before the HTTP response) that does steps a-i from the spec (Vault resolve → image pull → container create → attach networks → start → poll → DB update + event emit).
- Return `200` with `status: "starting"` immediately.

3.2. Background function lives in `server/src/services/stacks/pool-spawner.ts` (new) — keeps the route handler thin. Signature: `spawnPoolInstance(poolInstance, stack, service, callerEnv, taskId)`.

3.3. The existing idempotent path (instance already `running`) still returns the current row synchronously with its live status — no task is created in that case.

### 4. Heartbeat endpoint

4.1. `POST /:instanceId/heartbeat` on the pool routes file:
- Updates `PoolInstance.lastActive = now`.
- Returns `{ ok: true, lastActive, expiresAt }` where `expiresAt = lastActive + idleTimeoutMinutes`.
- Ignores heartbeats for `stopped`/`error` instances (returns 404).

4.2. No Socket.IO event for heartbeat — the reaper reads `lastActive` directly.

## Tests

- **Unit:** `pool-spawner.ts` with mocked Docker + Vault injector — verifies the step sequence and emits correct events on success + failure.
- **Integration:** POST returns `starting` immediately; a follow-up GET within ~1 s shows `starting`; after the spawn completes, GET returns `running` with a `containerId`.
- **Integration:** heartbeat updates `lastActive`; heartbeat on a `stopped` instance returns 404.
- **Integration:** simulate a spawn failure (bad image) → status transitions to `error`, `POOL_INSTANCE_FAILED` emitted, task tracker marks failure.

## Definition of done

- [ ] POST never blocks — handler returns within <100 ms even on cold image pull.
- [ ] Task tracker popover shows the spawn with live transitions.
- [ ] Socket.IO events are observable from a browser dev tools console subscribed to the `pools` channel.
- [ ] Heartbeat endpoint callable and returns expected shape.
- [ ] No regressions in Phase 1 happy paths (existing tests still pass).

## Out of scope

- Reaper (Phase 3)
- UI (Phase 4)
