# Agent Sidecar — AI Operations Assistant

> **Status**: Phases 1–4 complete. Phase 5 (polish/docs) is not yet started.

## Overview

A persistent sidecar container running the Anthropic Messages API in a manual agentic tool_use loop that acts as an autonomous AI operations assistant for Mini Infra. It has full access to application documentation, Docker, GitHub CLI, and curl, enabling it to diagnose issues, perform infrastructure tasks, and answer questions about the system — all isolated from the main application process.

Unlike the self-update sidecar (ephemeral, fire-and-forget), the agent sidecar is **long-lived** — provisioned at startup and kept running alongside the main container.

```
┌─────────────────────────────┐         ┌───────────────────────────────┐
│     Mini Infra (main)       │         │     Agent Sidecar             │
│                             │  HTTP   │                               │
│  Frontend ──▶ API ──────────│────────▶│  Express API                  │
│                             │  SSE    │    ├── POST /tasks            │
│  Task UI  ◀─────────────────│◀────────│    ├── GET  /tasks            │
│                             │         │    ├── GET  /tasks/:id        │
│                             │         │    ├── GET  /tasks/:id/stream │
│  Settings ──▶ API ──────────│────▶    │    ├── POST /tasks/:id/cancel │
│                             │         │    └── GET  /health           │
│                             │         │                               │
│  Routes:                    │         │  Anthropic Messages API       │
│   /api/agent-sidecar/*      │         │    ├── System prompt + docs   │
│                             │         │    ├── Tool: bash (docker/gh) │
│                             │         │    ├── Tool: mini_infra_api   │
│                             │         │    ├── Tool: read_file        │
│                             │         │    ├── Tool: write_file       │
│                             │         │    ├── Tool: list_docs        │
│                             │         │    └── Tool: read_doc         │
│                             │  docker │                               │
│                             │  socket │  Mounted:                     │
│                             │         │    ├── /var/run/docker.sock   │
│                             │         │    ├── /app/docs/ (user-docs) │
│                             │         │    └── /app/.claude/          │
└─────────────────────────────┘         └───────────────────────────────┘
        ▲                                          │
        │              Docker Network              │
        └──────────── (shared network) ────────────┘
```

## Motivation

- **Isolation**: The agent process can consume significant memory/CPU running API calls and tool execution. Isolating it prevents resource contention with the main app.
- **Security boundary**: The agent needs Docker socket access and shell execution capabilities. Running these in a separate container limits blast radius.
- **Independent lifecycle**: The agent sidecar can be restarted, upgraded, or scaled without affecting the main application.
- **Clean tooling**: The sidecar image can include tools (Docker CLI, gh, curl) without bloating the main image.

## Security Considerations

| Concern | Mitigation |
|---|---|
| **Docker socket access** | Mounted read-write (agent needs to manage containers), but agent actions are audited via task logs |
| **API key for Mini Infra** | Sidecar receives `MINI_INFRA_API_KEY` via env var — passed from `API_KEY_SECRET`. Key is generated on container creation |
| **Agent autonomy limits** | System prompt constrains destructive actions. Bash tool has blocked command patterns (rm -rf, docker system prune, force push, mkfs, dd, etc.) |
| **Network exposure** | Sidecar listens only on the Docker network (no host port binding). Only the main container can reach it |
| **Secret isolation** | Sidecar only receives the env vars it needs (Anthropic API key, Mini Infra API key, sidecar auth token). No database credentials, no OAuth secrets |
| **Resource limits** | Container runs with 512MB memory limit, 256 CPU shares, no swap |
| **Anthropic API key** | Passed via environment variable. Never logged, never included in task responses |
| **Inter-container auth** | Bearer token (`SIDECAR_AUTH_TOKEN`) generated via `crypto.randomBytes(32)` on each container creation |

## Implementation Status

### Phase 1: Sidecar Foundation ✅

- `agent-sidecar/` workspace with package.json and tsconfig.json
- Express 5 server with health endpoint (unauthenticated for Docker health checks)
- In-memory task store with state machine enforcement
- Task API routes (CRUD + SSE streaming)
- Bearer token authentication middleware
- Pino structured logging
- Dockerfile with multi-stage build

### Phase 2: Agent SDK Integration ✅

- System prompt assembly from baked-in `/app/docs/` directory (YAML frontmatter parsing)
- 6 tool definitions with Anthropic tool_use format
- Tool execution with safety checks (blocked command patterns)
- Agent runner loop with SSE event emission
- Cancellation via AbortController
- Timeout enforcement
- Token usage tracking

