import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiRoute, queryKeys } from "@mini-infra/types";
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
import { apiFetch } from "@/lib/api-client";

// NATS_APPLIED (Channel.NATS) only fires around an explicit /api/nats/apply
// operation — it isn't a continuous "reachability changed" push like
// Channel.VAULT's VAULT_STATUS_CHANGED (which is backed by a dedicated health
// watcher). useApplyNats already invalidates on its own success, so there's
// no genuine matching status-changed event for the periodic status poller
// below; it keeps polling.
export function useNatsStatus() {
  return useQuery<NatsStatus>({
    queryKey: queryKeys.nats.status,
    queryFn: () =>
      apiFetch<NatsStatus>(ApiRoute.nats.status(), { correlationIdPrefix: "nats-status" }),
    refetchInterval: 10_000,
    refetchOnReconnect: true,
  });
}

export function useNatsAccounts() {
  return useQuery<NatsAccountInfo[]>({
    queryKey: queryKeys.nats.accounts,
    queryFn: () =>
      apiFetch<NatsAccountInfo[]>(ApiRoute.nats.accounts(), { correlationIdPrefix: "nats-accounts" }),
  });
}

export function useNatsCredentials() {
  return useQuery<NatsCredentialProfileInfo[]>({
    queryKey: queryKeys.nats.credentials,
    queryFn: () =>
      apiFetch<NatsCredentialProfileInfo[]>(ApiRoute.nats.credentials(), {
        correlationIdPrefix: "nats-credentials",
      }),
  });
}

export function useNatsStreams() {
  return useQuery<NatsStreamInfo[]>({
    queryKey: queryKeys.nats.streams,
    queryFn: () =>
      apiFetch<NatsStreamInfo[]>(ApiRoute.nats.streams(), { correlationIdPrefix: "nats-streams" }),
  });
}

export function useNatsConsumers() {
  return useQuery<NatsConsumerInfo[]>({
    queryKey: queryKeys.nats.consumers,
    queryFn: () =>
      apiFetch<NatsConsumerInfo[]>(ApiRoute.nats.consumers(), { correlationIdPrefix: "nats-consumers" }),
  });
}

export function useApplyNats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ operationId: string }>(ApiRoute.nats.apply(), {
        method: "POST",
        correlationIdPrefix: "nats-apply",
      }),
    onSuccess: () => {
      toast.success("NATS configuration applied");
      qc.invalidateQueries({ queryKey: queryKeys.nats.all });
    },
    // Failure is toasted by the global `MutationCache.onError` default (see
    // `client/src/lib/query-client.ts`), which renders the server's `code` /
    // `resource` / `action` via `getUserFacingError` instead of a bare
    // "NATS apply failed: <message>" string.
  });
}

export function useCreateNatsAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNatsAccountRequest) =>
      apiFetch<NatsAccountInfo>(ApiRoute.nats.accounts(), {
        method: "POST",
        body: input,
        correlationIdPrefix: "nats-account-create",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.nats.all }),
  });
}

export function useCreateNatsCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNatsCredentialProfileRequest) =>
      apiFetch<NatsCredentialProfileInfo>(ApiRoute.nats.credentials(), {
        method: "POST",
        body: input,
        correlationIdPrefix: "nats-credential-create",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.nats.all }),
  });
}

export function useMintNatsCredential() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<MintNatsCredentialResponse>(ApiRoute.nats.credentialMint(id), {
        method: "POST",
        body: {},
        correlationIdPrefix: "nats-credential-mint",
      }),
  });
}

export function useCreateNatsStream() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNatsStreamRequest) =>
      apiFetch<NatsStreamInfo>(ApiRoute.nats.streams(), {
        method: "POST",
        body: input,
        correlationIdPrefix: "nats-stream-create",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.nats.all }),
  });
}

export function useCreateNatsConsumer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNatsConsumerRequest) =>
      apiFetch<NatsConsumerInfo>(ApiRoute.nats.consumers(), {
        method: "POST",
        body: input,
        correlationIdPrefix: "nats-consumer-create",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.nats.all }),
  });
}
