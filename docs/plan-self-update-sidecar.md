# Self-Update via Sidecar Container

**Issue:** #108
**Branch:** `feature/self-update-sidecar`

## Architecture Overview

The self-update system has two components: a lightweight **sidecar** Node.js app that performs the actual container swap, and **integration points** in the existing Mini Infra server + client.

```
┌─────────────────────┐          ┌──────────────────────┐
│   Mini Infra (main) │          │   Sidecar Container   │
│                     │  docker  │                       │
│  1. User clicks     │  socket  │  3. Pull new image    │
│     "Update"        │──mount──▶│  4. Inspect old cont  │
│  2. Launch sidecar  │          │  5. Stop old cont     │
│                     │          │  6. Create new cont   │
│  (goes down here)   │          │  7. Health-check new  │
│                     │          │  8. Rollback if fail  │
└─────────────────────┘          │  9. Exit / cleanup    │
                                 └──────────────────────┘
```

## Security Considerations

| Concern | Mitigation |
|---|---|
| **Docker socket access** | Both containers already need it; sidecar runs as read-only filesystem with `--read-only` flag except for temp dirs |
| **Sidecar image trust** | Sidecar image is built from the same repo and tagged alongside the main image. The main app only launches its own matching sidecar image (e.g. `mini-infra-sidecar:<same-version>`) — never an arbitrary image |
| **Env var leakage** | Sidecar receives only the container ID to inspect — it reads settings from the Docker API inspection, never from user input. Sensitive env vars are copied container-to-container via Docker API, not passed through the update trigger |
| **Arbitrary image pull** | Validate the target tag against an allowlist pattern (e.g. must match `ghcr.io/mrgeoffrich/mini-infra:*` or a configurable registry prefix stored in settings). Reject tags that don't match |
| **Race conditions** | Use Docker container labels (`mini-infra.update-lock=<timestamp>`) to prevent concurrent updates. Sidecar checks for this label before proceeding |
| **Permission gating** | New permission scope `settings:write` required to trigger updates (reuses existing settings domain — admins only) |
| **Rollback integrity** | Old image is not removed until the new container passes health checks. Rollback recreates from the old image with the same inspected settings |
| **Sidecar cleanup** | Sidecar sets `--rm` flag on itself so it's removed after exit. A cleanup job on Mini Infra startup also removes any orphaned sidecar containers |

## Component 1: `sidecar/` Workspace Package

New npm workspace: `sidecar/` with its own `package.json`, `tsconfig.json`, and `Dockerfile`.

**Dependencies:** `dockerode`, `pino` (minimal — no Express, no Prisma).

**Entry point:** `sidecar/src/index.ts`

### Input (environment variables)

Passed when the main app launches the sidecar container:

| Variable | Description | Example |
|---|---|---|
| `TARGET_IMAGE` | Fully qualified image ref | `ghcr.io/mrgeoffrich/mini-infra:v2.1.0` |
| `CONTAINER_ID` | Container ID of the running Mini Infra instance to replace | `abc123...` |
| `HEALTH_CHECK_URL` | URL to poll after the new container starts | `http://host.docker.internal:5005/api/health` |
| `HEALTH_CHECK_TIMEOUT_MS` | Max time to wait for health (default 60000) | `60000` |
| `STATUS_FILE` | Path to a shared volume file for progress reporting | `/status/update-status.json` |

### Update Algorithm

```
1.  Write status: "pulling"
2.  docker.pull(TARGET_IMAGE)
3.  Write status: "inspecting"
4.  inspectResult = docker.inspect(CONTAINER_ID)
5.  Extract: env, volumes, binds, ports, network, restart policy, labels
6.  Remove update-lock label from extracted labels
7.  Write status: "stopping"
8.  docker.stop(CONTAINER_ID, { t: 30 })  // 30s graceful shutdown
9.  docker.rename(CONTAINER_ID, `${name}-old-${timestamp}`)
10. Write status: "creating"
11. newContainer = docker.createContainer({ ...extractedSettings, Image: TARGET_IMAGE })
12. newContainer.start()
13. Write status: "health-checking"
14. Poll HEALTH_CHECK_URL for up to HEALTH_CHECK_TIMEOUT_MS
15. If healthy:
      Write status: "complete"
      docker.remove(old container)
      exit 0
16. If unhealthy (ROLLBACK):
      Write status: "rolling-back"
      docker.stop(newContainer)
      docker.remove(newContainer)
      docker.rename(old, original name)
      docker.start(old)
      Write status: "rollback-complete"
      exit 1
```

### Sidecar Dockerfile

`sidecar/Dockerfile`:

```dockerfile
FROM node:24-alpine
RUN apk add --no-cache dumb-init
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
USER node
ENTRYPOINT ["dumb-init", "node", "dist/index.js"]
```

## Component 2: Server API

**New route file:** `server/src/routes/self-update.ts`

### Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/self-update/status` | `settings:read` | Current update status (idle, in-progress, result of last update) |
| `POST` | `/api/self-update/check` | `settings:read` | Check for available updates (inspect remote registry for newer tags) |
| `POST` | `/api/self-update/trigger` | `settings:write` | Trigger an update to a specified tag |

### Trigger Request Body

```typescript
{
  targetTag: string;  // e.g. "v2.1.0" or "latest"
}
```

### Trigger Logic

1. Validate `targetTag` against the configured allowed registry pattern
2. Check no update is already in progress (check for running sidecar container or lock label)
3. Resolve the full image ref: `${configuredRegistry}:${targetTag}`
4. Determine the sidecar image to use: `${configuredSidecarImage}:${currentVersion}`
5. Create a temporary Docker volume for status file sharing
6. Launch sidecar container via Dockerode:

```typescript
docker.createContainer({
  Image: sidecarImage,
  Env: [
    `TARGET_IMAGE=${fullImageRef}`,
    `CONTAINER_ID=${ownContainerId}`,
    `HEALTH_CHECK_URL=http://host.docker.internal:5005/api/health`,
    `HEALTH_CHECK_TIMEOUT_MS=60000`,
    `STATUS_FILE=/status/update-status.json`,
  ],
  HostConfig: {
    Binds: ['/var/run/docker.sock:/var/run/docker.sock:ro'],
    AutoRemove: true,
    ReadonlyRootfs: true,
    Tmpfs: { '/tmp': 'rw,noexec,nosuid' },
  },
  Volumes: { '/status': {} },
});
```

7. Add `mini-infra.update-lock` label to self
8. Return `202 Accepted` with status polling URL
9. Begin emitting progress to Socket.IO channel before shutdown

### Self-Identification

The server reads its own container ID from `/proc/1/cpuset` or the `HOSTNAME` env var (standard Docker behavior).

## Component 3: Socket.IO Integration

New channel and events in `lib/types/socket-events.ts`:

```typescript
// Channel
SELF_UPDATE = 'self-update'

// Server events
SELF_UPDATE_STATUS = 'self-update:status'
```

### Status Payload Type

```typescript
interface SelfUpdateStatus {
  state:
    | 'idle'
    | 'checking'
    | 'pulling'
    | 'inspecting'
    | 'stopping'
    | 'creating'
    | 'health-checking'
    | 'complete'
    | 'rolling-back'
    | 'rollback-complete'
    | 'failed';
  targetTag?: string;
  progress?: number; // 0-100 for image pull progress
  error?: string;
  startedAt?: string;
}
```

The server polls the shared status file from the sidecar volume and emits status events until it shuts down. After the new container comes up, it can read the final status from the same volume.

## Component 4: Frontend UI

**New page/section:** Settings > System Update (or a dedicated update page)

### Components

- **Current version display** — reads from existing version endpoint
- **Check for updates button** — calls `POST /api/self-update/check`
- **Available update card** — shows new tag, changelog link if available
- **Update button** — confirmation dialog ("This will restart Mini Infra"), then calls trigger endpoint
- **Progress display** — subscribes to `self-update` Socket.IO channel, shows step-by-step progress
- **Reconnection handling** — after the container restarts, the frontend loses the socket. Use the existing reconnection logic; on reconnect, fetch `/api/self-update/status` to show the result

## Component 5: Startup Cleanup

In `server/src/server.ts`, add to the startup sequence (after Docker service init):

```typescript
// Clean up any orphaned sidecar containers from previous updates
await cleanupOrphanedSidecars(dockerService);
// Clean up shared status volumes
await cleanupUpdateStatusVolumes(dockerService);
// Read last update result if available
await recordUpdateResult();
```

## New Files Summary

```
sidecar/
├── package.json
├── tsconfig.json
├── Dockerfile
└── src/
    ├── index.ts              # Entry point - orchestrates update
    ├── container-inspector.ts # Extracts settings from running container
    ├── health-checker.ts      # Polls health endpoint
    └── status-reporter.ts     # Writes status to shared file

server/src/
├── routes/self-update.ts          # API endpoints
├── services/self-update.ts        # Service: launch sidecar, read status

client/src/
├── pages/settings/system-update.tsx   # Update UI page
├── hooks/useSelfUpdate.ts             # Query + socket hooks

lib/types/
└── socket-events.ts                   # (modified) Add self-update channel/events
└── permissions.ts                     # (modified) Document settings:write covers updates
```

## Build & Release

The CI pipeline builds both images:

- `ghcr.io/mrgeoffrich/mini-infra:<tag>` (main app, existing)
- `ghcr.io/mrgeoffrich/mini-infra-sidecar:<tag>` (new, same tag)

The main app's Dockerfile `ARG` bakes in the matching sidecar image tag at build time so it always launches the correct sidecar version.
