// ---------------------------------------------------------------------------
// Task status state machine
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

export type TaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timeout",
]);

// ---------------------------------------------------------------------------
// Tool call record (accumulated during task execution)
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  timestamp: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Token usage tracking
// ---------------------------------------------------------------------------

export interface TokenUsage {
  input: number;
  output: number;
}

// ---------------------------------------------------------------------------
// Task — the core domain object (stored in memory)
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  status: TaskStatus;
  prompt: string;
  context?: Record<string, unknown>;
  result: string | null;
  error: string | null;
  toolCalls: ToolCallRecord[];
  tokenUsage: TokenUsage;
  createdAt: string; // ISO 8601
  completedAt: string | null; // ISO 8601
  durationMs: number | null;
}

// ---------------------------------------------------------------------------
// API request/response shapes
// ---------------------------------------------------------------------------

/** POST /tasks request body */
export interface CreateTaskRequest {
  prompt: string;
  context?: Record<string, unknown>;
}

/** POST /tasks response (201) */
export interface CreateTaskResponse {
  id: string;
  status: TaskStatus;
  prompt: string;
  createdAt: string;
}

/** GET /tasks/:id response (200) */
export type GetTaskResponse = Task;

/** GET /tasks response (200) */
export interface ListTasksResponse {
  tasks: TaskSummary[];
}

/** Task summary for list endpoint */
export interface TaskSummary {
  id: string;
  status: TaskStatus;
  prompt: string;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

/** POST /tasks/:id/cancel response (200) */
export interface CancelTaskResponse {
  id: string;
  status: "cancelled";
}

/** GET /health response (200) */
export interface HealthResponse {
  status: "ok";
  uptime: number; // seconds
  activeTasks: number;
  totalTasksProcessed: number;
}

// ---------------------------------------------------------------------------
// SSE event types
// ---------------------------------------------------------------------------

export type SSEEventType =
  | "status"
  | "tool_call"
  | "tool_result"
  | "text"
  | "complete"
  | "error";

export interface SSEStatusEvent {
  status: TaskStatus;
  message: string;
}

export interface SSEToolCallEvent {
  tool: string;
  input: Record<string, unknown>;
}

export interface SSEToolResultEvent {
  tool: string;
  summary: string;
}

export interface SSETextEvent {
  content: string;
}

export interface SSECompleteEvent {
  status: "completed";
  result: string;
}

export interface SSEErrorEvent {
  status: "failed" | "timeout";
  error: string;
}

export type SSEEventData =
  | SSEStatusEvent
  | SSEToolCallEvent
  | SSEToolResultEvent
  | SSETextEvent
  | SSECompleteEvent
  | SSEErrorEvent;

export interface SSEEvent {
  type: SSEEventType;
  data: SSEEventData;
}
