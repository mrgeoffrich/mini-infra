# Claude Agent SDK Integration Plan

## Overview

Integrate the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) into Mini Infra to provide an AI assistant that helps users onboard, diagnose issues, and interact with the full API surface. The agent runs inside the existing Docker container and uses `curl` against the local API, operating at the same privilege level as any authenticated API consumer.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Mini Infra Docker Container                            │
│                                                         │
│  ┌──────────────┐     ┌─────────────────────────┐       │
│  │  React App   │◄───►│  Express API (existing)  │       │
│  │              │ SSE │                          │       │
│  │  Chat Panel  │◄────│  POST /api/agent/chat    │       │
│  │  (sidebar)   │     │  GET  /api/agent/stream  │       │
│  └──────────────┘     └───────────┬──────────────┘       │
│                                   │                      │
│                        ┌──────────▼──────────────┐       │
│                        │  Agent SDK Process       │       │
│                        │  - Tool: Bash (curl)     │       │
│                        │  - System prompt with    │       │
│                        │    API key + API docs    │       │
│                        │  - PreToolUse hooks      │       │
│                        │    for security           │       │
│                        └──────────┬──────────────┘       │
│                                   │ curl                 │
│                        ┌──────────▼──────────────┐       │
│                        │  localhost:5000/api/*    │       │
│                        └─────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
```

The agent is **not** given direct access to services, the database, or the filesystem. It can only interact with Mini Infra through the HTTP API using curl, which means:

- All requests go through existing auth, validation, and middleware
- Full audit trail via HTTP request logs
- The agent can't bypass business logic
- Revoking the agent's API key immediately cuts off access

---

## Phase 1: Backend — Agent Service & API Routes

### 1.1 Install the Agent SDK

```bash
cd server
npm install @anthropic-ai/claude-agent-sdk
```

### 1.2 Create the Agent Service

**File:** `server/src/services/agent-service.ts`

Responsibilities:
- Manage agent sessions (start, stream, resume)
- Build the system prompt dynamically (inject API key, API reference)
- Enforce security hooks (Bash whitelist)
- Cap resource usage (maxTurns)

```typescript
import { query, HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

interface AgentSession {
  id: string;
  sessionId?: string;  // SDK session ID for resumption
  userId: string;
  createdAt: Date;
  lastActivity: Date;
}

class AgentService {
  private sessions: Map<string, AgentSession> = new Map();
  private agentApiKey: string;

  constructor(agentApiKey: string) {
    this.agentApiKey = agentApiKey;
  }

  /**
   * Build the system prompt with API key, API reference, and behavioral rules.
   */
  buildSystemPrompt(): string {
    return `
You are the Mini Infra Assistant. You help users manage their Docker
infrastructure, deployments, PostgreSQL databases, Cloudflare tunnels,
TLS certificates, and services.

## How You Work

You interact with Mini Infra by making curl requests to the local API.
All your information comes from API responses — you do not have direct
access to the database, filesystem, or Docker socket.

## Authentication

Use this header for ALL API calls:
  x-api-key: ${this.agentApiKey}

Base URL: http://localhost:5000

Example:
  curl -s -H "x-api-key: ${this.agentApiKey}" http://localhost:5000/api/containers

## API Reference

${this.generateApiReference()}

## Onboarding Guide

When a user asks for help getting started, walk them through:
1. Check system health: curl GET /health
2. Check Docker connectivity: curl GET /api/settings/docker-host
3. List running containers: curl GET /api/containers
4. Check Cloudflare tunnel status: curl GET /api/connectivity
5. List PostgreSQL servers: curl GET /api/postgres-server/servers
6. List deployments: curl GET /api/deployments

## Behavioral Rules

1. NEVER expose the API key in your responses to the user.
2. NEVER modify or delete resources without explicit user confirmation.
3. For destructive operations (delete, remove, restart, stop), always
   explain what will happen and ask the user to confirm first.
4. Prefer read-only operations (GET requests) when investigating issues.
5. When diagnosing problems, start with the broadest view and narrow down.
6. Summarize API responses clearly — don't dump raw JSON unless the user
   asks for it.
7. If an API call fails, explain the error and suggest next steps.
8. When you don't know something, say so rather than guessing.
`.trim();
  }

  /**
   * Generate a condensed API reference from route metadata.
   */
  private generateApiReference(): string {
    // This would be generated from route metadata or a static file.
    // Keeping it condensed to minimize token usage in the system prompt.
    return API_REFERENCE; // see section 1.3
  }
}
```

### 1.3 API Reference for the System Prompt

**File:** `server/src/services/agent-api-reference.ts`

A static, curated API reference optimized for the agent's context window. Not every endpoint needs to be listed — focus on the ones users are most likely to ask about. Group by domain.

```typescript
export const API_REFERENCE = `
### Health
- GET /health — System health check

### Containers
- GET /api/containers — List all containers (query: ?page=1&limit=20&status=running)
- GET /api/containers/:id — Get container details
- GET /api/containers/:id/env — Get container environment variables
- POST /api/containers/:id/start — Start a container
- POST /api/containers/:id/stop — Stop a container (DESTRUCTIVE)
- POST /api/containers/:id/restart — Restart a container (DESTRUCTIVE)

### Docker Infrastructure
- GET /api/docker/networks — List Docker networks
- GET /api/docker/volumes — List Docker volumes

### PostgreSQL Servers
- GET /api/postgres-server/servers — List PostgreSQL servers
- POST /api/postgres-server/servers/:id/test — Test server connection

### PostgreSQL Databases
- GET /api/postgres/databases — List configured databases
- POST /api/postgres/databases/:id/test — Test database connection
- POST /api/postgres/databases/discover — Discover databases on a server

### Backups
- GET /api/postgres/backups/:databaseId — List backups for a database
- POST /api/postgres/backups — Create a backup (DESTRUCTIVE)

### Deployments
- GET /api/deployments — List deployment configurations
- GET /api/deployments/:id — Get deployment details
- GET /api/deployments/:id/history — Get deployment history
- POST /api/deployments/:id/trigger — Trigger a deployment (DESTRUCTIVE)

### Deployment Infrastructure
- GET /api/deployment-infrastructure/status — Get HAProxy infrastructure status

### HAProxy
- GET /api/haproxy/frontends — List HAProxy frontends
- GET /api/haproxy/frontends/:id/stats — Get frontend statistics
- GET /api/haproxy/backends — List HAProxy backends
- GET /api/haproxy/backends/:id/stats — Get backend statistics

### TLS Certificates
- GET /api/tls/certificates — List TLS certificates
- POST /api/tls/certificates/:id/renew — Renew a certificate (DESTRUCTIVE)
- GET /api/tls/settings — Get TLS/ACME configuration

### Cloudflare
- GET /api/connectivity — Get Cloudflare tunnel status
- GET /api/settings/cloudflare/tunnels — List Cloudflare tunnels

### Azure
- GET /api/connectivity/azure — Get Azure connectivity status

### Environments
- GET /api/environments — List environments
- GET /api/environments/:id/status — Get environment status

### Settings
- GET /api/settings/docker-host — Get Docker host configuration
- GET /api/settings/system — Get system settings

### Events
- GET /api/events — List recent events
`.trim();
```

### 1.4 Security Hook — Bash Command Whitelist

The most critical security component. The agent can only run `curl` commands against localhost:5000.

```typescript
const bashGuard: HookCallback = async (input) => {
  const preInput = input as PreToolUseHookInput;
  const command = (preInput.tool_input as Record<string, unknown>)?.command as string;

  if (!command) {
    return deny("Empty command");
  }

  // Strip leading whitespace and normalize
  const normalized = command.trim();

  // Must start with curl
  if (!normalized.startsWith("curl ")) {
    return deny("Only curl commands are allowed");
  }

  // Must target localhost:5000
  const localhostPattern = /https?:\/\/(localhost|127\.0\.0\.1):5000/;
  if (!localhostPattern.test(normalized)) {
    return deny("curl must target http://localhost:5000");
  }

  // Block command chaining (;, &&, ||, |, $(), backticks)
  const dangerousPatterns = /[;|`]|\$\(|&&|\|\|/;
  if (dangerousPatterns.test(normalized)) {
    return deny("Command chaining is not allowed");
  }

  return {}; // Allow
};

function deny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}
```

### 1.5 Agent API Routes

**File:** `server/src/routes/agent-routes.ts`

```typescript
// POST /api/agent/chat — Start or continue a conversation
// Request: { message: string, sessionId?: string }
// Response: SSE stream

// GET /api/agent/sessions — List user's agent sessions
// Response: { sessions: AgentSession[] }

// DELETE /api/agent/sessions/:id — Delete a session
```

**SSE streaming endpoint:**

```typescript
router.post("/chat", requireSessionOrApiKey, async (req, res) => {
  const { message, sessionId } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const options = {
      systemPrompt: agentService.buildSystemPrompt(),
      allowedTools: ["Bash"],
      permissionMode: "bypassPermissions",
      maxTurns: 20,
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [bashGuard] }],
      },
      ...(sessionId ? { resume: sessionId } : {}),
    };

    for await (const msg of query({ prompt: message, options })) {
      if (msg.type === "system" && msg.subtype === "init") {
        res.write(`data: ${JSON.stringify({ type: "session", sessionId: msg.session_id })}\n\n`);
      }

      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if ("text" in block) {
            res.write(`data: ${JSON.stringify({ type: "text", content: block.text })}\n\n`);
          }
          if ("name" in block && block.name === "Bash") {
            res.write(`data: ${JSON.stringify({ type: "tool_use", tool: block.name, input: block.input })}\n\n`);
          }
        }
      }

      if (msg.type === "result") {
        res.write(`data: ${JSON.stringify({ type: "result", subtype: msg.subtype })}\n\n`);
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: "error", message: error.message })}\n\n`);
    res.end();
  }
});
```

### 1.6 Agent API Key Management

Create a dedicated, non-user API key for the agent on startup:

- Stored in SystemSettings or as a dedicated DB record
- Labeled as "agent-internal" so it's distinguishable in logs
- Rotatable via settings
- The key is never exposed to the frontend — only injected into the system prompt server-side

```typescript
// In server startup (server.ts or app.ts)
async function ensureAgentApiKey(prisma: PrismaClient): Promise<string> {
  const existing = await prisma.systemSettings.findFirst({
    where: { key: "agent_api_key" },
  });

  if (existing) {
    return decrypt(existing.value); // Return the raw key
  }

  // Generate and store a new key
  const rawKey = `mk_agent_${crypto.randomBytes(32).toString("hex")}`;
  const hashedKey = hashApiKey(rawKey);

  await prisma.systemSettings.create({
    data: {
      key: "agent_api_key",
      value: encrypt(rawKey),
      category: "agent",
    },
  });

  // Also create the ApiKey record so the middleware can validate it
  await prisma.apiKey.create({
    data: {
      name: "Agent Internal Key",
      hashedKey,
      isAgent: true, // New field to mark agent keys
    },
  });

  return rawKey;
}
```

---

## Phase 2: Frontend — Chat UI

### 2.1 Chat Panel Component

**File:** `client/src/components/agent/agent-chat-panel.tsx`

A slide-out sidebar or bottom panel with:
- Message history (user messages + agent responses)
- Input field for user messages
- Collapsible "tool use" blocks showing curl commands the agent ran
- Loading/streaming indicator
- Session management (new chat, continue previous)

### 2.2 Agent Chat Hook

**File:** `client/src/hooks/use-agent-chat.ts`

```typescript
function useAgentChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  const sendMessage = async (message: string) => {
    // Add user message to state
    // POST to /api/agent/chat with SSE
    // Parse SSE events and append to messages
    // Capture sessionId for resumption
  };

  return { messages, sendMessage, isStreaming, sessionId };
}
```

### 2.3 UI Design

```
┌────────────────────────────────────────────────┐
│  Mini Infra Assistant                     [×]  │
├────────────────────────────────────────────────┤
│                                                │
│  User: Why is my postgres backup failing?      │
│                                                │
│  Assistant: Let me check your backup status.   │
│                                                │
│  ┌─ curl ─────────────────────────────────┐    │
│  │ GET /api/postgres/databases            │    │
│  │ Response: 3 databases configured       │    │
│  └────────────────────────────────────────┘    │
│                                                │
│  ┌─ curl ─────────────────────────────────┐    │
│  │ GET /api/postgres/backups/db_abc123    │    │
│  │ Response: Last backup failed at 02:00  │    │
│  └────────────────────────────────────────┘    │
│                                                │
│  Assistant: Your backup for "prod-db" failed   │
│  at 2:00 AM. The error indicates the Azure     │
│  storage container is not accessible. Let me   │
│  check your Azure connectivity...              │
│                                                │
├────────────────────────────────────────────────┤
│  [Ask the assistant anything...]        [Send] │
└────────────────────────────────────────────────┘
```

### 2.4 Navigation

Add an "Assistant" button to the main navigation or as a floating action button. The chat panel opens as a slide-over that doesn't navigate away from the current page — users can ask questions while looking at their containers, deployments, etc.

---

## Phase 3: Docker & Deployment

### 3.1 Environment Variable

Add `ANTHROPIC_API_KEY` to the container environment:

```yaml
# docker-compose.yml
services:
  mini-infra:
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
```

This is the API key for calling the Claude API (Anthropic's API), not the internal Mini Infra API key.

### 3.2 Agent Working Directory & Documentation

The agent runs with `cwd` set to `/app/agent` inside the Docker container. This directory contains markdown documentation files that the agent can read to answer onboarding and reference questions without making API calls (faster and cheaper).

**Documentation source:** `client/src/user-docs/` (the existing user-facing help docs)

```
client/src/user-docs/
├── getting-started/
│   ├── overview.md
│   ├── navigating-the-dashboard.md
│   └── running-with-docker.md
├── containers/
│   ├── viewing-containers.md
│   ├── managing-containers.md
│   ├── container-actions.md
│   ├── container-logs.md
│   └── troubleshooting.md
├── deployments/
│   ├── deployment-overview.md
│   ├── creating-deployments.md
│   ├── deployment-lifecycle.md
│   └── troubleshooting.md
├── postgres-backups/
│   ├── backup-overview.md
│   ├── configuring-backups.md
│   ├── restoring-backups.md
│   └── troubleshooting.md
├── connectivity/
│   ├── health-monitoring.md
│   └── troubleshooting.md
├── tunnels/
│   ├── tunnel-monitoring.md
│   └── troubleshooting.md
├── github/
│   ├── github-app-setup.md
│   ├── packages-and-registries.md
│   ├── repository-integration.md
│   └── troubleshooting.md
├── settings/
│   ├── system-settings.md
│   ├── api-keys.md
│   └── user-preferences.md
└── api/
    └── api-overview.md
