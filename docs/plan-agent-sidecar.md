# Agent Sidecar — AI Operations Assistant

## Overview

A persistent sidecar container running the Claude Agent SDK that acts as an autonomous AI operations assistant for Mini Infra. It has full access to application documentation, Docker, GitHub CLI, and curl, enabling it to diagnose issues, perform infrastructure tasks, and answer questions about the system — all isolated from the main application process.

Unlike the self-update sidecar (ephemeral, fire-and-forget), the agent sidecar is **long-lived** — provisioned at startup and kept running alongside the main container.

```
┌─────────────────────────────┐         ┌───────────────────────────────┐
│     Mini Infra (main)       │         │     Agent Sidecar             │
│                             │  HTTP   │                               │
│  Frontend ──▶ API ──────────│────────▶│  Express API                  │
│                             │  SSE    │    ├── POST /tasks            │
│  Task UI  ◀─────────────────│◀────────│    ├── GET  /tasks/:id        │
│                             │         │    ├── GET  /tasks/:id/stream │
│  Settings ──▶ API ──────────│────▶    │    ├── POST /tasks/:id/cancel │
│                             │         │    └── GET  /health           │
│                             │         │                               │
│                             │         │  Claude Agent SDK             │
│                             │         │    ├── System prompt + docs   │
│                             │         │    ├── Tool: docker CLI       │
│                             │         │    ├── Tool: gh CLI           │
│                             │         │    ├── Tool: curl             │
│                             │         │    ├── Tool: Mini Infra API   │
│                             │         │    └── Tool: file read/write  │
│                             │         │                               │
│                             │  docker │  Mounted:                     │
│                             │  socket │    ├── /var/run/docker.sock   │
│                             │         │    ├── /app/docs/ (user-docs) │
│                             │         │    └── /app/.claude/          │
└─────────────────────────────┘         └───────────────────────────────┘
        ▲                                          │
        │              Docker Network              │
        └──────────── (shared network) ────────────┘
```

## Motivation

- **Isolation**: The agent process can consume significant memory/CPU running the SDK. Isolating it prevents resource contention with the main app.
- **Security boundary**: The agent needs Docker socket access and shell execution capabilities. Running these in a separate container limits blast radius.
- **Independent lifecycle**: The agent sidecar can be restarted, upgraded, or scaled without affecting the main application.
- **Clean tooling**: The sidecar image can include tools (Docker CLI, gh, curl) without bloating the main image.

## Security Considerations

| Concern | Mitigation |
|---|---|
| **Docker socket access** | Mounted read-write (agent needs to manage containers), but agent actions are audited via task logs |
| **API key for Mini Infra** | Sidecar receives a dedicated internal API key via environment variable — not the user's key. Key is scoped and rotated on restart |
| **Agent autonomy limits** | System prompt constrains destructive actions (no `rm -rf`, no force-push). Dangerous operations require explicit user confirmation via the task UI |
| **Network exposure** | Sidecar listens only on the Docker network (no host port binding). Only the main container can reach it |
| **Secret isolation** | Sidecar only receives the env vars it needs (API key, Anthropic key). No database credentials, no OAuth secrets |
| **Resource limits** | Container runs with memory and CPU limits to prevent runaway agent loops from affecting the host |
| **Anthropic API key** | Passed via environment variable. Never logged, never included in task responses |

## Component 1: `agent-sidecar/` Workspace Package

New npm workspace at `agent-sidecar/` with its own `package.json`, `tsconfig.json`, and `Dockerfile`.

### Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "latest",
    "express": "^5",
    "pino": "^9",
    "pino-pretty": "^13",
    "uuid": "^11",
    "zod": "^3"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/node": "^22",
    "@types/express": "^5",
    "tsx": "^4"
  }
}
```

### Source Structure

```
agent-sidecar/
├── Dockerfile
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              # Express server entry point
    ├── routes/
    │   ├── tasks.ts          # Task CRUD + streaming endpoints
    │   └── health.ts         # Health check endpoint
    ├── agent/
    │   ├── runner.ts         # Agent SDK execution engine
    │   ├── system-prompt.ts  # System prompt assembly (loads docs)
    │   └── tools.ts          # Tool definitions for the agent
    ├── task-store.ts         # In-memory task state management
    └── logger.ts             # Pino logging setup
```

### Dockerfile

```dockerfile
FROM node:24-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ─────────────────────────────────────
FROM node:24-alpine AS production

# Tools the agent needs
RUN apk add --no-cache \
    dumb-init=1.2.5-r3 \
    docker-cli \
    github-cli \
    curl \
    git \
    bash

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Documentation and context are COPY'd at build time from the main repo
# (built as a stage in the main CI pipeline alongside the main image)
COPY docs/ /app/docs/
COPY claude-context/ /app/.claude/

RUN mkdir -p /tmp/agent-work && chown -R node:node /app /tmp/agent-work

USER node

ENV NODE_ENV=production
EXPOSE 3100

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
```

### Environment Variables

| Variable | Required | Description | Example |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | API key for Claude SDK | `sk-ant-...` |
| `MINI_INFRA_API_URL` | Yes | Main app internal URL | `http://mini-infra:5000` |
| `MINI_INFRA_API_KEY` | Yes | Internal API key for calling main app | `mi-internal-...` |
| `PORT` | No | Sidecar listen port (default 3100) | `3100` |
| `LOG_LEVEL` | No | Pino log level (default "info") | `debug` |
| `AGENT_MODEL` | No | Claude model to use (default `claude-sonnet-4-6`) | `claude-sonnet-4-6` |
| `AGENT_MAX_TURNS` | No | Max agent turns per task (default 50) | `50` |
| `AGENT_TIMEOUT_MS` | No | Task timeout in ms (default 300000 / 5min) | `300000` |

## Component 2: Task API

The sidecar exposes a lightweight REST API for task management. All endpoints are authenticated via a shared secret passed in the `Authorization: Bearer <token>` header (the main app and sidecar share this token).

### Endpoints

#### `POST /tasks`

Create and start a new agent task.

**Request:**
```json
{
  "prompt": "Why is the nginx container restarting every 5 minutes?",
  "context": {
    "containerId": "abc123",
    "containerName": "nginx-prod"
  }
}
```

**Response (201):**
```json
{
  "id": "task_01JQ...",
  "status": "running",
  "prompt": "Why is the nginx container restarting every 5 minutes?",
  "createdAt": "2026-03-11T10:00:00Z"
}
```

#### `GET /tasks/:id`

Get task status and result.

**Response (200):**
```json
{
  "id": "task_01JQ...",
  "status": "completed",
  "prompt": "Why is the nginx container restarting every 5 minutes?",
  "result": "The nginx container is restarting because...",
  "toolCalls": [
    { "tool": "docker_logs", "input": { "container": "nginx-prod", "tail": 100 }, "timestamp": "..." },
    { "tool": "docker_inspect", "input": { "container": "nginx-prod" }, "timestamp": "..." }
  ],
  "tokenUsage": { "input": 12500, "output": 3200 },
  "createdAt": "2026-03-11T10:00:00Z",
  "completedAt": "2026-03-11T10:00:45Z",
  "durationMs": 45000
}
```

Status values: `running` | `completed` | `failed` | `cancelled` | `timeout`

#### `GET /tasks/:id/stream`

Server-Sent Events stream of agent progress. The main app connects here to relay real-time progress to the frontend.

**SSE Events:**
```
event: status
data: {"status": "running", "message": "Starting analysis..."}

event: tool_call
data: {"tool": "docker_logs", "input": {"container": "nginx-prod", "tail": 100}}

event: tool_result
data: {"tool": "docker_logs", "summary": "Found OOMKilled in last 5 entries"}

event: text
data: {"content": "The container is being OOM killed. The memory limit is set to 256MB but the process is using..."}

event: complete
data: {"status": "completed", "result": "The nginx container is restarting because..."}

event: error
data: {"status": "failed", "error": "Agent exceeded maximum turns"}
```

