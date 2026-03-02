import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentConversationSummary, AgentConversationDetail } from "@mini-infra/types";

const CONVERSATIONS_QUERY_KEY = ["agent-conversations"];

async function fetchConversations(limit = 50): Promise<AgentConversationSummary[]> {
  const res = await fetch(`/api/agent/conversations?limit=${limit}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to fetch conversations");
  const data = (await res.json()) as { conversations: AgentConversationSummary[] };
  return data.conversations;
}

export async function fetchConversationDetail(id: string): Promise<AgentConversationDetail> {
  const res = await fetch(`/api/agent/conversations/${id}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to fetch conversation");
  const data = (await res.json()) as { conversation: AgentConversationDetail };
  return data.conversation;
}

async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`/api/agent/conversations/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to delete conversation");
}

export function useAgentConversations(enabled: boolean) {
  return useQuery({
    queryKey: CONVERSATIONS_QUERY_KEY,
    queryFn: () => fetchConversations(),
    enabled,
    staleTime: 30_000,
  });
}

export function useDeleteAgentConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteConversation,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY });
    },
  });
}

export function useInvalidateAgentConversations() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY });
}
