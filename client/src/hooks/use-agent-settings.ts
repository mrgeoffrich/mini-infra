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
  AgentSidecarStatus,
  AgentSidecarConfig,
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

// ---------------------------------------------------------------------------
// Sidecar status & config hooks (merged from use-agent-sidecar.ts)
// ---------------------------------------------------------------------------

async function fetchJSON<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

export function useAgentSidecarStatus(): UseQueryResult<AgentSidecarStatus, Error> {
  return useQuery({
    queryKey: ["agent-sidecar", "status"],
    queryFn: async () => {
      const data = await fetchJSON<{ success: boolean } & AgentSidecarStatus>(
        "/api/agent-sidecar/status",
      );
      return data;
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useAgentSidecarConfig(): UseQueryResult<AgentSidecarConfig, Error> {
  return useQuery({
    queryKey: ["agent-sidecar", "config"],
    queryFn: async () => {
      const data = await fetchJSON<{ success: boolean; config: AgentSidecarConfig }>(
        "/api/agent-sidecar/config",
      );
      return data.config;
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useUpdateAgentSidecarConfig(): UseMutationResult<
  AgentSidecarConfig,
  Error,
  Partial<AgentSidecarConfig>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data) => {
      const response = await fetch("/api/agent-sidecar/config", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Failed to update config: ${response.status}`);
      }
      const result = await response.json();
      return result.config;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-sidecar", "config"] });
      queryClient.invalidateQueries({ queryKey: ["agent-sidecar", "status"] });
      queryClient.invalidateQueries({ queryKey: ["agent", "status"] });
    },
  });
}

export function useRestartAgentSidecar(): UseMutationResult<
  { containerId: string; url: string },
  Error,
  void
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/agent-sidecar/restart", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Failed to restart sidecar: ${response.status}`);
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-sidecar", "status"] });
      queryClient.invalidateQueries({ queryKey: ["agent", "status"] });
    },
  });
}
