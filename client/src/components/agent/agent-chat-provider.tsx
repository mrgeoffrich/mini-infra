import { useState, type ReactNode } from "react";
import { AgentChatContext } from "@/lib/agent-chat-context";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { useAgentSession } from "@/hooks/use-agent-session";

interface AgentChatProviderProps {
  children: ReactNode;
}

export function AgentChatProvider({ children }: AgentChatProviderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { data: statusData } = useAgentStatus();
  const agentEnabled = statusData?.enabled === true;

  const {
    messages,
    streamingText,
    sessionStatus,
    session,
    model,
    sendMessage,
    startNewChat,
  } = useAgentSession();

  return (
    <AgentChatContext.Provider
      value={{
        isOpen,
        setIsOpen,
        agentEnabled,
        messages,
        streamingText,
        sessionStatus,
        session,
        model,
        sendMessage,
        startNewChat,
      }}
    >
      {children}
    </AgentChatContext.Provider>
  );
}
