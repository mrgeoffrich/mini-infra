# Application Update Feature

## Overview

A dedicated "Update" action on Application cards that pulls the latest image and redeploys running containers. StatelessWeb services get zero-downtime blue-green updates via a simplified state machine. Stateful services get a simple stop → pull → recreate cycle with brief downtime.

This is distinct from "recreate" (triggered by definition changes) — an update means "same config, fresh image."

## Backend

### New Endpoint: `POST /api/stacks/:id/update`

- **Auth**: `requirePermission('stacks:write')`
- **Request body**: `{}` — no parameters. Pulls the latest of each service's configured tag.
- **Validation**:
  - Stack exists and has status `synced` or `drifted` (i.e., is deployed and running)
  - Not already being applied/updated (reuse existing `applyingStacks` concurrency guard, return 409 if in progress)
- **Response**: `202 Accepted` with `{ success: true, data: { started: true, stackId } }`

### Background Execution Flow

1. Pull all service images using `forcePull` digest comparison
2. For services where the image digest changed:
   - **StatelessWeb**: Run through the new blue-green update state machine (zero-downtime)
   - **Stateful**: Stop → remove → pull → create → start (brief downtime)
3. Services with unchanged digests: skip (no-op)
4. Record `StackDeployment` with `action: 'update'`
5. Emit `STACK_APPLY_COMPLETED` with results

### Blue-Green Update State Machine

Copy `blue-green-deployment-state-machine.ts` to `blue-green-update-state-machine.ts` and strip out the TLS, DNS, and frontend configuration states (and their rollback counterparts). These resources are already configured from the initial deploy/apply — an update only swaps the container behind existing routing.

**State flow**:
```
idle
 → deployingGreen (15%)         Pull image, create new container
 → waitingGreenReady (30%)      Wait for container startup
 → addingGreenToLB (45%)        Register green in HAProxy backend
 → healthCheckGreen (60%)       Health checks against green
 → openingTrafficToGreen (75%)  Switch HAProxy traffic to green
 → validatingGreen (85%)        Validate green is serving
 → drainingBlue (90%)           Drain connections from old container
 → removingBlue (95%)           Stop and remove old container
 → completed (100%)
```

**Removed from the deployment machine**: `configuringFrontend`, `configuringDNS` states and their associated rollback states.

**Rollback**: On health check failure, the machine rolls back to the blue container (restore traffic, remove green) — same as the deployment machine minus the DNS/TLS rollback steps.

### Stateful Update Flow

Simple sequential execution within the reconciler (no state machine needed):

1. Stop existing container
2. Remove existing container
3. Pull image with `pullImageWithAutoAuth()`
4. Create new container with same definition
5. Start container
6. Wait for healthcheck

### Stack Reconciler Changes

Add a new method or parameterize the existing `apply()` to support update mode:

- Uses `forcePull` semantics to detect image digest changes
- Uses the update state machine (not deployment machine) for StatelessWeb services
- Skips resource reconciliation (TLS/DNS/tunnel) — resources are already in place
- Records the action as `'update'` in `StackDeployment`

### Schema Change

Add `'update'` to `StackDeployment.action`. Currently the field stores `'apply' | 'destroy'` as a string — extend validation to accept `'update'`.

### Socket.IO Events

Reuse existing events — they're generic enough:
- `STACK_APPLY_STARTED` — with `action: 'update'` in payload
- `STACK_APPLY_SERVICE_RESULT` — per-service progress
- `STACK_APPLY_COMPLETED` — final result

The `action` field in the payload distinguishes update from apply.

## Frontend

### Update Button (Applications Page)

In `client/src/app/applications/page.tsx`, add an "Update" button to each Application card. Visible only when the app has an active deployed stack (same condition used for the Stop button — `stackByTemplateId.has(app.id)` with a running stack).

### UpdateApplicationDialog

New file: `client/src/app/applications/update-application-dialog.tsx`

- Confirmation dialog: "Update [app name]? This will pull the latest image and redeploy."
- Cancel and Update buttons
- On confirm: calls `useUpdateApplication()` mutation
- On success: toast "Application update started", close dialog

### useUpdateApplication Hook

In `client/src/hooks/use-applications.ts`:

```typescript
export function useUpdateApplication() {
  return useMutation({
    mutationFn: async (stackId: string) => {
      return apiClient.post(`/api/stacks/${stackId}/update`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      queryClient.invalidateQueries({ queryKey: ['userStacks'] });
      queryClient.invalidateQueries({ queryKey: ['stacks'] });
    },
  });
}
```

### Task Tracker Integration

New entry in `client/src/lib/task-type-registry.ts`:

Task type: `'stack-update'` with steps derived from the update state machine states. Bound to the existing `STACK_APPLY_*` Socket.IO events (filtered by `action: 'update'` in payload).

Steps for StatelessWeb services:
- Pulling image
- Starting new container
- Adding to load balancer
- Health checking
- Switching traffic
- Validating
- Draining old container
- Removing old container
- Complete

Steps for Stateful services:
- Stopping container
- Pulling image
- Starting new container
- Health checking
- Complete

## Out of Scope

- Per-service update from stack detail view
- Tag override in the update dialog
- Rollback for stateful updates
- Update from the Deployments page (separate system)
