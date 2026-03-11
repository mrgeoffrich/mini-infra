import { useState, useEffect, useRef, useCallback } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  AgentSidecarStatus,
  AgentSidecarTaskSummary,
  AgentSidecarTaskDetail,
  AgentSidecarConfig,
} from "@mini-infra/types";

// ---------------------------------------------------------------------------
// Fetch helpers
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

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

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

export function useAgentSidecarTasks(): UseQueryResult<AgentSidecarTaskSummary[], Error> {
  return useQuery({
    queryKey: ["agent-sidecar", "tasks"],
    queryFn: async () => {
      const data = await fetchJSON<{ success: boolean; tasks: AgentSidecarTaskSummary[] }>(
        "/api/agent-sidecar/tasks",
      );
      return data.tasks;
    },
    staleTime: 5_000,
    refetchInterval: (query) => {
      const tasks = query.state.data;
      if (tasks && tasks.some((t) => t.status === "running")) return 5_000;
      return 30_000;
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useAgentSidecarTask(
  id: string | undefined,
): UseQueryResult<AgentSidecarTaskDetail, Error> {
  return useQuery({
    queryKey: ["agent-sidecar", "tasks", id],
    queryFn: async () => {
      const data = await fetchJSON<{ success: boolean; task: AgentSidecarTaskDetail }>(
        `/api/agent-sidecar/tasks/${id}`,
      );
      return data.task;
    },
    enabled: !!id,
    staleTime: 3_000,
    refetchInterval: (query) => {
      const task = query.state.data;
      if (task && task.status === "running") return 3_000;
      return false;
    },
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

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useCreateAgentSidecarTask(): UseMutationResult<
  { id: string; externalId: string; status: string },
  Error,
  { prompt: string; context?: Record<string, unknown> }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data) => {
      const response = await fetch("/api/agent-sidecar/tasks", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || body.message || `Failed to create task: ${response.status}`);
      }
      const result = await response.json();
      return result.task;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-sidecar", "tasks"] });
    },
  });
}

export function useCancelAgentSidecarTask(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/agent-sidecar/tasks/${id}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Failed to cancel task: ${response.status}`);
      }
    },
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["agent-sidecar", "tasks", id] });
      queryClient.invalidateQueries({ queryKey: ["agent-sidecar", "tasks"] });
    },
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
    },
  });
}

// ---------------------------------------------------------------------------
// SSE Stream Hook
// ---------------------------------------------------------------------------

export interface SSEEvent {
  type: "status" | "tool_call" | "tool_result" | "text" | "complete" | "error";
  data: Record<string, unknown>;
  timestamp: number;
}

interface UseAgentSidecarTaskStreamResult {
  events: SSEEvent[];
  isConnected: boolean;
  error: string | null;
  disconnect: () => void;
}

export function useAgentSidecarTaskStream(
  taskId: string | undefined,
  enabled: boolean,
): UseAgentSidecarTaskStreamResult {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const queryClient = useQueryClient();

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      setIsConnected(false);
    }
  }, []);

  useEffect(() => {
    if (!taskId || !enabled) {
      disconnect();
      return;
    }

    const es = new EventSource(`/api/agent-sidecar/tasks/${taskId}/stream`, {
      withCredentials: true,
    });
    eventSourceRef.current = es;

    es.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    es.onerror = () => {
      setIsConnected(false);
      setError("Stream connection lost");
    };

    const eventTypes = ["status", "tool_call", "tool_result", "text", "complete", "error"] as const;

    for (const type of eventTypes) {
      es.addEventListener(type, (e: MessageEvent) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(e.data);
        } catch {
          data = { raw: e.data };
        }

        const event: SSEEvent = { type, data, timestamp: Date.now() };
        setEvents((prev) => [...prev, event]);

        // Terminal events: close stream and invalidate caches
        if (type === "complete" || type === "error") {
          es.close();
          eventSourceRef.current = null;
          setIsConnected(false);
          queryClient.invalidateQueries({ queryKey: ["agent-sidecar", "tasks", taskId] });
          queryClient.invalidateQueries({ queryKey: ["agent-sidecar", "tasks"] });
        }
      });
    }

    return () => {
      es.close();
      eventSourceRef.current = null;
      setIsConnected(false);
    };
  }, [taskId, enabled, disconnect, queryClient]);

  // Reset events when taskId changes
  useEffect(() => {
    setEvents([]);
    setError(null);
  }, [taskId]);

  return { events, isConnected, error, disconnect };
}
