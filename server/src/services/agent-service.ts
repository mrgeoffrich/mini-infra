import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type { Response } from "express";
import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type HookCallback,
  type PreToolUseHookInput,
  type HookCallbackMatcher,
} from "../lib/agent-sdk";
import { agentLogger } from "../lib/logger-factory";
import appConfig, { agentConfig } from "../lib/config-new";
import { API_REFERENCE } from "./agent-api-reference";
import { createUiToolsMcpServer } from "./agent-ui-tools";
import { githubAppService } from "./github-app-service";
import { agentConversationService } from "./agent-conversation-service";

const logger = agentLogger();

// Resolve agent working directory based on environment.
// AGENT_CWD env var can override for non-standard setups.
const AGENT_CWD =
  process.env.AGENT_CWD ??
  (process.env.NODE_ENV === "production"
    ? "/app/agent"
    : path.resolve(__dirname, "../../../agent"));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Capabilities resolved at session creation time */
interface AgentCapabilities {
  dockerEnabled: boolean;
  ghEnabled: boolean;
  ghToken: string | null;
}

interface AgentSession {
  id: string;
  userId: string;
  conversationId: string;
  queue: AgentMessageQueue;
  abortController: AbortController;
  subscribers: Set<Response>;
  createdAt: Date;
  running: boolean;
  currentPath: string;
  /** Stable API message ID for the current streaming turn, set from message_start. */
  currentTurnUuid: string | null;
  /** Buffered tool_use input keyed by toolId, flushed on tool_result. */
  pendingToolUse: Map<string, { toolName: string; input: Record<string, unknown> }>;
  /** Monotonically increasing message sequence counter. */
  nextSequence: number;
  /** Number of in-flight fire-and-forget persist calls currently outstanding. */
  pendingPersistCount: number;
}

// ---------------------------------------------------------------------------
// AgentMessageQueue — AsyncIterable<SDKUserMessage> for multi-turn
// ---------------------------------------------------------------------------

class AgentMessageQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private resolve: ((value: IteratorResult<SDKUserMessage>) => void) | null =
    null;
  private closed = false;

  push(content: string): void {
    const msg: SDKUserMessage = {
      type: "user" as const,
      message: { role: "user" as const, content },
      parent_tool_use_id: null,
      session_id: "",
    };

    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({
            value: this.buffer.shift()!,
            done: false,
          });
        }
        if (this.closed) {
          return Promise.resolve({
            value: undefined as unknown as SDKUserMessage,
            done: true,
          });
        }
        return new Promise((resolve) => {
          this.resolve = resolve;
        });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// bashGuard — PreToolUse hook that restricts Bash to allowed commands only
// ---------------------------------------------------------------------------

/** Docker subcommands the agent is allowed to run */
const DOCKER_ALLOWED_SUBCOMMANDS = new Set([
  "ps",
  "logs",
  "inspect",
  "images",
  "stats",
  "top",
  "port",
  "diff",
  "start",
  "stop",
  "restart",
]);

/** Docker compound subcommands (two-word) the agent is allowed to run */
const DOCKER_ALLOWED_COMPOUND = new Set([
  "network ls",
  "network inspect",
  "volume ls",
  "volume inspect",
  "compose ps",
  "compose logs",
]);

/** gh top-level subcommands that are always blocked (security-sensitive) */
const GH_BLOCKED_SUBCOMMANDS = new Set(["auth", "ssh-key", "gpg-key"]);

