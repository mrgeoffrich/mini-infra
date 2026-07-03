import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiKey, CreateApiKeyRequest } from "../lib/auth-types";
import { ApiRoute, CreateApiKeyResponse, queryKeys } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

async function fetchApiKeys(): Promise<ApiKey[]> {
  return (
    (await apiFetch<ApiKey[]>(ApiRoute.apiKeys.list(), {
      correlationIdPrefix: "api-keys",
    })) ?? []
  );
}

async function createApiKey(
  request: CreateApiKeyRequest,
): Promise<CreateApiKeyResponse> {
  return apiFetch<CreateApiKeyResponse>(ApiRoute.apiKeys.list(), {
    method: "POST",
    body: request,
    correlationIdPrefix: "api-keys",
  });
}

async function revokeApiKey(keyId: string): Promise<void> {
  await apiFetch<void>(ApiRoute.apiKeys.revoke(keyId), {
    method: "PATCH",
    correlationIdPrefix: "api-keys",
  });
}

async function rotateApiKey(keyId: string): Promise<CreateApiKeyResponse> {
  return apiFetch<CreateApiKeyResponse>(ApiRoute.apiKeys.rotate(keyId), {
    method: "POST",
    correlationIdPrefix: "api-keys",
  });
}

async function deleteApiKey(keyId: string): Promise<void> {
  await apiFetch<void>(ApiRoute.apiKeys.get(keyId), {
    method: "DELETE",
    correlationIdPrefix: "api-keys",
  });
}

async function fetchApiKeyStats(): Promise<{
  total: number;
  active: number;
  revoked: number;
}> {
  return apiFetch(ApiRoute.apiKeys.stats(), {
    correlationIdPrefix: "api-keys",
  });
}

export function useApiKeys() {
  return useQuery({
    queryKey: queryKeys.apiKeys.all,
    queryFn: fetchApiKeys,
    retry: 1,
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createApiKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.stats });
    },
  });
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: revokeApiKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.stats });
    },
  });
}

export function useRotateApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: rotateApiKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
    },
  });
}

export function useDeleteApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: deleteApiKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.stats });
    },
  });
}

export function useApiKeyStats() {
  return useQuery({
    queryKey: queryKeys.apiKeys.stats,
    queryFn: fetchApiKeyStats,
    retry: 1,
  });
}