```

These are the same markdown files used by the in-app help system, so documentation stays in sync automatically — no duplicate content to maintain.

**Dockerfile changes:**

```dockerfile
# Copy user documentation for the agent to read
COPY client/src/user-docs/ /app/agent/docs/
```

**SDK configuration:**

```typescript
const queryResult = query({
  prompt: messageQueue,
  options: {
    cwd: "/app/agent",                          // Agent working directory
    allowedTools: ["Bash", "Read", "Glob"],      // Read/Glob for docs, Bash for curl
    // ...
  },
});
```

**Tool access:**

| Tool | Purpose | Scope |
|------|---------|-------|
| `Read` | Read documentation markdown files | `/app/agent/docs/**/*.md` |
| `Glob` | Find documentation files by pattern | `/app/agent/` |
| `Bash` | Execute `curl` against local API | `localhost:5000` only (enforced by hook) |

The agent can answer "how do deployments work?" by reading `docs/deployments/deployment-overview.md` directly, and answer "show me my deployments" by curling the API. This split keeps documentation questions fast and cheap while still allowing full API interaction.

**System prompt addition:**

```
## Documentation

You have access to Mini Infra's documentation in the docs/ directory.
Use the Read and Glob tools to look up documentation before making API calls.
When a user asks a conceptual question, check the docs first.

