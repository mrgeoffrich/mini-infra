import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import { toast } from "sonner";
import {
  Channel,
  ServerEvent,
} from "@mini-infra/types";
import type {
  StackInfo,
  StackServiceInfo,
  StackPlan,
  ServiceAction,
  FieldDiff,
  ApplyResult,
  DestroyResult,
  ServiceApplyResult,
  ResourceResult,
  ApplyStackRequest,
  StackListResponse,
  StackResponse,
  StackPlanResponse,
  StackValidationError,
  StackValidationResult,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `stacks-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Stack API Functions
// ====================

async function fetchStacks(
  environmentId?: string,
  correlationId?: string,
  scope?: string,
): Promise<StackListResponse> {
  const url = new URL("/api/stacks", window.location.origin);
  if (scope) url.searchParams.set("scope", scope);
  else if (environmentId) url.searchParams.set("environmentId", environmentId);

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId ?? generateCorrelationId(),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch stacks: ${response.statusText}`);
  }

  const data: StackListResponse = await response.json();
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch stacks");
  }

  return data;
}

async function fetchStack(
  stackId: string,
  correlationId?: string,
): Promise<StackResponse> {
  const response = await fetch(`/api/stacks/${stackId}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId ?? generateCorrelationId(),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch stack: ${response.statusText}`);
  }

  const data: StackResponse = await response.json();
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch stack");
  }

  return data;
}

async function fetchStackPlan(
  stackId: string,
  correlationId?: string,
): Promise<StackPlanResponse> {
  const response = await fetch(`/api/stacks/${stackId}/plan`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId ?? generateCorrelationId(),
    },
  });

  if (!response.ok) {
    if (response.status === 503) {
      throw new Error("Docker is unavailable");
    }
    throw new Error(`Failed to fetch stack plan: ${response.statusText}`);
  }

  const data: StackPlanResponse = await response.json();
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch stack plan");
  }

  return data;
}

async function fetchStackValidation(
  stackId: string,
  correlationId?: string,
): Promise<StackValidationResult> {
  const response = await fetch(`/api/stacks/${stackId}/validate`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId ?? generateCorrelationId(),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to validate stack: ${response.statusText}`);
  }

  const data = await response.json();
  return data;
}

async function applyStack(
  stackId: string,
  options: ApplyStackRequest,
  correlationId?: string,
): Promise<{ success: boolean; data: { started: true; stackId: string } }> {
  const response = await fetch(`/api/stacks/${stackId}/apply`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId ?? generateCorrelationId(),
    },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    if (response.status === 503) {
      throw new Error("Docker is unavailable");
    }
    if (response.status === 409) {
      throw new Error("Stack apply already in progress");
    }
    const errorData = await response.json().catch(() => null);
    throw new Error(errorData?.message || `Failed to apply stack: ${response.statusText}`);
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.message || "Failed to apply stack");
  }

  return data;
}

async function fetchStackStatus(
  stackId: string,
  correlationId?: string,
): Promise<{ success: boolean; data: { stack: StackInfo; containerStatus: unknown[] } }> {
  const response = await fetch(`/api/stacks/${stackId}/status`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId ?? generateCorrelationId(),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch stack status: ${response.statusText}`);
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch stack status");
  }

  return data;
}

async function fetchStackHistory(
  stackId: string,
  correlationId?: string,
): Promise<{ success: boolean; data: unknown[]; total?: number }> {
  const response = await fetch(`/api/stacks/${stackId}/history`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId ?? generateCorrelationId(),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch stack history: ${response.statusText}`);
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch stack history");
  }

  return data;
}

async function deleteStack(
  stackId: string,
  correlationId?: string,
): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`/api/stacks/${stackId}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId ?? generateCorrelationId(),
    },
  });

  if (!response.ok) {
    let errorMessage = `Failed to delete stack: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorMessage;
    } catch {
      // Use default error message
    }
    throw new Error(errorMessage);
  }

  return await response.json();
}

async function destroyStack(
  stackId: string,
  correlationId?: string,
): Promise<{ success: boolean; data: { started: true; stackId: string } }> {
  const response = await fetch(`/api/stacks/${stackId}/destroy`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId ?? generateCorrelationId(),
    },
  });

  if (!response.ok) {
    if (response.status === 503) {
      throw new Error("Docker is unavailable");
    }
    if (response.status === 409) {
      throw new Error("An operation is already in progress for this stack");
    }
    let errorMessage = `Failed to destroy stack: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorMessage;
    } catch {
      // Use default error message
    }
    throw new Error(errorMessage);
  }

  return await response.json();
}

