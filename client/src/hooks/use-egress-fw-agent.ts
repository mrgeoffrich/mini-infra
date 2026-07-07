import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
  type UseMutationResult,
} from "@tanstack/react-query";
import { Channel, ServerEvent, ApiRoute, queryKeys } from "@mini-infra/types";
import type {
  EgressFwAgentStatus,
  EgressFwAgentConfig,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";
import { useOperationProgress } from "./use-operation-progress";

// No continuous "status changed" push event exists for the egress fw-agent
// (only EGRESS_FW_AGENT_STARTUP_STARTED/STEP/COMPLETED around an explicit
// restart/start, already handled by useEgressFwAgentStartupProgress's
// invalidateKeys below) — unlike Channel.VAULT's VAULT_STATUS_CHANGED,
// there's no background health watcher pushing fw-agent reachability
// changes, so periodic polling stays.
export function useEgressFwAgentStatus(): UseQueryResult<EgressFwAgentStatus, Error> {
  return useQuery({
    queryKey: queryKeys.egressFwAgent.status,
    queryFn: () =>
      apiFetch<{ success: boolean } & EgressFwAgentStatus>(ApiRoute.egressFwAgent.status(), {
        unwrap: false,
        correlationIdPrefix: "egress-fw-agent-status",
      }),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useEgressFwAgentConfig(): UseQueryResult<EgressFwAgentConfig, Error> {
  return useQuery({
    queryKey: queryKeys.egressFwAgent.config,
    queryFn: () =>
      apiFetch<{ success: boolean; config: EgressFwAgentConfig }>(
        ApiRoute.egressFwAgent.config(),
        { unwrap: false, correlationIdPrefix: "egress-fw-agent-config" },
      ).then((data) => data.config),
    staleTime: 5 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useUpdateEgressFwAgentConfig(): UseMutationResult<
  EgressFwAgentConfig,
  Error,
  Partial<EgressFwAgentConfig>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data) =>
      apiFetch<{ success: boolean; config: EgressFwAgentConfig }>(
        ApiRoute.egressFwAgent.config(),
        {
          method: "PATCH",
          body: data,
          unwrap: false,
          correlationIdPrefix: "egress-fw-agent-config-update",
        },
      ).then((result) => result.config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.egressFwAgent.config });
      queryClient.invalidateQueries({ queryKey: queryKeys.egressFwAgent.status });
    },
  });
}

export function useRestartEgressFwAgent(): UseMutationResult<
  { operationId: string },
  Error,
  void
> {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ operationId: string }>(ApiRoute.egressFwAgent.restart(), {
        method: "POST",
        correlationIdPrefix: "egress-fw-agent-restart",
      }),
  });
}

export function useStartEgressFwAgent(): UseMutationResult<
  { operationId: string },
  Error,
  void
> {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ operationId: string }>(ApiRoute.egressFwAgent.start(), {
        method: "POST",
        correlationIdPrefix: "egress-fw-agent-start",
      }),
  });
}

export function useEgressFwAgentStartupProgress(operationId: string | null, label?: string) {
  return useOperationProgress({
    channel: Channel.EGRESS_FW_AGENT,
    startedEvent: ServerEvent.EGRESS_FW_AGENT_STARTUP_STARTED,
    stepEvent: ServerEvent.EGRESS_FW_AGENT_STARTUP_STEP,
    completedEvent: ServerEvent.EGRESS_FW_AGENT_STARTUP_COMPLETED,
    operationId,
    getOperationId: (p) => p.operationId,
    getTotalSteps: (p) => p.totalSteps,
    getStepNames: (p) => p.stepNames ?? [],
    getStep: (p) => p.step,
    getResult: (p) => ({ success: p.success, steps: p.steps, errors: p.errors }),
    invalidateKeys: [[...queryKeys.egressFwAgent.status]],
    toasts: {
      success: "Egress fw-agent started successfully",
      error: "Egress fw-agent startup failed",
    },
    tracker: {
      type: "egress-fw-agent-startup",
      label: label ?? "Starting egress fw-agent",
    },
  });
}
