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
  queue: AgentMessageQueue;
  abortController: AbortController;
  subscribers: Set<Response>;
  createdAt: Date;
  running: boolean;
  currentPath: string;
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
- Use \`get_current_page\` to find out which page the user is currently viewing.
- Read manifest files in \`${AGENT_CWD}/docs/ui-elements/\` to discover available element IDs and routes.
- Use \`navigate_to\` to take the user to a page, and \`highlight_element\` to spotlight a specific element.

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

  async createSession(userId: string, message: string, currentPath?: string): Promise<string> {
    const sessionId = randomUUID();
    const queue = new AgentMessageQueue();
    const abortController = new AbortController();

    const session: AgentSession = {
      id: sessionId,
      userId,
      queue,
      abortController,
      subscribers: new Set(),
      createdAt: new Date(),
      running: true,
      currentPath: currentPath ?? "",
    };

    this.sessions.set(sessionId, session);

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

    logger.info({ sessionId, userId }, "Agent session created");
    return sessionId;
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
          persistSession: false,
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

        if (event.type === "content_block_delta") {
          const delta = event.delta as { type: string; text?: string };
          if (delta.type === "text_delta" && delta.text) {
            this.broadcast(session, {
              type: "text_delta",
              data: { content: delta.text },
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
          }
        }
        break;
      }

      case "assistant": {
        const assistantMsg = msg as Extract<SDKMessage, { type: "assistant" }>;
        const content = assistantMsg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              this.broadcast(session, {
                type: "text",
                data: {
                  content: (block as { type: "text"; text: string }).text,
                  uuid: assistantMsg.uuid,
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
