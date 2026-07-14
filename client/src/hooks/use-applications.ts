import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type {
  StackTemplateInfo,
  StackTemplateListResponse,
  StackTemplateResponse,
  StackTemplateVersionInfo,
  CreateStackTemplateRequest,
  DraftVersionInput,
  StackInfo,
  StackListResponse,
  StackResponse,
  StackStatus,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";
import { toastApiError } from "@/lib/errors";

// ====================
// Application API Functions
// ====================

async function fetchApplications(): Promise<StackTemplateListResponse> {
  const url = new URL(ApiRoute.stackTemplates.list(), window.location.origin);
  url.searchParams.set("source", "user");

  // Enveloped — kept as-is; consumed as `.data` externally
  // (applications/page.tsx).
  const data = await apiFetch<StackTemplateListResponse>(url.toString(), {
    unwrap: false,
    correlationIdPrefix: "applications",
  });
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch applications");
  }
  return data;
}

async function fetchApplication(id: string): Promise<StackTemplateResponse> {
  // Enveloped — kept as-is; consumed as `.data` externally
  // (applications/[id]/layout.tsx).
  const data = await apiFetch<StackTemplateResponse>(
    ApiRoute.stackTemplates.get(id),
    { unwrap: false, correlationIdPrefix: "applications" },
  );
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch application");
  }
  return data;
}

async function createApplication(
  request: CreateStackTemplateRequest,
): Promise<StackTemplateResponse> {
  // Enveloped — kept as-is; `.data.id` is read both internally (below) and
  // externally (claude-shell/page.tsx's `result.data.id`).
  const data = await apiFetch<StackTemplateResponse>(
    ApiRoute.stackTemplates.list(),
    { method: "POST", body: request, correlationIdPrefix: "applications", unwrap: false },
  );
  if (!data.success) {
    throw new Error(data.message || "Failed to create application");
  }
  return data;
}

async function publishApplication(templateId: string): Promise<void> {
  await apiFetch(ApiRoute.stackTemplates.publish(templateId), {
    method: "POST",
    body: {},
    correlationIdPrefix: "applications",
  });
}

async function createDraft(
  templateId: string,
  input: DraftVersionInput,
): Promise<void> {
  await apiFetch(ApiRoute.stackTemplates.draft(templateId), {
    method: "POST",
    body: input,
    correlationIdPrefix: "applications",
  });
}

async function updateTemplateMetadata(
  templateId: string,
  metadata: { displayName?: string; description?: string; category?: string },
): Promise<void> {
  await apiFetch(ApiRoute.stackTemplates.get(templateId), {
    method: "PATCH",
    body: metadata,
    correlationIdPrefix: "applications",
  });
}

async function deleteTemplate(
  id: string,
): Promise<{ success: boolean; message: string }> {
  // Raw response — original code never checked `.success` either.
  return apiFetch<{ success: boolean; message: string }>(
    ApiRoute.stackTemplates.get(id),
    { method: "DELETE", unwrap: false, correlationIdPrefix: "applications" },
  );
}

async function instantiateApplication(
  templateId: string,
  body: { name?: string; environmentId?: string; parameterValues?: Record<string, unknown> },
): Promise<StackResponse> {
  // Enveloped — kept as-is; `.data.id` read internally below.
  const data = await apiFetch<StackResponse>(
    ApiRoute.stackTemplates.instantiate(templateId),
    { method: "POST", body, correlationIdPrefix: "applications", unwrap: false },
  );
  if (!data.success) {
    throw new Error(data.message || "Failed to instantiate application");
  }
  return data;
}

async function applyStack(
  stackId: string,
): Promise<{ started: true; stackId: string }> {
  return apiFetch<{ started: true; stackId: string }>(ApiRoute.stacks.apply(stackId), {
    method: "POST",
    body: {},
    correlationIdPrefix: "applications",
  });
}

async function destroyStack(
  stackId: string,
): Promise<{ started: true; stackId: string }> {
  return apiFetch<{ started: true; stackId: string }>(ApiRoute.stacks.destroy(stackId), {
    method: "POST",
    correlationIdPrefix: "applications",
  });
}

/**
 * Stop a stack's containers but KEEP its definition + DB row (status becomes
 * `undeployed`). This is the honest "Stop" — the stack can be deployed again
 * without re-instantiating, and Stateful volumes are preserved. Distinct from
 * {@link destroyStack}, which deletes the stack record.
 */
async function stopStackKeep(
  stackId: string,
): Promise<{ started: true; stackId: string }> {
  return apiFetch<{ started: true; stackId: string }>(ApiRoute.stacks.stop(stackId), {
    method: "POST",
    body: {},
    correlationIdPrefix: "applications",
  });
}

/**
 * Statuses on which POST /stacks/:id/update (pull-latest-and-recreate) is a
 * valid no-op-tag redeploy. Anything else must go through POST /apply, which
 * has no status guard and is the correct recovery for error/undeployed/pending
 * stacks (the /update route 400s with STACK_NOT_DEPLOYED for those).
 */
