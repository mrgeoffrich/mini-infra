import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  StackTemplateInfo,
  StackTemplateListResponse,
  StackTemplateResponse,
  StackTemplateVersionInfo,
  StackTemplateVersionListResponse,
  CreateStackTemplateRequest,
  UpdateStackTemplateRequest,
  DraftVersionInput,
  PublishDraftRequest,
  StackTemplateSource,
  StackTemplateScope,
} from "@mini-infra/types";

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
  const url = new URL("/api/stack-templates", window.location.origin);
  if (params?.source) url.searchParams.set("source", params.source);
  if (params?.scope) url.searchParams.set("scope", params.scope);
  if (params?.environmentId) url.searchParams.set("environmentId", params.environmentId);
  if (params?.includeArchived)
    url.searchParams.set("includeArchived", String(params.includeArchived));
  if (params?.includeLinkedStacks)
    url.searchParams.set("includeLinkedStacks", String(params.includeLinkedStacks));

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch stack templates: ${response.statusText}`);
  }

  const data: StackTemplateListResponse = await response.json();
  return data.data || [];
}

async function fetchStackTemplate(templateId: string): Promise<StackTemplateInfo> {
  const response = await fetch(`/api/stack-templates/${templateId}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch stack template: ${response.statusText}`);
  }

  const data: StackTemplateResponse = await response.json();
  return data.data;
}

async function fetchStackTemplateVersions(
  templateId: string,
): Promise<StackTemplateVersionInfo[]> {
  const response = await fetch(`/api/stack-templates/${templateId}/versions`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch stack template versions: ${response.statusText}`,
    );
  }

  const data: StackTemplateVersionListResponse = await response.json();
  return data.data || [];
}

async function createStackTemplate(
  request: CreateStackTemplateRequest,
): Promise<StackTemplateInfo> {
  const response = await fetch("/api/stack-templates", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(
      errorData?.message || `Failed to create stack template: ${response.statusText}`,
    );
  }

  const data: StackTemplateResponse = await response.json();
  return data.data;
}

async function updateStackTemplate(args: {
  templateId: string;
  request: UpdateStackTemplateRequest;
}): Promise<StackTemplateInfo> {
  const response = await fetch(`/api/stack-templates/${args.templateId}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args.request),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(
      errorData?.message || `Failed to update stack template: ${response.statusText}`,
    );
  }

  const data: StackTemplateResponse = await response.json();
  return data.data;
}

async function saveDraft(args: {
  templateId: string;
  request: DraftVersionInput;
}): Promise<StackTemplateInfo> {
  const response = await fetch(`/api/stack-templates/${args.templateId}/draft`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args.request),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(
      errorData?.message || `Failed to save draft: ${response.statusText}`,
    );
  }

  const data: StackTemplateResponse = await response.json();
  return data.data;
}

async function publishDraft(args: {
  templateId: string;
  request: PublishDraftRequest;
}): Promise<StackTemplateInfo> {
  const response = await fetch(`/api/stack-templates/${args.templateId}/publish`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args.request),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(
      errorData?.message || `Failed to publish draft: ${response.statusText}`,
    );
  }

  const data: StackTemplateResponse = await response.json();
  return data.data;
}

async function discardDraft(templateId: string): Promise<void> {
  const response = await fetch(`/api/stack-templates/${templateId}/draft`, {
    method: "DELETE",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(
      errorData?.message || `Failed to discard draft: ${response.statusText}`,
    );
  }
}

async function deleteTemplate(templateId: string): Promise<void> {
  const response = await fetch(`/api/stack-templates/${templateId}`, {
    method: "DELETE",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(
      errorData?.message || `Failed to delete stack template: ${response.statusText}`,
    );
  }
}

// ─── Query hooks ──────────────────────────────────────────────────────────────

export function useStackTemplates(params?: StackTemplateFilterParams) {
  return useQuery({
    queryKey: ["stackTemplates", params],
    queryFn: () => fetchStackTemplates(params),
    retry: 1,
  });
}

export function useStackTemplate(templateId: string | undefined) {
  return useQuery({
    queryKey: ["stackTemplate", templateId],
    queryFn: () => fetchStackTemplate(templateId!),
    enabled: !!templateId,
    retry: 1,
  });
}

export function useStackTemplateVersions(templateId: string | undefined) {
  return useQuery({
    queryKey: ["stackTemplateVersions", templateId],
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
      queryClient.invalidateQueries({ queryKey: ["stackTemplates"] });
    },
  });
}

export function useUpdateStackTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateStackTemplate,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["stackTemplates"] });
      queryClient.invalidateQueries({
        queryKey: ["stackTemplate", variables.templateId],
      });
    },
  });
}

export function useSaveDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: saveDraft,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["stackTemplates"] });
      queryClient.invalidateQueries({
        queryKey: ["stackTemplate", variables.templateId],
      });
      queryClient.invalidateQueries({
        queryKey: ["stackTemplateVersions", variables.templateId],
      });
    },
  });
}

export function usePublishDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: publishDraft,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["stackTemplates"] });
      queryClient.invalidateQueries({
        queryKey: ["stackTemplate", variables.templateId],
      });
      queryClient.invalidateQueries({
        queryKey: ["stackTemplateVersions", variables.templateId],
      });
    },
  });
}

export function useDiscardDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: discardDraft,
    onSuccess: (_data, templateId) => {
      queryClient.invalidateQueries({ queryKey: ["stackTemplates"] });
      queryClient.invalidateQueries({ queryKey: ["stackTemplate", templateId] });
      queryClient.invalidateQueries({
        queryKey: ["stackTemplateVersions", templateId],
      });
    },
  });
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: deleteTemplate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stackTemplates"] });
    },
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
    }) => {
      const response = await fetch(`/api/stack-templates/${args.templateId}/instantiate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: args.name,
          environmentId: args.environmentId,
          parameterValues: args.parameterValues,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.message || `Failed to instantiate template: ${response.statusText}`);
      }
      const data = await response.json();
      return data.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stackTemplates"] });
      queryClient.invalidateQueries({ queryKey: ["stacks"] });
    },
  });
}
