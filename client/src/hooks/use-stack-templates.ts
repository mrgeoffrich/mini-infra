import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type {
  StackTemplateInfo,
  StackTemplateVersionInfo,
  CreateStackTemplateRequest,
  UpdateStackTemplateRequest,
  DraftVersionInput,
  PublishDraftRequest,
  StackTemplateSource,
  StackTemplateScope,
  PrerequisiteEvaluation,
  StackInfo,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

// ─── Filter params type ───────────────────────────────────────────────────────

export interface StackTemplateFilterParams {
  source?: StackTemplateSource;
  scope?: StackTemplateScope;
  environmentId?: string;
  includeArchived?: boolean;
  includeLinkedStacks?: boolean;
}

// ─── Fetch functions ──────────────────────────────────────────────────────────

async function fetchStackTemplates(
  params?: StackTemplateFilterParams,
): Promise<StackTemplateInfo[]> {
  const url = new URL(ApiRoute.stackTemplates.list(), window.location.origin);
  if (params?.source) url.searchParams.set("source", params.source);
  if (params?.scope) url.searchParams.set("scope", params.scope);
  if (params?.environmentId) url.searchParams.set("environmentId", params.environmentId);
  if (params?.includeArchived)
    url.searchParams.set("includeArchived", String(params.includeArchived));
  if (params?.includeLinkedStacks)
    url.searchParams.set("includeLinkedStacks", String(params.includeLinkedStacks));

  // Enveloped `{success, data, message}`; already unwrapped by the
  // original code (`return data.data || []`), so the default unwrap here
  // is behavior-preserving for every consumer.
  return (await apiFetch<StackTemplateInfo[]>(url.toString(), {
    correlationIdPrefix: "stack-templates",
  })) ?? [];
}

async function fetchStackTemplate(
  templateId: string,
  includeLinkedStacks?: boolean,
): Promise<StackTemplateInfo> {
  const url = new URL(ApiRoute.stackTemplates.get(templateId), window.location.origin);
  if (includeLinkedStacks) url.searchParams.set("includeLinkedStacks", "true");
  return apiFetch<StackTemplateInfo>(url.toString(), {
    correlationIdPrefix: "stack-templates",
  });
}

async function rollbackTemplateVersion(args: {
  templateId: string;
  versionId: string;
}): Promise<StackTemplateInfo> {
  return apiFetch<StackTemplateInfo>(ApiRoute.stackTemplates.rollback(args.templateId), {
    method: "POST",
    body: { versionId: args.versionId },
    correlationIdPrefix: "stack-templates",
  });
}

async function fetchStackTemplateVersions(
  templateId: string,
): Promise<StackTemplateVersionInfo[]> {
  return (await apiFetch<StackTemplateVersionInfo[]>(
    ApiRoute.stackTemplates.versions(templateId),
    { correlationIdPrefix: "stack-templates" },
  )) ?? [];
}

async function createStackTemplate(
  request: CreateStackTemplateRequest,
): Promise<StackTemplateInfo> {
  return apiFetch<StackTemplateInfo>(ApiRoute.stackTemplates.list(), {
    method: "POST",
    body: request,
    correlationIdPrefix: "stack-templates",
  });
}

async function updateStackTemplate(args: {
  templateId: string;
  request: UpdateStackTemplateRequest;
}): Promise<StackTemplateInfo> {
  return apiFetch<StackTemplateInfo>(ApiRoute.stackTemplates.get(args.templateId), {
    method: "PATCH",
    body: args.request,
    correlationIdPrefix: "stack-templates",
  });
}

async function saveDraft(args: {
  templateId: string;
  request: DraftVersionInput;
}): Promise<StackTemplateInfo> {
  return apiFetch<StackTemplateInfo>(ApiRoute.stackTemplates.draft(args.templateId), {
    method: "POST",
    body: args.request,
    correlationIdPrefix: "stack-templates",
  });
}

async function publishDraft(args: {
  templateId: string;
  request: PublishDraftRequest;
}): Promise<StackTemplateInfo> {
  return apiFetch<StackTemplateInfo>(ApiRoute.stackTemplates.publish(args.templateId), {
    method: "POST",
    body: args.request,
    correlationIdPrefix: "stack-templates",
  });
}

async function discardDraft(templateId: string): Promise<void> {
  await apiFetch(ApiRoute.stackTemplates.draft(templateId), {
    method: "DELETE",
    correlationIdPrefix: "stack-templates",
  });
}

async function deleteTemplate(templateId: string): Promise<void> {
  await apiFetch(ApiRoute.stackTemplates.get(templateId), {
    method: "DELETE",
    correlationIdPrefix: "stack-templates",
  });
}

// ─── Query hooks ──────────────────────────────────────────────────────────────

export function useStackTemplates(params?: StackTemplateFilterParams) {
  return useQuery({
    queryKey: queryKeys.stackTemplates.list(params),
    queryFn: () => fetchStackTemplates(params),
    retry: 1,
  });
}

export function useStackTemplate(
  templateId: string | undefined,
  opts?: { includeLinkedStacks?: boolean },
) {
  const includeLinkedStacks = opts?.includeLinkedStacks ?? false;
  return useQuery({
    // Distinct key when linked stacks are requested so the richer payload
    // doesn't clobber (or get clobbered by) a plain detail fetch. `detail(id)`
    // still prefix-matches this key, so existing invalidations cover both.
    queryKey: includeLinkedStacks
      ? [...queryKeys.stackTemplates.detail(templateId ?? ""), "linked"]
      : queryKeys.stackTemplates.detail(templateId ?? ""),
    queryFn: () => fetchStackTemplate(templateId!, includeLinkedStacks),
    enabled: !!templateId,
    retry: 1,
  });
}

export function useStackTemplateVersions(templateId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.stackTemplates.versions(templateId ?? ""),
    queryFn: () => fetchStackTemplateVersions(templateId!),
    enabled: !!templateId,
    retry: 1,
  });
}

