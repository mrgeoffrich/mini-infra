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

| Room Pattern | Purpose | Replaces Polling |
|---|---|---|
| `containers` | Container list updates | 5s refetchInterval in `useContainers` |
| `container:{id}` | Single container status + logs | SSE log stream + per-container polling |
| `deployments` | Active deployment list | 5-15s in `use-deployment-history` |
| `deployment:{id}` | Deployment progress & steps | 2-10s adaptive in `use-deployment-status` |
| `removal:{id}` | Removal operation progress | 2-5s adaptive in `use-removal-status` |
| `postgres` | Backup/restore operations | 2-30s in `use-postgres-progress` |
| `monitoring` | Monitoring stack status | 15s in `use-monitoring` |
| `events` | User events feed | 5s adaptive in `use-events` |
| `connectivity` | Service health status | 30s in `use-settings` |
| `logs` | Centralized Loki log tailing | 2s conditional in `use-loki-logs` |
| `stacks` | Stack status updates | 5s in `use-stacks` |
| `volumes` | Volume list and inspection | 5s + 2s adaptive in `use-volumes` |
| `networks` | Network list updates | 5s in `use-networks` |
| `backup-health` | Self-backup health | 60s in `use-self-backup` |

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

1. Socket event received → updates TanStack Query cache immediately
2. Polling interval increased (e.g., 5s → 60s) as a fallback safety net
3. Once stable, polling can be removed entirely per domain

## Implementation Steps

### Phase 1: Foundation (steps 1-4)
1. **Add `socket-events.ts` to `lib/types/`** — all event interfaces, channel types
2. **Install packages** — `socket.io` (server), `socket.io-client` (client)
3. **Wire up server** — attach to httpServer, auth middleware, room management, export `getIO()` accessor
4. **Create client hooks** — `useSocket` (connection), `useSocketEvent` (cache bridge)

### Phase 2: First Domain Migration
5. **Migrate containers** — server emits `containers:updated` on Docker state change, client updates query cache
6. **Migrate container logs** — replace SSE with socket events on `container:{id}` room

### Phase 3: Remaining Domains
7. Deployments (status, history, removal)
8. Postgres operations (backup, restore progress)
9. Events, connectivity, monitoring
10. Stacks, volumes, networks, backup health

### Phase 4: Cleanup
11. Remove SSE endpoints (container logs, agent sessions)
12. Remove or reduce polling intervals across all hooks
13. Update tests