#### `POST /tasks/:id/cancel`

Cancel a running task. The agent loop is aborted and the task is marked as cancelled.

**Response (200):**
```json
{
  "id": "task_01JQ...",
  "status": "cancelled"
}
```

#### `GET /tasks`

List recent tasks (last 50, in-memory only — not persisted across sidecar restarts).

**Response (200):**
```json
{
  "tasks": [
    { "id": "task_01JQ...", "status": "completed", "prompt": "...", "createdAt": "..." },
    { "id": "task_01JR...", "status": "running", "prompt": "...", "createdAt": "..." }
  ]
}
```

#### `GET /health`

Health check endpoint.

**Response (200):**
```json
{
  "status": "ok",
  "uptime": 3600,
  "activeTasks": 1,
  "totalTasksProcessed": 42
}
```

## Component 3: Agent SDK Integration

### System Prompt Assembly

The system prompt is assembled at startup by reading documentation files from the baked-in `/app/docs/` directory and the `.claude/` context.

```typescript
// agent/system-prompt.ts
function buildSystemPrompt(): string {
  const parts = [
    CORE_IDENTITY,           // "You are an AI operations assistant for Mini Infra..."
    loadDocsIndex(),          // Table of contents from /app/docs/
    TOOL_USAGE_GUIDELINES,    // How/when to use each tool
    SAFETY_RULES,             // What NOT to do (destructive ops, etc.)
    API_REFERENCE,            // Mini Infra API endpoints the agent can call
  ];
  return parts.join('\n\n');
}
```

The system prompt includes:
- **Identity**: What the agent is, its role, and its constraints
- **Documentation index**: Summarized user docs so the agent understands Mini Infra features
- **Tool usage guidelines**: When to use Docker CLI vs the Mini Infra API vs curl
- **Safety rules**: Explicit prohibitions (no `docker system prune`, no deleting volumes, no force-push, etc.)
- **API reference**: The main app's REST endpoints the agent can call for structured operations

### Tool Definitions

The agent has access to these tools via the Claude Agent SDK:

| Tool | Description | Implementation |
|---|---|---|
| `bash` | Execute shell commands (docker, gh, curl, etc.) | `child_process.execFile` with timeout |
| `mini_infra_api` | Call the main app's REST API | HTTP client using `MINI_INFRA_API_URL` |
| `read_file` | Read files in the agent workspace or docs | `fs.readFile` |
| `write_file` | Write files to `/tmp/agent-work/` only | `fs.writeFile` (sandboxed) |
| `list_docs` | List available documentation files | `fs.readdir` on `/app/docs/` |
| `read_doc` | Read a specific documentation file | `fs.readFile` on `/app/docs/<path>` |

### Tool Safety

```typescript
// Blocked patterns for bash tool
const BLOCKED_COMMANDS = [
  /rm\s+-rf\s+\//,           // rm -rf /
  /docker\s+system\s+prune/, // docker system prune
  /docker\s+volume\s+rm/,    // docker volume rm (without explicit container)
  /mkfs/,                     // filesystem formatting
  /dd\s+if=/,                // disk operations
  />\s*\/dev\//,             // writing to devices
];
```

Bash commands are executed with:
- A 30-second default timeout (configurable per-call)
- Working directory set to `/tmp/agent-work/`
- Blocked command pattern matching before execution
- stdout/stderr captured and returned to the agent
- Non-zero exit codes reported as tool errors (not thrown)

### Agent Runner