Documentation structure (all under docs/):
- getting-started/ — Overview, dashboard navigation, Docker setup
- containers/ — Viewing, managing, actions, logs, troubleshooting
- deployments/ — Overview, creating, lifecycle, troubleshooting
- postgres-backups/ — Overview, configuring, restoring, troubleshooting
- connectivity/ — Health monitoring, troubleshooting
- tunnels/ — Tunnel monitoring, troubleshooting
- github/ — App setup, packages, repositories, troubleshooting
- settings/ — System settings, API keys, user preferences
- api/ — API overview

Example: To learn about deployments, run:
  Glob docs/deployments/*.md
  Read docs/deployments/deployment-overview.md
```

### 3.3 Dockerfile Changes

The Agent SDK is a Node.js dependency — no additional system packages are needed. It runs in-process with the Express server. Beyond `npm install`, the only Dockerfile change is copying `client/src/user-docs/` to `/app/agent/docs/`.

### 3.3 Resource Considerations

The Agent SDK itself is lightweight — the heavy work is done by the Claude API remotely. The main resource concern is concurrent agent sessions:

- Each active session holds an open SSE connection
- curl subprocesses are short-lived
- Memory overhead is minimal (session state + SSE buffers)

For a single-user or small-team deployment, this is fine running in the same container. If scaling becomes a concern, the agent service could be extracted to a sidecar.

### 3.4 Feature Flag

The agent feature should be opt-in, gated on whether `ANTHROPIC_API_KEY` is set:

```typescript
const agentEnabled = !!process.env.ANTHROPIC_API_KEY;

if (agentEnabled) {
  app.use("/api/agent", agentRoutes);
}
```

The frontend checks a `/api/agent/status` endpoint to know whether to show the chat UI.

---

## Phase 4: Conversation Persistence (Optional)

### 4.1 Database Schema

```prisma
model AgentConversation {
  id          String   @id @default(uuid())
  userId      String
  sessionId   String?  // SDK session ID for resumption
  title       String?  // Auto-generated from first message
  messages    AgentMessage[]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  user        User     @relation(fields: [userId], references: [id])
}

model AgentMessage {
  id              String   @id @default(uuid())
  conversationId  String
  role            String   // "user" | "assistant" | "tool_use" | "tool_result"
  content         String   // Message text or JSON for tool calls
  createdAt       DateTime @default(now())
  conversation    AgentConversation @relation(fields: [conversationId], references: [id])
}
```

### 4.2 Session Resumption

The Agent SDK supports session resumption via `session_id`. When a user returns to a previous conversation:

1. Load the conversation from the database
2. Display previous messages in the chat UI
3. Pass the `session_id` to `query({ options: { resume: sessionId } })`
4. The SDK resumes with full context

---

## Security Summary

| Threat | Mitigation |
|--------|------------|
| Agent runs arbitrary commands | PreToolUse hook whitelists only `curl` to `localhost:5000` |
| Command injection via chaining | Block `;`, `&&`, `\|\|`, `\|`, `` ` ``, `$()` in commands |
| Agent accesses sensitive files | `Read`/`Glob` scoped to `/app/agent` (docs only) via `cwd` + no `Write`/`Edit` tools. `additionalDirectories` not set, so agent cannot read outside its working directory |
| Agent leaks its API key | System prompt rule + key is never sent to frontend |
| Runaway cost / infinite loops | `maxTurns: 20` caps agent iterations |
| Unauthorized access | Agent API key goes through same auth middleware as all other keys |
| Privilege escalation | Agent operates at API-consumer level, no direct DB/Docker access |
| Anthropic API key exposure | Stored as env var, never exposed to frontend or agent responses |
| Multi-user isolation | Each user's agent session is scoped to their auth context |

### Additional Security Hardening (Future)

- Rate limiting on `/api/agent/chat` (e.g., 10 requests/minute per user)
- Token budget tracking per user/day
- Audit log for all agent-initiated API calls (already captured by HTTP logging)
- Read-only mode option that blocks POST/PUT/DELETE curl commands
- Content filtering on agent responses

---

## Implementation Order

1. **Phase 1.1–1.4**: Agent service, security hook, system prompt — get the core working in isolation
2. **Phase 1.5**: API routes with SSE streaming
3. **Phase 1.6**: Agent API key auto-provisioning
4. **Phase 2**: Frontend chat UI
5. **Phase 3**: Docker/deployment configuration
6. **Phase 4**: Conversation persistence (optional, can defer)

---

## Open Questions

1. **API key scope**: Should the agent have a single service account key, or per-user keys that inherit the user's permissions?
2. **Cost visibility**: Should users see estimated token costs per conversation?
3. **Model selection**: Default to `claude-sonnet-4-6` for speed/cost, or `claude-opus-4-6` for capability? Could be a setting.
4. **Chat location**: Sidebar panel, dedicated page, or floating button?
5. **Conversation limits**: Max conversations per user? Auto-cleanup of old sessions?
6. **Read-only mode**: Should there be a toggle that restricts the agent to GET requests only?
