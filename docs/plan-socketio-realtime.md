# Socket.IO Real-Time Push Migration Plan

## Overview

Replace polling-based data fetching with Socket.IO push-based events. The frontend currently polls the API at various intervals (2-60s) using TanStack Query `refetchInterval`. Socket.IO will push updates from the server when state changes, eliminating unnecessary network traffic and reducing latency.

## Architecture

### Type Safety Strategy

All socket event definitions live in the shared types package (`@mini-infra/types` in `lib/types/socket-events.ts`). Both server and client import these types, so TypeScript enforces that every `.emit()` and `.on()` call uses the correct event name and payload shape — a typo or wrong payload is a compile error on both sides.

Four interfaces following Socket.IO v4 conventions:
- **`ServerToClientEvents`** — events the server pushes to clients
- **`ClientToServerEvents`** — events clients send to the server (subscribe/unsubscribe)
- **`InterServerEvents`** — empty (single-server deployment)
- **`SocketData`** — per-socket data populated by auth middleware

### Room-Based Scoping

Clients subscribe to rooms matching what they're viewing. The server emits to rooms when state changes, so only interested clients receive updates.

| Room Pattern | Purpose | Replaces Polling | Status |
|---|---|---|---|
| `containers` | Container list updates | 5s refetchInterval in `useContainers` | **Done** |
| `container:{id}` | Single container status + logs | SSE log stream + per-container polling | Partial (status done, logs still SSE) |
| `deployments` | Active deployment list | 5-15s in `use-deployment-history` | **Done** |
| `deployment:{id}` | Deployment progress & steps | 2-10s adaptive in `use-deployment-status` | **Done** |
| `removal:{id}` | Removal operation progress | 2-5s adaptive in `use-removal-status` | **Done** |
| `postgres` | Backup/restore operations | 2-30s in `use-postgres-progress` | **Done** |
| `monitoring` | Monitoring stack status | 15s in `use-monitoring` | **Done** (via stacks+containers channels) |
| `events` | User events feed | 5s adaptive in `use-events` | **Done** |
| `connectivity` | Service health status | 30s in `use-settings` | **Done** |
| `logs` | Centralized Loki log tailing | 2s conditional in `use-loki-logs` | Not started |
| `stacks` | Stack status updates | 5s in `use-stacks` | **Done** (apply/destroy operations) |
| `volumes` | Volume list and inspection | 5s + 2s adaptive in `use-volumes` | **Done** |
| `networks` | Network list updates | 5s in `use-networks` | **Done** |
| `backup-health` | Self-backup health | 60s in `use-self-backup` | **Done** |

### Channel Type Safety

Room/channel names are typed with template literal types:

```typescript
type SocketChannel =
  | 'containers' | 'deployments' | 'postgres' | 'monitoring'
  | 'events' | 'connectivity' | 'logs' | 'stacks'
  | 'volumes' | 'networks' | 'backup-health'
  | `container:${string}`
  | `deployment:${string}`
  | `removal:${string}`;
```

This ensures `subscribe`/`unsubscribe` calls can only use valid patterns.

### Integration Points

**Server (`server/src/server.ts`):**
- Extract `http.Server` from `app.listen()` → use `createServer(app)` + `httpServer.listen()`
- Attach Socket.IO to the HTTP server
- Auth middleware validates JWT/session on connection
- Services emit to rooms when state changes

**Client:**
- `useSocket` hook manages connection lifecycle, auth, reconnection
- `useSocketEvent` hook bridges socket events into TanStack Query cache
- Initial data load remains HTTP GET (useQuery), subsequent updates pushed via socket
- TanStack Query stays as the cache/state layer — socket events call `queryClient.setQueryData()`

### Migration Strategy — Hybrid Approach

Each domain migrates independently. During migration, both polling and socket push coexist:

1. Socket event received → invalidates TanStack Query cache (triggers refetch)
2. Polling disabled when socket is connected (`refetchInterval: false`)
3. Polling re-enabled as fallback when socket disconnects

## Implementation Steps

### Phase 1: Foundation (steps 1-4) — COMPLETE

