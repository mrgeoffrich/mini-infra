import type { AgentConversationSummary } from "@mini-infra/types";

export type SessionStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "waiting"
  | "done"
  | "error";

export interface ChatMessageUser {
  id: string;
  role: "user";
  content: string;
  timestamp: number;
}

export interface ChatMessageAssistant {
  id: string;
  role: "assistant";
  content: string;
  timestamp: number;
}

export interface ChatMessageToolUse {
  id: string;
  role: "tool_use";
  toolId: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: string;
  timestamp: number;
}

export interface ChatMessageThinking {
  id: string;
  role: "thinking";
  assistantUuid: string;
  blockIndex: number;
  content: string;
  signature?: string;
  status: "streaming" | "complete";
  redacted?: boolean;
  timestamp: number;
}

export interface ChatMessageError {
  id: string;
  role: "error";
  content: string;
  timestamp: number;
}

export interface ChatMessageResult {
  id: string;
  role: "result";
  success: boolean;
  cost?: number;
  duration?: number;
  turns?: number;
  timestamp: number;
}

export type ChatMessage =
  | ChatMessageUser
  | ChatMessageAssistant
  | ChatMessageToolUse
  | ChatMessageThinking
  | ChatMessageError
  | ChatMessageResult;

export interface AgentSession {
  sessionId: string;
  conversationId?: string;
  model?: string;
}

export interface AgentChatContextType {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  agentEnabled: boolean;
  messages: ChatMessage[];
  streamingText: string;
  sessionStatus: SessionStatus;
  session: AgentSession | null;
  model: string | null;
  sendMessage: (message: string) => Promise<void>;
  stopSession: () => void;
  startNewChat: () => void;
  // Conversation history
  activeConversationId: string | null;
  conversations: AgentConversationSummary[];
  isHistoryOpen: boolean;
  setIsHistoryOpen: (open: boolean) => void;
  loadConversation: (conversationId: string, messages: ChatMessage[]) => void;
  deleteConversation: (conversationId: string) => Promise<void>;
}

// Re-export for convenience
export type { AgentConversationSummary };
