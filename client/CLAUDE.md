# Client — Frontend Patterns & Coding Conventions

## Task Tracker for Long-Running Operations

The frontend tracks long-running backend operations via a unified task tracking system. When adding a new tracked operation, follow this pattern — don't build one-off progress UIs.

### Architecture

```
TaskTrackerProvider (root context, persists to sessionStorage)
  └─ subscribes to Socket.IO via TaskEventListener
       └─ matches events using Task Type Registry
            └─ updates TrackedTask state (phase, steps, errors)
                 ├─ TaskTrackerPopover (top nav badge + list)
                 └─ TaskDetailDialog (step-by-step detail view)
```

### Task Type Registry (`src/lib/task-type-registry.ts`)

Static map of task types → Socket.IO bindings and normalizer functions. Every tracked operation needs an entry here.

Each entry defines:
- `channel` — which Socket.IO channel to subscribe to
- `startedEvent` / `stepEvent` / `completedEvent` — the three event names
- `getId(payload)` — extracts operation ID from the started event
- `normalizeStarted(payload)` — extracts `totalSteps` and `plannedStepNames`
- `normalizeStep(payload)` — extracts the `OperationStep` from a step event
- `normalizeCompleted(payload)` — extracts `success`, `steps[]`, `errors[]`
- `invalidateKeys()` — TanStack Query keys to invalidate on completion

### Adding a New Tracked Operation

1. Add an entry to the task type registry in `src/lib/task-type-registry.ts`
2. In the component that triggers the operation, call `trackTask()` from `useTaskTracker()`:
   ```ts
   const { trackTask } = useTaskTracker();
   trackTask({
     id: operationId,
     type: 'your-task-type',  // matches registry key
     label: 'Human-readable label',
   });
   ```
3. The task tracker automatically subscribes to the correct channel/events and updates the UI

### `useOperationProgress` Hook (`src/hooks/use-operation-progress.ts`)

For components that need local progress state (e.g., a dialog showing live steps), use this hook:

```ts
const progress = useOperationProgress({
  channel: Channel.TLS,
  startedEvent: ServerEvent.CERT_ISSUANCE_STARTED,
  stepEvent: ServerEvent.CERT_ISSUANCE_STEP,
  completedEvent: ServerEvent.CERT_ISSUANCE_COMPLETED,
  operationId,
  getOperationId: (p) => p.operationId,
  getTotalSteps: (p) => p.totalSteps,
  getStep: (p) => p.step,
  getResult: (p) => ({ success: p.success, steps: p.steps, errors: p.errors }),
  tracker: { type: 'cert-issuance', label: 'Issuing certificate' },  // optional: register with global tracker
  invalidateKeys: [['certificates']],
  toasts: { success: 'Certificate issued', error: 'Certificate issuance failed' },
  timeoutMs: 300000,  // 5 min default
});
```

Returns `{ phase, steps, totalSteps, errors, completedCount }`.

| Do this | Not this | Why |
|---------|----------|-----|
| Use `useOperationProgress` | Manual socket listeners + local state | Hook handles subscription, cleanup, timeout, query invalidation, and toast |
| Register with global tracker via `tracker` option | Only tracking locally | Global tracker persists across navigation and page reloads |
| Use `Channel.*` and `ServerEvent.*` constants | Raw strings | Type-safe, matches server-side constants |

### Task Tracker Behaviors

- **Session persistence** — active tasks survive page reloads via `sessionStorage`
- **Auto-dismiss** — completed tasks clear after 5 minutes
- **Restored task timeout** — tasks restored from `sessionStorage` timeout after 30 seconds if no events arrive
- **Operation timeout** — `useOperationProgress` defaults to 5-minute timeout, then transitions to error state

## Data Fetching with Socket.IO

| Do this | Not this | Why |
|---------|----------|-----|
| Disable polling when socket connected | Always polling | Socket events invalidate TanStack Query caches in real-time |
| `useSocketChannel()` to subscribe on mount | Manual `socket.emit('subscribe')` | Hook handles subscribe/unsubscribe lifecycle |
| `useSocketEvent()` to listen and invalidate | Manual event listeners | Hook handles cleanup and integrates with query invalidation |
| `refetchOnReconnect: true` | Manual reconnect handling | Catches any events missed during disconnection |

Reference pattern: `src/hooks/useContainers.ts`
