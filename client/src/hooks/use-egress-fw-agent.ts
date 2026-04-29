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
  EgressFwAgentStatus,
  EgressFwAgentConfig,
} from "@mini-infra/types";
import { useOperationProgress } from "./use-operation-progress";

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

export function useEgressFwAgentStatus(): UseQueryResult<EgressFwAgentStatus, Error> {
  return useQuery({
    queryKey: ["egress-fw-agent", "status"],
    queryFn: async () => {
      const data = await fetchJSON<{ success: boolean } & EgressFwAgentStatus>(
        "/api/egress-fw-agent/status",
      );
      return data;
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useEgressFwAgentConfig(): UseQueryResult<EgressFwAgentConfig, Error> {
  return useQuery({
    queryKey: ["egress-fw-agent", "config"],
    queryFn: async () => {
      const data = await fetchJSON<{ success: boolean; config: EgressFwAgentConfig }>(
        "/api/egress-fw-agent/config",
      );
      return data.config;
    },
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
    mutationFn: async (data) => {
      const response = await fetch("/api/egress-fw-agent/config", {
        method: "PATCH",
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
      queryClient.invalidateQueries({ queryKey: ["egress-fw-agent", "config"] });
      queryClient.invalidateQueries({ queryKey: ["egress-fw-agent", "status"] });
    },
  });
}

export function useRestartEgressFwAgent(): UseMutationResult<
  { operationId: string },
  Error,
  void
> {
  return useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/egress-fw-agent/restart", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Failed to restart fw-agent: ${response.status}`);
      }
      const result = await response.json();
      return { operationId: result.data.operationId };
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
}

export function useStartEgressFwAgent(): UseMutationResult<
  { operationId: string },
  Error,
  void
> {
  return useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/egress-fw-agent/start", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Failed to start fw-agent: ${response.status}`);
      }
      const result = await response.json();
      return { operationId: result.data.operationId };
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
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
    invalidateKeys: [["egress-fw-agent", "status"]],
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
