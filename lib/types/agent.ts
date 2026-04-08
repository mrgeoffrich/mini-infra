// Agent conversation types shared between client and server

export type AgentMessageRole =
  | "user"
  | "assistant"
  | "tool_use"
  | "error"
  | "result";

export interface AgentPersistedMessage {
  id: string;
  conversationId: string;
  role: AgentMessageRole;
  content: string | null;
  toolId: string | null;
  toolName: string | null;
  toolInput: Record<string, unknown> | null;
  toolOutput: string | null;
  success: boolean | null;
  cost: number | null;
  duration: number | null;
  turns: number | null;
  sequence: number;
  createdAt: string; // ISO date string
}

export interface AgentConversationSummary {
  id: string;
  userId: string;
  title: string;
  sdkSessionId?: string | null;
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
}

export interface AgentConversationDetail extends AgentConversationSummary {
  messages: AgentPersistedMessage[];
}

// Agent settings types

export type AgentConfigSource = "environment" | "database" | "default" | "none";

export interface AgentSettingsResponse {
  apiKey: {
    configured: boolean;
    source: AgentConfigSource;
    maskedKey: string | null; // e.g. "sk-ant-...abcd"
  };
  model: {
    current: string;
    source: AgentConfigSource;
    available: { id: string; label: string }[];
  };
  capabilities: {
    github: { available: boolean };
    api: { available: boolean };
  };
  advanced: {
    thinking: string;
    effort: string;
  };
}

export interface UpdateAgentSettingsRequest {
  apiKey?: string;
  model?: string;
}

export interface AgentApiKeyValidationResponse {
  success: boolean;
  valid: boolean;
  message: string;
}

// Agent Sidecar types

export type AgentSidecarTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface AgentSidecarTaskSummary {
  id: string;
  externalId: string;
  status: AgentSidecarTaskStatus;
  prompt: string;
  triggeredBy: string;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export interface AgentSidecarTaskDetail extends AgentSidecarTaskSummary {
  result: string | null;
  errorMessage: string | null;
  tokenUsage: { input: number; output: number } | null;
  context: Record<string, unknown> | null;
  toolCalls?: Array<{
    tool: string;
    input: Record<string, unknown>;
    timestamp: string;
  }>;
}

export interface AgentSidecarStatus {
  available: boolean;
  containerRunning: boolean;
  containerId: string | null;
  health: {
    status: "ok" | "unhealthy" | "unavailable";
    uptime: number | null;
    activeTasks: number;
    totalTasksProcessed: number;
  } | null;
}

export interface AgentSidecarConfig {
  image: string | null;
  model: string;
  timeoutMs: number;
  autoStart: boolean;
}
