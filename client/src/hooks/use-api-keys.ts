import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiKey, CreateApiKeyRequest, ApiKeyResponse } from "../lib/auth-types";
import { CreateApiKeyResponse } from "@mini-infra/types";

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

async function createApiKey(request: CreateApiKeyRequest): Promise<CreateApiKeyResponse> {
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
  return data.data as CreateApiKeyResponse;
}

async function revokeApiKey(keyId: string): Promise<void> {
  const response = await fetch(`/api/keys/${keyId}/revoke`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to revoke API key: ${response.statusText}`);
  }
}

async function rotateApiKey(keyId: string): Promise<CreateApiKeyResponse> {
  const response = await fetch(`/api/keys/${keyId}/rotate`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to rotate API key: ${response.statusText}`);
  }

  const data: ApiKeyResponse = await response.json();
  return data.data as CreateApiKeyResponse;
}

async function deleteApiKey(keyId: string): Promise<void> {
  const response = await fetch(`/api/keys/${keyId}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to delete API key: ${response.statusText}`);
  }
}

async function fetchApiKeyStats(): Promise<{
  total: number;
  active: number;
  revoked: number;
}> {
  const response = await fetch(`/api/keys/stats`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch API key stats: ${response.statusText}`);
  }

  const data = await response.json();
  return data.data;
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
      queryClient.invalidateQueries({ queryKey: ["apiKeyStats"] });
    },
  });
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: revokeApiKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["apiKeys"] });
      queryClient.invalidateQueries({ queryKey: ["apiKeyStats"] });
    },
  });
}

export function useRotateApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: rotateApiKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["apiKeys"] });
    },
  });
}

export function useDeleteApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: deleteApiKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["apiKeys"] });
      queryClient.invalidateQueries({ queryKey: ["apiKeyStats"] });
    },
  });
}

export function useApiKeyStats() {
  return useQuery({
    queryKey: ["apiKeyStats"],
    queryFn: fetchApiKeyStats,
    retry: 1,
  });
}
