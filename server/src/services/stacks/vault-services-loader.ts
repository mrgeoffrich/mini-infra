/**
 * Unified Vault service facades for the stack-vault pipeline.
 *
 * Both the apply phase (stack-vault-reconciler) and the cascade-delete phase
 * (stack-vault-deleter) need a small subset of the real Vault*Service classes.
 * Each consumer used to define its own narrow interface and its own lazy
 * loader; this module is the single home for both.
 *
 * Lazy loading: the real implementations pull in DB + HTTP wiring that some
 * unit tests do not need. Each loader is an async dynamic import so the
 * module graph stays cheap to load.
 */

import type { PrismaClient } from "../../lib/prisma";

// =====================
// Facade interfaces (union of methods used across reconciler + deleter)
// =====================

export interface VaultPolicyFacade {
  getByName(name: string): Promise<{ id: string; displayName: string } | null>;
  create(
    input: {
      name: string;
      displayName: string;
      description?: string;
      draftHclBody: string;
    },
    userId: string,
  ): Promise<{ id: string; displayName: string }>;
  update(
    id: string,
    input: { draftHclBody?: string; displayName?: string },
    userId: string,
  ): Promise<{ id: string; displayName: string }>;
  publish(id: string): Promise<{ id: string }>;
  delete(id: string): Promise<void>;
}

export interface VaultAppRoleFacade {
  getByName(name: string): Promise<{ id: string } | null>;
  create(
    input: {
      name: string;
      policyId: string;
      secretIdNumUses?: number;
      secretIdTtl?: string;
      tokenTtl?: string;
      tokenMaxTtl?: string;
      tokenPeriod?: string;
    },
    userId: string,
  ): Promise<{ id: string }>;
  update(
    id: string,
    input: {
      policyId?: string;
      secretIdNumUses?: number;
      secretIdTtl?: string;
      tokenTtl?: string;
      tokenMaxTtl?: string;
      tokenPeriod?: string;
    },
  ): Promise<{ id: string }>;
  apply(id: string): Promise<{ id: string }>;
  delete(id: string): Promise<void>;
}

export interface VaultKVFacade {
  write(path: string, data: Record<string, unknown>): Promise<void>;
  delete(path: string, opts?: { permanent?: boolean }): Promise<void>;
}

// =====================
// Loader injection shape — used by reconciler and deleter for testability
// =====================

export interface VaultServiceLoaders {
  getPolicyService?: (prisma: PrismaClient) => Promise<VaultPolicyFacade>;
  getAppRoleService?: (prisma: PrismaClient) => Promise<VaultAppRoleFacade>;
  getKVService?: () => Promise<VaultKVFacade>;
}

// =====================
// Default loaders
// =====================

export async function loadDefaultPolicyService(
  prisma: PrismaClient,
): Promise<VaultPolicyFacade> {
  const { VaultPolicyService } = await import("../vault/vault-policy-service");
  const { getVaultServices } = await import("../vault/vault-services");
  return new VaultPolicyService(prisma, getVaultServices().admin);
}

export async function loadDefaultAppRoleService(
  prisma: PrismaClient,
): Promise<VaultAppRoleFacade> {
  const { VaultAppRoleService } = await import("../vault/vault-approle-service");
  const { getVaultServices } = await import("../vault/vault-services");
  return new VaultAppRoleService(prisma, getVaultServices().admin);
}

export async function loadDefaultKVService(): Promise<VaultKVFacade> {
  const { getVaultKVService } = await import("../vault/vault-kv-service");
  return getVaultKVService();
}

/**
 * Resolve all three facades, honouring caller-supplied overrides for tests.
 * Returns null for any facade whose corresponding `present` flag is false —
 * callers can short-circuit the import for empty phases.
 */
export async function resolveVaultServiceFacades(
  prisma: PrismaClient,
  present: { policy: boolean; appRole: boolean; kv: boolean },
  overrides?: VaultServiceLoaders,
): Promise<{
  policy: VaultPolicyFacade | null;
  appRole: VaultAppRoleFacade | null;
  kv: VaultKVFacade | null;
}> {
  const policy = present.policy
    ? await (overrides?.getPolicyService ?? loadDefaultPolicyService)(prisma)
    : null;
  const appRole = present.appRole
    ? await (overrides?.getAppRoleService ?? loadDefaultAppRoleService)(prisma)
    : null;
  const kv = present.kv ? await (overrides?.getKVService ?? loadDefaultKVService)() : null;
  return { policy, appRole, kv };
}
