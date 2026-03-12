import { useQuery, UseQueryResult } from "@tanstack/react-query";

interface AgentStatusResponse {
  enabled: boolean;
  sidecarAvailable: boolean;
  reason?: string;
}

async function fetchAgentStatus(): Promise<AgentStatusResponse> {
  const response = await fetch("/api/agent/status", {
    method: "GET",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch agent status: ${response.status}`);
  }

  return response.json();
}

export function useAgentStatus(): UseQueryResult<AgentStatusResponse, Error> {
  return useQuery({
    queryKey: ["agent", "status"],
    queryFn: fetchAgentStatus,
    staleTime: 30 * 1000,
    gcTime: 60 * 1000,
    retry: 1,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
}
