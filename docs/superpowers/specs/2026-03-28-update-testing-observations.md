# Application Update — Testing Observations

## What Works

1. **Container naming fix works** — new containers created with 5-char random suffix (e.g., `internet-facing-test-nginx-test-nginx-aplvs`), no more HTTP 409 name collisions
2. **Update button and dialog** — renders correctly, triggers API call, shows in task tracker
3. **`POST /api/stacks/:id/update` endpoint** — validates stack status, prevents concurrent operations, emits Socket.IO events
4. **`StackReconciler.update()`** — correctly pulls images, detects digest changes, routes to blue-green for StatelessWeb
5. **Blue-green update state machine** — successfully creates green container, registers in HAProxy, transitions through `deployingGreenApp → waitingGreenReady → initializingGreenLB → healthCheckWait`
6. **Rollback on failure** — green container cleaned up correctly (removed from HAProxy, stopped, removed from Docker)

## Issues Found

### Issue 1: Health check endpoint hardcoded to `/health`

**Location:** `server/src/services/stacks/stack-reconciler.ts` — `buildStateMachineContext()` line 1193

```typescript
healthCheckEndpoint: '/health',
```

**Problem:** The HAProxy health check endpoint is hardcoded to `/health`. The stack service's Docker healthcheck config specifies the actual endpoint (e.g., `curl -f http://localhost:80/index.html`), but this information isn't passed to the state machine. For services like nginx that don't have a `/health` route, the health check times out after 90 seconds and triggers a rollback.

**Impact:** Affects both initial deploy (`apply`) and update flows for any StatelessWeb service without a `/health` endpoint. The first successful deploy of test-nginx likely used a different code path or had a different healthcheck config.

**Proper fix:** The health check endpoint used by HAProxy should be derived from the stack service definition. Options:
1. Add an explicit `healthCheckEndpoint` field to `StackServiceRouting` (cleanest — user configures it alongside hostname/port)
2. Parse the path from the Docker healthcheck `test` command (fragile — depends on command format)
3. Fall back to `/` instead of `/health` when no explicit endpoint is configured (quick fix but less correct)

**Recommendation:** Option 1 — add `healthCheckEndpoint` to `StackServiceRouting`. Default to `/` if not set. This gives users explicit control and aligns with how the Deployments system handles it (deployment configs have a dedicated health check section).

### Issue 2: `captureContainerForDeployment` foreign key violation

**Location:** `server/src/services/haproxy/actions/deploy-application-containers.ts` line 124

**Problem:** The `captureContainerForDeployment` call tries to create a `DeploymentContainer` record referencing `context.deploymentId`. For stack-based deployments, the deployment ID is a synthetic string (e.g., `stack-{stackId}-{serviceName}-{timestamp}`) that doesn't correspond to a real `Deployment` record in the database, causing a foreign key constraint violation.

**Impact:** Non-blocking — the error is caught and logged as a warning. The deployment continues. But it generates noisy error logs.

**Proper fix:** Either:
1. Skip the `captureContainerForDeployment` call when the deployment ID starts with `stack-` (quick)
2. Have the stack reconciler create a proper tracking record that the capture can reference (proper but more work)

### Issue 3: Orphaned service name in container map

**Observation:** The update history shows a second service `stk-test-nginx-test-nginx-deployment-stack-cm` being processed alongside `test-nginx`. This is a container from a previous failed deployment that got picked up by the label-based container discovery (it has `mini-infra.stack-id` label). The reconciler treats it as a separate service that needs updating.

**Impact:** The update correctly handles it (marks as success since there's nothing to do), but it's confusing in the audit trail.

**Proper fix:** The `plan()` method should only consider containers whose `mini-infra.service` label matches a service name defined in the current stack definition. Orphaned containers from failed deployments should be flagged for cleanup, not treated as services to update.