```typescript
// agent/runner.ts (simplified)
async function runTask(task: Task): Promise<void> {
  const client = new Anthropic();

  const messages = [{ role: 'user', content: task.prompt }];

  let turns = 0;
  while (turns < MAX_TURNS) {
    const response = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 16384,
      system: systemPrompt,
      messages,
      tools: TOOL_DEFINITIONS,
    });

    // Emit text blocks to SSE stream
    for (const block of response.content) {
      if (block.type === 'text') {
        task.emit('text', { content: block.text });
      }
    }

    // If no tool use, agent is done
    if (response.stop_reason === 'end_turn') {
      task.complete(extractFinalText(response));
      return;
    }

    // Execute tool calls
    const toolResults = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        task.emit('tool_call', { tool: block.name, input: block.input });
        const result = await executeTool(block.name, block.input);
        task.emit('tool_result', { tool: block.name, summary: summarize(result) });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
    turns++;
  }

  task.fail('Agent exceeded maximum turns');
}
```

### Concurrency

- Tasks run one at a time by default (single-threaded agent execution)
- Additional task requests while one is running are queued (max queue depth: 5)
- Queue overflow returns `429 Too Many Requests`
- This prevents runaway API costs and resource exhaustion

## Component 4: Provisioning (Main App)

The main app provisions the agent sidecar at startup, similar to how it manages the self-update sidecar.

### Service: `server/src/services/agent-sidecar.ts`

```typescript
// Key functions

/** Check if agent sidecar is already running */
async function findAgentSidecar(): Promise<Container | null>

/** Launch or reconnect to the agent sidecar */
async function ensureAgentSidecar(): Promise<{ containerId: string; url: string }>

/** Stop and remove the agent sidecar */
async function removeAgentSidecar(): Promise<void>

/** Proxy a task request to the sidecar */
async function createAgentTask(prompt: string, context?: object): Promise<Task>

/** Stream task progress from sidecar SSE */
async function streamTaskProgress(taskId: string): AsyncIterable<SSEEvent>
```

### Startup Flow

```
Main App Startup
    │
    ▼
┌─────────────────────────────────┐
│  1. Check for existing sidecar  │
│     (label: mini-infra.agent-   │
│      sidecar=true)              │
└────────────┬────────────────────┘
             │
     ┌───────┴───────┐
     │               │
  Found          Not found
     │               │
     ▼               ▼
┌──────────┐  ┌────────────────┐
│ Health    │  │ Pull image if  │
│ check it │  │ not present    │
└────┬─────┘  └───────┬────────┘
     │                │
  ┌──┴──┐            ▼
  │     │     ┌────────────────┐
 OK   Fail    │ Create & start │
  │     │     │ container      │
  │     ▼     └───────┬────────┘
  │  Remove &         │
  │  recreate ────────┘
  │                   │
  ▼                   ▼
┌─────────────────────────────────┐
│  2. Store sidecar URL in       │
│     appConfig for proxy routes  │
└─────────────────────────────────┘
```

### Container Creation

