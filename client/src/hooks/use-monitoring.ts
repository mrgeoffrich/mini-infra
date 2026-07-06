import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Channel,
  ServerEvent,
  MonitoringStatusResponse,
  PrometheusQueryResult,
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

export type { MonitoringStatusResponse };

// Fetch monitoring status (stack-based)
async function fetchMonitoringStatus(): Promise<MonitoringStatusResponse> {
  // Raw body — no `{success,data}` envelope at all (see server route) — so
  // this stays unwrapped.
  return apiFetch<MonitoringStatusResponse>(ApiRoute.monitoring.status(), {
    correlationIdPrefix: "monitoring",
    unwrap: false,
  });
}

// Fetch Prometheus instant query
async function fetchPrometheusQuery(query: string): Promise<PrometheusQueryResult> {
  const url = new URL(ApiRoute.monitoring.query(), window.location.origin);
  url.searchParams.set("query", query);
  // Raw Prometheus response shape ({status, data}) proxied straight through —
  // not Mini Infra's own envelope — so this stays unwrapped.
  return apiFetch<PrometheusQueryResult>(url.toString(), {
    correlationIdPrefix: "monitoring",
    unwrap: false,
  });
}

// Fetch Prometheus range query
async function fetchPrometheusRangeQuery(
  query: string,
  start: string,
  end: string,
  step: string,
): Promise<PrometheusQueryResult> {
  const url = new URL(ApiRoute.monitoring.queryRange(), window.location.origin);
  url.searchParams.set("query", query);
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);
  url.searchParams.set("step", step);
  // Raw Prometheus response shape — see `fetchPrometheusQuery` above.
  return apiFetch<PrometheusQueryResult>(url.toString(), {
    correlationIdPrefix: "monitoring",
    unwrap: false,
  });
}

// Apply stack (deploy/update)
async function applyMonitoringStack(stackId: string): Promise<Record<string, unknown>> {
  return apiFetch<Record<string, unknown>>(ApiRoute.stacks.apply(stackId), {
    method: "POST",
    body: {},
    correlationIdPrefix: "monitoring",
  });
}

// Stop monitoring stack
async function stopMonitoringStack(): Promise<{ message: string }> {
  // Flat response shape ({ message, ...result } — no envelope), so this
  // stays raw rather than unwrapped.
  return apiFetch<{ message: string }>(ApiRoute.monitoring.stop(), {
    method: "POST",
    correlationIdPrefix: "monitoring",
    unwrap: false,
  });
}

// Fetch stack plan
async function fetchMonitoringPlan(stackId: string): Promise<Record<string, unknown>> {
  try {
    return await apiFetch<Record<string, unknown>>(ApiRoute.stacks.plan(stackId), {
      correlationIdPrefix: "monitoring",
    });
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 503) {
      throw new ApiRequestError(err.status, err.code, "Docker is unavailable", err.body);
    }
    throw err;
  }
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
      queryClient.invalidateQueries({ queryKey: queryKeys.monitoring.status });
      queryClient.invalidateQueries({ queryKey: queryKeys.monitoring.plan });
    },
    enabled,
  );

  useSocketEvent(
    ServerEvent.STACK_DESTROY_COMPLETED,
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.monitoring.status });
      queryClient.invalidateQueries({ queryKey: queryKeys.monitoring.plan });
    },
    enabled,
  );

  // When container list changes, monitoring container status may have changed
  useSocketEvent(
    ServerEvent.CONTAINERS_LIST,
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.monitoring.status });
    },
    enabled,
  );

  // No polling when socket is connected; fall back to 15s when disconnected
  const refetchInterval = options.refetchInterval ?? (connected ? false : 15000);

  return useQuery({
    queryKey: queryKeys.monitoring.status,
    queryFn: fetchMonitoringStatus,
    enabled,
    refetchInterval,
    staleTime: 5000,
    gcTime: 5 * 60 * 1000,
    retry: (failureCount, error) => {
      if (error instanceof ApiRequestError && error.isAuth) return false;
      return failureCount < 2;
    },
  });
}

/**
 * Query key for a single stack's monitoring plan. No parameterized builder
 * for this in the registry yet (see Phase 4 report) — derived from the bare
 * root here so it still prefix-matches `queryKeys.monitoring.plan` for broad
 * invalidation.
 */
function monitoringPlanKey(stackId: string | undefined) {
  return [...queryKeys.monitoring.plan, stackId] as const;
}

export function useMonitoringPlan(stackId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: monitoringPlanKey(stackId),
    queryFn: () => fetchMonitoringPlan(stackId!),
    enabled: !!stackId && enabled,
    staleTime: 0,
    gcTime: 2 * 60 * 1000,
  });
}

export function useApplyMonitoring() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (stackId: string) => applyMonitoringStack(stackId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.monitoring.status });
      queryClient.invalidateQueries({ queryKey: queryKeys.monitoring.plan });
    },
  });
}

export function useStopMonitoring() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => stopMonitoringStack(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.monitoring.status });
      queryClient.invalidateQueries({ queryKey: queryKeys.monitoring.plan });
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
    queryKey: queryKeys.monitoring.prometheusQuery(query),
    queryFn: () => fetchPrometheusQuery(query),
    enabled: enabled && !!query,
    refetchInterval,
    staleTime: 10000,
    gcTime: 2 * 60 * 1000,
    retry: 1,
  });
}

/**
 * Query key for a Prometheus range query. The registry's
 * `prometheusRangeQuery(query)` builder doesn't cover `rangeSeconds`/`step`
 * (see Phase 4 report) — derived here so it still prefix-matches
 * `queryKeys.monitoring.prometheusRangeQuery(query)`.
 */
function prometheusRangeQueryKey(query: string, rangeSeconds: number, step: string) {
  return [...queryKeys.monitoring.prometheusRangeQuery(query), rangeSeconds, step] as const;
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
    queryKey: prometheusRangeQueryKey(query, rangeSeconds, step),
    queryFn: () => {
      const now = Math.floor(Date.now() / 1000);
      const start = (now - rangeSeconds).toString();
      const end = now.toString();
      return fetchPrometheusRangeQuery(query, start, end, step);
    },
    enabled: enabled && !!query,
    refetchInterval,
    staleTime: 10000,
    gcTime: 2 * 60 * 1000,
    retry: 1,
  });
}
