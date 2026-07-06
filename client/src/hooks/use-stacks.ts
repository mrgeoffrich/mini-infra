import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import { toast } from "sonner";
import {
  Channel,
  ServerEvent,
  ApiRoute,
  queryKeys,
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
  StackValidationError,
  StackValidationResult,
  StackStatusResponseData,
  StackDeploymentRecord,
  PrerequisiteEvaluation,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

// ====================
// Stack API Functions
// ====================

async function fetchStacks(
  environmentId?: string,
  scope?: string,
): Promise<StackListResponse> {
  const url = new URL(ApiRoute.stacks.list(), window.location.origin);
  if (scope) url.searchParams.set("scope", scope);
  else if (environmentId) url.searchParams.set("environmentId", environmentId);

  // Enveloped response — kept as-is (not unwrapped) because several
  // out-of-batch consumers (e.g. applications/new/page.tsx,
  // applications/adopt/page.tsx) already read `.data` off the resolved
  // query value.
  const data = await apiFetch<StackListResponse>(url.toString(), {
    unwrap: false,
    correlationIdPrefix: "stacks",
  });
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch stacks");
  }
  return data;
}

async function fetchStack(stackId: string): Promise<StackResponse> {
  // Enveloped — kept as-is; consumed as `.data.data` externally (e.g.
  // egress pages' `useStack()` usage).
  const data = await apiFetch<StackResponse>(ApiRoute.stacks.get(stackId), {
    unwrap: false,
    correlationIdPrefix: "stacks",
  });
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch stack");
  }
  return data;
}

async function fetchStackPlan(stackId: string): Promise<StackPlan> {
  // Only consumer is StackPlanView.tsx (same batch), so this is safely
  // unwrapped — apiFetch throws ApiRequestError (with `.status`/`.code`/
  // `.body`) on failure, which the call site inspects directly.
  return apiFetch<StackPlan>(ApiRoute.stacks.plan(stackId), {
    correlationIdPrefix: "stacks",
  });
}

async function fetchStackValidation(
  stackId: string,
): Promise<StackValidationResult> {
  // Raw (non-{success,data}-enveloped) response shape — `{success, valid,
  // errors, warnings}` has no `data` field, so unwrap:false and return the
  // parsed body directly (matches original behavior, which never checked
  // `.success` either).
  return apiFetch<StackValidationResult>(ApiRoute.stacks.validate(stackId), {
    unwrap: false,
    correlationIdPrefix: "stacks",
  });
}

async function applyStack(
  stackId: string,
  options: ApplyStackRequest,
): Promise<{ started: true; stackId: string }> {
  try {
    return await apiFetch<{ started: true; stackId: string }>(
      ApiRoute.stacks.apply(stackId),
      { method: "POST", body: options, correlationIdPrefix: "stacks" },
    );
  } catch (err) {
    if (err instanceof ApiRequestError) {
      if (err.status === 503) throw new Error("Docker is unavailable", { cause: err });
      if (err.status === 409) {
        throw new Error("Stack apply already in progress", { cause: err });
      }
    }
    throw err;
  }
}

async function fetchStackStatus(
  stackId: string,
): Promise<{ success: boolean; data: StackStatusResponseData }> {
  // Enveloped — kept as-is; consumed as `.data.data` externally
  // (applications/[id]/layout.tsx's `useStackStatus()` usage).
  const data = await apiFetch<{
    success: boolean;
    data: StackStatusResponseData;
    message?: string;
  }>(ApiRoute.stacks.status(stackId), {
    unwrap: false,
    correlationIdPrefix: "stacks",
  });
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch stack status");
  }
  return data;
}

async function fetchStackHistory(
  stackId: string,
): Promise<{ success: boolean; data: StackDeploymentRecord[]; total?: number }> {
  // Enveloped — kept as-is; consumed as `.data.data` externally
  // (applications/[id]/history/page.tsx and overview/page.tsx).
  const data = await apiFetch<{
    success: boolean;
    data: StackDeploymentRecord[];
    total?: number;
    message?: string;
  }>(ApiRoute.stacks.history(stackId), {
    unwrap: false,
    correlationIdPrefix: "stacks",
  });
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch stack history");
  }
  return data;
}

async function deleteStack(
  stackId: string,
): Promise<{ success: boolean; message: string }> {
  // Raw response — no `data` field, and the original code never checked
  // `.success` either, so unwrap:false with no manual check.
  return apiFetch<{ success: boolean; message: string }>(
    ApiRoute.stacks.get(stackId),
    { method: "DELETE", unwrap: false, correlationIdPrefix: "stacks" },
  );
}