```typescript
async function createAgentSidecar(): Promise<Docker.Container> {
  const ownContainerId = await getOwnContainerId();
  const ownContainer = docker.getContainer(ownContainerId);
  const ownInfo = await ownContainer.inspect();

  // Detect network for DNS resolution
  const network = detectUserNetwork(ownInfo);

  // Generate internal auth token for sidecar <-> main communication
  const internalToken = crypto.randomBytes(32).toString('hex');
  // Store token for use in proxy requests
  await storeInternalToken(internalToken);

  const container = await docker.createContainer({
    Image: agentSidecarImage,
    name: `mini-infra-agent-sidecar`,
    Labels: {
      'mini-infra.agent-sidecar': 'true',
      'mini-infra.managed': 'true',
    },
    Env: [
      `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`,
      `MINI_INFRA_API_URL=http://${ownInfo.Name.replace('/', '')}:5000`,
      `MINI_INFRA_API_KEY=${await getInternalApiKey()}`,
      `SIDECAR_AUTH_TOKEN=${internalToken}`,
      `PORT=3100`,
      `AGENT_MODEL=${agentModel}`,
      `AGENT_MAX_TURNS=${maxTurns}`,
      `LOG_LEVEL=${process.env.LOG_LEVEL || 'info'}`,
    ],
    ExposedPorts: { '3100/tcp': {} },
    HostConfig: {
      Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: 512 * 1024 * 1024,       // 512MB limit
      MemorySwap: 512 * 1024 * 1024,   // No swap
      CpuShares: 256,                    // Lower priority than main app
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [network]: {},
      },
    },
  });

  await container.start();
  return container;
}
```

Key differences from self-update sidecar:
- **`RestartPolicy: unless-stopped`** — persistent, auto-restarts on failure
- **No `AutoRemove`** — we want it to stick around
- **Memory/CPU limits** — prevent runaway agent from starving the host
- **Named container** (`mini-infra-agent-sidecar`) — predictable, not timestamped

### When Not Running in Docker

If the main app detects it's not running in Docker (development mode), the agent sidecar features are disabled. The UI shows a message indicating the agent is only available in containerized deployments. Alternatively, a development mode could run the agent in-process for local testing.

## Component 5: Main App API Routes

New route file: `server/src/routes/agent.ts`

These routes proxy between the frontend and the agent sidecar, adding authentication and audit logging.

### Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `POST` | `/api/agent/tasks` | `agent:write` | Create a new agent task |
| `GET` | `/api/agent/tasks` | `agent:read` | List recent tasks |
| `GET` | `/api/agent/tasks/:id` | `agent:read` | Get task status/result |
| `GET` | `/api/agent/tasks/:id/stream` | `agent:read` | SSE stream of task progress |
| `POST` | `/api/agent/tasks/:id/cancel` | `agent:write` | Cancel a running task |
| `GET` | `/api/agent/status` | `agent:read` | Agent sidecar health/status |
| `POST` | `/api/agent/restart` | `agent:write` | Restart the agent sidecar |
| `GET` | `/api/agent/config` | `settings:read` | Get agent configuration |
| `PUT` | `/api/agent/config` | `settings:write` | Update agent configuration |

### Proxy Pattern

```typescript
// Simplified proxy for task creation
router.post('/tasks', requirePermission('agent:write'), async (req, res) => {
  const sidecarUrl = appConfig.agentSidecar?.url;
  if (!sidecarUrl) {
    return res.status(503).json({ error: 'Agent sidecar not available' });
  }

  // Audit log
  logger.info({ userId: req.user.id, prompt: req.body.prompt }, 'Agent task requested');

  // Proxy to sidecar
  const response = await fetch(`${sidecarUrl}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${internalToken}`,
    },
    body: JSON.stringify(req.body),
  });

  const task = await response.json();

  // Store task reference in main DB for persistence across sidecar restarts
  await prisma.agentTask.create({
    data: {
      externalId: task.id,
      prompt: req.body.prompt,
      status: task.status,
      triggeredBy: req.user.id,
    },
  });

  res.status(201).json(task);
});
```

### SSE Relay

The main app relays the SSE stream from the sidecar to the frontend, adding authentication:

```typescript
router.get('/tasks/:id/stream', requirePermission('agent:read'), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sidecarUrl = appConfig.agentSidecar?.url;
  const upstream = await fetch(`${sidecarUrl}/tasks/${req.params.id}/stream`, {
    headers: { 'Authorization': `Bearer ${internalToken}` },
  });

  // Pipe upstream SSE to client
  upstream.body.pipeTo(new WritableStream({
    write(chunk) {
      res.write(chunk);
    },
    close() {
      res.end();
    },
  }));

  req.on('close', () => upstream.body.cancel());
});
```

## Component 6: Database Schema

Add a task tracking table to the main app's Prisma schema for audit and persistence:

```prisma
model AgentTask {
  id          String   @id @default(cuid())
  externalId  String   // Task ID from sidecar
  prompt      String   // User's original prompt
  status      String   // running, completed, failed, cancelled, timeout
  result      String?  // Final agent response (synced from sidecar)
  errorMessage String? // Error if failed
  tokenUsage  String?  // JSON: { input, output }
  triggeredBy String   // User ID
  createdAt   DateTime @default(now())
  completedAt DateTime?
  durationMs  Int?

  @@index([status])
  @@index([triggeredBy])
  @@index([createdAt])
  @@map("agent_tasks")
}
```

## Component 7: Docker Build Pipeline

### Image Build

The agent sidecar image is built alongside the main image and self-update sidecar in CI:

```yaml
# .github/workflows/docker-build.yml (additions)
  build-agent-sidecar:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build agent sidecar image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: agent-sidecar/Dockerfile
          push: true
          tags: ghcr.io/${{ github.repository }}-agent-sidecar:${{ env.TAG }}
          # Bake in docs from the repo at build time
          build-contexts: |
            docs=client/src/user-docs
            claude-context=.claude
