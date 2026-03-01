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
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
}

export interface AgentConversationDetail extends AgentConversationSummary {
  messages: AgentPersistedMessage[];
}
