// ---------------------------------------------------------------------------
// Session state machine
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

export type SessionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
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
// Session — the core domain object (stored in memory)
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  status: SessionStatus;
  currentPath: string;
  sdkSessionId: string | null;
  tokenUsage: TokenUsage;
  turns: number;
  createdAt: string; // ISO 8601
  completedAt: string | null;
  durationMs: number | null;
}

// ---------------------------------------------------------------------------
// API request/response shapes
// ---------------------------------------------------------------------------

/** POST /sessions request body */
export interface CreateSessionRequest {
  message: string;
  currentPath?: string;
  context?: Record<string, unknown>;
  sdkSessionId?: string;
}

/** POST /sessions response (201) */
export interface CreateSessionResponse {
  id: string;
  status: SessionStatus;
  createdAt: string;
}

/** POST /sessions/:id/messages request body */
export interface SendMessageRequest {
  message: string;
}

/** PUT /sessions/:id/context request body */
export interface UpdateContextRequest {
  currentPath: string;
}

/** GET /health response (200) */
export interface HealthResponse {
  status: "ok";
  uptime: number; // seconds
  activeSessions: number;
  totalSessionsProcessed: number;
}