### Phase 3: Main App Integration ✅

- `AgentTask` Prisma model + migration
- `agent-sidecar.ts` provisioning service (discover, create, health check, remove)
- `ensureAgentSidecar()` called at startup in `server.ts`
- `stopAgentSidecarHealthChecks()` in graceful shutdown
- 9 proxy routes at `/api/agent-sidecar/*`
- `agent:read` / `agent:write` permissions
- Agent sidecar configuration via `SystemSettings` (category: `agent-sidecar`)
- CI/CD: agent sidecar image built and pushed in `docker-build.yml`
- `AGENT_SIDECAR_IMAGE_TAG` baked into main Dockerfile

### Phase 4: Frontend ✅

- TanStack Query hooks + SSE stream hook (`client/src/hooks/use-agent-sidecar.ts`)
- Agent tasks list page with submit form (`client/src/app/agent-tasks/page.tsx`)
- Task detail page with live SSE streaming (`client/src/app/agent-tasks/[id]/page.tsx`)
- Sidecar settings page with status & config (`client/src/app/settings/agent-sidecar/page.tsx`)
- Status badge, status banner, and stream viewer components
- Routes registered in `route-config.ts` and `routes.tsx` under "Administration"

## Component 1: `agent-sidecar/` Workspace Package

Workspace at `agent-sidecar/` registered in root `package.json` workspaces.

### Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.52.0",
    "express": "^5.2.1",
    "pino": "^9.9.0",
    "pino-pretty": "^13.1.1",
    "uuid": "^11.1.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.3",
    "@types/node": "^22.16.0",
    "@types/uuid": "^10.0.0",
    "tsx": "^4.21.0",
    "typescript": "^5.1.6"
  }
}
```

> Note: Uses Zod v3 (not v4 like the main server) since this is a standalone package.

### Source Structure

```
agent-sidecar/
├── Dockerfile
├── package.json
├── package-lock.json      # Standalone lock file for Docker npm ci
├── tsconfig.json
└── src/
    ├── index.ts              # Express server entry point
    ├── logger.ts             # Pino logging setup
    ├── types.ts              # Task types, API shapes, SSE event types
    ├── task-store.ts         # In-memory task state management
    ├── middleware/
    │   └── auth.ts           # Bearer token auth middleware
    ├── routes/
    │   ├── tasks.ts          # Task CRUD + SSE streaming endpoints
    │   └── health.ts         # Health check endpoint (unauthenticated)
    └── agent/
        ├── runner.ts         # Agentic loop (Anthropic Messages API)
        ├── system-prompt.ts  # System prompt assembly (docs scanning)
        └── tools.ts          # Tool definitions + execution + safety
```

### Dockerfile

Build context is the **repo root** (not the agent-sidecar directory):

```dockerfile
# Build: docker build -f agent-sidecar/Dockerfile .
FROM node:24-alpine AS builder
WORKDIR /app
COPY agent-sidecar/package*.json ./
RUN npm ci
COPY agent-sidecar/tsconfig.json ./
COPY agent-sidecar/src/ ./src/
RUN npm run build

FROM node:24-alpine AS production
RUN apk add --no-cache dumb-init docker-cli github-cli curl git bash
WORKDIR /app
COPY agent-sidecar/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ ./dist/

# Documentation and .claude context baked in at build time from repo root
COPY client/src/user-docs/ /app/docs/
COPY .claude/ /app/.claude/

RUN mkdir -p /tmp/agent-work && chown -R node:node /app /tmp/agent-work
USER node
ENV NODE_ENV=production
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3100/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
```

### Environment Variables

| Variable | Required | Description | Example |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | API key for Anthropic Messages API | `sk-ant-...` |
| `MINI_INFRA_API_URL` | Yes | Main app internal URL (set automatically by provisioner) | `http://mini-infra:5005` |
| `MINI_INFRA_API_KEY` | Yes | Internal API key for calling main app (`API_KEY_SECRET`) | `mi-...` |
| `SIDECAR_AUTH_TOKEN` | Yes | Bearer token for authenticating requests to sidecar | (auto-generated) |
| `PORT` | No | Sidecar listen port (default 3100) | `3100` |
| `LOG_LEVEL` | No | Pino log level (default "info") | `debug` |
| `AGENT_MODEL` | No | Claude model to use (default `claude-sonnet-4-6`) | `claude-sonnet-4-6` |
| `AGENT_MAX_TURNS` | No | Max agent turns per task (default 50) | `50` |
| `AGENT_TIMEOUT_MS` | No | Task timeout in ms (default 300000 / 5min) | `300000` |

