# State Machine Integration for Stack StatelessWeb Deployments

## Goal

Replace the procedural `applyStatelessWeb()` code in the stack reconciler with the existing xstate deployment state machines (`initialDeploymentMachine`, `blueGreenDeploymentMachine`, `removalDeploymentMachine`), giving stack-based StatelessWeb deployments the same resilience features (formal rollback chains, timeouts, retries, drain monitoring) as the legacy deployment orchestrator path.

## Approach

1. **Make 4 action classes source-agnostic** — `DeployApplicationContainers`, `AddContainerToLB`, `ConfigureFrontend`, and `ConfigureDNS` currently do Prisma lookups against the `DeploymentConfiguration` table. Refactor them to read config directly from context fields, with fallback to DB lookup for backwards compatibility.

2. **Populate context from stack data** — The stack reconciler builds state machine context objects from `StackServiceDefinition`, `StackServiceRouting`, and environment data, mapping them to the fields the actions expect.

3. **Create actors directly in the reconciler** — `applyStatelessWeb()` creates xstate actors, subscribes for completion, awaits the final state, and maps results to `ServiceApplyResult`.

## Key Design Decisions

- **Backwards compatible** — Legacy `DeploymentOrchestrator` path unchanged. Actions check new flat context fields first, fall back to `context.config.*` and DB lookups.
- **No new state machines** — Reuse all three existing machines as-is. State transitions, rollback chains, and timeouts remain untouched.
- **Awaitable actors** — The reconciler wraps actor lifecycle in a Promise so it can process services sequentially and collect results.
- **Backend naming** — Stacks use `stk-{stackName}-{serviceName}` for backend names (set via `context.applicationName`), matching existing reconciler convention.

## Files Changed

### Action Classes (make source-agnostic)
- `server/src/services/haproxy/actions/deploy-application-containers.ts`
- `server/src/services/haproxy/actions/add-container-to-lb.ts`
- `server/src/services/haproxy/actions/configure-frontend.ts`
- `server/src/services/haproxy/actions/configure-dns.ts`

### State Machine Context Types
- `server/src/services/haproxy/initial-deployment-state-machine.ts`
- `server/src/services/haproxy/blue-green-deployment-state-machine.ts`

### Legacy Caller (populate new context fields)
- `server/src/services/deployment-orchestrator.ts`

### Stack Reconciler (create actors)
- `server/src/services/stacks/stack-reconciler.ts`

### Tests
- `server/src/__tests__/stack-reconciler-apply-stateless.test.ts`
- New: `server/src/__tests__/action-source-agnostic.test.ts`
