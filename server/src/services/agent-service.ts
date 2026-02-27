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
} from "@anthropic-ai/claude-agent-sdk";
import { agentLogger } from "../lib/logger-factory";
import appConfig from "../lib/config-new";
import { API_REFERENCE } from "./agent-api-reference";
import { githubAppService } from "./github-app-service";
import { githubService } from "./github-service";

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

/** gh subcommands the agent is allowed to run (two-word minimum) */
const GH_ALLOWED_COMPOUND = new Set([
  "repo view",
  "repo list",
  "issue list",
  "issue view",
  "issue create",
  "pr list",
  "pr view",
  "pr create",
  "pr checks",
  "pr diff",
  "release list",
  "release view",
  "run list",
  "run view",
  "run watch",
]);

/** gh top-level subcommands that are always blocked */
const GH_BLOCKED_SUBCOMMANDS = new Set([
  "auth",
  "ssh-key",
  "gpg-key",
]);

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
  const args = command.trimStart().replace(/^docker\s+/, "").trim();
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
  const args = command.trimStart().replace(/^gh\s+/, "").trim();
  if (!args) {
    return denyResult("gh command requires a subcommand.");
  }

  const parts = args.split(/\s+/);
  const sub1 = parts[0];
  const sub2 = parts.length > 1 ? `${parts[0]} ${parts[1]}` : null;

  // Block dangerous top-level subcommands
  if (GH_BLOCKED_SUBCOMMANDS.has(sub1)) {
    return denyResult(
      `gh subcommand "${sub1}" is not allowed for security reasons.`,
    );
  }

  // "gh config set" is blocked but "gh config" generally is fine to read
  if (sub2 === "config set") {
    return denyResult("gh config set is not allowed for security reasons.");
  }

  // "gh repo delete" and "gh repo create" are blocked
  if (sub2 === "repo delete" || sub2 === "repo create") {
    return denyResult(`gh ${sub2} is not allowed for security reasons.`);
  }

  // "gh api" is allowed (scoped by token permissions)
  if (sub1 === "api") {
    return null; // allowed
  }

  // Check against the compound allowlist
  if (sub2 && GH_ALLOWED_COMPOUND.has(sub2)) {
    return null; // allowed
  }

  return denyResult(
    `gh subcommand "${sub2 || sub1}" is not allowed. Allowed: ${[...GH_ALLOWED_COMPOUND, "api"].join(", ")}`,
  );
}

interface BashGuardOptions {
  port: number;
  dockerEnabled: boolean;
  ghEnabled: boolean;
}