const UPDATABLE_STATUSES: ReadonlySet<StackStatus> = new Set<StackStatus>([
  "synced",
  "drifted",
]);

async function updateStack(
  stackId: string,
): Promise<{ started: true; stackId: string }> {
  return apiFetch<{ started: true; stackId: string }>(ApiRoute.stacks.update(stackId), {
    method: "POST",
    correlationIdPrefix: "applications",
  });
}

async function updateStackService(
  stackId: string,
  serviceName: string,
  patch: { dockerTag?: string; dockerImage?: string },
): Promise<StackInfo> {
  return apiFetch<StackInfo>(ApiRoute.stacks.service(stackId, serviceName), {
    method: "PUT",
    body: patch,
    correlationIdPrefix: "applications",
  });
}

async function fetchUserStacks(): Promise<StackListResponse> {
  const url = new URL(ApiRoute.stacks.list(), window.location.origin);
  url.searchParams.set("source", "user");

  // Enveloped — kept as-is; consumed as `.data` externally
  // (applications/page.tsx, applications/new/page.tsx).
  const data = await apiFetch<StackListResponse>(url.toString(), {
    unwrap: false,
    correlationIdPrefix: "applications",
  });
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch stacks");
  }
  return data;
}

// ====================
// Application Hooks
// ====================

export function useApplications() {
  return useQuery({
    queryKey: queryKeys.applications.all,
    queryFn: () => fetchApplications(),
    staleTime: 10000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}

export function useApplication(id: string) {
  return useQuery({
    queryKey: queryKeys.applications.detail(id),
    queryFn: () => fetchApplication(id),
    enabled: !!id,
    staleTime: 5000,
    gcTime: 5 * 60 * 1000,
  });
}

export function useUserStacks() {
  return useQuery({
    queryKey: queryKeys.applications.userStacks,
    queryFn: () => fetchUserStacks(),
    staleTime: 10000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}

export function useCreateApplication() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      request: CreateStackTemplateRequest & {
        onStackCreated?: (stackId: string) => void;
        /**
         * Optional async hook fired AFTER `POST /:templateId/instantiate`
         * returns the new stack id but BEFORE the apply kicks off. Used by
         * the Claude Shell preset to upload a Vault-stored git deploy key
         * (`PUT /api/stacks/:stackId/services/:serviceName/git-deploy-key`)
         * in the same submission so the very first apply sees the key.
         *
         * The callback's failure is fatal — the apply is skipped and the
         * outer mutation rejects, so the operator gets one clear error
         * rather than a healthy-stack-with-missing-credentials half state.
         */
        onStackInstantiated?: (stackId: string) => Promise<void> | void;
      },
    ) => {
      // Create template
      const result = await createApplication(request);
      // Publish the draft immediately
      await publishApplication(result.data.id);

      // If deployImmediately, instantiate and apply
      if (request.deployImmediately && request.environmentId) {
        const stackResult = await instantiateApplication(
          result.data.id,
          { name: result.data.name, environmentId: request.environmentId },
        );
        // Run the post-instantiate hook (e.g. claude-shell deploy-key upload)
        // before kicking off apply so the first apply already sees Vault.
        // Failure here MUST reject so the form stays on the page and the
        // operator can correct the input (review #4). Returning the
        // partial-create result would let the form `.reset()` + navigate
        // away while a half-created stack sits behind in the backend.
        //
        // Edge case: when `onStackInstantiated` throws, the stack template
        // is already created + instantiated. We intentionally leave the
        // stack un-applied — the operator can retry the key upload from
        // the stack detail page (option (c) per the review). The form's
        // banner + outer `onError` toast surface the failure.
        if (request.onStackInstantiated) {
          await request.onStackInstantiated(stackResult.data.id);
        }
        try {
          // Register task tracking before apply starts
          request.onStackCreated?.(stackResult.data.id);
          // Apply is fire-and-forget (progress via Socket.IO)
          await applyStack(stackResult.data.id);
          return { ...result, stackId: stackResult.data.id };
        } catch (err) {
          // Template was created + instantiated successfully, but the
          // apply trigger itself failed (network blip, server-side
          // validation, etc.). The stack is durable — toast the partial
          // success (via the shared presentation layer, so the real
          // code/resource/action still renders) and let the operator retry
          // from the applications list.
          toastApiError(err, { title: "Application created but deployment failed" });
          return result; // Return success for the create
        }
      }

      return result;
    },
    onSuccess: (_data, variables) => {
      const message = variables.deployImmediately
        ? "Application created and deployment started"
        : "Application created successfully";
      toast.success(message);
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      if (variables.deployImmediately) {
        queryClient.invalidateQueries({ queryKey: queryKeys.applications.userStacks });
        queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
      }
    },
    // No onError — the global MutationCache.onError (query-client.ts)
    // toasts the real ApiRequestError (code/resource/action) by default.
  });
}

