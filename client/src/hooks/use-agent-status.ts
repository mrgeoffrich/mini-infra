import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type { AgentStatusResponse } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

async function fetchAgentStatus(): Promise<AgentStatusResponse> {
  return apiFetch<AgentStatusResponse>(ApiRoute.agent.status(), {
    unwrap: false,
    correlationIdPrefix: "agent-status",
  });
}

// No continuous "status changed" push event exists for agent status — it's
// derived from whether an API key is configured plus sidecar health, and the
// only related socket events (SIDECAR_STARTUP_STARTED/STEP/COMPLETED on
// Channel.AGENT_SIDECAR) fire only around an explicit sidecar restart, which
// already invalidates this query via useAgentSidecarStartupProgress's
// invalidateKeys (see use-agent-settings.ts). Unlike Channel.VAULT's
// VAULT_STATUS_CHANGED, there's no background watcher pushing continuous
// status transitions, so periodic polling stays.
export function useAgentStatus(): UseQueryResult<AgentStatusResponse, Error> {
  return useQuery({
    queryKey: queryKeys.agent.status,
    queryFn: fetchAgentStatus,
    staleTime: 30 * 1000,
    gcTime: 60 * 1000,
    retry: 1,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
}