## Component 2: Task Store & State Machine

### Task Status State Machine

```
(created) --> running --> completed
                |   |
                |   +--> failed
                |   |
                |   +--> timeout
                |
                +------> cancelled
```

- `running` is the initial state set at creation time
- Terminal states: `completed`, `failed`, `cancelled`, `timeout`
- Only transitions from `running` to terminal states are allowed

### TaskStore (`task-store.ts`)

- **Map-based storage**: `Map<string, Task>` keyed by task ID
- **EventEmitter per task**: Each task gets its own `EventEmitter` for SSE streaming
- **Max 50 tasks**: Oldest terminal tasks are evicted when limit is reached
- **Max 5 concurrent**: `canAcceptTask()` checks active task count; overflow returns 429
- **Tool call recording**: `addToolCall()` appends to task's `toolCalls` array
- **Token usage tracking**: `updateTokenUsage()` updates cumulative usage

### Task API Endpoints (Sidecar)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/tasks` | Bearer token | Create and start a new agent task |
| `GET` | `/tasks` | Bearer token | List recent tasks (in-memory) |
| `GET` | `/tasks/:id` | Bearer token | Get task status/result |
| `GET` | `/tasks/:id/stream` | Bearer token | SSE stream of agent progress |
| `POST` | `/tasks/:id/cancel` | Bearer token | Cancel a running task |
| `GET` | `/health` | None | Health check (unauthenticated) |

### SSE Event Types

| Event | Data | When |
|---|---|---|
| `status` | `{ status, message }` | Task starts |
| `tool_call` | `{ tool, input }` | Before tool execution |
| `tool_result` | `{ tool, summary }` | After tool execution |
| `text` | `{ content }` | Agent produces text |
| `complete` | `{ status: "completed", result }` | Task completes |
| `error` | `{ status: "failed"\|"timeout", error }` | Task fails or times out |

SSE stream includes heartbeat comments (`: heartbeat`) every 15 seconds to keep connections alive.

## Component 3: Agent Integration

Uses the **Anthropic Messages API** (`@anthropic-ai/sdk`) with a manual agentic tool_use loop (not the Agent SDK convenience layer).

### System Prompt Assembly (`system-prompt.ts`)

The system prompt is assembled at startup and cached. It scans `/app/docs/` for Markdown files, parses YAML frontmatter for metadata (title, description, category, order), and builds a categorized table of contents.

Prompt sections:
1. **CORE_IDENTITY** — Role, capabilities, access description
2. **Documentation Index** — Auto-generated from baked-in docs with `read_doc` tool references
3. **TOOL_USAGE_GUIDELINES** — When to use bash vs mini_infra_api vs read_doc
4. **SAFETY_RULES** — Forbidden operations and caution guidelines
5. **API_REFERENCE** — Mini Infra REST endpoints the agent can call

### Tool Definitions

6 tools defined in Anthropic `tool_use` format:

| Tool | Description | Safety |
|---|---|---|
| `bash` | Execute shell commands (docker, gh, curl, etc.) | Blocked patterns, 30s default timeout (max 120s), 1MB buffer, `/tmp/agent-work/` cwd |
| `mini_infra_api` | Call Mini Infra REST API with auto-auth | 30s timeout, auto-injects `x-api-key` header |
| `read_file` | Read any accessible file | Path traversal (`..`) blocked, 500 line default limit |
| `write_file` | Write files to `/tmp/agent-work/` only | Path sandboxed — resolved path must start with `/tmp/agent-work/` |
| `list_docs` | List documentation files | Optional category filter, recursive walk |
| `read_doc` | Read a specific documentation file | Path sandboxed to docs directory |

### Blocked Command Patterns

```
rm -rf /                    docker system prune
docker volume rm            docker container prune
docker image prune -a       mkfs
dd if=                      > /dev/
chmod .../docker.sock       kill -9 1
shutdown                    reboot
git push --force            git push -f
```

### Agent Runner (`runner.ts`)

