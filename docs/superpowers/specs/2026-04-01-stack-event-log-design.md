# Stack Deployment Event Log Integration

## Overview

Integrate stack deployment operations (apply and destroy) into the UserEvent system so they appear on the `/events` page with structured, step-by-step logs and error reporting.

Currently, HAProxy (single-app) deployments create UserEvent records, but stack deployments do not. Stacks have their own `StackDeployment` table and Socket.IO events but are invisible on the events page.

## Scope

- Stack apply and destroy operations only
- One UserEvent per stack operation (not per-service)
- Structured step-by-step log format with service actions and resource reconciliation
- No changes to HAProxy deployment events
- No frontend changes required — the existing events page and detail view handle everything

## Event Configuration

### Stack Apply

| Field | Value |
|-------|-------|
| `eventType` | `stack_deploy` (new) |
| `eventCategory` | `infrastructure` |
| `eventName` | `Deploy {stackName} v{version}` |
| `triggeredBy` | `manual` or `api` based on request context |
| `resourceType` | `stack` |
| `resourceId` | stack ID |
| `resourceName` | stack name |

### Stack Destroy

| Field | Value |
|-------|-------|
| `eventType` | `stack_destroy` (new) |
| `eventCategory` | `infrastructure` |
| `eventName` | `Destroy {stackName}` |
| `triggeredBy` | `manual` or `api` based on request context |
| `resourceType` | `stack` |
| `resourceId` | stack ID |
| `resourceName` | stack name |

## Progress Tracking

Progress is calculated as: `completedSteps / totalSteps * 100`

Total steps = 1 (planning) + active service actions (excluding no-ops) + resource reconciliation groups (TLS, DNS, Tunnel — each counted as one step only if there are actions for that group).

Progress is updated after each step completes via `userEventService.updateEvent()`.

## Structured Log Format

Logs are appended incrementally via `userEventService.appendLogs()` as each step completes. The format uses a numbered step layout with status indicators:

```
[1/6] Planning stack changes...
      -> 2 services to create, 1 to recreate, 0 to remove

[2/6] Creating service: postgres
      ok Image pulled: postgres:16 (1.8s)
      ok Container created and started (2.3s)

[3/6] Creating service: redis
      ok Image pulled: redis:7 (0.9s)
      ok Container created and started (1.1s)

[4/6] Recreating service: web-app
      FAIL Container failed to start: port 8080 already in use
        Error: Bind for 0.0.0.0:8080 failed: port is already allocated

[5/6] Reconciling TLS certificates
      ok web-app.example.com — certificate issued (4.2s)

[6/6] Reconciling DNS records
      ok web-app.example.com — CNAME created (0.9s)
```

Note: Unicode checkmarks/crosses will be used in actual implementation for the ok/FAIL markers above.

## Error Handling

- **Service failure**: Log the error in that step's output, continue with remaining services, mark the overall event as `failed` at the end.
- **Resource reconciliation failure**: Log the error for the failed resource group, mark the event as `failed`.
- **`errorMessage`**: Set to a human-readable summary, e.g., `"1 of 3 services failed: web-app"` or `"DNS reconciliation failed"`.
- **`errorDetails`**: JSON-stringified object containing the full error details for each failed service/resource.
- **Partial success**: If some services succeed and others fail, the event status is `failed` but the logs clearly show which steps succeeded and which failed.

## Implementation Changes

### 1. `lib/types/user-events.ts` — Add new event types

Add `stack_deploy` and `stack_destroy` to the `UserEventType` union type.

### 2. `server/src/routes/stacks.ts` — Create and manage UserEvent

In the apply and destroy route handlers (where the fire-and-forget async blocks live):

1. Create a UserEvent before starting the operation with status `running`.
2. Append the planning step log after `reconciler.plan()` completes.
3. Use the existing `onProgress` callback to append per-service step logs and update progress.
4. After resource reconciliation, append resource step logs.
5. On completion: update event to `completed` with `resultSummary`.
6. On failure: update event to `failed` with `errorMessage` and `errorDetails`.

### 3. `server/src/services/stacks/stack-reconciler.ts` — Extend onProgress for resources

The current `onProgress` callback only fires for service action results. Extend it (or add a separate `onResourceProgress` callback) so that resource reconciliation results (TLS, DNS, Tunnel) are also reported back to the caller.

This allows the route handler to append resource step logs to the UserEvent.

### 4. New helper — Log formatter

A small utility function (likely in the stacks service directory) that formats structured log lines:

- `formatPlanStep(stepNumber, totalSteps, plan)` — formats the planning summary
- `formatServiceStep(stepNumber, totalSteps, serviceResult)` — formats a service action result
- `formatResourceStep(stepNumber, totalSteps, resourceType, results)` — formats resource reconciliation results

This keeps the formatting logic testable and separate from the route handler.

## What Stays the Same

- **Frontend**: No changes. The existing events page, event detail page, logs viewer, filters, and badges all work with the new event types automatically.
- **UserEventService**: Used as-is via `createEvent()`, `updateEvent()`, `appendLogs()`.
- **Stack Socket.IO events**: `STACK_APPLY_STARTED`, `STACK_APPLY_SERVICE_RESULT`, `STACK_APPLY_COMPLETED` continue to fire for the real-time stack deployment UI.
- **StackDeployment table**: Continues to be written for stack-specific deployment history.
- **HAProxy deployment events**: Untouched.
