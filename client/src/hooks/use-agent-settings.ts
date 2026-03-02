import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  AgentSettingsResponse,
  UpdateAgentSettingsRequest,
  AgentApiKeyValidationResponse,
} from "@mini-infra/types";

async function fetchAgentSettings(): Promise<AgentSettingsResponse> {
  const response = await fetch("/api/agent/settings", {
    method: "GET",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch agent settings: ${response.status}`);
  }
  return response.json();
}

export function useAgentSettings(): UseQueryResult<AgentSettingsResponse, Error> {
  return useQuery({
    queryKey: ["agent", "settings"],
    queryFn: fetchAgentSettings,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useUpdateAgentSettings(): UseMutationResult<
  AgentSettingsResponse,
  Error,
  UpdateAgentSettingsRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: UpdateAgentSettingsRequest) => {
      const response = await fetch("/api/agent/settings", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Failed to update settings: ${response.status}`);
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent", "settings"] });
      queryClient.invalidateQueries({ queryKey: ["agent", "status"] });
    },
  });
}

export function useValidateAgentApiKey(): UseMutationResult<
  AgentApiKeyValidationResponse,
  Error,
  string
> {
  return useMutation({
    mutationFn: async (apiKey: string) => {
      const response = await fetch("/api/agent/settings/validate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      if (!response.ok) {
        throw new Error(`Validation request failed: ${response.status}`);
      }
      return response.json();
    },
  });
}

export function useDeleteAgentApiKey(): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/agent/settings/api-key", {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Failed to delete API key: ${response.status}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent", "settings"] });
      queryClient.invalidateQueries({ queryKey: ["agent", "status"] });
    },
  });
}