- Creates `Anthropic` client per task
- Iterates messages/tool_use cycles until `stop_reason === "end_turn"` or max turns
- **Cancellation**: Module-level `Map<string, AbortController>` — `cancelTask(taskId)` aborts the controller
- **Timeout**: `setTimeout` triggers `AbortController.abort()` after `AGENT_TIMEOUT_MS`
- **SSE emission**: Emits events via `TaskStore.emitSSE()` for each text block, tool call, tool result, completion, and error
- **Token usage**: Accumulates `input_tokens` and `output_tokens` across all turns
- **Error handling**: Distinguishes timeout (AbortController aborted + removed from map) from user cancellation (AbortController aborted + still in map)

### Concurrency

- Max 5 concurrent running tasks (configurable via `MAX_QUEUE_DEPTH` in task-store)
- Overflow returns `429 Too Many Requests`
- Max 50 tasks retained in memory (terminal tasks evicted LRU)

## Component 4: Provisioning (Main App)

### Service: `server/src/services/agent-sidecar.ts`

Module-level state:
- `sidecarUrl: string | null` — URL for HTTP communication
- `internalToken: string | null` — Bearer token for sidecar auth
- `healthCheckInterval: NodeJS.Timeout | null` — 30-second health check timer
- `sidecarHealthy: boolean` — Last known health status

Key functions:

| Function | Description |
|---|---|
| `findAgentSidecar()` | Find existing sidecar by label `mini-infra.agent-sidecar=true` |
| `ensureAgentSidecar()` | Startup flow: discover or create sidecar container |
| `createAgentSidecar(config)` | Create new sidecar container with Docker API |
| `removeAgentSidecar()` | Stop and remove sidecar, clear module state |
| `restartAgentSidecar()` | Remove then ensure (full restart) |
| `proxyToSidecar(path, options)` | HTTP fetch helper with auto-auth header |
| `getAgentSidecarConfig()` | Read config from SystemSettings table |
| `getAgentSidecarUrl()` | Get current sidecar URL |
| `getInternalToken()` | Get current auth token |
| `isAgentSidecarHealthy()` | Get last health check result |
| `stopHealthChecks()` | Clear health check interval (for shutdown) |

### Startup Flow

```
Main App Startup (server.ts)
    │
    ▼
ensureAgentSidecar() — non-fatal on failure
    │
    ├── Not in Docker? → return null (disabled)
    ├── Disabled in settings? → return null
    ├── No image configured? → return null (warn)
    │
    ├── Found running sidecar?
    │   ├── Reconnect (recover URL, read token from env)
    │   └── Start health checks
    │
    ├── Found stopped sidecar?
    │   ├── Remove it
    │   └── Create new one
    │
    └── No sidecar found?
        └── Create new one
```

### Container Creation

```typescript
// Key container configuration
{
  Image: config.image,                          // from AGENT_SIDECAR_IMAGE_TAG or settings
  name: "mini-infra-agent-sidecar",             // predictable name
  Labels: {
    "mini-infra.agent-sidecar": "true",         // discovery label
    "mini-infra.managed": "true",
  },
  Env: [
    "ANTHROPIC_API_KEY=...",                    // from process.env
    "MINI_INFRA_API_URL=http://<main-name>:<port>",
    "MINI_INFRA_API_KEY=...",                   // from API_KEY_SECRET
    "SIDECAR_AUTH_TOKEN=...",                   // crypto.randomBytes(32)
    "PORT=3100",
    "AGENT_MODEL=...",                          // from settings
    "AGENT_MAX_TURNS=...",
    "AGENT_TIMEOUT_MS=...",
    "LOG_LEVEL=...",
  ],
  HostConfig: {
    Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
    RestartPolicy: { Name: "unless-stopped" },  // persistent
    Memory: 512 * 1024 * 1024,                  // 512MB limit
    MemorySwap: 512 * 1024 * 1024,              // no swap
    CpuShares: 256,                             // lower priority
  },
  NetworkingConfig: {
    EndpointsConfig: { [sidecarNetwork]: {} },  // same network as main
  },
}
```

Key differences from self-update sidecar:
- **`RestartPolicy: unless-stopped`** — persistent, auto-restarts on failure
- **No `AutoRemove`** — we want it to stick around
- **Memory/CPU limits** — prevent runaway agent from starving the host
- **Named container** (`mini-infra-agent-sidecar`) — predictable, not timestamped

### When Not Running in Docker

If the main app detects it's not running in Docker (development mode), `ensureAgentSidecar()` returns null and logs "Not running in Docker, agent sidecar disabled". API routes return 503 with a descriptive message.

## Component 5: Main App API Routes

