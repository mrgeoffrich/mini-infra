import { agentLogger } from "../lib/logger-factory";
import { agentConversationService } from "./agent-conversation-service";
import {
  getAgentSidecarUrl,
  getInternalToken,
  isAgentSidecarHealthy,
  proxyToSidecar,
} from "./agent-sidecar";

const logger = agentLogger();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** In-memory mapping from sidecar session ID to local state */
interface SessionMapping {
  userId: string;
  conversationId: string;
  nextSequence: number;
  pendingPersistCount: number;
  /** Buffered tool_use input keyed by toolId, flushed on tool_result. */
  pendingToolUse: Map<
    string,
    { toolName: string; input: Record<string, unknown> }
  >;
}

interface AgentEvent {
  type: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AgentProxyService — thin proxy to sidecar + conversation persistence
// ---------------------------------------------------------------------------

class AgentProxyService {
  private sessions = new Map<string, SessionMapping>();

  // -----------------------------------------------------------------------
  // Session lifecycle
  // -----------------------------------------------------------------------

  async createSession(
    userId: string,
    message: string,
    currentPath?: string,
    existingConversationId?: string,
  ): Promise<{ sessionId: string; conversationId: string }> {
    // 1. Create or verify conversation in DB
    let conversationId: string;
    let initialSequence = 0;

    let sdkSessionId: string | undefined;

    if (existingConversationId) {
      const existing = await agentConversationService.getConversationDetail(
        existingConversationId,
        userId,
      );
      if (existing) {
        conversationId = existingConversationId;
        const maxSeq = existing.messages.reduce(
          (max, m) => Math.max(max, m.sequence),
          -1,
        );
        initialSequence = maxSeq + 1;
        // Look up the SDK session ID for resume
        const storedSdkSessionId = await agentConversationService.getSdkSessionId(
          existingConversationId,
        );
        if (storedSdkSessionId) {
          sdkSessionId = storedSdkSessionId;
        }
      } else {
        conversationId = await agentConversationService.createConversation(
          userId,
          message,
        );
      }
    } else {
      conversationId = await agentConversationService.createConversation(
        userId,
        message,
      );
    }

    // 2. Proxy to sidecar
    const response = await proxyToSidecar("/turns", {
      method: "POST",
      body: { message, currentPath, sdkSessionId },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Sidecar turn creation failed: ${response.status} ${text}`,
      );
    }

    const data = (await response.json()) as {
      id: string;
      status: string;
      createdAt: string;
    };
    const sessionId = data.id;

    // 3. Store mapping
    this.sessions.set(sessionId, {
      userId,
      conversationId,
      nextSequence: initialSequence,
      pendingPersistCount: 0,
      pendingToolUse: new Map(),
    });

    // 4. Persist initial user message (fire-and-forget)
    this.persistMessage(sessionId, "user", message);

    logger.info(
      { sessionId, userId, conversationId },
      "Agent session created via sidecar",
    );
    return { sessionId, conversationId };
  }

  async updateContext(
    sessionId: string,
    currentPath: string,
  ): Promise<boolean> {
    try {
      const response = await proxyToSidecar(
        `/turns/${sessionId}/context`,
        {
          method: "PUT",
          body: { currentPath },
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      await proxyToSidecar(`/turns/${sessionId}`, {
        method: "DELETE",
      });
    } catch {
      // Sidecar might be down, still clean up mapping
    }
    this.sessions.delete(sessionId);
    logger.info({ sessionId }, "Agent session deleted");
    return true;
  }

  getSessionMapping(sessionId: string): SessionMapping | undefined {
    return this.sessions.get(sessionId);
  }

  // -----------------------------------------------------------------------
  // SSE relay — connect to sidecar stream, pipe to client, persist as side-effect
  // -----------------------------------------------------------------------

  async connectToSidecarStream(
    sessionId: string,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const url = getAgentSidecarUrl();
    if (!url) return null;

    const token = getInternalToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(`${url}/turns/${sessionId}/stream`, {
      headers,
      signal: AbortSignal.timeout(600_000),
    });

    if (!response.ok || !response.body) {
      return null;
    }

    return response.body;
  }

  /**
   * Parse an SSE event from the sidecar and persist it to the conversation DB.
   * Called from the route handler as events flow through.
   */
  persistFromSSEEvent(sessionId: string, event: AgentEvent): void {
    const mapping = this.sessions.get(sessionId);
    if (!mapping) return;

    switch (event.type) {
      case "init": {
        // Capture the SDK session ID returned by the sidecar
        const sdkId = event.data.sdkSessionId as string | undefined;
        if (sdkId && mapping.conversationId) {
          agentConversationService
            .updateSdkSessionId(mapping.conversationId, sdkId)
            .catch((err: unknown) => {
              logger.warn(
                { err, sessionId, sdkSessionId: sdkId },
                "Failed to persist SDK session ID",
              );
            });
        }
        break;
      }

      case "tool_use":
        // Buffer tool input; flushed when tool_result arrives
        mapping.pendingToolUse.set(event.data.toolId as string, {
          toolName: event.data.toolName as string,
          input: (event.data.input as Record<string, unknown>) ?? {},
        });
        break;

      case "tool_result": {
        const pending = mapping.pendingToolUse.get(
          event.data.toolId as string,
        );
        mapping.pendingToolUse.delete(event.data.toolId as string);
        this.persistMessage(sessionId, "tool_use", null, {
          toolId: event.data.toolId as string,
          toolName: pending?.toolName,
          toolInput: pending?.input,
          toolOutput: event.data.output as string | undefined,
        });
        break;
      }

      case "text":
        this.persistMessage(
          sessionId,
          "assistant",
          event.data.content as string,
        );
        break;

      case "result":
        this.persistMessage(sessionId, "result", null, {
          success: event.data.success as boolean,
          cost: event.data.cost as number | undefined,
          duration: event.data.duration as number | undefined,
          turns: event.data.turns as number | undefined,
        });
        break;

      case "error":
        this.persistMessage(
          sessionId,
          "error",
          event.data.message as string,
        );
        break;

      case "done":
        // Clean up session mapping after a delay to let persistence complete
        setTimeout(() => {
          this.sessions.delete(sessionId);
        }, 5000);
        break;
    }
  }

  async shutdown(): Promise<void> {
    logger.info(
      { sessionCount: this.sessions.size },
      "Shutting down AgentProxyService",
    );
    // Clean up all session mappings
    for (const sessionId of this.sessions.keys()) {
      try {
        await this.deleteSession(sessionId);
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
  }

  // -----------------------------------------------------------------------
  // Private: fire-and-forget persistence
  // -----------------------------------------------------------------------

  private persistMessage(
    sessionId: string,
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
    const mapping = this.sessions.get(sessionId);
    if (!mapping) return;

    const MAX_IN_FLIGHT = 20;
    if (mapping.pendingPersistCount >= MAX_IN_FLIGHT) {
      logger.warn(
        {
          sessionId,
          pendingPersistCount: mapping.pendingPersistCount,
        },
        "Max in-flight persist operations reached — dropping message",
      );
      return;
    }

    const sequence = mapping.nextSequence++;
    const messageData = {
      conversationId: mapping.conversationId,
      role,
      content: content ?? undefined,
      sequence,
      ...extra,
    };

    mapping.pendingPersistCount++;

    const attempt = (tries: number): void => {
      agentConversationService
        .addMessage(messageData)
        .then(() => {
          mapping.pendingPersistCount--;
          void agentConversationService
            .touchConversation(mapping.conversationId)
            .catch((touchErr: unknown) => {
              logger.warn(
                {
                  touchErr,
                  sessionId,
                  conversationId: mapping.conversationId,
                },
                "Failed to touch agent conversation updatedAt",
              );
            });
        })
        .catch((err: unknown) => {
          if (tries < 3) {
            const delay = 200 * tries;
            setTimeout(() => attempt(tries + 1), delay);
          } else {
            mapping.pendingPersistCount--;
            logger.error(
              { err, sessionId, sequence, role },
              "Failed to persist agent message after 3 attempts",
            );
          }
        });
    };

    attempt(1);
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let agentProxyServiceInstance: AgentProxyService | null = null;

export function getAgentService(): AgentProxyService | null {
  return agentProxyServiceInstance;
}

export function setAgentService(service: AgentProxyService | null): void {
  agentProxyServiceInstance = service;
}

/**
 * Check if the agent system is available (API key configured + sidecar healthy).
 */
export function isAgentAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY && isAgentSidecarHealthy();
}

/**
 * Get the reason the agent is unavailable, if any.
 */
export function getAgentUnavailableReason(): string | null {
  if (!process.env.ANTHROPIC_API_KEY) return "api_key_not_configured";
  if (!getAgentSidecarUrl()) return "sidecar_unavailable";
  if (!isAgentSidecarHealthy()) return "sidecar_unhealthy";
  return null;
}

export { AgentProxyService };
