import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiKey, CreateApiKeyRequest, ApiKeyResponse } from "../lib/auth-types";

async function fetchApiKeys(): Promise<ApiKey[]> {
  const response = await fetch(`/api/keys`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch API keys: ${response.statusText}`);
  }

  const data = await response.json();
  return data.data || [];
}

async function createApiKey(request: CreateApiKeyRequest): Promise<ApiKey> {
  const response = await fetch(`/api/keys`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Failed to create API key: ${response.statusText}`);
  }

  const data: ApiKeyResponse = await response.json();
  return data.data;
}

async function revokeApiKey(keyId: string): Promise<void> {
  const response = await fetch(`/api/keys/${keyId}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to revoke API key: ${response.statusText}`);
  }
}

export function useApiKeys() {
  return useQuery({
    queryKey: ["apiKeys"],
    queryFn: fetchApiKeys,
    retry: 1,
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createApiKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["apiKeys"] });
    },
  });
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: revokeApiKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["apiKeys"] });
    },
  });
}