async function updateStackParameterValues(
  stackId: string,
  parameterValues: Record<string, string | number | boolean>,
  correlationId?: string,
): Promise<StackResponse> {
  const response = await fetch(`/api/stacks/${stackId}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId ?? generateCorrelationId(),
    },
    body: JSON.stringify({ parameterValues }),
  });

  if (!response.ok) {
    let errorMessage = `Failed to update stack parameters: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorMessage;
    } catch {
      // Use default error message
    }
    throw new Error(errorMessage);
  }

  return await response.json();
}

export type { StackValidationError, StackValidationResult };

// ====================
// Stack Hooks
// ====================

export function useStackValidation(stackId: string, enabled = true) {
  const correlationId = generateCorrelationId();

  return useQuery<StackValidationResult>({
    queryKey: ["stackValidation", stackId],
    queryFn: () => fetchStackValidation(stackId, correlationId),
    enabled: !!stackId && enabled,
    staleTime: 10000,
    gcTime: 2 * 60 * 1000,
  });
}

export function useStacks(environmentId?: string, options?: { scope?: string }) {
  const correlationId = generateCorrelationId();
  const scope = options?.scope;

  return useQuery({
    queryKey: ["stacks", environmentId, scope],
    queryFn: () => fetchStacks(environmentId, correlationId, scope),
    staleTime: 10000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}

export function useStack(stackId: string) {
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["stack", stackId],
    queryFn: () => fetchStack(stackId, correlationId),
    enabled: !!stackId,
    staleTime: 5000,
    gcTime: 5 * 60 * 1000,
  });
}

export function useStackPlan(stackId: string, enabled = true) {
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["stackPlan", stackId],
    queryFn: () => fetchStackPlan(stackId, correlationId),
    enabled: !!stackId && enabled,
    staleTime: 0,
    gcTime: 2 * 60 * 1000,
  });
}

export function useStackApply() {
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: ({
      stackId,
      options,
    }: {
      stackId: string;
      options: ApplyStackRequest;
    }) => applyStack(stackId, options, correlationId),
    onSuccess: () => {
      // The HTTP response just confirms the apply started.
      // Final results come via Socket.IO events.
    },
    onError: (error: Error) => {
      toast.error(`Failed to apply stack: ${(error instanceof Error ? error.message : String(error))}`);
    },
  });
}

/** Live apply progress state from Socket.IO events */
export interface StackApplyProgressState {
  isApplying: boolean;
  totalActions: number;
  completedResults: Array<ServiceApplyResult | ResourceResult>;
  actions: Array<{ serviceName: string; action: string }>;
  forcePull: boolean;
  finalResult: (ApplyResult & { error?: string; postApply?: { success: boolean; errors?: string[] } }) | null;
}

const INITIAL_APPLY_STATE: StackApplyProgressState = {
  isApplying: false,
  totalActions: 0,
  completedResults: [],
  actions: [],
  forcePull: false,
  finalResult: null,
};

/**
 * Subscribe to Socket.IO events for live stack apply progress.
 * Returns real-time state as each service completes.
 */
export function useStackApplyProgress(stackId: string) {
  const queryClient = useQueryClient();
  const { connected } = useSocket();
  const [applyState, setApplyState] = useState<StackApplyProgressState>(INITIAL_APPLY_STATE);

  // Subscribe to the stacks channel
  useSocketChannel(Channel.STACKS, !!stackId);

  // Apply started
  useSocketEvent(
    ServerEvent.STACK_APPLY_STARTED,
    (data) => {
      if (data.stackId !== stackId) return;
      setApplyState({
        isApplying: true,
        totalActions: data.totalActions,
        completedResults: [],
        actions: data.actions,
        forcePull: !!data.forcePull,
        finalResult: null,
      });
    },
    !!stackId,
  );

  // Per-service result
  useSocketEvent(
    ServerEvent.STACK_APPLY_SERVICE_RESULT,
    (data) => {
      if (data.stackId !== stackId) return;
      setApplyState((prev) => ({
        ...prev,
        // For forcePull, replace totalActions from the first service result
        // since the initial STARTED event used "pull" placeholders
        totalActions: prev.forcePull && data.totalActions != null && prev.completedResults.length === 0 ? data.totalActions : prev.totalActions,
        completedResults: [...prev.completedResults, data],
      }));
    },
    !!stackId,
  );

  // Apply completed
  useSocketEvent(
    ServerEvent.STACK_APPLY_COMPLETED,
    (data) => {
      if (data.stackId !== stackId) return;
      setApplyState((prev) => ({
        ...prev,
        isApplying: false,
        finalResult: data,
      }));
      // Invalidate all stack and application queries so data refreshes
      queryClient.invalidateQueries({ queryKey: ["stacks"] });
      queryClient.invalidateQueries({ queryKey: ["stack", stackId] });
      queryClient.invalidateQueries({ queryKey: ["stackPlan", stackId] });
      queryClient.invalidateQueries({ queryKey: ["stackStatus", stackId] });
      queryClient.invalidateQueries({ queryKey: ["stackHistory", stackId] });
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: ["userStacks"] });

      // Toast notification
      if (data.error) {
        toast.error(`Stack apply failed: ${data.error}`);
      } else if (data.success && data.serviceResults.length === 0 && applyState.forcePull) {
        toast.success('All images are up to date');
      } else if (data.success) {
        toast.success(`Stack applied successfully (v${data.appliedVersion})`);
      } else {
        const failed = data.serviceResults.filter((r) => !r.success);
        toast.error(`Apply partially failed: ${failed.length} service(s) had errors`);
      }
    },
    !!stackId,
  );

  const reset = useCallback(
    () => setApplyState(INITIAL_APPLY_STATE),
    [],
  );

  return { ...applyState, connected, reset };
}