Route file: `server/src/routes/agent-sidecar.ts`, registered at `/api/agent-sidecar`.

These routes proxy between the frontend and the agent sidecar, adding authentication, Zod validation, and audit logging via the `AgentTask` Prisma model.

### Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `POST` | `/api/agent-sidecar/tasks` | `agent:write` | Create a new agent task |
| `GET` | `/api/agent-sidecar/tasks` | `agent:read` | List recent tasks (from DB) |
| `GET` | `/api/agent-sidecar/tasks/:id` | `agent:read` | Get task status/result (live + DB) |
| `GET` | `/api/agent-sidecar/tasks/:id/stream` | `agent:read` | SSE stream relay from sidecar |
| `POST` | `/api/agent-sidecar/tasks/:id/cancel` | `agent:write` | Cancel a running task |
| `GET` | `/api/agent-sidecar/status` | `agent:read` | Agent sidecar health/status |
| `POST` | `/api/agent-sidecar/restart` | `agent:write` | Restart the agent sidecar |
| `GET` | `/api/agent-sidecar/config` | `settings:read` | Get agent configuration |
| `PUT` | `/api/agent-sidecar/config` | `settings:write` | Update agent configuration |

### Task Creation Flow

1. Validate request body with Zod schema (`prompt`, optional `context`)
2. Check sidecar availability (503 if not running)
3. Extract user ID from JWT
4. Proxy `POST /tasks` to sidecar with internal bearer token
5. On success, create `AgentTask` record in Prisma DB
6. Return task with both DB `id` and sidecar `externalId`

### Task Detail with Live Sync

When fetching a running task, the route:
1. Looks up the task in the DB
2. If still `running` and sidecar is available, fetches live data from sidecar
3. If sidecar reports a terminal status, syncs the result back to the DB
4. Returns the most up-to-date data

### SSE Relay

The `/tasks/:id/stream` endpoint:
1. Sets SSE headers (`Content-Type: text/event-stream`, `X-Accel-Buffering: no`)
2. Opens a fetch connection to sidecar's SSE stream with internal auth
3. Pipes chunks from sidecar `ReadableStream` to client response
4. On terminal events (`complete`/`error`), triggers fire-and-forget DB sync
5. Cleans up reader on client disconnect

## Component 6: Database Schema

`AgentTask` model in `server/prisma/schema.prisma`:

```prisma
model AgentTask {
  id           String    @id @default(cuid())
  externalId   String    // Task ID from sidecar
  prompt       String    // User's original prompt
  status       String    // running, completed, failed, cancelled, timeout
  result       String?   // Final agent response (synced from sidecar)
  errorMessage String?   // Error if failed
  tokenUsage   String?   // JSON string: { input, output }
  triggeredBy  String    // User ID
  context      String?   // JSON string: { ... }
  createdAt    DateTime  @default(now())
  completedAt  DateTime?
  durationMs   Int?
  updatedAt    DateTime  @updatedAt

  @@index([status])
  @@index([triggeredBy])
  @@index([createdAt])
  @@map("agent_tasks")
}
```

Migration: `20260311112426_add_agent_task_model`

## Component 7: Docker Build Pipeline

### CI/CD (`.github/workflows/docker-build.yml`)

The agent sidecar image is built alongside the main image and self-update sidecar in CI:

1. **Metadata step** (`agent-sidecar-meta`): generates tags using `docker/metadata-action`
2. **Build & push**: builds from `agent-sidecar/Dockerfile` with repo-root context
3. **Tag extraction** (`agent-sidecar-tag`): extracts the tag for passing to main image build
4. **Main image receives**: `AGENT_SIDECAR_IMAGE_TAG` as a build-arg, baked into the main image as an env var

### Image Tag in Main Dockerfile

```dockerfile
# In root Dockerfile
ARG AGENT_SIDECAR_IMAGE_TAG=latest
ENV AGENT_SIDECAR_IMAGE_TAG=${AGENT_SIDECAR_IMAGE_TAG}
```

The main app reads `process.env.AGENT_SIDECAR_IMAGE_TAG` to determine which agent sidecar image to launch. This can be overridden via SystemSettings.

## Component 8: Configuration

### System Settings (stored in `SystemSettings` table, category: `agent-sidecar`)

| Key | Default | Description |
|---|---|---|
| `enabled` | `false` | Enable/disable agent sidecar |
| `image` | (from `AGENT_SIDECAR_IMAGE_TAG` env) | Agent sidecar Docker image |
| `model` | `claude-sonnet-4-6` | Claude model for agent |
| `max_turns` | `50` | Max agentic turns per task |
| `timeout_ms` | `300000` | Task timeout (5 min default) |
| `auto_start` | `true` | Start sidecar on main app boot |

