import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
  type UseMutationResult,
} from "@tanstack/react-query";
import { Channel, ServerEvent, ApiRoute, queryKeys } from "@mini-infra/types";
import type {
  AgentSettingsResponse,
  UpdateAgentSettingsRequest,
  AgentApiKeyValidationResponse,
  AgentSidecarStatus,
  AgentSidecarConfig,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";
import { useOperationProgress } from "./use-operation-progress";

async function fetchAgentSettings(): Promise<AgentSettingsResponse> {
  return apiFetch<AgentSettingsResponse>(ApiRoute.agent.settings(), {
    unwrap: false,
    correlationIdPrefix: "agent-settings",
  });
}

export function useAgentSettings(): UseQueryResult<AgentSettingsResponse, Error> {
  return useQuery({
    queryKey: queryKeys.agent.settings,
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
    mutationFn: (data: UpdateAgentSettingsRequest) =>
      apiFetch<AgentSettingsResponse>(ApiRoute.agent.settings(), {
        method: "POST",
        body: data,
        unwrap: false,
        correlationIdPrefix: "agent-settings-update",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agent.settings });
      queryClient.invalidateQueries({ queryKey: queryKeys.agent.status });
    },
  });
}

export function useValidateAgentApiKey(): UseMutationResult<
  AgentApiKeyValidationResponse,
  Error,
  string
> {
  return useMutation({
    mutationFn: (apiKey: string) =>
      apiFetch<AgentApiKeyValidationResponse>(ApiRoute.agent.settingsValidate(), {
        method: "POST",
        body: { apiKey },
        unwrap: false,
        correlationIdPrefix: "agent-settings-validate",
      }),
  });
}

export function useDeleteAgentApiKey(): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<void>(ApiRoute.agent.settingsApiKey(), {
        method: "DELETE",
        unwrap: false,
        correlationIdPrefix: "agent-settings-delete-key",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agent.settings });
      queryClient.invalidateQueries({ queryKey: queryKeys.agent.status });
    },
  });
}

// ---------------------------------------------------------------------------
// Sidecar status & config hooks (merged from use-agent-sidecar.ts)
// ---------------------------------------------------------------------------

export function useAgentSidecarStatus(): UseQueryResult<AgentSidecarStatus, Error> {
  return useQuery({
    queryKey: queryKeys.agentSidecar.status,
    queryFn: () =>
      apiFetch<{ success: boolean } & AgentSidecarStatus>(ApiRoute.agentSidecar.status(), {
        unwrap: false,
        correlationIdPrefix: "agent-sidecar-status",
      }),
    // No continuous "status changed" push event exists for the agent sidecar
    // (only SIDECAR_STARTUP_STARTED/STEP/COMPLETED around an explicit
    // restart, already handled by useAgentSidecarStartupProgress's
    // invalidateKeys below) — unlike Channel.VAULT's VAULT_STATUS_CHANGED,
    // there's no background health watcher pushing sidecar reachability
    // changes, so periodic polling stays.
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useAgentSidecarConfig(): UseQueryResult<AgentSidecarConfig, Error> {
  return useQuery({
    queryKey: queryKeys.agentSidecar.config,
    queryFn: () =>
      apiFetch<{ success: boolean; config: AgentSidecarConfig }>(ApiRoute.agentSidecar.config(), {
        unwrap: false,
        correlationIdPrefix: "agent-sidecar-config",
      }).then((data) => data.config),
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
    mutationFn: (data) =>
      apiFetch<{ success: boolean; config: AgentSidecarConfig }>(ApiRoute.agentSidecar.config(), {
        method: "PUT",
        body: data,
        unwrap: false,
        correlationIdPrefix: "agent-sidecar-config-update",
      }).then((result) => result.config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentSidecar.config });
      queryClient.invalidateQueries({ queryKey: queryKeys.agentSidecar.status });
      queryClient.invalidateQueries({ queryKey: queryKeys.agent.status });
    },
  });
}

export function useStartAgentSidecar(): UseMutationResult<
  { operationId: string },
  Error,
  void
> {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ operationId: string }>(ApiRoute.agentSidecar.restart(), {
        method: "POST",
        correlationIdPrefix: "agent-sidecar-restart",
      }),
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
    invalidateKeys: [[...queryKeys.agentSidecar.status], [...queryKeys.agent.status]],
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
