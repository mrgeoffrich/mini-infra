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
  TemplateInputDeclaration,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";
import { useTaskTracker } from "./use-task-tracker";
import { apiFetch } from "@/lib/api-client";

// ====================
// Stack API Functions
// ====================

async function fetchStacks(
  environmentId?: string,
  scope?: string,
  source?: string,
): Promise<StackListResponse> {
  const url = new URL(ApiRoute.stacks.list(), window.location.origin);
  if (scope) url.searchParams.set("scope", scope);
  else if (environmentId) url.searchParams.set("environmentId", environmentId);
  // Source is now an explicit filter: without it a scoped query returns ALL
  // sources. Infra lists pass `source=system`, application lists `source=user`.
  if (source) url.searchParams.set("source", source);

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

/**
 * The `rotateOnUpgrade` input declarations the operator must supply to move this
 * stack to `targetVersionId` (or the template's current version when omitted).
 * Empty when that version has no such inputs — the caller can then upgrade
 * without a dialog.
 *
 * The target matters: inputs belong to the version being deployed, so asking
 * the current version what a *different* version needs would prompt for the
 * wrong secrets.
 */
export async function fetchStackUpgradeInputs(
  stackId: string,
  targetVersionId?: string,
): Promise<TemplateInputDeclaration[]> {
  // Query string is appended here rather than baked into the ApiRoute builder:
  // ALL_API_ROUTES is a registry of paths, and a builder that emitted `?…` broke
  // the route-drift check that matches builders against Express routes.
  const path = ApiRoute.stacks.upgradeInputs(stackId);
  const url = targetVersionId
    ? `${path}?targetVersionId=${encodeURIComponent(targetVersionId)}`
    : path;
  const data = await apiFetch<{ inputs: TemplateInputDeclaration[] }>(url, {
    correlationIdPrefix: "stacks",
  });
  return data.inputs ?? [];
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
  // Does NOT catch-and-flatten ApiRequestError into a generic Error — the
  // real error (with its `code`/`resource`/`action`) needs to reach the
  // global MutationCache.onError (client/src/lib/query-client.ts), which
  // renders it via getUserFacingError/toastApiError. Previously this
  // collapsed every 409 into "Stack apply already in progress" even when
  // the real cause was a different conflict (e.g. unmet prerequisites) —
  // the server's actual message is more accurate and no longer needs
  // flattening here.
  return apiFetch<{ started: true; stackId: string }>(
    ApiRoute.stacks.apply(stackId),
    { method: "POST", body: options, correlationIdPrefix: "stacks" },
  );
}

async function upgradeStack(
  stackId: string,
  inputValues?: Record<string, string>,
  targetVersionId?: string,
): Promise<StackInfo> {
  // POST /upgrade re-materializes the stack from a published version of its
  // template — `targetVersionId` when given, else the current version. It does
  // NOT apply — callers chain applyStack afterwards. No catch-and-flatten so the
  // real ApiRequestError (e.g. rotation-required) reaches the global
  // MutationCache.onError.
  return apiFetch<StackInfo>(ApiRoute.stacks.upgrade(stackId), {
    method: "POST",
    body: {
      ...(inputValues ? { inputValues } : {}),
      ...(targetVersionId ? { targetVersionId } : {}),
    },
    correlationIdPrefix: "stacks",
  });
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
  // See applyStack() above — no catch-and-flatten, so the real
  // ApiRequestError (code/resource/action) reaches the global handler.
  return apiFetch<{ started: true; stackId: string }>(
    ApiRoute.stacks.destroy(stackId),
    { method: "POST", correlationIdPrefix: "stacks" },
  );
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

export function useStacks(
  environmentId?: string,
  options?: { scope?: string; source?: string },
) {
  const scope = options?.scope;
  const source = options?.source;

  return useQuery({
    queryKey: queryKeys.stacks.list(environmentId, scope, source),
    queryFn: () => fetchStacks(environmentId, scope, source),
    staleTime: 10000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Global list of EVERY stack across all scopes and sources — the data source
 * for the top-level /stacks page. No scope/environment/source filter is passed,
 * so the server returns all sources for every scope.
 */
export function useAllStacks() {
  return useQuery({
    queryKey: queryKeys.stacks.list(undefined, undefined, undefined),
    queryFn: () => fetchStacks(),
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
    // No onError — the global MutationCache.onError (query-client.ts)
    // toasts the real ApiRequestError (code/resource/action) by default.
  });
}

async function stopStackKeep(
  stackId: string,
): Promise<{ started: true; stackId: string }> {
  // POST /stop — undeploy but keep the definition + DB row (status becomes
  // `undeployed`). Distinct from destroy, which deletes the stack.
  return apiFetch<{ started: true; stackId: string }>(ApiRoute.stacks.stop(stackId), {
    method: "POST",
    body: {},
    correlationIdPrefix: "stacks",
  });
}

/**
 * Stop a stack (undeploy-but-keep) with tracked progress. Registers a
 * "stack-stop" task so progress surfaces in the global tracker.
 */
export function useStackStop() {
  const queryClient = useQueryClient();
  const { registerTask } = useTaskTracker();
  return useMutation({
    mutationFn: async ({ stackId, label }: { stackId: string; label: string }) => {
      registerTask({ id: stackId, type: "stack-stop", label, channel: Channel.STACKS });
      await stopStackKeep(stackId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.userStacks });
    },
    // No onError — the global MutationCache.onError toasts by default.
  });
}

/**
 * Discard unapplied definition edits — POST /stacks/:id/revert-pending.
 * Restores the definition from the last applied snapshot and flips status back
 * to `synced`. 400s (STACK_NO_APPLIED_SNAPSHOT) for never-applied stacks.
 */
export function useRevertPendingStack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stackId: string) =>
      apiFetch<StackInfo>(ApiRoute.stacks.revertPending(stackId), {
        method: "POST",
        body: {},
        correlationIdPrefix: "stacks",
      }),
    onSuccess: () => {
      toast.success("Pending changes discarded");
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.userStacks });
    },
    // No onError — the global MutationCache.onError toasts by default.
  });
}

