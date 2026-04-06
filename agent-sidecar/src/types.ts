// ---------------------------------------------------------------------------
// Turn state machine
// ---------------------------------------------------------------------------
//
//   (created) --> running --> completed
//                   |   |
//                   |   +--> failed
//                   |   |
//                   |   +--> timeout
//                   |
//                   +------> cancelled
//
// "running" is the initial state set at creation time.
// Terminal states: completed, failed, cancelled, timeout
// ---------------------------------------------------------------------------

export type TurnStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export const TERMINAL_STATUSES: ReadonlySet<TurnStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timeout",
]);

// ---------------------------------------------------------------------------
// SSE event types — matches what the chat panel expects
// ---------------------------------------------------------------------------

export type SSEEventType =
  | "connected"
  | "init"
  | "text_delta"
  | "text"
  | "tool_start"
  | "tool_use"
  | "tool_result"
  | "thinking_start"
  | "thinking_delta"
  | "thinking_signature"
  | "thinking_complete"
  | "thinking_redacted"
  | "assistant_message_stop"
  | "ui_highlight"
  | "ui_navigate"
  | "error"
  | "result"
  | "done";

export interface SSEEvent {
  type: SSEEventType;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Token usage tracking
// ---------------------------------------------------------------------------

export interface TokenUsage {
  input: number;
  output: number;
}

// ---------------------------------------------------------------------------
// Turn — a single agent query/response cycle (stored in memory)
// ---------------------------------------------------------------------------

export interface Turn {
  id: string;
  status: TurnStatus;
  currentPath: string;
  /** The session ID returned by the Claude Agent SDK after the first turn. */
  claudeSessionId: string | null;
  tokenUsage: TokenUsage;
  turns: number;
  errorMessage: string | null;
  createdAt: string; // ISO 8601
  completedAt: string | null;
  durationMs: number | null;
}

// ---------------------------------------------------------------------------
// API request/response shapes
// ---------------------------------------------------------------------------

/** POST /turns request body */
export interface CreateTurnRequest {
  message: string;
  currentPath?: string;
  context?: Record<string, unknown>;
  /** Claude Agent SDK session ID to resume (continues prior conversation context). */
  sdkSessionId?: string;
}

/** POST /turns response (201) */
export interface CreateTurnResponse {
  id: string;
  status: TurnStatus;
  createdAt: string;
}

/** PUT /turns/:id/context request body */
export interface UpdateContextRequest {
  currentPath: string;
}

/** GET /health response (200) */
export interface HealthResponse {
  status: "ok";
  uptime: number; // seconds
  activeTurns: number;
  totalTurnsProcessed: number;
}
