import { useState, useCallback, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AgentChatContext } from "@/lib/agent-chat-context";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { useAgentSession } from "@/hooks/use-agent-session";
import {
  useAgentConversations,
  useDeleteAgentConversation,
} from "@/hooks/use-agent-conversations";

interface AgentChatProviderProps {
  children: ReactNode;
}

export function AgentChatProvider({ children }: AgentChatProviderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const { data: statusData } = useAgentStatus();
  const agentEnabled = statusData?.enabled === true;
  const location = useLocation();
  const queryClient = useQueryClient();

  const {
    messages,
    streamingText,
    sessionStatus,
    session,
    model,
    activeConversationId,
    sendMessage,
    stopSession,
    startNewChat,
    loadConversation,
  } = useAgentSession(location.pathname);

  const { data: conversationsData } = useAgentConversations(agentEnabled);
  const conversations = conversationsData ?? [];

  const deleteConversationMutation = useDeleteAgentConversation();

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      await deleteConversationMutation.mutateAsync(conversationId);
      // If the deleted conversation was active, clear it
      if (activeConversationId === conversationId) {
        startNewChat();
      }
    },
    [deleteConversationMutation, activeConversationId, startNewChat],
  );

  // When a new conversation is created, refresh the list
  const wrappedSendMessage = useCallback(
    async (message: string) => {
      await sendMessage(message);
      void queryClient.invalidateQueries({ queryKey: ["agent-conversations"] });
    },
    [sendMessage, queryClient],
  );

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
        sendMessage: wrappedSendMessage,
        stopSession,
        startNewChat,
        activeConversationId,
        conversations,
        isHistoryOpen,
        setIsHistoryOpen,
        loadConversation,
        deleteConversation,
      }}
    >
      {children}
    </AgentChatContext.Provider>
  );
}
