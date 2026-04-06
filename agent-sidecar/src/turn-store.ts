import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";
import {
  Turn,
  TurnStatus,
  TERMINAL_STATUSES,
  TokenUsage,
  SSEEvent,
  CreateTurnRequest,
} from "./types";
import { AsyncMessageQueue } from "./async-message-queue";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "./logger";

const MAX_TURNS = 20;
const MAX_CONCURRENT = 5;

// ---------------------------------------------------------------------------
// Internal turn state (superset of the Turn interface)
// ---------------------------------------------------------------------------

interface InternalTurn extends Turn {
  abortController: AbortController;
  emitter: EventEmitter;
  messageQueue: AsyncMessageQueue<SDKUserMessage>;
}

// ---------------------------------------------------------------------------
// TurnStore
// ---------------------------------------------------------------------------

export class TurnStore {
  private turns = new Map<string, InternalTurn>();
  private totalProcessed = 0;

  // -----------------------------------------------------------------------
  // Turn creation
  // -----------------------------------------------------------------------

  createTurn(req: CreateTurnRequest): InternalTurn {
    const id = `turn_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
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

    const turn: InternalTurn = {
      id,
      status: "running",
      currentPath: req.currentPath ?? "",
      claudeSessionId: req.sdkSessionId ?? null,
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

    this.turns.set(id, turn);
    this.totalProcessed++;
    this.evictOldTurns();

    logger.info(
      { turnId: id, message: req.message.slice(0, 100) },
      "Turn created",
    );
    return turn;
  }

  // -----------------------------------------------------------------------
  // Turn retrieval
  // -----------------------------------------------------------------------

  getTurn(id: string): InternalTurn | undefined {
    return this.turns.get(id);
  }

  getActiveTurns(): InternalTurn[] {
    return [...this.turns.values()].filter((t) => t.status === "running");
  }

  getStats(): { activeTurns: number; totalTurnsProcessed: number } {
    return {
      activeTurns: this.getActiveTurns().length,
      totalTurnsProcessed: this.totalProcessed,
    };
  }

  // -----------------------------------------------------------------------
  // Concurrency check
  // -----------------------------------------------------------------------

  canAcceptTurn(): boolean {
    return this.getActiveTurns().length < MAX_CONCURRENT;
  }

  // -----------------------------------------------------------------------
  // State transitions
  // -----------------------------------------------------------------------

  completeTurn(id: string): boolean {
    return this.transitionTurn(id, "completed");
  }

  failTurn(id: string, error: string): boolean {
    const result = this.transitionTurn(id, "failed");
    if (result) {
      const turn = this.turns.get(id);
      if (turn) turn.errorMessage = error;
    }
    return result;
  }

  cancelTurn(id: string): boolean {
    return this.transitionTurn(id, "cancelled");
  }

  timeoutTurn(id: string): boolean {
    return this.transitionTurn(id, "timeout");
  }

  private transitionTurn(id: string, newStatus: TurnStatus): boolean {
    const turn = this.turns.get(id);
    if (!turn) return false;

    if (turn.status !== "running") {
      logger.warn(
        {
          turnId: id,
          currentStatus: turn.status,
          requestedStatus: newStatus,
        },
        "Cannot transition turn from non-running state",
      );
      return false;
    }

    const now = new Date().toISOString();
    turn.status = newStatus;
    turn.completedAt = now;
    turn.durationMs =
      new Date(now).getTime() - new Date(turn.createdAt).getTime();
    turn.messageQueue.close();

    logger.info(
      { turnId: id, status: newStatus, durationMs: turn.durationMs },
      "Turn transitioned",
    );
    return true;
  }

  // -----------------------------------------------------------------------
  // Token usage
  // -----------------------------------------------------------------------

  updateTokenUsage(id: string, usage: TokenUsage): void {
    const turn = this.turns.get(id);
    if (!turn) return;
    turn.tokenUsage = usage;
  }

  incrementTurns(id: string): void {
    const turn = this.turns.get(id);
    if (!turn) return;
    turn.turns++;
  }

  // -----------------------------------------------------------------------
  // SSE event emission
  // -----------------------------------------------------------------------

  emitSSE(id: string, event: SSEEvent): void {
    const turn = this.turns.get(id);
    if (turn) {
      turn.emitter.emit("sse", event);
    }
  }

  getEmitter(id: string): EventEmitter | undefined {
    return this.turns.get(id)?.emitter;
  }

  // -----------------------------------------------------------------------
  // Turn cleanup
  // -----------------------------------------------------------------------

  /** Push a follow-up message into a running turn's queue. */
  pushMessage(id: string, text: string): boolean {
    const turn = this.turns.get(id);
    if (!turn || turn.status !== "running") return false;

    turn.messageQueue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: turn.claudeSessionId ?? "",
    });
    return true;
  }

  deleteTurn(id: string): boolean {
    const turn = this.turns.get(id);
    if (!turn) return false;

    turn.messageQueue.close();
    turn.abortController.abort();

    if (turn.status === "running") {
      turn.status = "cancelled";
      turn.completedAt = new Date().toISOString();
      turn.durationMs =
        new Date(turn.completedAt).getTime() -
        new Date(turn.createdAt).getTime();
    }

    // Don't delete from map immediately — let stream handlers clean up
    logger.info({ turnId: id }, "Turn closed");
    return true;
  }

  removeTurn(id: string): void {
    this.turns.delete(id);
  }

  private evictOldTurns(): void {
    if (this.turns.size <= MAX_TURNS) return;

    for (const [id, turn] of this.turns) {
      if (this.turns.size <= MAX_TURNS) break;
      if (TERMINAL_STATUSES.has(turn.status)) {
        this.turns.delete(id);
        logger.debug({ turnId: id }, "Evicted old turn");
      }
    }
  }
}
