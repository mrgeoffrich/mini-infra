import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";
import {
  Session,
  SessionStatus,
  TERMINAL_STATUSES,
  TokenUsage,
  SSEEvent,
  CreateSessionRequest,
} from "./types";
import { AsyncMessageQueue } from "./async-message-queue";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "./logger";

const MAX_SESSIONS = 20;
const MAX_CONCURRENT = 5;

// ---------------------------------------------------------------------------
// Internal session state (superset of the Session interface)
// ---------------------------------------------------------------------------

interface InternalSession extends Session {
  abortController: AbortController;
  emitter: EventEmitter;
  messageQueue: AsyncMessageQueue<SDKUserMessage>;
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore {
  private sessions = new Map<string, InternalSession>();
  private totalProcessed = 0;

  // -----------------------------------------------------------------------
  // Session creation
  // -----------------------------------------------------------------------

  createSession(req: CreateSessionRequest): InternalSession {
    const id = `sess_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();

    // Build the initial message content (with optional context appended)
    let messageText = req.message;
    if (req.context && Object.keys(req.context).length > 0) {
      messageText += `\n\nContext: ${JSON.stringify(req.context, null, 2)}`;
    }

    const messageQueue = new AsyncMessageQueue<SDKUserMessage>();
    messageQueue.push({
      type: "user",
      message: { role: "user", content: messageText },
      parent_tool_use_id: null,
      session_id: "",
    });

    const session: InternalSession = {
      id,
      status: "running",
      currentPath: req.currentPath ?? "",
      claudeSessionId: null,
      tokenUsage: { input: 0, output: 0 },
      turns: 0,
      errorMessage: null,
      createdAt: now,
      completedAt: null,
      durationMs: null,
      abortController: new AbortController(),
      emitter: new EventEmitter(),
      messageQueue,
    };

    this.sessions.set(id, session);
    this.totalProcessed++;
    this.evictOldSessions();

    logger.info(
      { sessionId: id, message: req.message.slice(0, 100) },
      "Session created",
    );
    return session;
  }

  // -----------------------------------------------------------------------
  // Session retrieval
  // -----------------------------------------------------------------------

  getSession(id: string): InternalSession | undefined {
    return this.sessions.get(id);
  }

  getActiveSessions(): InternalSession[] {
    return [...this.sessions.values()].filter((s) => s.status === "running");
  }

  getStats(): { activeSessions: number; totalSessionsProcessed: number } {
    return {
      activeSessions: this.getActiveSessions().length,
      totalSessionsProcessed: this.totalProcessed,
    };
  }

  // -----------------------------------------------------------------------
  // Concurrency check
  // -----------------------------------------------------------------------

  canAcceptSession(): boolean {
    return this.getActiveSessions().length < MAX_CONCURRENT;
  }

  // -----------------------------------------------------------------------
  // State transitions
  // -----------------------------------------------------------------------

  completeSession(id: string): boolean {
    return this.transitionSession(id, "completed");
  }

  failSession(id: string, error: string): boolean {
    const result = this.transitionSession(id, "failed");
    if (result) {
      const session = this.sessions.get(id);
      if (session) session.errorMessage = error;
    }
    return result;
  }

  cancelSession(id: string): boolean {
    return this.transitionSession(id, "cancelled");
  }

  timeoutSession(id: string): boolean {
    return this.transitionSession(id, "timeout");
  }

  private transitionSession(id: string, newStatus: SessionStatus): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    if (session.status !== "running") {
      logger.warn(
        {
          sessionId: id,
          currentStatus: session.status,
          requestedStatus: newStatus,
        },
        "Cannot transition session from non-running state",
      );
      return false;
    }

    const now = new Date().toISOString();
    session.status = newStatus;
    session.completedAt = now;
    session.durationMs =
      new Date(now).getTime() - new Date(session.createdAt).getTime();
    session.messageQueue.close();

    logger.info(
      { sessionId: id, status: newStatus, durationMs: session.durationMs },
      "Session transitioned",
    );
    return true;
  }

  // -----------------------------------------------------------------------
  // Token usage
  // -----------------------------------------------------------------------

  updateTokenUsage(id: string, usage: TokenUsage): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.tokenUsage = usage;
  }

  incrementTurns(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.turns++;
  }

  // -----------------------------------------------------------------------
  // SSE event emission
  // -----------------------------------------------------------------------

  emitSSE(id: string, event: SSEEvent): void {
    const session = this.sessions.get(id);
    if (session) {
      session.emitter.emit("sse", event);
    }
  }

  getEmitter(id: string): EventEmitter | undefined {
    return this.sessions.get(id)?.emitter;
  }

  // -----------------------------------------------------------------------
  // Session cleanup
  // -----------------------------------------------------------------------

  /** Push a follow-up message into a running session's queue. */
  pushMessage(id: string, text: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.status !== "running") return false;

    session.messageQueue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: session.claudeSessionId ?? "",
    });
    return true;
  }

  deleteSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.messageQueue.close();
    session.abortController.abort();

    if (session.status === "running") {
      session.status = "cancelled";
      session.completedAt = new Date().toISOString();
      session.durationMs =
        new Date(session.completedAt).getTime() -
        new Date(session.createdAt).getTime();
    }

    // Don't delete from map immediately — let stream handlers clean up
    logger.info({ sessionId: id }, "Session closed");
    return true;
  }

  removeSession(id: string): void {
    this.sessions.delete(id);
  }

  private evictOldSessions(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;

    for (const [id, session] of this.sessions) {
      if (this.sessions.size <= MAX_SESSIONS) break;
      if (TERMINAL_STATUSES.has(session.status)) {
        this.sessions.delete(id);
        logger.debug({ sessionId: id }, "Evicted old session");
      }
    }
  }
}
