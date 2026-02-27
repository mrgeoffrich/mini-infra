import { randomUUID } from "crypto";
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

const logger = agentLogger();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentEvent {
  type: string;
  data: Record<string, unknown>;
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
// bashGuard — PreToolUse hook that restricts Bash to curl-only localhost
// ---------------------------------------------------------------------------

function createBashGuard(port: number): HookCallback {
  return async (input) => {
    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as { command?: string } | undefined;
    const command = toolInput?.command ?? "";

    // Must start with curl
    if (!command.trimStart().startsWith("curl ")) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: `Only curl commands are allowed. Got: ${command.slice(0, 60)}`,
        },
      };
    }

    // No command chaining characters
    const chainPattern = /[;|`]|\$\(|&&|\|\|/;
    if (chainPattern.test(command)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason:
            "Command chaining is not allowed in agent curl commands.",
        },
      };
    }

    // URL must be localhost or 127.0.0.1 on the correct port
    const localhostPattern = new RegExp(
      `https?://(localhost|127\\.0\\.0\\.1):${port}(/|\\s|$|"|')`,
    );
    if (!localhostPattern.test(command)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: `curl target must be localhost:${port}. External requests are not allowed.`,
        },
      };
    }

    // Allow
    return {};
  };
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(apiKey: string, port: number): string {
  const baseUrl = `http://localhost:${port}`;

  return `You are the Mini Infra AI assistant. You help users understand and manage their Docker infrastructure, deployments, databases, and services.

## How to interact with the system

You have access to the Mini Infra API at ${baseUrl}. Use curl to call endpoints.

**Authentication:** Always include the header \`-H "x-api-key: ${apiKey}"\` in every curl command.

**Example:**
\`\`\`bash
curl -s -H "x-api-key: ${apiKey}" ${baseUrl}/api/containers
\`\`\`

${API_REFERENCE}

## Documentation

You can read documentation files in /app/agent/docs/ using the Read or Glob tools.

## Rules

1. **Only use curl** to interact with the API. Never run other shell commands.
2. **Always use -s** (silent) flag with curl to avoid progress bars.
3. **Always pipe through jq** when the output is JSON, for readability: \`curl -s ... | jq .\` — but only if jq is available; fall back to raw output otherwise.
4. **Be concise.** Summarize API responses for the user rather than dumping raw JSON.
5. **Be helpful.** If the user asks something vague, suggest what information you can look up.
6. **Never modify or delete** resources unless the user explicitly asks you to.
7. **Report errors clearly.** If an API call fails, explain what went wrong and suggest next steps.
`;
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

  createSession(userId: string, message: string): string {
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

    // Push initial message and start the query loop
    queue.push(message);
    this.runQueryLoop(session).catch((err) => {
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

  private async runQueryLoop(session: AgentSession): Promise<void> {
    const bashGuardHook: HookCallbackMatcher = {
      matcher: "Bash",
      hooks: [createBashGuard(this.port)],
    };

    try {
      const q = query({
        prompt: session.queue,
        options: {
          systemPrompt: buildSystemPrompt(this.apiKey, this.port),
          tools: ["Bash", "Read", "Glob"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 20,
          cwd: "/app/agent",
          includePartialMessages: true,
          abortController: session.abortController,
          persistSession: false,
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