function createBashGuard(options: BashGuardOptions): HookCallback {
  const { port, dockerEnabled, ghEnabled } = options;

  return async (input) => {
    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as { command?: string } | undefined;
    const command = toolInput?.command ?? "";
    const trimmed = command.trimStart();

    // Universal: no command chaining characters
    const chainPattern = /[;|`]|\$\(|&&|\|\|/;
    if (chainPattern.test(command)) {
      return denyResult(
        "Command chaining is not allowed in agent commands.",
      );
    }

    // Determine which tool is being invoked
    if (trimmed.startsWith("curl ")) {
      const result = validateCurlCommand(command, port);
      return result ?? {};
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
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  apiKey: string,
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

Use curl to call the Mini Infra API at ${baseUrl}.

**Authentication:** Always include the header \`-H "x-api-key: ${apiKey}"\` in every curl command.

**Example:**
\`\`\`bash
curl -s -H "x-api-key: ${apiKey}" ${baseUrl}/api/containers
\`\`\`

${API_REFERENCE}
`;

  if (capabilities.dockerEnabled) {
    prompt += `
## Docker CLI

You have direct access to the Docker CLI. Use it for container logs, live stats, and detailed inspection.

**Available commands:**
- \`docker ps\` — list running containers (\`-a\` for all)
- \`docker logs <container>\` — view container logs (\`--tail 100\`, \`--since 1h\`)
- \`docker inspect <container>\` — detailed container/image metadata
- \`docker images\` — list images
- \`docker stats --no-stream\` — resource usage snapshot
- \`docker top <container>\` — processes running in a container
- \`docker port <container>\` — port mappings
- \`docker diff <container>\` — filesystem changes
- \`docker start/stop/restart <container>\` — manage container lifecycle
- \`docker network ls\`, \`docker network inspect <network>\` — networking
- \`docker volume ls\`, \`docker volume inspect <volume>\` — volumes
- \`docker compose ps\`, \`docker compose logs\` — Compose services

**When to use Docker CLI vs API:**
- Use the **API** for structured data, deployments, and operations that need Mini Infra tracking.
- Use **Docker CLI** for live logs, stats, detailed inspect output, and troubleshooting.
`;
  }

  if (capabilities.ghEnabled) {
    prompt += `
## GitHub CLI (gh)

You have access to the GitHub CLI with pre-configured authentication.

**Available commands:**
- \`gh repo view [owner/repo]\` — repository details
- \`gh repo list [owner]\` — list repositories
- \`gh issue list\`, \`gh issue view <number>\`, \`gh issue create\` — issues
- \`gh pr list\`, \`gh pr view <number>\`, \`gh pr create\` — pull requests
- \`gh pr checks <number>\`, \`gh pr diff <number>\` — PR checks and diffs
- \`gh release list\`, \`gh release view <tag>\` — releases
- \`gh run list\`, \`gh run view <id>\`, \`gh run watch <id>\` — workflow runs
- \`gh api <endpoint>\` — raw GitHub API calls (e.g. \`gh api repos/owner/repo\`)

**Examples:**
\`\`\`bash
gh pr list --repo owner/repo --state open
gh issue view 42 --repo owner/repo
gh run list --repo owner/repo --limit 5
\`\`\`
`;
  }

  prompt += `
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

    // Try to resolve a GitHub token
    let ghToken: string | null = null;
    try {
      // Primary: GitHub App installation token (short-lived, scoped)
      const { token } = await githubAppService.generateInstallationToken();
      ghToken = token;
      logger.debug("Resolved GitHub token from GitHub App installation");
    } catch {
      // Fallback: Personal Access Token
      try {
        const pat = await githubService.get("personal_access_token");
        if (pat) {
          ghToken = pat;
          logger.debug("Resolved GitHub token from Personal Access Token");
        }
      } catch (err) {
        logger.debug({ err }, "No GitHub PAT available");
      }
    }

    return {
      dockerEnabled,
      ghEnabled: !!ghToken,
      ghToken,
    };
  }

  async createSession(userId: string, message: string): Promise<string> {
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
    };

    this.sessions.set(sessionId, session);

    // Resolve capabilities (Docker, GitHub) before starting the loop
    const capabilities = await this.resolveCapabilities();
    logger.info(
      { sessionId, dockerEnabled: capabilities.dockerEnabled, ghEnabled: capabilities.ghEnabled },
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
          dockerEnabled: capabilities.dockerEnabled,
          ghEnabled: capabilities.ghEnabled,
        }),
      ],
    };

    // Build a minimal env for the agent subprocess. We allowlist only
    // the variables the CLI tools need — everything else (secrets, DB
    // credentials, API keys, etc.) is excluded so the agent can never
    // read them via /proc/self/environ or similar.
    const sessionEnv = buildSessionEnv(capabilities);

    try {
      const q = query({
        prompt: session.queue,
        options: {
          systemPrompt: buildSystemPrompt(this.apiKey, this.port, capabilities),
          tools: ["Bash", "Read", "Glob"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 20,
          cwd: AGENT_CWD,
          includePartialMessages: true,
          abortController: session.abortController,
          persistSession: false,
          env: sessionEnv,
          hooks: {
            PreToolUse: [bashGuardHook],
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
            message:
              err instanceof Error ? err.message : "Unknown agent error",
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
        const userMsg = msg as Extract<SDKMessage, { type: "user" }>;
        if (userMsg.isSynthetic && userMsg.tool_use_result !== undefined) {
          // Tool result (synthetic user message)
          const toolResult = userMsg.tool_use_result;
          // Extract tool_use_id from the message content if available
          const messageContent = userMsg.message?.content;
          let toolId: string | undefined;
          if (Array.isArray(messageContent)) {
            for (const block of messageContent) {
              if (
                typeof block === "object" &&
                block !== null &&
                "type" in block &&
                block.type === "tool_result" &&
                "tool_use_id" in block
              ) {
                toolId = (block as { tool_use_id: string }).tool_use_id;
                break;
              }
            }
          }
          this.broadcast(session, {
            type: "tool_result",
            data: {
              toolId,
              output:
                typeof toolResult === "string"
                  ? toolResult
                  : JSON.stringify(toolResult),
            },
          });
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
            duration:
              "duration_ms" in resultMsg ? resultMsg.duration_ms : 0,
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
