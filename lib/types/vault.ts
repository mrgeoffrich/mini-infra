// ====================
// Vault Types
// ====================

import type { OperationStep } from "./operations";

// ── Status & lifecycle ───────────────────────────────────

export type VaultSealState = "uninitialised" | "sealed" | "unsealed" | "unknown";

export interface VaultStatus {
  /** true when Mini Infra has a VaultState row with bootstrappedAt set */
  initialised: boolean;
  bootstrappedAt: string | null;
  sealed: boolean | null; // null when unreachable
  sealState: VaultSealState;
  reachable: boolean;
  address: string | null;
  stackId: string | null;
  passphrase: {
    state: "uninitialised" | "locked" | "unlocked";
    retryDelayMs: number;
  };
  errorMessage?: string;
}

// ── Bootstrap ────────────────────────────────────────────

/**
 * One-time-viewable blob returned by a successful bootstrap. The server NEVER
 * stores these unencrypted — the operator is responsible for saving them.
 */
export interface VaultBootstrapResult {
  unsealKeys: string[];
  unsealThreshold: number;
  unsealShares: number;
  rootToken: string;
  adminRoleId: string;
  adminSecretId: string;
  operatorUsername: string;
  operatorPassword: string;
}

// ── Policy & AppRole (Phase 2) ──────────────────────────

export interface VaultPolicyInfo {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  draftHclBody: string | null;
  publishedHclBody: string | null;
  publishedVersion: number;
  publishedAt: string | null;
  lastAppliedAt: string | null;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VaultAppRoleInfo {
  id: string;
  name: string;
  policyId: string;
  policyName: string;
  secretIdNumUses: number;
  secretIdTtl: string;
  tokenTtl: string | null;
  tokenMaxTtl: string | null;
  tokenPeriod: string | null;
  cachedRoleId: string | null;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVaultPolicyRequest {
  name: string;
  displayName: string;
  description?: string;
  draftHclBody: string;
}

export interface UpdateVaultPolicyRequest {
  displayName?: string;
  description?: string;
  draftHclBody?: string;
}

export interface CreateVaultAppRoleRequest {
  name: string;
  policyId: string;
  secretIdNumUses?: number;
  secretIdTtl?: string;
  tokenTtl?: string;
  tokenMaxTtl?: string;
  tokenPeriod?: string;
}

export interface UpdateVaultAppRoleRequest {
  policyId?: string;
  secretIdNumUses?: number;
  secretIdTtl?: string;
  tokenTtl?: string;
  tokenMaxTtl?: string;
  tokenPeriod?: string;
}

// ── Dynamic env (Phase 3) ───────────────────────────────

// DynamicEnvSource lives in ./stacks because it's part of StackContainerConfig;
// re-exported from here for discoverability from vault consumers.
export type { DynamicEnvSource } from "./stacks";

// ── Events ──────────────────────────────────────────────

export interface VaultBootstrapStartedEvent {
  operationId: string;
  totalSteps: number;
  stepNames?: string[];
}

export interface VaultBootstrapStepEvent {
  operationId: string;
  step: OperationStep;
  completedCount: number;
  totalSteps: number;
}

export interface VaultBootstrapCompletedEvent {
  operationId: string;
  success: boolean;
  steps: OperationStep[];
  errors: string[];
  // IMPORTANT: this event does NOT carry the one-time-viewable credentials
  // (root token, unseal keys, operator password). Those are returned only on
  // the HTTP response that initiated bootstrap, so they never fan out to other
  // subscribers on Channel.VAULT. See docs/secrets-vault-implementation.md.
}

export interface VaultUnsealStartedEvent {
  operationId: string;
  totalSteps: number;
  stepNames?: string[];
}

export interface VaultUnsealStepEvent {
  operationId: string;
  step: OperationStep;
  completedCount: number;
  totalSteps: number;
}

export interface VaultUnsealCompletedEvent {
  operationId: string;
  success: boolean;
  steps: OperationStep[];
  errors: string[];
}

export interface VaultStatusChangedEvent {
  /**
   * Full vault status snapshot. Optional because some events (e.g. admin
   * token staleness) only carry a degradation flag without re-probing health.
   */
  status?: VaultStatus;
  /**
   * Set to `true` when the cached admin token has been dropped after a failed
   * renewal. UI should surface a banner prompting the operator to lock+unlock
   * the passphrase (or hit the reauthenticate endpoint).
   */
  adminTokenStale?: boolean;
  /**
   * Human-readable reason accompanying `adminTokenStale`.
   */
  reason?: string;
}

export interface VaultPassphraseLockEvent {
  state: "locked" | "unlocked";
}

export interface VaultPolicyAppliedEvent {
  policyId: string;
  policyName: string;
  publishedVersion: number;
}

export interface VaultAppRoleAppliedEvent {
  appRoleId: string;
  appRoleName: string;
  cachedRoleId: string | null;
}
