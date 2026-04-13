import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { StackInfo } from "@mini-infra/types";
import { Channel, ServerEvent } from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";

function generateCorrelationId(): string {
  return `monitoring-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Types for monitoring API responses
export interface MonitoringStatusResponse {
  stack: StackInfo | null;
  containerStatus: Array<{
    serviceName: string;
    containerId: string;
    containerName: string;
    image: string;
    state: string;
    status: string;
  }>;
  running: boolean;
  message?: string;
}

export interface PrometheusQueryResponse {
  status: string;
  data: {
    resultType: string;
    result: Array<{
      metric: Record<string, string>;
      value?: [number, string];
      values?: Array<[number, string]>;
    }>;
  };
}

// Fetch monitoring status (stack-based)
async function fetchMonitoringStatus(
  correlationId: string
): Promise<MonitoringStatusResponse> {
  const response = await fetch(`/api/monitoring/status`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch monitoring status: ${response.statusText}`
    );
  }

  return response.json();
}

// Fetch Prometheus instant query
async function fetchPrometheusQuery(
  query: string,
  correlationId: string
): Promise<PrometheusQueryResponse> {
  const params = new URLSearchParams({ query });
  const response = await fetch(`/api/monitoring/query?${params}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to query Prometheus: ${response.statusText}`);
  }

  return response.json();
}

// Fetch Prometheus range query
async function fetchPrometheusRangeQuery(
  query: string,
  start: string,
  end: string,
  step: string,
  correlationId: string
): Promise<PrometheusQueryResponse> {
  const params = new URLSearchParams({ query, start, end, step });
  const response = await fetch(`/api/monitoring/query_range?${params}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to query Prometheus range: ${response.statusText}`);
  }

  return response.json();
}

// Apply stack (deploy/update)
async function applyMonitoringStack(
  stackId: string,
  correlationId: string
): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/stacks/${stackId}/apply`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || `Failed to apply monitoring stack`);
  }

  return response.json();
}

// Stop monitoring stack
async function stopMonitoringStack(
  correlationId: string
): Promise<{ message: string }> {
  const response = await fetch(`/api/monitoring/stop`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Failed to stop monitoring stack`);
  }

  return response.json();
}

// Fetch stack plan
async function fetchMonitoringPlan(
  stackId: string,
  correlationId: string
): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/stacks/${stackId}/plan`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    if (response.status === 503) {
      throw new Error("Docker is unavailable");
    }
    throw new Error(`Failed to fetch plan: ${response.statusText}`);
  }

  return response.json();
}

// Hooks

export function useMonitoringStatus(options: { refetchInterval?: number; enabled?: boolean } = {}) {
  const { enabled = true } = options;
  const queryClient = useQueryClient();
  const { connected } = useSocket();

  // Monitoring status changes when the monitoring stack is applied/destroyed.
  // Subscribe to the stacks channel to catch those events.
  useSocketChannel(Channel.STACKS, enabled);

  // Also subscribe to containers channel since monitoring containers may start/stop
  useSocketChannel(Channel.CONTAINERS, enabled);

  // When stacks are applied or destroyed, invalidate monitoring status
  useSocketEvent(
    ServerEvent.STACK_APPLY_COMPLETED,
    () => {
      queryClient.invalidateQueries({ queryKey: ["monitoringStatus"] });
      queryClient.invalidateQueries({ queryKey: ["monitoringPlan"] });
    },
    enabled,
  );

  useSocketEvent(
    ServerEvent.STACK_DESTROY_COMPLETED,
    () => {
      queryClient.invalidateQueries({ queryKey: ["monitoringStatus"] });
      queryClient.invalidateQueries({ queryKey: ["monitoringPlan"] });
    },
    enabled,
  );

  // When container list changes, monitoring container status may have changed
  useSocketEvent(
    ServerEvent.CONTAINERS_LIST,
    () => {
      queryClient.invalidateQueries({ queryKey: ["monitoringStatus"] });
    },
    enabled,
  );

  // No polling when socket is connected; fall back to 15s when disconnected
  const refetchInterval = options.refetchInterval ?? (connected ? false : 15000);

  return useQuery({
    queryKey: ["monitoringStatus"],
    queryFn: () => fetchMonitoringStatus(generateCorrelationId()),
    enabled,
    refetchInterval,
    staleTime: 5000,
    gcTime: 5 * 60 * 1000,
    retry: (failureCount, error) => {
      if ((error instanceof Error ? error.message : String(error)).includes("401")) return false;
      return failureCount < 2;
    },
  });
}

export function useMonitoringPlan(stackId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["monitoringPlan", stackId],
    queryFn: () => fetchMonitoringPlan(stackId!, generateCorrelationId()),
    enabled: !!stackId && enabled,
    staleTime: 0,
    gcTime: 2 * 60 * 1000,
  });
}

export function useApplyMonitoring() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (stackId: string) =>
      applyMonitoringStack(stackId, generateCorrelationId()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["monitoringStatus"] });
      queryClient.invalidateQueries({ queryKey: ["monitoringPlan"] });
    },
  });
}

export function useStopMonitoring() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => stopMonitoringStack(generateCorrelationId()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["monitoringStatus"] });
      queryClient.invalidateQueries({ queryKey: ["monitoringPlan"] });
    },
  });
}

export function usePrometheusQuery(
  query: string,
  options: { enabled?: boolean; refetchInterval?: number } = {}
) {
  const { enabled = true } = options;
  // Prometheus queries are time-series data — keep polling but no socket event exists.
  // Use the provided interval or default.
  const refetchInterval = options.refetchInterval ?? 15000;

  return useQuery({
    queryKey: ["prometheusQuery", query],
    queryFn: () => fetchPrometheusQuery(query, generateCorrelationId()),
    enabled: enabled && !!query,
    refetchInterval,
    staleTime: 10000,
    gcTime: 2 * 60 * 1000,
    retry: 1,
  });
}

export function usePrometheusRangeQuery(
  query: string,
  rangeSeconds: number,
  step: string = "15s",
  options: { enabled?: boolean; refetchInterval?: number } = {}
) {
  const { enabled = true } = options;
  // Prometheus range queries are time-series data — keep polling.
  const refetchInterval = options.refetchInterval ?? 30000;

  return useQuery({
    queryKey: ["prometheusRangeQuery", query, rangeSeconds, step],
    queryFn: () => {
      const now = Math.floor(Date.now() / 1000);
      const start = (now - rangeSeconds).toString();
      const end = now.toString();
      return fetchPrometheusRangeQuery(query, start, end, step, generateCorrelationId());
    },
    enabled: enabled && !!query,
    refetchInterval,
    staleTime: 10000,
    gcTime: 2 * 60 * 1000,
    retry: 1,
  });
}