function denyResult(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

function validateCurlCommand(command: string, port: number) {
  // URL must be localhost or 127.0.0.1 on the correct port.
  // Strip -H/--header flag values first so a URL embedded in a header
  // (e.g. -H "x-api-key: http://localhost:5005/") can't fool the check.
  const strippedCommand = command
    .replace(/-(-header|H)\s+(['"]).*?\2/g, "")
    .replace(/-(-header|H)\s+\S+/g, "");
  const localhostPattern = new RegExp(
    `https?://(localhost|127\\.0\\.0\\.1):${port}(/|\\s|$|"|')`,
  );
  if (!localhostPattern.test(strippedCommand)) {
    return denyResult(
      `curl target must be localhost:${port}. External requests are not allowed.`,
    );
  }
  return null; // allowed
}

function validateDockerCommand(command: string) {
  // Extract the subcommand(s) after "docker"
  const args = command
    .trimStart()
    .replace(/^docker\s+/, "")
    .trim();
  if (!args) {
    return denyResult("docker command requires a subcommand.");
  }

  const parts = args.split(/\s+/);
  const sub1 = parts[0];
  const sub2 = parts.length > 1 ? `${parts[0]} ${parts[1]}` : null;

  // Check compound commands first (e.g. "network ls", "compose ps")
  if (sub2 && DOCKER_ALLOWED_COMPOUND.has(sub2)) {
    return null; // allowed
  }

  // Check single subcommands
  if (DOCKER_ALLOWED_SUBCOMMANDS.has(sub1)) {
    return null; // allowed
  }

  return denyResult(
    `docker subcommand "${sub1}" is not allowed. Allowed: ${[...DOCKER_ALLOWED_SUBCOMMANDS, ...DOCKER_ALLOWED_COMPOUND].join(", ")}`,
  );
}

function validateGhCommand(command: string) {
  const args = command
    .trimStart()
    .replace(/^gh\s+/, "")
    .trim();
  if (!args) {
    return denyResult("gh command requires a subcommand.");
  }

  const parts = args.split(/\s+/);
  const sub1 = parts[0];

  // Block security-sensitive subcommands; everything else is allowed
  // and scoped by the token's permissions.
  if (GH_BLOCKED_SUBCOMMANDS.has(sub1)) {
    return denyResult(
      `gh subcommand "${sub1}" is not allowed for security reasons.`,
    );
  }

  return null; // allowed — token permissions control what actually succeeds
}

interface BashGuardOptions {
  port: number;
  apiKey: string;
  dockerEnabled: boolean;
  ghEnabled: boolean;
}

function allowWithInjectedHeader(command: string, apiKey: string) {
  // Inject the x-api-key header into the curl command so the API key
  // never appears in the system prompt or conversation history.
  const header = `-H "x-api-key: ${apiKey}"`;
  // Insert after "curl" (and any flags before the URL) by appending
  // right after "curl " or "curl -s ".
  const injected = command.replace(/^(\s*curl\s)/, `$1${header} `);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "allow" as const,
      updatedInput: { command: injected },
    },
  };
}

function createBashGuard(options: BashGuardOptions): HookCallback {
  const { port, apiKey, dockerEnabled, ghEnabled } = options;

  return async (input) => {
    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as { command?: string } | undefined;
    const command = toolInput?.command ?? "";
    const trimmed = command.trimStart();

    // Reject newlines and tabs — a shell treats \n as a command terminator
    // just like ";", so a multi-line command would bypass the chain guard.
    if (/[\n\r\t]/.test(command)) {
      return denyResult("Newlines and tabs are not allowed in commands.");
    }

    // Universal: no command chaining characters
    const chainPattern = /[;|`]|\$\(|&&|\|\|/;
    if (chainPattern.test(command)) {
      return denyResult("Command chaining is not allowed in agent commands.");
    }

    // Determine which tool is being invoked
    if (trimmed.startsWith("curl ")) {
      const result = validateCurlCommand(command, port);
      if (result) return result; // denied
      return allowWithInjectedHeader(command, apiKey);
    }

    if (trimmed.startsWith("docker ")) {
      if (!dockerEnabled) {
        return denyResult("Docker CLI is not available in this environment.");
      }
      const result = validateDockerCommand(command);
      return result ?? {};
    }

    if (trimmed.startsWith("gh ")) {
      if (!ghEnabled) {
        return denyResult(
          "GitHub CLI is not available. Configure GitHub credentials in Settings to enable it.",
        );
      }
      const result = validateGhCommand(command);
      return result ?? {};
    }

    // Build list of allowed commands for the error message
    const allowed = ["curl"];
    if (dockerEnabled) allowed.push("docker");
    if (ghEnabled) allowed.push("gh");

    return denyResult(
      `Only ${allowed.join(", ")} commands are allowed. Got: ${trimmed.slice(0, 60)}`,
    );
  };
}

// ---------------------------------------------------------------------------
// pathGuard — PreToolUse hook that restricts Read/Glob to AGENT_CWD
// ---------------------------------------------------------------------------

function createPathGuard(allowedRoot: string): HookCallback {
  // Resolve once so relative CWD values are normalised.
  const resolvedRoot = path.resolve(allowedRoot);

  return async (input) => {
    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as Record<string, unknown> | undefined;

    // Read uses "file_path"; Glob uses "path" (optional) and "pattern".
    // We need to validate any explicit path the agent supplies.
    const filePath = (toolInput?.file_path ?? toolInput?.path ?? null) as
      | string
      | null;

    if (filePath) {
      const resolved = path.resolve(resolvedRoot, filePath);
      if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
        return denyResult(
          `Access denied: path "${filePath}" is outside the allowed directory.`,
        );
      }
    }

    return {}; // allowed
  };
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  port: number,
  capabilities: AgentCapabilities,
): string {
  const baseUrl = `http://localhost:${port}`;

  const toolList = ["curl (Mini Infra API)"];
  if (capabilities.dockerEnabled) toolList.push("docker (Docker CLI)");
  if (capabilities.ghEnabled) toolList.push("gh (GitHub CLI)");

  let prompt = `You are the Mini Infra AI assistant. You help users understand and manage their Docker infrastructure, deployments, databases, and services.

## Available Tools

You have access to: ${toolList.join(", ")}.

## Mini Infra API (curl)

Use curl to call the Mini Infra API at ${baseUrl}. Authentication is handled automatically — do not include any auth headers.

**Example:**
\`\`\`bash
curl -s ${baseUrl}/api/containers
\`\`\`

${API_REFERENCE}
`;

  if (capabilities.dockerEnabled) {
    prompt += `
## Docker CLI

You have direct access to the Docker CLI. Use it for container logs, live stats, and detailed inspection.

**When to use Docker CLI vs API:**
- Use the **API** for structured data, deployments, and operations that need Mini Infra tracking.
- Use **Docker CLI** for live logs, stats, detailed inspect output, and troubleshooting.
`;
  }

  if (capabilities.ghEnabled) {
    prompt += `
## GitHub CLI (gh)

You have full access to the GitHub CLI with pre-configured authentication.
The token's permissions control what operations are available.
The only blocked subcommands are \`auth\`, \`ssh-key\`, and \`gpg-key\`.

**Examples:**
\`\`\`bash
gh pr list --repo owner/repo --state open
gh issue view 42 --repo owner/repo
gh issue create --repo owner/repo --title "Bug" --body "Details"
gh pr create --repo owner/repo --title "Fix" --body "Description"
gh api repos/owner/repo/actions/runs
gh run list --repo owner/repo --limit 5
\`\`\`
`;
  }

  if (!capabilities.ghEnabled) {
    prompt += `
## GitHub CLI

GitHub CLI (\`gh\`) is **not available** in this session. No assistant GitHub token has been configured.
To enable GitHub access, ask the user to go to the **GitHub connectivity page** (\`/connectivity-github\`) and configure an **Assistant Access** token under the "Assistant Access" section.
`;
  }

  prompt += `
## UI Guidance Tools

You have \`highlight_element\`, \`navigate_to\`, and \`get_current_page\` tools to visually guide users in the browser.
- Always call \`get_current_page\` first to find out which page the user is currently viewing before deciding whether navigation is needed — if they are already on the right page, skip navigation entirely.
- Read manifest files in \`${AGENT_CWD}/docs/ui-elements/\` to discover available element IDs and routes.
- Use \`navigate_to\` to take the user to a page, and \`highlight_element\` to spotlight a specific element.
- Before calling \`navigate_to\`, ask the user for permission unless they have explicitly asked you to navigate them to a specific page (e.g. "take me to...", "go to...", "navigate to..."). For example: "I can take you to the Containers page — would you like me to navigate there?"

## Documentation

You can read documentation files in ${AGENT_CWD}/docs/ using the Read or Glob tools.

## Rules

1. **Only use allowed commands** (${toolList.map((t) => t.split(" ")[0]).join(", ")}). No other shell commands.
2. **Always use -s** (silent) flag with curl to avoid progress bars.
3. Present JSON responses in a readable format in your response.
4. **Be concise.** Summarize responses for the user rather than dumping raw output.
5. **Be helpful.** If the user asks something vague, suggest what information you can look up.
6. **Never modify or delete** resources unless the user explicitly asks you to.
7. **Report errors clearly.** If a command fails, explain what went wrong and suggest next steps.
`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Session environment builder — allowlist only what the agent needs
// ---------------------------------------------------------------------------

/** Env vars the agent subprocess is allowed to inherit from the host. */
const ALLOWED_ENV_VARS = [
  // Core runtime
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  // Node.js
  "NODE_ENV",
  // Docker (socket path, host overrides)
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  // Anthropic SDK (needed by the Claude Agent SDK subprocess)
  "ANTHROPIC_API_KEY",
];

function buildSessionEnv(
  capabilities: AgentCapabilities,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};

  for (const key of ALLOWED_ENV_VARS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  if (capabilities.ghToken) {
    env.GH_TOKEN = capabilities.ghToken;
  }

  return env;
}

// ---------------------------------------------------------------------------
// AgentService — singleton managing sessions
// ---------------------------------------------------------------------------

class AgentService {
  private sessions = new Map<string, AgentSession>();
  private apiKey: string;
  private port: number;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.port = appConfig.server.port;
    logger.info("AgentService initialized");
  }

  /**
   * Resolve available capabilities for a new agent session.
   * Checks Docker socket availability and resolves a GitHub token.
   */
  private async resolveCapabilities(): Promise<AgentCapabilities> {
    // Check if Docker socket is available
    const dockerEnabled = fs.existsSync("/var/run/docker.sock");

    // Only use a dedicated agent token — no implicit fallback chain
    let ghToken: string | null = null;
    try {
      ghToken = await githubAppService.getAgentToken();
      if (ghToken) {
        logger.debug("Resolved GitHub token from dedicated agent token");
      }
    } catch (err) {
      logger.debug({ err }, "Failed to retrieve agent GitHub token");
    }

    return {
      dockerEnabled,
      ghEnabled: !!ghToken,
      ghToken,
    };
  }

  async createSession(
    userId: string,
    message: string,
    currentPath?: string,
    existingConversationId?: string,
  ): Promise<{ sessionId: string; conversationId: string }> {
    const sessionId = randomUUID();
    const queue = new AgentMessageQueue();
    const abortController = new AbortController();

    // Resolve or create a conversation record. No fallback UUID — let DB
    // failures propagate so the caller gets a real error instead of silently
    // persisting messages to a non-existent conversation.
    let conversationId: string;
    let initialSequence = 0;

    if (existingConversationId) {
      // Verify the conversation belongs to this user and get its current length
      const existing = await agentConversationService.getConversationDetail(
        existingConversationId,
        userId,
      );
      if (existing) {
        conversationId = existingConversationId;
        // Start sequence after the highest persisted sequence so resumed
        // conversations never produce duplicate or out-of-order sequence numbers
        const maxSeq = existing.messages.reduce((max, m) => Math.max(max, m.sequence), -1);
        initialSequence = maxSeq + 1;
      } else {
        // Supplied conversationId doesn't belong to this user — start fresh
        conversationId = await agentConversationService.createConversation(userId, message);
      }
    } else {
      conversationId = await agentConversationService.createConversation(userId, message);
    }

    const session: AgentSession = {
      id: sessionId,
      userId,
      conversationId,
      queue,
      abortController,
      subscribers: new Set(),
      createdAt: new Date(),
      running: true,
      currentPath: currentPath ?? "",
      currentTurnUuid: null,
      pendingToolUse: new Map(),
      nextSequence: initialSequence,
      pendingPersistCount: 0,
    };

    this.sessions.set(sessionId, session);

    // Persist the initial user message (fire-and-forget)
    this.persistMessage(session, "user", message);

    // Resolve capabilities (Docker, GitHub) before starting the loop
    const capabilities = await this.resolveCapabilities();
    logger.info(
      {
        sessionId,
        dockerEnabled: capabilities.dockerEnabled,
        ghEnabled: capabilities.ghEnabled,
      },
      "Agent capabilities resolved",
    );

    // Push initial message and start the query loop
    queue.push(message);
    this.runQueryLoop(session, capabilities).catch((err) => {
      logger.error({ err, sessionId }, "Query loop failed");
    });

    logger.info({ sessionId, userId, conversationId }, "Agent session created");
    return { sessionId, conversationId };
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  sendMessage(sessionId: string, message: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.running) {
      return false;
    }
    session.queue.push(message);
    // Persist follow-up user message (fire-and-forget)
    this.persistMessage(session, "user", message);
    logger.debug({ sessionId }, "Message pushed to agent queue");
    return true;
  }

  updateCurrentPath(sessionId: string, currentPath: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.currentPath = currentPath;
    logger.debug({ sessionId, currentPath }, "Current path updated");
    return true;
  }

  addSubscriber(sessionId: string, res: Response): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.subscribers.add(res);
    logger.debug(
      { sessionId, subscriberCount: session.subscribers.size },
      "SSE subscriber added",
    );
    return true;
  }

  removeSubscriber(sessionId: string, res: Response): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subscribers.delete(res);
    }
  }

  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.abortController.abort();
    session.queue.close();
    session.running = false;

    // End all SSE connections
    for (const res of session.subscribers) {
      try {
        res.write(`data: ${JSON.stringify({ type: "closed" })}\n\n`);
        res.end();
      } catch {
        // subscriber already disconnected
      }
    }
    session.subscribers.clear();

    this.sessions.delete(sessionId);
    logger.info({ sessionId }, "Agent session deleted");
    return true;
  }

  async shutdown(): Promise<void> {
    logger.info(
      { sessionCount: this.sessions.size },
      "Shutting down AgentService",
    );
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      this.deleteSession(id);
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Fire-and-forget message persistence with up to 3 retries. Never throws, never blocks streaming. */
  private persistMessage(
    session: AgentSession,
    role: "user" | "assistant" | "tool_use" | "error" | "result",
    content: string | null,
    extra?: {
      toolId?: string;
      toolName?: string;
      toolInput?: Record<string, unknown>;
      toolOutput?: string;
      success?: boolean;
      cost?: number;
      duration?: number;
      turns?: number;
    },
  ): void {
    const MAX_IN_FLIGHT = 20;
    if (session.pendingPersistCount >= MAX_IN_FLIGHT) {
      logger.warn(
        { sessionId: session.id, pendingPersistCount: session.pendingPersistCount },
        "Max in-flight persist operations reached — dropping message",
      );
      return;
    }

    const sequence = session.nextSequence++;
    const messageData = {
      conversationId: session.conversationId,
      role,
      content: content ?? undefined,
      sequence,
      ...extra,
    };

    session.pendingPersistCount++;

    const attempt = (tries: number): void => {
      agentConversationService
        .addMessage(messageData)
        .then(() => {
          session.pendingPersistCount--;
          // Touch is best-effort metadata only; never retry addMessage based on touch failures.
          void agentConversationService
            .touchConversation(session.conversationId)
            .catch((touchErr: unknown) => {
              logger.warn(
                { touchErr, sessionId: session.id, conversationId: session.conversationId },
                "Failed to touch agent conversation updatedAt",
              );
            });
        })
        .catch((err: unknown) => {
          if (tries < 3) {
            const delay = 200 * tries; // 200ms, 400ms
            setTimeout(() => attempt(tries + 1), delay);
          } else {
            session.pendingPersistCount--;
            logger.error(
              { err, sessionId: session.id, sequence, role },
              "Failed to persist agent message after 3 attempts",
            );
          }
        });
    };

    attempt(1);
  }

  private broadcast(session: AgentSession, event: AgentEvent): void {
    const data = JSON.stringify(event);
    const failed: Response[] = [];

    for (const res of session.subscribers) {
      try {
        res.write(`data: ${data}\n\n`);
      } catch {
        failed.push(res);
      }
    }

    for (const res of failed) {
      session.subscribers.delete(res);
    }

    // Persistence side-effects (fire-and-forget, never blocks)
    switch (event.type) {
      case "tool_use":
        // Buffer tool input; it will be flushed when the tool result arrives
        session.pendingToolUse.set(event.data.toolId as string, {
          toolName: event.data.toolName as string,
          input: (event.data.input as Record<string, unknown>) ?? {},
        });
        break;

      case "tool_result": {
        const pending = session.pendingToolUse.get(event.data.toolId as string);
        session.pendingToolUse.delete(event.data.toolId as string);
        this.persistMessage(session, "tool_use", null, {
          toolId: event.data.toolId as string,
          toolName: pending?.toolName,
          toolInput: pending?.input,
          toolOutput: event.data.output as string | undefined,
        });
        break;
      }

      case "text":
        this.persistMessage(session, "assistant", event.data.content as string);
        break;

      case "result":
        this.persistMessage(session, "result", null, {
          success: event.data.success as boolean,
          cost: event.data.cost as number | undefined,
          duration: event.data.duration as number | undefined,
          turns: event.data.turns as number | undefined,
        });
        break;

      case "error":
        this.persistMessage(session, "error", event.data.message as string);
        break;
    }
  }

  private async runQueryLoop(
    session: AgentSession,
    capabilities: AgentCapabilities,
  ): Promise<void> {
    const bashGuardHook: HookCallbackMatcher = {
      matcher: "Bash",
      hooks: [
        createBashGuard({
          port: this.port,
          apiKey: this.apiKey,
          dockerEnabled: capabilities.dockerEnabled,
          ghEnabled: capabilities.ghEnabled,
        }),
      ],
    };

    const pathGuard = createPathGuard(AGENT_CWD);
    const readGuardHook: HookCallbackMatcher = {
      matcher: "Read",
      hooks: [pathGuard],
    };
    const globGuardHook: HookCallbackMatcher = {
      matcher: "Glob",
      hooks: [pathGuard],
    };

    // Build a minimal env for the agent subprocess. We allowlist only
    // the variables the CLI tools need — everything else (secrets, DB
    // credentials, API keys, etc.) is excluded so the agent can never
    // read them via /proc/self/environ or similar.
    const sessionEnv = buildSessionEnv(capabilities);

    // Create per-session MCP server with UI guidance tools
    const uiToolsServer = createUiToolsMcpServer(
      (event) => this.broadcast(session, event),
      () => session.currentPath,
    );

    try {
      const q = query({
        prompt: session.queue,
        options: {
          model: agentConfig.model,
          systemPrompt: buildSystemPrompt(this.port, capabilities),
          tools: ["Bash", "Read", "Glob"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          thinking: { type: agentConfig.thinking },
          effort: agentConfig.effort,
          maxTurns: agentConfig.maxTurns,
          cwd: AGENT_CWD,
          includePartialMessages: true,
          abortController: session.abortController,
          persistSession: true,
          env: sessionEnv,
          mcpServers: { "mini-infra-ui": uiToolsServer },
          hooks: {
            PreToolUse: [bashGuardHook, readGuardHook, globGuardHook],
          },
        },
      });

      for await (const msg of q) {
        if (session.abortController.signal.aborted) break;
        this.processSDKMessage(session, msg);
      }
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.name === "AbortError" || err.message.includes("aborted"))
      ) {
        logger.debug({ sessionId: session.id }, "Query loop aborted");
      } else {
        logger.error({ err, sessionId: session.id }, "Query loop error");
        this.broadcast(session, {
          type: "error",
          data: {
            message: err instanceof Error ? err.message : "Unknown agent error",
          },
        });
      }
    } finally {
      session.running = false;
      this.broadcast(session, { type: "done", data: {} });
    }
  }

  private processSDKMessage(session: AgentSession, msg: SDKMessage): void {
    switch (msg.type) {
      case "system": {
        if ("subtype" in msg && msg.subtype === "init") {
          const initMsg = msg as Extract<
            SDKMessage,
            { type: "system"; subtype: "init" }
          >;
          this.broadcast(session, {
            type: "init",
            data: { sessionId: session.id, model: initMsg.model },
          });
        }
        break;
      }

      case "stream_event": {
        const streamMsg = msg as Extract<SDKMessage, { type: "stream_event" }>;
        const event = streamMsg.event;

        // Capture the stable API message ID from message_start so all
        // thinking events in a turn share the same UUID — the SDK docs note
        // that each stream_event wrapper may carry its own unique uuid, so
        // we cannot rely on streamMsg.uuid being consistent across events.
        if (event.type === "message_start") {
          const startEvent = event as { type: "message_start"; message?: { id?: string } };
          session.currentTurnUuid = startEvent.message?.id ?? streamMsg.uuid;
        }

        // Use the stable turn UUID established at message_start; fall back to
        // the per-event uuid only when no turn has started yet.
        const assistantUuid = session.currentTurnUuid ?? streamMsg.uuid;

        if (event.type === "content_block_delta") {
          const delta = event.delta as {
            type: string;
            text?: string;
            thinking?: string;
            signature?: string;
          };
          if (delta.type === "text_delta" && delta.text) {
            this.broadcast(session, {
              type: "text_delta",
              data: { content: delta.text },
            });
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            this.broadcast(session, {
              type: "thinking_delta",
              data: {
                assistantUuid,
                blockIndex: event.index,
                content: delta.thinking,
              },
            });
          } else if (delta.type === "signature_delta" && delta.signature) {
            this.broadcast(session, {
              type: "thinking_signature",
              data: {
                assistantUuid,
                blockIndex: event.index,
                signature: delta.signature,
              },
            });
          }
        } else if (event.type === "content_block_start") {
          const block = event.content_block as {
            type: string;
            name?: string;
            id?: string;
          };
          if (block.type === "tool_use") {
            this.broadcast(session, {
              type: "tool_start",
              data: { toolName: block.name, toolId: block.id },
            });
          } else if (block.type === "thinking") {
            this.broadcast(session, {
              type: "thinking_start",
              data: {
                assistantUuid,
                blockIndex: event.index,
              },
            });
          }
        } else if (event.type === "message_stop") {
          this.broadcast(session, {
            type: "assistant_message_stop",
            data: { assistantUuid },
          });
          // Clear the stable turn UUID; the next turn will set a new one.
          session.currentTurnUuid = null;
        }
        break;
      }

      case "assistant": {
        const assistantMsg = msg as Extract<SDKMessage, { type: "assistant" }>;
        const content = assistantMsg.message?.content;
        if (Array.isArray(content)) {
          // Use the turn UUID that was established during streaming so that
          // thinking_complete can find the blocks already in the client's
          // messages list.  Fall back to the SDK message uuid when no streaming
          // turn preceded this message (e.g. thinking is disabled).
          const assistantUuid = session.currentTurnUuid ?? assistantMsg.uuid;
          // Now that we have emitted the final assistant message, clear the
          // turn UUID so it cannot leak into the next turn.
          session.currentTurnUuid = null;

          for (const [blockIndex, block] of content.entries()) {
            if (block.type === "text") {
              this.broadcast(session, {
                type: "text",
                data: {
                  content: (block as { type: "text"; text: string }).text,
                  uuid: assistantUuid,
                },
              });
            } else if (block.type === "thinking") {
              const thinkingBlock = block as {
                type: "thinking";
                thinking: string;
                signature?: string;
              };
              this.broadcast(session, {
                type: "thinking_complete",
                data: {
                  assistantUuid,
                  blockIndex,
                  content: thinkingBlock.thinking,
                  signature: thinkingBlock.signature,
                },
              });
            } else if (block.type === "redacted_thinking") {
              this.broadcast(session, {
                type: "thinking_redacted",
                data: {
                  assistantUuid,
                  blockIndex,
                  content: "Thinking content is redacted.",
                },
              });
            } else if (block.type === "tool_use") {
              const toolBlock = block as {
                type: "tool_use";
                name: string;
                id: string;
                input: unknown;
              };
              this.broadcast(session, {
                type: "tool_use",
                data: {
                  toolName: toolBlock.name,
                  toolId: toolBlock.id,
                  input: toolBlock.input as Record<string, unknown>,
                },
              });
            }
          }
        }
        break;
      }

      case "user": {
        // Extract tool results from the message content array.
        // The SDK emits user messages containing tool_result blocks after
        // executing tools. Each block has a tool_use_id that correlates
        // back to the assistant's tool_use content block.
        const userMsg = msg as Extract<SDKMessage, { type: "user" }>;
        const content = userMsg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type: string; tool_use_id?: string; content?: unknown };
            if (b.type === "tool_result" && b.tool_use_id) {
              const output = typeof b.content === "string"
                ? b.content
                : JSON.stringify(b.content ?? "");
              this.broadcast(session, {
                type: "tool_result",
                data: {
                  toolId: b.tool_use_id,
                  output,
                },
              });
            }
          }
        }
        break;
      }

      case "result": {
        const resultMsg = msg as Extract<SDKMessage, { type: "result" }>;
        this.broadcast(session, {
          type: "result",
          data: {
            success: !resultMsg.is_error,
            cost: "total_cost_usd" in resultMsg ? resultMsg.total_cost_usd : 0,
            duration: "duration_ms" in resultMsg ? resultMsg.duration_ms : 0,
            turns: "num_turns" in resultMsg ? resultMsg.num_turns : 0,
          },
        });
        break;
      }

      // Ignore other message types (auth_status, compact_boundary, etc.)
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton accessors
// ---------------------------------------------------------------------------

let agentServiceInstance: AgentService | null = null;

export function setAgentService(service: AgentService): void {
  agentServiceInstance = service;
}

export function getAgentService(): AgentService | null {
  return agentServiceInstance;
}

export { AgentService };
