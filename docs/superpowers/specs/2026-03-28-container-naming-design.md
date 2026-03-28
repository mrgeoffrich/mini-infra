# StatelessWeb Container Naming with Random Suffix

## Overview

StatelessWeb service containers need unique names to support blue-green updates. During an update, the new (green) container must coexist with the old (blue) container. Currently, the `DeployApplicationContainers` action generates its own name using a deployment ID slice, which can collide and ignores the `containerName` passed in the state machine context. This change adds a 5-char random alpha suffix to StatelessWeb container names and makes the deploy action respect the context-provided name.

## Changes

### StackReconciler — `buildStateMachineContext`

Generate `containerName` with a random suffix for StatelessWeb services:

```typescript
const suffix = Array.from(crypto.randomBytes(5), b => String.fromCharCode(97 + (b % 26))).join('');
const containerName = `${projectName}-${action.serviceName}-${suffix}`;
```

This produces names like `prod-myapp-backend-xkvmr`. The name is passed in the state machine context and used by all downstream actions.

### `DeployApplicationContainers` action

Change line 36 from generating its own name:

```typescript
const containerName = `${context.applicationName}-deployment-${context.deploymentId.slice(0, 8)}`;
```

To using the context-provided name with a fallback:

```typescript
const containerName = context.containerName
  ?? `${context.applicationName}-deployment-${context.deploymentId.slice(0, 8)}`;
```

This makes the reconciler the single source of truth for container names when using stacks, while preserving backwards compatibility for the Deployments system (which doesn't set `context.containerName`).

### No changes required

- **Stateful containers:** Keep fixed names (`${projectName}-${serviceName}`), no suffix.
- **Container discovery:** Uses `mini-infra.stack-id` and `mini-infra.service` labels, not container names.
- **Container mapping (`buildContainerMap`):** Maps by `mini-infra.service` label, not name.
- **HAProxy routing (`AddContainerToLB`):** Already uses `context.containerName` — works automatically with the new suffixed names.
- **`MonitorContainerStartup`:** Reads actual container name from Docker inspect — works automatically.
- **`StackContainerManager.createAndStartContainer`:** Only used for stateful services — unchanged.

### Existing containers

Old containers with the previous naming scheme are found by labels and cleaned up during the blue-green swap. No migration needed.

## Out of Scope

- Changing stateful container naming
- Changing the Deployments system naming
- Container name display in the UI (already shows whatever Docker reports)