```

### Baking the Image Tag

Same pattern as the self-update sidecar — the agent sidecar image tag is baked into the main image:

```dockerfile
# In main Dockerfile
ARG AGENT_SIDECAR_IMAGE_TAG=latest
ENV AGENT_SIDECAR_IMAGE_TAG=${AGENT_SIDECAR_IMAGE_TAG}
```

The main app reads `process.env.AGENT_SIDECAR_IMAGE_TAG` to determine which agent sidecar image to launch.

## Component 8: Configuration

### System Settings (stored in `SystemSettings` table)

| Key | Category | Default | Description |
|---|---|---|---|
| `agent_sidecar_enabled` | `agent` | `false` | Enable/disable agent sidecar |
| `agent_sidecar_image` | `agent` | (from env) | Agent sidecar Docker image |
| `agent_model` | `agent` | `claude-sonnet-4-6` | Claude model for agent |
| `agent_max_turns` | `agent` | `50` | Max agentic turns per task |
| `agent_timeout_ms` | `agent` | `300000` | Task timeout (5 min default) |
| `agent_auto_start` | `agent` | `true` | Start sidecar on main app boot |

### Settings UI

New settings page at `/settings/agent` for:
- Enable/disable the agent sidecar
- Configure model selection
- Set max turns and timeout
- View sidecar container status (running, stopped, image version)
- Restart sidecar button
- View API key usage / token consumption

## Component 9: Frontend Integration

### Agent Task UI

New page at `/agent` (or embedded as a panel/drawer accessible from multiple pages):

```
┌─────────────────────────────────────────────┐
│  Agent Assistant                    [Active] │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ Why is nginx restarting?        ▶ │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  ─── Task: Running ─────────────────────    │
│                                             │
│  🔧 docker logs nginx-prod --tail 50       │
│  📋 Found OOMKilled in recent events        │
│                                             │
│  🔧 docker inspect nginx-prod              │
│  📋 Memory limit: 256MB                     │
│                                             │
│  The nginx container is restarting due to   │
│  OOM kills. The memory limit is set to      │
│  256MB but the worker processes are         │
│  consuming ~300MB under load.               │
│                                             │
│  **Recommendation:** Increase the memory    │
│  limit to 512MB.                            │
│                                             │
│  ─── History ───────────────────────────    │
│  ✓ Check backup status (2 min ago)          │
│  ✓ Diagnose slow API response (15 min ago)  │
│                                             │
└─────────────────────────────────────────────┘
```

### React Hooks

```typescript
// client/src/hooks/use-agent.ts

/** Fetch agent sidecar status */
useAgentStatus()

/** Create a new agent task */
useCreateAgentTask()

/** Get task by ID with polling */
useAgentTask(taskId: string)

/** SSE stream of task progress */
useAgentTaskStream(taskId: string)

