# Pool Phase 4 — UI

**Parent spec:** [stack-service-pools-plan.md](stack-service-pools-plan.md). Prereq: [Phase 3](pool-phase-3-idle-reaper.md) is merged and the reaper is emitting events.

**Goal:** operators can see live pool activity and manually stop instances from the UI. No spawn UI — instances remain caller-managed.

## Work items

### 1. Stack detail page — pool service section

1.1. Locate the existing service list component on the stack detail page. Pool services currently render the same row as static services with a generic running/stopped badge. Replace the Pool row rendering with a dedicated component.

1.2. New component: `client/src/components/stacks/PoolServiceRow.tsx` (or colocated near the existing service row component, matching the codebase convention).

1.3. Row shows:
- Pool service name
- Live instance count: `{running} running, {starting} starting`
- Expand chevron (collapsed by default)

1.4. Expanded panel: table of instances with columns `instanceId`, `status`, `lastActive`, `containerId`, actions. Actions column has a single **Stop** button → calls DELETE, confirms before firing.

1.5. Data fetching:
- `useQuery` keyed on `["pool-instances", stackId, serviceName]` hitting `GET .../instances`.
- `useSocketChannel("pools")` on mount/unmount.
- `useSocketEvent` on `POOL_INSTANCE_STARTING`, `STARTED`, `FAILED`, `IDLE_STOPPED`, `STOPPED` — invalidate the query on each.
- `refetchInterval: false` while socket connected, fall back to polling only when disconnected. `refetchOnReconnect: true`.

1.6. Empty state: `No active instances` with a single-line hint about caller-driven spawning.

### 2. Containers page — pool instance filter

2.1. Locate the containers page filter UI. Add a filter chip/toggle: **Pool instances**.

2.2. When active, filter the container list to rows with the `mini-infra.pool-instance = "true"` label.

2.3. Rows render normally — existing container actions (stop, remove, logs) work without modification. Adds a small "Pool" badge in the row showing the parent stack + service.

### 3. Socket channel subscription UX

3.1. Confirm the `"pools"` channel is subscribable via the shared `useSocketChannel` hook (Phase 1 added it to `STATIC_SOCKET_CHANNELS`, so this is a no-op sanity check).

### 4. Accessibility + interaction polish

4.1. Expand/collapse chevron uses the same pattern as existing expandable service rows — keyboard accessible.

4.2. Stop button uses the existing `ConfirmDialog` (or equivalent) — never a bare alert/confirm.

4.3. Last-active column formats with `Intl.RelativeTimeFormat` (e.g. "2 min ago"), live-updating without a full re-render.

## Tests

- **Component:** `PoolServiceRow` renders correct counts from a mocked query result. Expanding reveals the instance table. Stop button fires DELETE with correct URL.
- **Component:** Container filter chip toggles the list correctly.
- **Playwright (dev instance):** manually spawn an instance via curl, verify it appears in the UI within seconds; click Stop, verify it disappears; spawn and wait for idle reap, verify row transitions to stopped then disappears on refresh.

## Definition of done

- [ ] Pool services on stack detail page show a live count + expandable instance table.
- [ ] Manual stop works and does not race the reaper.
- [ ] Containers page filter isolates pool instances.
- [ ] UI updates via socket events without polling.
- [ ] Playwright happy path green.

## Out of scope

- Spawn-from-UI button (intentional — caller-driven only).
- Streaming spawn progress via SSE (task tracker covers progress).
- Multi-host view (single host remains the mini-infra constraint).