async function destroyStack(
  stackId: string,
): Promise<{ started: true; stackId: string }> {
  try {
    return await apiFetch<{ started: true; stackId: string }>(
      ApiRoute.stacks.destroy(stackId),
      { method: "POST", correlationIdPrefix: "stacks" },
    );
  } catch (err) {
    if (err instanceof ApiRequestError) {
      if (err.status === 503) throw new Error("Docker is unavailable", { cause: err });
      if (err.status === 409) {
        throw new Error("An operation is already in progress for this stack", {
          cause: err,
        });
      }
    }
    throw err;
  }
}

async function updateStackParameterValues(
  stackId: string,
  parameterValues: Record<string, string | number | boolean>,
): Promise<StackInfo> {
  // Not consumed downstream — safe to unwrap.
  return apiFetch<StackInfo>(ApiRoute.stacks.get(stackId), {
    method: "PUT",
    body: { parameterValues },
    correlationIdPrefix: "stacks",
  });
}

export type { StackValidationError, StackValidationResult };

// ====================
// Stack Hooks
// ====================

export function useStackValidation(stackId: string, enabled = true) {
  return useQuery<StackValidationResult>({
    queryKey: queryKeys.stacks.validation(stackId),
    queryFn: () => fetchStackValidation(stackId),
    enabled: !!stackId && enabled,
    staleTime: 10000,
    gcTime: 2 * 60 * 1000,
  });
}

export function useStacks(environmentId?: string, options?: { scope?: string }) {
  const scope = options?.scope;

  return useQuery({
    queryKey: queryKeys.stacks.list(environmentId, scope),
    queryFn: () => fetchStacks(environmentId, scope),
    staleTime: 10000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}

export function useStack(stackId: string) {
  return useQuery({
    queryKey: queryKeys.stacks.detail(stackId),
    queryFn: () => fetchStack(stackId),
    enabled: !!stackId,
    staleTime: 5000,
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * Cross-stack prerequisites precheck for an existing stack. Returns
 * `ok: true` when all prereqs are met (apply will proceed), `ok: false`
 * with structured failures otherwise. UI uses this to render an
 * "apply blocked" banner and disable the apply button before the user
 * even hits the apply endpoint.
 */
export function useStackPrerequisites(stackId: string, enabled = true) {
  return useQuery<PrerequisiteEvaluation>({
    queryKey: queryKeys.stacks.prerequisites(stackId),
    queryFn: async () => {
      // Raw response — `{success, ok, failures}` has no `data` field.
      const data = await apiFetch<{ success: boolean } & PrerequisiteEvaluation>(
        ApiRoute.stacks.prerequisites(stackId),
        { unwrap: false, correlationIdPrefix: "stacks" },
      );
      return { ok: data.ok, failures: data.failures };
    },
    enabled: !!stackId && enabled,
    staleTime: 5_000,
  });
}

export function useStackPlan(stackId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.stacks.plan(stackId),
    queryFn: () => fetchStackPlan(stackId),
    enabled: !!stackId && enabled,
    staleTime: 0,
    gcTime: 2 * 60 * 1000,
  });
}

export function useStackApply() {
  return useMutation({
    mutationFn: ({
      stackId,
      options,
    }: {
      stackId: string;
      options: ApplyStackRequest;
    }) => applyStack(stackId, options),
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
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.detail(stackId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.plan(stackId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.status(stackId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.history(stackId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.userStacks });

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
  const { connected } = useSocket();

  // Subscribe to stacks channel for push updates
  useSocketChannel(Channel.STACKS, !!stackId);

  return useQuery({
    queryKey: queryKeys.stacks.status(stackId),
    queryFn: () => fetchStackStatus(stackId),
    enabled: !!stackId,
    refetchInterval: connected ? false : 5000,
    staleTime: 2000,
    gcTime: 2 * 60 * 1000,
    refetchOnReconnect: true,
  });
}

export function useStackHistory(stackId: string) {
  return useQuery({
    queryKey: queryKeys.stacks.history(stackId),
    queryFn: () => fetchStackHistory(stackId),
    enabled: !!stackId,
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
  });
}

export function useDeleteStack() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (stackId: string) => deleteStack(stackId),
    onSuccess: () => {
      toast.success("Stack deleted successfully");
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete stack: ${(error instanceof Error ? error.message : String(error))}`);
    },
  });
}

export function useStackDestroy() {
  return useMutation({
    mutationFn: (stackId: string) => destroyStack(stackId),
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

      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
      if (stackId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.stacks.detail(stackId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.stacks.status(stackId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.stacks.history(stackId) });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.userStacks });

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
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.detail(stackId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.plan(stackId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.validation(stackId) });
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
