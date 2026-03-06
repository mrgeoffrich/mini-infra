import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

function generateCorrelationId(): string {
  return `monitoring-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Types for monitoring API responses
export interface MonitoringServiceStatus {
  service: {
    id: string;
    serviceName: string;
    serviceType: string;
    status: string;
    health: string;
    config: Record<string, unknown> | null;
    startedAt: string | null;
    stoppedAt: string | null;
    lastError: unknown;
    createdAt: string;
    updatedAt: string;
  };
  metadata: {
    name: string;
    version: string;
    description: string;
    dependencies: string[];
    tags: string[];
    requiredNetworks: Array<{ name: string; driver?: string }>;
    requiredVolumes: Array<{ name: string }>;
    exposedPorts: Array<{
      name: string;
      containerPort: number;
      hostPort: number;
      protocol: string;
      description: string;
    }>;
  };
  healthDetails: {
    status: string;
    message: string;
    lastChecked: string;
    details?: Record<string, unknown>;
  };
  lastError?: {
    message: string;
    timestamp: string;
    details?: Record<string, unknown>;
  };
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

// Fetch monitoring service status
async function fetchMonitoringStatus(
  correlationId: string
): Promise<MonitoringServiceStatus> {
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

// Start monitoring service
async function startMonitoringService(
  correlationId: string
): Promise<{ message: string; duration?: number }> {
  const response = await fetch(`/api/monitoring/start`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Failed to start monitoring service`);
  }

  return response.json();
}

// Stop monitoring service
async function stopMonitoringService(
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
    throw new Error(data.error || `Failed to stop monitoring service`);
  }

  return response.json();
}

// Hooks

export function useMonitoringStatus(options: { refetchInterval?: number; enabled?: boolean } = {}) {
  const { refetchInterval = 15000, enabled = true } = options;

  return useQuery({
    queryKey: ["monitoringStatus"],
    queryFn: () => fetchMonitoringStatus(generateCorrelationId()),
    enabled,
    refetchInterval,
    staleTime: 5000,
    gcTime: 5 * 60 * 1000,
    retry: (failureCount, error) => {
      if (error.message.includes("401")) return false;
      return failureCount < 2;
    },
  });
}

export function useStartMonitoring() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => startMonitoringService(generateCorrelationId()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["monitoringStatus"] });
    },
  });
}

export function useStopMonitoring() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => stopMonitoringService(generateCorrelationId()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["monitoringStatus"] });
    },
  });
}

export function usePrometheusQuery(
  query: string,
  options: { enabled?: boolean; refetchInterval?: number } = {}
) {
  const { enabled = true, refetchInterval = 15000 } = options;

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
  start: string,
  end: string,
  step: string = "15s",
  options: { enabled?: boolean; refetchInterval?: number } = {}
) {
  const { enabled = true, refetchInterval = 30000 } = options;

  return useQuery({
    queryKey: ["prometheusRangeQuery", query, start, end, step],
    queryFn: () =>
      fetchPrometheusRangeQuery(query, start, end, step, generateCorrelationId()),
    enabled: enabled && !!query && !!start && !!end,
    refetchInterval,
    staleTime: 10000,
    gcTime: 2 * 60 * 1000,
    retry: 1,
  });
}
