import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  VaultStatus,
  VaultPolicyInfo,
  VaultAppRoleInfo,
  VaultBootstrapResult,
  CreateVaultPolicyRequest,
  UpdateVaultPolicyRequest,
  CreateVaultAppRoleRequest,
  UpdateVaultAppRoleRequest,
} from "@mini-infra/types";

async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (body as { message?: string }).message ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return (body as { data: T }).data;
}

// ── Status ──────────────────────────────────────────────

export function useVaultStatus() {
  return useQuery<VaultStatus>({
    queryKey: ["vault", "status"],
    queryFn: () => apiFetch<VaultStatus>("/api/vault/status"),
    refetchInterval: (q) => (q.state.data?.reachable ? 10_000 : 5_000),
    refetchOnReconnect: true,
  });
}

// ── Passphrase ──────────────────────────────────────────

export function useUnlockPassphrase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (passphrase: string) =>
      apiFetch<void>("/api/vault/passphrase/unlock", {
        method: "POST",
        body: JSON.stringify({ passphrase }),
      }),
    onSuccess: () => {
      toast.success("Passphrase unlocked");
      qc.invalidateQueries({ queryKey: ["vault"] });
    },
    onError: (err: Error) => {
      toast.error(`Unlock failed: ${err.message}`);
    },
  });
}

export function useLockPassphrase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<void>("/api/vault/passphrase/lock", { method: "POST" }),
    onSuccess: () => {
      toast.success("Passphrase locked");
      qc.invalidateQueries({ queryKey: ["vault"] });
    },
  });
}

// ── Bootstrap / unseal ──────────────────────────────────

export interface BootstrapResponse {
  operationId: string;
  result: VaultBootstrapResult;
}

/**
 * Bootstrap is synchronous on the wire — the mutation resolves with the
 * one-time-viewable credentials blob. Progress is still emitted on
 * `Channel.VAULT` but without credentials.
 */
export function useBootstrapVault() {
  return useMutation({
    mutationFn: (input: {
      passphrase: string;
      address: string;
      stackId?: string;
    }) =>
      apiFetch<BootstrapResponse>("/api/vault/bootstrap", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  });
}

export function useTriggerUnseal() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ operationId: string }>("/api/vault/unseal", {
        method: "POST",
      }),
  });
}

// ── Policies ────────────────────────────────────────────

export function useVaultPolicies() {
  return useQuery<VaultPolicyInfo[]>({
    queryKey: ["vault", "policies"],
    queryFn: () => apiFetch<VaultPolicyInfo[]>("/api/vault/policies"),
  });
}

export function useVaultPolicy(id: string | undefined) {
  return useQuery<VaultPolicyInfo>({
    queryKey: ["vault", "policies", id],
    queryFn: () => apiFetch<VaultPolicyInfo>(`/api/vault/policies/${id}`),
    enabled: !!id,
  });
}

export function useCreateVaultPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateVaultPolicyRequest) =>
      apiFetch<VaultPolicyInfo>("/api/vault/policies", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vault", "policies"] }),
  });
}

export function useUpdateVaultPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateVaultPolicyRequest }) =>
      apiFetch<VaultPolicyInfo>(`/api/vault/policies/${args.id}`, {
        method: "PUT",
        body: JSON.stringify(args.input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vault", "policies"] }),
  });
}

export function usePublishVaultPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<VaultPolicyInfo>(`/api/vault/policies/${id}/publish`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("Policy published to Vault");
      qc.invalidateQueries({ queryKey: ["vault", "policies"] });
    },
  });
}

export function useDeleteVaultPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/vault/policies/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vault", "policies"] }),
  });
}

// ── AppRoles ────────────────────────────────────────────

export function useVaultAppRoles() {
  return useQuery<VaultAppRoleInfo[]>({
    queryKey: ["vault", "approles"],
    queryFn: () => apiFetch<VaultAppRoleInfo[]>("/api/vault/approles"),
  });
}

export function useVaultAppRole(id: string | undefined) {
  return useQuery<VaultAppRoleInfo>({
    queryKey: ["vault", "approles", id],
    queryFn: () => apiFetch<VaultAppRoleInfo>(`/api/vault/approles/${id}`),
    enabled: !!id,
  });
}

export function useCreateVaultAppRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateVaultAppRoleRequest) =>
      apiFetch<VaultAppRoleInfo>("/api/vault/approles", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vault", "approles"] }),
  });
}

export function useUpdateVaultAppRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateVaultAppRoleRequest }) =>
      apiFetch<VaultAppRoleInfo>(`/api/vault/approles/${args.id}`, {
        method: "PUT",
        body: JSON.stringify(args.input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vault", "approles"] }),
  });
}

export function useApplyVaultAppRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<VaultAppRoleInfo>(`/api/vault/approles/${id}/apply`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("AppRole applied to Vault");
      qc.invalidateQueries({ queryKey: ["vault", "approles"] });
    },
  });
}

export function useDeleteVaultAppRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/vault/approles/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vault", "approles"] }),
  });
}

export function useAppRoleStacks(id: string | undefined) {
  return useQuery<{ id: string; name: string }[]>({
    queryKey: ["vault", "approles", id, "stacks"],
    queryFn: () =>
      apiFetch<{ id: string; name: string }[]>(
        `/api/vault/approles/${id}/stacks`,
      ),
    enabled: !!id,
  });
}
