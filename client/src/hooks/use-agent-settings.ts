import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { Channel, ServerEvent } from "@mini-infra/types";
import type {
  AgentSettingsResponse,
  UpdateAgentSettingsRequest,
  AgentApiKeyValidationResponse,
  AgentSidecarStatus,
  AgentSidecarConfig,
} from "@mini-infra/types";
import { useOperationProgress } from "./use-operation-progress";

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

export function useStartAgentSidecar(): UseMutationResult<
  { operationId: string },
  Error,
  void
> {
  return useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/agent-sidecar/restart", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Failed to start sidecar: ${response.status}`);
      }
      const result = await response.json();
      return { operationId: result.data.operationId };
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
}

export function useAgentSidecarStartupProgress(operationId: string | null, label?: string) {
  return useOperationProgress({
    channel: Channel.AGENT_SIDECAR,
    startedEvent: ServerEvent.SIDECAR_STARTUP_STARTED,
    stepEvent: ServerEvent.SIDECAR_STARTUP_STEP,
    completedEvent: ServerEvent.SIDECAR_STARTUP_COMPLETED,
    operationId,
    getOperationId: (p) => p.operationId,
    getTotalSteps: (p) => p.totalSteps,
    getStepNames: (p) => p.stepNames ?? [],
    getStep: (p) => p.step,
    getResult: (p) => ({ success: p.success, steps: p.steps, errors: p.errors }),
    invalidateKeys: [["agent-sidecar", "status"], ["agent", "status"]],
    toasts: {
      success: "Agent sidecar started successfully",
      error: "Agent sidecar startup failed",
    },
    tracker: {
      type: "sidecar-startup",
      label: label ?? "Starting agent sidecar",
    },
  });
}