export function useStackStatus(stackId: string) {
  const correlationId = generateCorrelationId();
  const { connected } = useSocket();

  // Subscribe to stacks channel for push updates
  useSocketChannel(Channel.STACKS, !!stackId);

  return useQuery({
    queryKey: ["stackStatus", stackId],
    queryFn: () => fetchStackStatus(stackId, correlationId),
    enabled: !!stackId,
    refetchInterval: connected ? false : 5000,
    staleTime: 2000,
    gcTime: 2 * 60 * 1000,
    refetchOnReconnect: true,
  });
}

export function useStackHistory(stackId: string) {
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["stackHistory", stackId],
    queryFn: () => fetchStackHistory(stackId, correlationId),
    enabled: !!stackId,
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
  });
}

export function useDeleteStack() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (stackId: string) => deleteStack(stackId, correlationId),
    onSuccess: () => {
      toast.success("Stack deleted successfully");
      queryClient.invalidateQueries({ queryKey: ["stacks"] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete stack: ${(error instanceof Error ? error.message : String(error))}`);
    },
  });
}

export function useStackDestroy() {
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (stackId: string) => destroyStack(stackId, correlationId),
    onSuccess: () => {
      // HTTP response just confirms the destroy started.
      // Final results come via Socket.IO events.
    },
    onError: (error: Error) => {
      toast.error(`Failed to destroy stack: ${(error instanceof Error ? error.message : String(error))}`);
    },
  });
}

/** Listen for stack destroy completion events */
export function useStackDestroyProgress(stackId: string | null) {
  const queryClient = useQueryClient();
  const [destroying, setDestroying] = useState(false);
  const [result, setResult] = useState<(DestroyResult & { error?: string }) | null>(null);

  useSocketChannel(Channel.STACKS, !!stackId);

  useSocketEvent(
    ServerEvent.STACK_DESTROY_STARTED,
    (data) => {
      if (data.stackId !== stackId) return;
      setDestroying(true);
      setResult(null);
    },
    !!stackId,
  );

  useSocketEvent(
    ServerEvent.STACK_DESTROY_COMPLETED,
    (data) => {
      if (data.stackId !== stackId) return;
      setDestroying(false);
      setResult(data);

      queryClient.invalidateQueries({ queryKey: ["stacks"] });
      if (stackId) {
        queryClient.invalidateQueries({ queryKey: ["stack", stackId] });
        queryClient.invalidateQueries({ queryKey: ["stackStatus", stackId] });
        queryClient.invalidateQueries({ queryKey: ["stackHistory", stackId] });
      }
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: ["userStacks"] });

      if (data.error) {
        toast.error(`Stack destroy failed: ${data.error}`);
      } else if (data.success) {
        toast.success("Stack destroyed successfully");
      }
    },
    !!stackId,
  );

  const reset = useCallback(() => {
    setDestroying(false);
    setResult(null);
  }, []);

  return { destroying, result, reset };
}

export function useUpdateStackParameterValues() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      stackId,
      parameterValues,
    }: {
      stackId: string;
      parameterValues: Record<string, string | number | boolean>;
    }) => updateStackParameterValues(stackId, parameterValues),
    onSuccess: (_, { stackId }) => {
      queryClient.invalidateQueries({ queryKey: ["stack", stackId] });
      queryClient.invalidateQueries({ queryKey: ["stackPlan", stackId] });
      queryClient.invalidateQueries({ queryKey: ["stackValidation", stackId] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to save parameters: ${(error instanceof Error ? error.message : String(error))}`);
    },
  });
}

// ====================
// Type Exports
// ====================

export type {
  StackInfo,
  StackServiceInfo,
  StackPlan,
  ServiceAction,
  FieldDiff,
  ApplyResult,
  DestroyResult,
  ServiceApplyResult,
  ApplyStackRequest,
};
