import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type { AgentConversationSummary, AgentConversationDetail } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

async function fetchConversations(limit = 50): Promise<AgentConversationSummary[]> {
  const url = new URL(ApiRoute.agent.conversations(), window.location.origin);
  url.searchParams.set("limit", String(limit));
  const data = await apiFetch<{ conversations: AgentConversationSummary[] }>(
    url.toString(),
    { unwrap: false, correlationIdPrefix: "agent-conversations" },
  );
  return data.conversations;
}

export async function fetchConversationDetail(id: string): Promise<AgentConversationDetail> {
  const data = await apiFetch<{ conversation: AgentConversationDetail }>(
    ApiRoute.agent.conversation(id),
    { unwrap: false, correlationIdPrefix: "agent-conversation" },
  );
  return data.conversation;
}

async function deleteConversation(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(ApiRoute.agent.conversation(id), {
    method: "DELETE",
    unwrap: false,
    correlationIdPrefix: "agent-conversation-delete",
  });
}

export function useAgentConversations(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.agent.conversations(),
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.agent.conversations() });
    },
  });
}

export function useInvalidateAgentConversations() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.agent.conversations() });
}
