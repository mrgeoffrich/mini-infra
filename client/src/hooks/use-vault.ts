import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiRoute, queryKeys } from "@mini-infra/types";
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
import { apiFetch } from "@/lib/api-client";

// ── Status ──────────────────────────────────────────────

export function useVaultStatus() {
  return useQuery<VaultStatus>({
    queryKey: queryKeys.vault.status,
    queryFn: () =>
      apiFetch<VaultStatus>(ApiRoute.vault.status(), { correlationIdPrefix: "vault-status" }),
    refetchInterval: (q) => (q.state.data?.reachable ? 10_000 : 5_000),
    refetchOnReconnect: true,
  });
}

// ── Passphrase ──────────────────────────────────────────

export function useUnlockPassphrase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (passphrase: string) =>
      apiFetch<void>(ApiRoute.vault.passphraseUnlock(), {
        method: "POST",
        body: { passphrase },
        correlationIdPrefix: "vault-unlock",
      }),
    onSuccess: () => {
      toast.success("Passphrase unlocked");
      qc.invalidateQueries({ queryKey: queryKeys.vault.all });
    },
    // PassphraseUnlockDialog.tsx renders the failure inline (next to the
    // passphrase input) instead of a toast — see getUserFacingError().
    meta: { skipErrorToast: true },
  });
}

export function useLockPassphrase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<void>(ApiRoute.vault.passphraseLock(), {
        method: "POST",
        correlationIdPrefix: "vault-lock",
      }),
    onSuccess: () => {
      toast.success("Passphrase locked");
      qc.invalidateQueries({ queryKey: queryKeys.vault.all });
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
      apiFetch<BootstrapResponse>(ApiRoute.vault.bootstrap(), {
        method: "POST",
        body: input,
        correlationIdPrefix: "vault-bootstrap",
      }),
    // BootstrapDialog.tsx renders the failure inline (its "failed" phase)
    // instead of a toast.
    meta: { skipErrorToast: true },
  });
}

export function useTriggerUnseal() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ operationId: string }>(ApiRoute.vault.unseal(), {
        method: "POST",
        correlationIdPrefix: "vault-unseal",
      }),
  });
}

// ── Policies ────────────────────────────────────────────

export function useVaultPolicies() {
  return useQuery<VaultPolicyInfo[]>({
    queryKey: queryKeys.vault.policies,
    queryFn: () =>
      apiFetch<VaultPolicyInfo[]>(ApiRoute.vault.policies(), {
        correlationIdPrefix: "vault-policies",
      }),
  });
}

export function useVaultPolicy(id: string | undefined) {
  return useQuery<VaultPolicyInfo>({
    queryKey: queryKeys.vault.policy(id ?? ""),
    queryFn: () =>
      apiFetch<VaultPolicyInfo>(ApiRoute.vault.policy(id as string), {
        correlationIdPrefix: "vault-policy",
      }),
    enabled: !!id,
  });
}

export function useCreateVaultPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateVaultPolicyRequest) =>
      apiFetch<VaultPolicyInfo>(ApiRoute.vault.policies(), {
        method: "POST",
        body: input,
        correlationIdPrefix: "vault-policy-create",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.vault.policies }),
  });
}

export function useUpdateVaultPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateVaultPolicyRequest }) =>
      apiFetch<VaultPolicyInfo>(ApiRoute.vault.policy(args.id), {
        method: "PUT",
        body: args.input,
        correlationIdPrefix: "vault-policy-update",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.vault.policies }),
  });
}

export function usePublishVaultPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<VaultPolicyInfo>(ApiRoute.vault.policyPublish(id), {
        method: "POST",
        correlationIdPrefix: "vault-policy-publish",
      }),
    onSuccess: () => {
      toast.success("Policy published to Vault");
      qc.invalidateQueries({ queryKey: queryKeys.vault.policies });
    },
  });
}

export function useDeleteVaultPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(ApiRoute.vault.policy(id), {
        method: "DELETE",
        correlationIdPrefix: "vault-policy-delete",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.vault.policies }),
  });
}

// ── AppRoles ────────────────────────────────────────────

export function useVaultAppRoles() {
  return useQuery<VaultAppRoleInfo[]>({
    queryKey: queryKeys.vault.appRoles,
    queryFn: () =>
      apiFetch<VaultAppRoleInfo[]>(ApiRoute.vault.appRoles(), {
        correlationIdPrefix: "vault-approles",
      }),
  });
}

export function useVaultAppRole(id: string | undefined) {
  return useQuery<VaultAppRoleInfo>({
    queryKey: queryKeys.vault.appRole(id ?? ""),
    queryFn: () =>
      apiFetch<VaultAppRoleInfo>(ApiRoute.vault.appRole(id as string), {
        correlationIdPrefix: "vault-approle",
      }),
    enabled: !!id,
  });
}

export function useCreateVaultAppRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateVaultAppRoleRequest) =>
      apiFetch<VaultAppRoleInfo>(ApiRoute.vault.appRoles(), {
        method: "POST",
        body: input,
        correlationIdPrefix: "vault-approle-create",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.vault.appRoles }),
  });
}

export function useUpdateVaultAppRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateVaultAppRoleRequest }) =>
      apiFetch<VaultAppRoleInfo>(ApiRoute.vault.appRole(args.id), {
        method: "PUT",
        body: args.input,
        correlationIdPrefix: "vault-approle-update",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.vault.appRoles }),
  });
}

export function useApplyVaultAppRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<VaultAppRoleInfo>(ApiRoute.vault.appRoleApply(id), {
        method: "POST",
        correlationIdPrefix: "vault-approle-apply",
      }),
    onSuccess: () => {
      toast.success("AppRole applied to Vault");
      qc.invalidateQueries({ queryKey: queryKeys.vault.appRoles });
    },
  });
}

export function useDeleteVaultAppRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(ApiRoute.vault.appRole(id), {
        method: "DELETE",
        correlationIdPrefix: "vault-approle-delete",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.vault.appRoles }),
  });
}

export function useOperatorCredentials() {
  return useQuery<{ username: string; password: string }>({
    queryKey: queryKeys.vault.operatorCredentials,
    queryFn: () =>
      apiFetch<{ username: string; password: string }>(
        ApiRoute.vault.operatorCredentials(),
        { correlationIdPrefix: "vault-operator-credentials" },
      ),
    enabled: false,
    retry: false,
  });
}

export function useAppRoleStacks(id: string | undefined) {
  return useQuery<{ id: string; name: string }[]>({
    queryKey: queryKeys.vault.appRoleStacks(id ?? ""),
    queryFn: () =>
      apiFetch<{ id: string; name: string }[]>(
        ApiRoute.vault.appRoleStacks(id as string),
        { correlationIdPrefix: "vault-approle-stacks" },
      ),
    enabled: !!id,
  });
}
