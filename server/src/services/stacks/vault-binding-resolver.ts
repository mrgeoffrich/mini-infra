/**
 * Resolve the *effective* Vault AppRole binding for a service.
 *
 * A service may carry its own `vaultAppRoleId` override. If it does, that
 * override wins; otherwise the stack-level binding applies. The fail-closed
 * stable-binding check on the next apply must compare against the matching
 * "previous" — per-service vs. stack-level — so this helper returns both.
 *
 * Returned `recordPerService` indicates whether the caller should write
 * `service.lastAppliedVaultAppRoleId` after a successful apply. Stack-level
 * bindings are tracked on the Stack row instead and never need a per-service
 * write, even when a service consumes them.
 */
export interface EffectiveVaultBinding {
  appRoleId: string | null;
  prevBoundAppRoleId: string | null;
  recordPerService: boolean;
}

export function resolveEffectiveVaultBinding(
  stack: { vaultAppRoleId: string | null; lastAppliedVaultAppRoleId: string | null },
  service: { vaultAppRoleId: string | null; lastAppliedVaultAppRoleId: string | null },
): EffectiveVaultBinding {
  if (service.vaultAppRoleId) {
    return {
      appRoleId: service.vaultAppRoleId,
      prevBoundAppRoleId: service.lastAppliedVaultAppRoleId,
      recordPerService: true,
    };
  }
  return {
    appRoleId: stack.vaultAppRoleId,
    prevBoundAppRoleId: stack.lastAppliedVaultAppRoleId,
    recordPerService: false,
  };
}
