import { useContext } from "react";
import { AgentChatContextType } from "../lib/agent-chat-types";
import { AgentChatContext } from "../lib/agent-chat-context";

export function useAgentChat(): AgentChatContextType {
  const context = useContext(AgentChatContext);
  if (context === undefined) {
    throw new Error("useAgentChat must be used within an AgentChatProvider");
  }
  return context;
}