1. **Add `socket-events.ts` to `lib/types/`** — all event interfaces, channel types
2. **Install packages** — `socket.io` (server), `socket.io-client` (client)
3. **Wire up server** — attach to httpServer, auth middleware, room management, export `getIO()` accessor
4. **Create client hooks** — `useSocket` (connection), `useSocketEvent` (cache bridge), `useSocketChannel` (room subscription)

### Phase 2: First Domain Migration — COMPLETE

5. **Migrate containers** — server emits `containers:list` on Docker state change via `container-socket-emitter.ts`, client invalidates query cache
6. **Migrate container logs** — *not yet done* (still uses SSE via EventSource)

### Phase 3: Remaining Domains — COMPLETE

7. **Deployments** — server emits `deployment:status`, `deployment:completed`, `removal:status` from `deployment-orchestrator.ts`; client hooks `use-deployment-status`, `use-deployment-history`, `use-removal-status` migrated
8. **Postgres operations** — server emits `postgres:operation`, `postgres:operation:completed` from `backup-executor.ts` and `restore-executor/db-operations.ts`; client hook `use-postgres-progress` migrated
9. **Events** — server emits `event:created`, `event:updated` from `user-event-service.ts`; client hook `use-events` migrated
10. **Connectivity** — server emits `connectivity:all` from `connectivity-socket-emitter.ts`; client hook `use-settings` migrated
11. **Monitoring** — client hook `use-monitoring` subscribes to `stacks` + `containers` channels (no dedicated emitter needed; monitoring status derived from stack/container state)
12. **Stacks** — server emits `stack:apply:*`, `stack:destroy:*` from `stacks.ts` routes; client hook `use-stacks` migrated
13. **Volumes** — server emits `volumes:list` from `container-socket-emitter.ts` (piggybacks on Docker events); client hook `use-volumes` migrated
14. **Networks** — server emits `networks:list` from `container-socket-emitter.ts` (piggybacks on Docker events); client hook `use-networks` migrated
15. **Backup health** — server emits `backup-health:status` from `backup-health-socket-emitter.ts`; client hook `use-self-backup` migrated

### Phase 4: Cleanup — REMAINING

16. **Replace SSE container logs** — replace EventSource in `use-container-logs.ts` with Socket.IO events on `container:{id}` room (types already defined: `container:log`, `container:log:end`, `container:log:error`)
17. **Replace SSE Loki log tailing** — implement `logs:entries` push via Socket.IO on `logs` channel
18. **Lower-priority hooks** — some hooks still use polling but are low-frequency or config-based (e.g., `use-deployment-configs`, `use-haproxy-backends`, `use-auth-status`). These don't benefit much from socket push since their data rarely changes.
19. **Prometheus queries** — `usePrometheusQuery` and `usePrometheusRangeQuery` remain on polling (time-series data with no discrete change events)

## Server Emitter Reference

| Emitter File | Channel(s) | Events Emitted |
|---|---|---|
| `container-socket-emitter.ts` | `containers`, `volumes`, `networks` | `containers:list`, `volumes:list`, `networks:list` |
| `connectivity-socket-emitter.ts` | `connectivity` | `connectivity:all` |
| `backup-health-socket-emitter.ts` | `backup-health` | `backup-health:status` |
| `deployment-orchestrator.ts` | `deployments`, `deployment:{id}`, `removal:{id}` | `deployment:status`, `deployment:completed`, `removal:status` |
| `backup-executor.ts` | `postgres` | `postgres:operation`, `postgres:operation:completed` |
| `restore-executor/db-operations.ts` | `postgres` | `postgres:operation`, `postgres:operation:completed` |
| `user-event-service.ts` | `events` | `event:created`, `event:updated` |
| `routes/stacks.ts` (inline) | `stacks` | `stack:apply:started`, `stack:apply:service-result`, `stack:apply:completed`, `stack:destroy:started`, `stack:destroy:completed` |
| `routes/environments.ts` (inline) | `haproxy` | `migration:started`, `migration:step`, `migration:completed` |
| `routes/tls-certificates.ts` (inline) | `tls` | `cert:issuance:started`, `cert:issuance:step`, `cert:issuance:completed` |
| `routes/manual-haproxy-frontends.ts` (inline) | `haproxy` | `frontend:setup:started`, `frontend:setup:step`, `frontend:setup:completed` |