/**
 * Restore the stack's definition from what a past deployment applied —
 * POST /stacks/:id/history/:deploymentId/restore.
 *
 * Definition only: nothing is deployed, so the stack lands `pending` and the
 * operator applies when ready. Distinct from revert-pending, which restores the
 * LAST applied state (an undo of unapplied edits); this goes back to an older
 * deployment on purpose.
 */
export function useRestoreStackDeployment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stackId, deploymentId }: { stackId: string; deploymentId: string }) =>
      apiFetch<StackInfo>(ApiRoute.stacks.historyRestore(stackId, deploymentId), {
        method: "POST",
        body: {},
        correlationIdPrefix: "stacks",
      }),
    onSuccess: (_data, variables) => {
      toast.success("Definition restored", {
        description: "The stack is now Pending — Apply to deploy it.",
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.history(variables.stackId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.userStacks });
    },
    // No onError — the global MutationCache.onError toasts by default.
  });
}

/**
 * Raw upgrade mutation — POST /stacks/:id/upgrade. Re-materializes the stack
 * from a published template version (`targetVersionId`, else current) and flips
 * it to `pending`. Does NOT apply. Most call sites want
 * {@link useUpgradeAndApplyStack} instead.
 */
export function useStackUpgrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      stackId,
      inputValues,
      targetVersionId,
    }: {
      stackId: string;
      inputValues?: Record<string, string>;
      targetVersionId?: string;
    }) => upgradeStack(stackId, inputValues, targetVersionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.userStacks });
    },
    // No onError — the global MutationCache.onError toasts by default.
  });
}

/**
 * "Upgrade & deploy" as one user action: re-materialize the stack from its
 * template's current published version (POST /upgrade), then run the tracked
 * apply (POST /apply). The apply is fire-and-forget — progress streams via
 * Socket.IO and is surfaced by the global task tracker under "stack-apply".
 *
 * Because the apply is fire-and-forget, this mutation resolves when the deploy
 * *starts*, not when it finishes — and the dialogs that call it close on that
 * ACK. Without a hand-off the user is left staring at a closed dialog with no
 * idea whether anything happened, so success explicitly points at the tracker
 * where the deploy is actually running. Toasting here rather than at each of
 * the three call sites keeps the hand-off consistent across all of them.
 */
export function useUpgradeAndApplyStack() {
  const queryClient = useQueryClient();
  const { registerTask } = useTaskTracker();
  return useMutation({
    mutationFn: async ({
      stackId,
      label,
      inputValues,
      targetVersionId,
    }: {
      stackId: string;
      label: string;
      inputValues?: Record<string, string>;
      targetVersionId?: string;
    }) => {
      await upgradeStack(stackId, inputValues, targetVersionId);
      registerTask({ id: stackId, type: "stack-apply", label, channel: Channel.STACKS });
      await applyStack(stackId, {});
    },
    onSuccess: (_data, variables) => {
      // Title mirrors the label this deploy is registered under in the tracker,
      // so the toast names the exact entry it is pointing the user at.
      toast.success(variables.label, {
        description: "Deploying now — follow progress in the task tracker.",
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.userStacks });
    },
    // No onError — the global MutationCache.onError toasts by default.
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
      } else if (data.upToDate) {
        // Zero-work update: every image was already current, nothing pulled.
        toast.success('Already up to date — nothing to pull');
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

/**
 * Subscribe to server-pushed `STACK_STATUS` events and invalidate the affected
 * list/detail queries so any open view updates live without polling. Mount this
 * on pages that render stack status outside a tracked-operation flow — the
 * global /stacks list, the stack detail page, the applications list/detail, and
 * the environment/host stack lists — so post-plan drift flips, edits that set
 * `pending`, reverts, and apply/upgrade/stop results all surface immediately.
 */
export function useStackStatusEvents() {
  const queryClient = useQueryClient();

  useSocketChannel(Channel.STACKS, true);
  useSocketEvent(
    ServerEvent.STACK_STATUS,
    (data) => {
      // `stacks.all` (["stacks"]) prefix-matches every scoped list variant too.
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.detail(data.stackId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.plan(data.stackId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.status(data.stackId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.userStacks });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.detailAll });
      // Linked-stack status (and the update badge) rides on the template list.
      queryClient.invalidateQueries({ queryKey: queryKeys.stackTemplates.all });
    },
    true,
  );
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
    // No onError — the global MutationCache.onError toasts by default.
  });
}

export function useStackDestroy() {
  return useMutation({
    mutationFn: (stackId: string) => destroyStack(stackId),
    onSuccess: () => {
      // HTTP response just confirms the destroy started.
      // Final results come via Socket.IO events.
    },
    // No onError — the global MutationCache.onError toasts by default.
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
    // No onError — the global MutationCache.onError toasts by default.
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
