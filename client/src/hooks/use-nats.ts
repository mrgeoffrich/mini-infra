import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  CreateNatsAccountRequest,
  CreateNatsConsumerRequest,
  CreateNatsCredentialProfileRequest,
  CreateNatsStreamRequest,
  MintNatsCredentialResponse,
  NatsAccountInfo,
  NatsConsumerInfo,
  NatsCredentialProfileInfo,
  NatsStatus,
  NatsStreamInfo,
} from "@mini-infra/types";

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { message?: string }).message ?? `${res.status} ${res.statusText}`);
  }
  return (body as { data: T }).data;
}

export function useNatsStatus() {
  return useQuery<NatsStatus>({
    queryKey: ["nats", "status"],
    queryFn: () => apiFetch<NatsStatus>("/api/nats/status"),
    refetchInterval: 10_000,
    refetchOnReconnect: true,
  });
}

export function useNatsAccounts() {
  return useQuery<NatsAccountInfo[]>({
    queryKey: ["nats", "accounts"],
    queryFn: () => apiFetch<NatsAccountInfo[]>("/api/nats/accounts"),
  });
}

export function useNatsCredentials() {
  return useQuery<NatsCredentialProfileInfo[]>({
    queryKey: ["nats", "credentials"],
    queryFn: () => apiFetch<NatsCredentialProfileInfo[]>("/api/nats/credentials"),
  });
}

export function useNatsStreams() {
  return useQuery<NatsStreamInfo[]>({
    queryKey: ["nats", "streams"],
    queryFn: () => apiFetch<NatsStreamInfo[]>("/api/nats/streams"),
  });
}

export function useNatsConsumers() {
  return useQuery<NatsConsumerInfo[]>({
    queryKey: ["nats", "consumers"],
    queryFn: () => apiFetch<NatsConsumerInfo[]>("/api/nats/consumers"),
  });
}

export function useApplyNats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ operationId: string }>("/api/nats/apply", { method: "POST" }),
    onSuccess: () => {
      toast.success("NATS configuration applied");
      qc.invalidateQueries({ queryKey: ["nats"] });
    },
    onError: (err: Error) => toast.error(`NATS apply failed: ${err.message}`),
  });
}

export function useCreateNatsAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNatsAccountRequest) => apiFetch<NatsAccountInfo>("/api/nats/accounts", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nats"] }),
  });
}

export function useCreateNatsCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNatsCredentialProfileRequest) => apiFetch<NatsCredentialProfileInfo>("/api/nats/credentials", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nats"] }),
  });
}

export function useMintNatsCredential() {
  return useMutation({
    mutationFn: (id: string) => apiFetch<MintNatsCredentialResponse>(`/api/nats/credentials/${id}/mint`, { method: "POST", body: JSON.stringify({}) }),
  });
}

export function useCreateNatsStream() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNatsStreamRequest) => apiFetch<NatsStreamInfo>("/api/nats/streams", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nats"] }),
  });
}

export function useCreateNatsConsumer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNatsConsumerRequest) => apiFetch<NatsConsumerInfo>("/api/nats/consumers", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nats"] }),
  });
}