// ─── Mutation hooks ───────────────────────────────────────────────────────────

export function useCreateStackTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createStackTemplate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stackTemplates.all });
    },
  });
}

export function useUpdateStackTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateStackTemplate,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stackTemplates.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.stackTemplates.detail(variables.templateId),
      });
    },
  });
}

export function useSaveDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: saveDraft,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stackTemplates.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.stackTemplates.detail(variables.templateId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.stackTemplates.versions(variables.templateId),
      });
    },
  });
}

export function usePublishDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: publishDraft,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stackTemplates.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.stackTemplates.detail(variables.templateId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.stackTemplates.versions(variables.templateId),
      });
    },
  });
}

export function useDiscardDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: discardDraft,
    onSuccess: (_data, templateId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stackTemplates.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.stackTemplates.detail(templateId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.stackTemplates.versions(templateId),
      });
    },
  });
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: deleteTemplate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stackTemplates.all });
    },
  });
}

/**
 * Cross-stack prerequisites precheck for what would happen if a
 * template were instantiated into the given scope. Used by the
 * instantiate dialog to render a soft-warn before the user commits.
 *
 * `environmentId` is required for environment-scoped templates and
 * optional for `any`-scoped ones; the server returns 400 with code
 * `ENVIRONMENT_ID_REQUIRED` otherwise.
 */
export function useTemplatePrerequisites(args: {
  templateId: string | undefined;
  environmentId?: string;
  enabled?: boolean;
}) {
  const { templateId, environmentId, enabled = true } = args;
  return useQuery<PrerequisiteEvaluation>({
    queryKey: queryKeys.stackTemplates.prerequisites(templateId!, environmentId),
    queryFn: async () => {
      const url = new URL(
        ApiRoute.stackTemplates.prerequisites(templateId!),
        window.location.origin,
      );
      if (environmentId) url.searchParams.set("environmentId", environmentId);
      // Raw response — `{success, ok, failures}` has no `data` field.
      // 400 with ENVIRONMENT_ID_REQUIRED is expected for env-scoped
      // templates when the user hasn't picked an env yet — apiFetch's
      // built-in message extraction from the error body surfaces it.
      const data = await apiFetch<{ success: boolean } & PrerequisiteEvaluation>(
        url.toString(),
        { unwrap: false, correlationIdPrefix: "stack-templates" },
      );
      return { ok: data.ok, failures: data.failures };
    },
    enabled: !!templateId && enabled,
    staleTime: 5_000,
    retry: false, // 400s for missing env shouldn't retry
  });
}

export function useInstantiateTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (args: {
      templateId: string;
      name?: string;
      environmentId?: string;
      parameterValues?: Record<string, unknown>;
      inputValues?: Record<string, string>;
    }) => {
      return apiFetch<StackInfo>(ApiRoute.stackTemplates.instantiate(args.templateId), {
        method: "POST",
        body: {
          name: args.name,
          environmentId: args.environmentId,
          parameterValues: args.parameterValues,
          inputValues: args.inputValues,
        },
        correlationIdPrefix: "stack-templates",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stackTemplates.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
    },
  });
}

/**
 * Re-point a template's current version to an older published version
 * (POST /:id/rollback). Stacks on a newer version stop showing the update
 * badge; stacks on an older version start showing it.
 */
export function useRollbackTemplateVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: rollbackTemplateVersion,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stackTemplates.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.stackTemplates.detail(variables.templateId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.stackTemplates.versions(variables.templateId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.stacks.all });
    },
  });
}