export function useUpdateApplication() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      templateId,
      metadata,
      draft,
    }: {
      templateId: string;
      metadata: { displayName?: string; description?: string; category?: string };
      draft: DraftVersionInput;
    }) => {
      // Update metadata
      await updateTemplateMetadata(templateId, metadata);
      // Create a new draft
      await createDraft(templateId, draft);
      // Publish it
      await publishApplication(templateId);
    },
    onSuccess: () => {
      toast.success("Application updated successfully");
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.detailAll });
      // A republish can change a service's declared `joinNetworks` (e.g. via the
      // Overview Connected Networks card), so refresh the managed-network views
      // that read it. The change only compiles into live memberships on the
      // stack's next apply, but this keeps the declared-vs-live delta current.
      queryClient.invalidateQueries({ queryKey: queryKeys.docker.managedNetworksAll });
    },
    // No onError — the global MutationCache.onError toasts by default.
  });
}

export function useDeleteApplication() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ templateId }: { templateId: string }) => {
      return deleteTemplate(templateId);
    },
    onSuccess: () => {
      toast.success("Application deleted successfully");
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.userStacks });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
    },
    // No onError — the global MutationCache.onError toasts by default.
  });
}

export function useDeployApplication() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      templateId,
      name,
      environmentId,
      onStackCreated,
    }: {
      templateId: string;
      name: string;
      environmentId: string;
      onStackCreated?: (stackId: string) => void;
    }) => {
      // Instantiate a stack from the template
      const stackResult = await instantiateApplication(
        templateId,
        { name, environmentId },
      );
      // Register task tracking before apply starts
      onStackCreated?.(stackResult.data.id);
      // Apply/deploy the stack
      await applyStack(stackResult.data.id);
      return stackResult.data;
    },
    onSuccess: () => {
      toast.success("Application deployment started");
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.userStacks });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
    },
    // No onError — the global MutationCache.onError toasts by default.
  });
}

/**
 * The honest "Stop": undeploy-but-keep. Stops the stack's containers via
 * POST /stacks/:id/stop; the stack definition + row are preserved so the app
 * can be deployed again without re-instantiating.
 */
export function useStopApplication() {
  return useMutation({
    mutationFn: async (stackId: string) => {
      await stopStackKeep(stackId);
    },
    // No onError — the global MutationCache.onError toasts by default.
  });
}

/**
 * The destructive "Remove"/"Uninstall": tears down the deployed stack —
 * containers, volumes, and the stack DB record are deleted. The application
 * template is kept, so the app can be redeployed from scratch afterwards.
 */
export function useRemoveApplicationStack() {
  return useMutation({
    mutationFn: async (stackId: string) => {
      await destroyStack(stackId);
    },
    // No onError — the global MutationCache.onError toasts by default.
  });
}

export function useRedeployApplication() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (args: { stackId: string; stackStatus: StackStatus }) => {
      // A no-op-tag redeploy of a synced/drifted stack is a pull-latest via
      // /update; any other status must recover through /apply (which has no
      // status guard) or /update would 400 with STACK_NOT_DEPLOYED.
      if (UPDATABLE_STATUSES.has(args.stackStatus)) {
        await updateStack(args.stackId);
      } else {
        await applyStack(args.stackId);
      }
    },
    onSuccess: () => {
      toast.success("Application update started");
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.userStacks });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
    },
    // No onError — the global MutationCache.onError toasts by default.
  });
}

/**
 * Apply/Retry a stack directly — the recovery path for a stack in
 * `error`/`pending`/`undeployed`. POST /apply has no status guard, so it is
 * the correct action wherever those non-synced states surface (the detail
 * header retry button, the overview failure alert).
 */
export function useApplyApplicationStack() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (stackId: string) => {
      await applyStack(stackId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.userStacks });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
    },
    // No onError — the global MutationCache.onError toasts by default.
  });
}

export function useDeployApplicationUpdate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (args: {
      stackId: string;
      serviceName: string;
      newTag: string;
      currentTag: string;
      stackStatus: StackStatus;
    }) => {
      if (args.newTag !== args.currentTag) {
        await updateStackService(
          args.stackId,
          args.serviceName,
          { dockerTag: args.newTag },
        );
        await applyStack(args.stackId);
      } else if (UPDATABLE_STATUSES.has(args.stackStatus)) {
        // Unchanged tag on a deployed stack → pull-latest-and-recreate.
        await updateStack(args.stackId);
      } else {
        // Unchanged tag on a non-synced stack (error/undeployed/pending):
        // /update would 400, so recover through /apply instead.
        await applyStack(args.stackId);
      }
    },
    onSuccess: () => {
      toast.success("Application update started");
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.userStacks });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
    },
    // No onError — the global MutationCache.onError toasts by default.
  });
}

// ====================
// Type Exports
// ====================

export type { StackTemplateInfo, StackTemplateVersionInfo, StackInfo };