/** Cancel a running task */
useCancelAgentTask()

/** List recent tasks */
useAgentTasks()
```

### Context-Aware Prompts

The frontend can pre-populate the agent prompt with context from the current page:

```typescript
// From container detail page
createTask({
  prompt: "Why is this container using so much memory?",
  context: {
    containerId: container.id,
    containerName: container.name,
    currentPage: "container-detail"
  }
});

// From deployment page
createTask({
  prompt: "Is this deployment healthy?",
  context: {
    deploymentId: deployment.id,
    deploymentName: deployment.name,
    currentPage: "deployment-detail"
  }
});
```

## Implementation Order

### Phase 1: Sidecar Foundation
1. Create `agent-sidecar/` workspace with package.json and tsconfig
2. Implement Express server with health endpoint
3. Implement task store (in-memory)
4. Implement task API routes (CRUD + SSE streaming)
5. Write Dockerfile
6. Test locally with `docker build` + `docker run`

### Phase 2: Agent SDK Integration
1. Implement system prompt assembly from documentation
2. Define tool schemas (bash, mini_infra_api, read_file, etc.)
3. Implement tool execution with safety checks
4. Implement agent runner loop with streaming events
5. Wire up task creation → agent execution → SSE events
6. Test with real Anthropic API key

### Phase 3: Main App Integration
1. Add `AgentTask` model to Prisma schema + migration
2. Implement `agent-sidecar.ts` service (provisioning, health checks)
3. Add provisioning to startup flow in `server.ts`
4. Implement proxy routes in `server/src/routes/agent.ts`
5. Add `agent:read` / `agent:write` permissions
6. Add agent configuration to system settings

### Phase 4: Frontend
1. Create agent hooks (`use-agent.ts`)
2. Build agent task UI page
3. Add agent settings page
4. Add context-aware prompt helpers from existing pages
5. Add agent status indicator to main nav/header

### Phase 5: CI/CD
1. Add agent sidecar to Docker build workflow
2. Add `AGENT_SIDECAR_IMAGE_TAG` to main Dockerfile
3. Add image cleanup workflow for agent sidecar
4. Update docker-compose files with optional agent sidecar service

## Docker Compose (Development)

```yaml
# deployment/development/docker-compose.yaml (additions)
services:
  mini-infra:
    # ... existing config ...
    environment:
      - AGENT_SIDECAR_IMAGE=ghcr.io/mrgeoffrich/mini-infra-agent-sidecar:dev
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}

  # Optional: run agent sidecar directly in compose for development
  agent-sidecar:
    build:
      context: ../..
      dockerfile: agent-sidecar/Dockerfile
    container_name: mini-infra-agent-sidecar
    restart: unless-stopped
    profiles: ["agent"]  # Only start with: docker compose --profile agent up
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - MINI_INFRA_API_URL=http://mini-infra:5000
      - MINI_INFRA_API_KEY=${MINI_INFRA_API_KEY:-dev}
      - AGENT_MODEL=${AGENT_MODEL:-claude-sonnet-4-6}
      - LOG_LEVEL=debug
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '0.5'
```

## Open Questions

1. **Task persistence**: Should task history survive sidecar restarts? Current design stores minimal records in main DB, full results are ephemeral in sidecar memory. Could add a shared volume for task logs if needed.

2. **Multi-turn conversations**: Should the agent support follow-up questions on the same context? This would require maintaining conversation history in the sidecar, keyed by a session/thread ID.

3. **Pre-built prompt templates**: Should the UI offer canned prompts like "Diagnose container", "Check backup status", "Review deployment health"? These could be stored as prompt templates in the main DB.

4. **Cost controls**: Should there be per-user or per-day token budgets? The sidecar could track usage and enforce limits.

5. **Approval workflows**: For destructive actions the agent wants to take (e.g., restart a container), should it pause and request user approval via the task UI before proceeding?