### Config API

- `GET /api/agent-sidecar/config` — returns `AgentSidecarConfig` object
- `PUT /api/agent-sidecar/config` — upserts individual settings via `SystemSettings.upsert()`

## Component 9: Shared Types

Types defined in `lib/types/agent.ts`:

- `AgentSidecarTaskStatus` — union of task statuses
- `AgentSidecarTaskSummary` — list view (id, externalId, status, prompt, triggeredBy, timestamps)
- `AgentSidecarTaskDetail` — extends summary with result, errorMessage, tokenUsage, context, toolCalls
- `AgentSidecarStatus` — available, containerRunning, health
- `AgentSidecarConfig` — enabled, image, model, maxTurns, timeoutMs, autoStart

### Permissions

Added to `lib/types/permissions.ts`:
- `agent:read` — view agent tasks and status
- `agent:write` — create, cancel tasks; restart sidecar
- `agent:read` added to the `ai-agent` preset

## Component 10: Frontend Integration (Phase 4 — Complete)

### Files Created

| File | Purpose |
|------|---------|
| `client/src/hooks/use-agent-sidecar.ts` | All TanStack Query hooks + SSE stream hook |
| `client/src/app/agent-tasks/page.tsx` | Task list page with submit form |
| `client/src/app/agent-tasks/[id]/page.tsx` | Task detail page with SSE streaming |
| `client/src/app/settings/agent-sidecar/page.tsx` | Sidecar settings page |
| `client/src/components/agent-sidecar/task-status-badge.tsx` | Status badge component |
| `client/src/components/agent-sidecar/task-stream-viewer.tsx` | SSE stream display component |
| `client/src/components/agent-sidecar/sidecar-status-banner.tsx` | Availability banner |

### Files Modified

| File | Change |
|------|--------|
| `client/src/lib/route-config.ts` | Added `/agent-tasks` and `/settings-agent-sidecar` entries |
| `client/src/lib/routes.tsx` | Added 3 React Router routes + page imports |

### Routes

- `/agent-tasks` — Task list with submit form and recent tasks table (nav: Administration)
- `/agent-tasks/:id` — Task detail with live SSE stream (running) or static tool call history (terminal)
- `/settings-agent-sidecar` — Sidecar status, restart, and configuration form (nav: Administration)

### React Hooks

```typescript
// Queries
useAgentSidecarStatus()      // GET /api/agent-sidecar/status — staleTime 30s, refetchInterval 30s
useAgentSidecarTasks()       // GET /api/agent-sidecar/tasks — dynamic polling: 5s if running, 30s otherwise
useAgentSidecarTask(id)      // GET /api/agent-sidecar/tasks/:id — poll 3s when running
useAgentSidecarConfig()      // GET /api/agent-sidecar/config — staleTime 5min

// Mutations
useCreateAgentSidecarTask()  // POST /tasks → invalidate tasks list
useCancelAgentSidecarTask()  // POST /tasks/:id/cancel → invalidate task + list
useUpdateAgentSidecarConfig() // PUT /config → invalidate config + status
useRestartAgentSidecar()     // POST /restart → invalidate status

// SSE
useAgentSidecarTaskStream(taskId, enabled)  // EventSource with named events
```

### Context-Aware Prompts

The task creation API accepts an optional `context` object for page-specific prompts:

```typescript
// From container detail page
createTask({
  prompt: "Why is this container using so much memory?",
  context: { containerId: "...", containerName: "nginx-prod" }
});

// From deployment page
createTask({
  prompt: "Is this deployment healthy?",
  context: { deploymentId: "...", deploymentName: "my-app" }
});
```

## Open Questions

1. **Multi-turn conversations**: Should the agent support follow-up questions on the same context? This would require maintaining conversation history in the sidecar, keyed by a session/thread ID.

2. **Pre-built prompt templates**: Should the UI offer canned prompts like "Diagnose container", "Check backup status", "Review deployment health"? These could be stored as prompt templates in the main DB.

3. **Cost controls**: Should there be per-user or per-day token budgets? The sidecar tracks token usage per task already.

4. **Approval workflows**: For destructive actions the agent wants to take (e.g., restart a container), should it pause and request user approval via the task UI before proceeding?
