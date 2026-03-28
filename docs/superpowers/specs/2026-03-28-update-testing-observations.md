# Application Update — Testing Observations

## What Works

1. **Container naming fix works** — new containers created with 5-char random suffix (e.g., `internet-facing-test-nginx-test-nginx-aplvs`, `internet-facing-test-nginx-test-nginx-ulxcp`), no more HTTP 409 name collisions
2. **Update button and dialog** — renders correctly, triggers API call, shows in task tracker
3. **`POST /api/stacks/:id/update` endpoint** — validates stack status, prevents concurrent operations, emits Socket.IO events
4. **`StackReconciler.update()`** — correctly pulls images, detects digest changes, routes to blue-green for StatelessWeb
5. **Blue-green update state machine** — successfully transitions through the full happy path up to traffic enablement: `deployingGreenApp → waitingGreenReady → initializingGreenLB → healthCheckWait → openingTraffic`
6. **HAProxy health check passes** — server reaches `UP` / `L4OK` status in HAProxy
7. **Traffic enablement works** — HAProxy reports server UP with 0 sessions after enabling traffic
8. **Rollback on failure** — green container cleaned up correctly (removed from HAProxy, stopped, removed from Docker)

## Issues Found and Fixed

### Issue 1: Health check endpoint hardcoded to `/health` — FIXED

Added `healthCheckEndpoint` field to `StackServiceRouting` type, Zod schema, and `buildStateMachineContext`. Defaults to `/` when not set. Users can now configure a custom health check path per service.

### Issue 2: `captureContainerForDeployment` foreign key violation — FIXED

Removed the `captureContainerForDeployment` call from `DeployApplicationContainers` entirely. Stacks have their own `StackDeployment` audit trail, so the `DeploymentContainer` records are unnecessary and caused FK violations for stack-based deployments.

## Remaining Issues

### Issue 3: Orphaned service name in container map

**Observation:** The update history shows a second service `stk-test-nginx-test-nginx-deployment-stack-cm` being processed alongside `test-nginx`. This is a container from a previous failed deployment that got picked up by label-based container discovery (it has `mini-infra.stack-id` label). The reconciler treats it as a separate service that needs updating.

**Impact:** The update correctly handles it (marks as success since there's nothing to do), but it's confusing in the audit trail.

**Proper fix:** The `plan()` method should only consider containers whose `mini-infra.service` label matches a service name defined in the current stack definition. Orphaned containers from failed deployments should be flagged for cleanup, not treated as services to update.

### Issue 4: Blue-green update fails after traffic enablement — `containerId` undefined in post-traffic actions

**Observed flow (from logs):**
```
deployingGreenApp     → DEPLOYMENT_SUCCESS (container created with suffix name)
waitingGreenReady     → CONTAINERS_RUNNING (IP: 172.28.0.4, port: 80)
initializingGreenLB   → LB_CONFIGURED (server added to HAProxy backend)
healthCheckWait       → SERVERS_HEALTHY (status: UP, checkStatus: L4OK)
openingTraffic        → traffic enabled (server UP, 0 sessions)
??? → FAILED with "Container ID is required for server identification"
```

**Problem:** After `openingTraffic` succeeds, a subsequent action fails because `context.containerId` is undefined. The blue-green update state machine maps `context.newContainerId → containerId` in each action's entry function using a spread operator. But somewhere between the `openingTraffic` success and the next state, the `containerId` mapping breaks.

**Suspected cause:** The `enableTraffic` action sends `TRAFFIC_ENABLED` event after successfully enabling traffic, but the action might throw asynchronously after sending the event. The state machine transitions to `drainingBlue`, which maps `containerId: context.newContainerId` for `initiateDrain`. If `newContainerId` is somehow lost during the xstate state transition, the validation in the drain/stop actions fails.

Alternatively, there may be a race condition in xstate v5's `assign` — the `TRAFFIC_ENABLED` handler assigns `trafficOpenedToGreen: true, trafficValidated: true`, but the failure report shows `trafficEnabled: false`, suggesting the assign may not have been applied before the error was captured.

**Impact:** The blue-green update completes the hardest parts (container creation, LB registration, health check, traffic switch) but fails during the drain/cleanup phase. The rollback then removes the healthy green container and restores the original state.

**Investigation needed:**
1. Add logging in the `drainingBlue` entry action to confirm `context.newContainerId` and `context.oldContainerId` values
2. Check if the `TRAFFIC_ENABLED` → `drainingBlue` transition properly preserves all context fields
3. Consider whether `enableTraffic` action throws after sending the success event (dual-outcome issue)
4. Test with the original `blue-green-deployment-state-machine.ts` (with frontend/DNS states) to see if the same issue exists — this would confirm it's a pre-existing state machine bug, not specific to the update machine
