# Pool Phase 3 — Idle reaper

**Parent spec:** [stack-service-pools-plan.md](stack-service-pools-plan.md). Prereq: [Phase 2](pool-phase-2-async-spawn.md) is merged.

**Goal:** mini-infra autonomously reaps idle instances and rescues stuck-starting ones. Until this lands, caller-orchestrated spawns accumulate unless the caller explicitly DELETEs them — unacceptable for slackbot's steady-state.

## Work items

### 1. `PoolInstanceReaper` class — `server/src/services/stacks/pool-instance-reaper.ts` (new)

1.1. Follow the existing scheduler pattern (`setInterval` loop started from `server.ts`, not `node-cron` — the 60 s interval is too short for cron syntax). Mirror `ConnectivityScheduler` or whichever in-repo scheduler is closest structurally.

1.2. Public shape: `start()`, `stop()`, exposed `tick()` for tests.

1.3. Every 60 s, run two queries in sequence (not parallel — keeps log lines coherent and avoids two simultaneous Docker storms):

**Query A — idle running instances:**
```ts
WHERE status = 'running' AND lastActive < NOW() - idleTimeoutMinutes * 60s
```
For each:
1. `docker stop` with 10 s graceful timeout.
2. `docker rm`.
3. Update row: `status = stopped`, `stoppedAt = now`.
4. Emit `POOL_INSTANCE_IDLE_STOPPED` with `{ stackId, serviceName, instanceId, idleMinutes }`.

**Query B — stuck-starting instances:**
```ts
WHERE status = 'starting' AND createdAt < NOW() - 5m
```
For each:
1. Attempt `docker stop` + `docker rm` — container may not exist; swallow NotFound errors.
2. Update row: `status = error`, `errorMessage = 'Spawn timed out after 5 minutes'`.
3. Emit `POOL_INSTANCE_FAILED`.

1.4. Each instance's cleanup is wrapped in try/catch — one failure must not abort the loop for other instances. Log at `warn` with stackId/serviceName/instanceId.

### 2. Wire into server startup

2.1. `server/src/server.ts` — instantiate `PoolInstanceReaper` alongside existing schedulers and call `start()` after DB is ready.

2.2. Graceful shutdown path — call `reaper.stop()` alongside other schedulers.

### 3. Edge-case handling

3.1. If Docker is unreachable at reap time, log and skip this tick — don't transition DB rows to `stopped` without confirming the container is gone. Next tick retries.

3.2. If the stack is in `error` status, reaper still runs — a failing stack shouldn't leak idle containers.

3.3. Heartbeat during a stop window (reaper has started the docker stop but not yet updated DB): the heartbeat endpoint should still return 200 because the row is still `running`. This is a tiny race (≤10 s); acceptable. Don't add locking.

## Tests

- **Unit:** `PoolInstanceReaper.tick()` with a fake clock + mocked Docker/DB:
  - Idle instance past its window → stopped.
  - Idle instance within window → untouched.
  - Stuck-starting past 5 min → error.
  - Docker stop throws NotFound → row still transitions (already gone).
  - Docker unreachable → tick logs and exits without DB changes.
- **Integration (dev instance):** set a 1-min idle timeout on a test pool, spawn an instance, wait 90 s, verify container is gone and `POOL_INSTANCE_IDLE_STOPPED` was emitted.

## Definition of done

- [ ] A pool instance with no heartbeat for `idleTimeoutMinutes` is reaped within one tick (~60 s) of the deadline.
- [ ] A spawn that hangs (e.g. image pull stall) transitions to `error` after 5 minutes.
- [ ] Reaper survives Docker outages without corrupting DB state.
- [ ] No regressions — Phase 2 tests still pass.

## Out of scope

- UI changes (Phase 4) — reaper emits events, UI just consumes them.
- Per-instance rolling restarts on image update (deferred from MVP).
