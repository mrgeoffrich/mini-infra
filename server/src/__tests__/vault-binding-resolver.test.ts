import { describe, it, expect } from 'vitest';
import { resolveEffectiveVaultBinding } from '../services/stacks/vault-binding-resolver';

describe('resolveEffectiveVaultBinding', () => {
  it('uses stack-level binding when service has no override', () => {
    const result = resolveEffectiveVaultBinding(
      { vaultAppRoleId: 'stack-ar', lastAppliedVaultAppRoleId: 'stack-ar' },
      { vaultAppRoleId: null, lastAppliedVaultAppRoleId: null },
    );
    expect(result).toEqual({
      appRoleId: 'stack-ar',
      prevBoundAppRoleId: 'stack-ar',
      recordPerService: false,
    });
  });

  it('prefers per-service binding when service has its own override', () => {
    const result = resolveEffectiveVaultBinding(
      { vaultAppRoleId: 'stack-ar', lastAppliedVaultAppRoleId: 'stack-ar' },
      { vaultAppRoleId: 'svc-ar', lastAppliedVaultAppRoleId: 'svc-ar' },
    );
    expect(result).toEqual({
      appRoleId: 'svc-ar',
      prevBoundAppRoleId: 'svc-ar',
      recordPerService: true,
    });
  });

  it('uses per-service prevBound when service has its own binding (compares like-for-like)', () => {
    // Per-service binding present; stack also has its own lastApplied. The
    // service's stable-binding check must compare against the per-service
    // history, not the stack history, otherwise switching the binding from
    // stack→service (or vice-versa) would mistakenly pass the stable check.
    const result = resolveEffectiveVaultBinding(
      { vaultAppRoleId: 'stack-ar', lastAppliedVaultAppRoleId: 'stack-ar-old' },
      { vaultAppRoleId: 'svc-ar', lastAppliedVaultAppRoleId: 'svc-ar-prev' },
    );
    expect(result.prevBoundAppRoleId).toBe('svc-ar-prev');
  });

  it('returns null appRoleId when neither stack nor service has a binding', () => {
    const result = resolveEffectiveVaultBinding(
      { vaultAppRoleId: null, lastAppliedVaultAppRoleId: null },
      { vaultAppRoleId: null, lastAppliedVaultAppRoleId: null },
    );
    expect(result.appRoleId).toBeNull();
    expect(result.recordPerService).toBe(false);
  });

  it('per-service binding with no prior apply yields prevBound=null (fresh binding fails closed)', () => {
    // First-ever apply with a per-service binding: prev is null, so the
    // injector must fail-closed if Vault is unreachable instead of degrading.
    const result = resolveEffectiveVaultBinding(
      { vaultAppRoleId: null, lastAppliedVaultAppRoleId: null },
      { vaultAppRoleId: 'svc-ar', lastAppliedVaultAppRoleId: null },
    );
    expect(result).toEqual({
      appRoleId: 'svc-ar',
      prevBoundAppRoleId: null,
      recordPerService: true,
    });
  });

  it('changing per-service binding leaves prevBound at the old value (stable check will fail)', () => {
    // User swaps the per-service AppRole. lastApplied still holds the OLD
    // binding. Resolver returns the new binding with prev=old; injector's
    // stable-binding check (prev !== current) correctly fails closed.
    const result = resolveEffectiveVaultBinding(
      { vaultAppRoleId: null, lastAppliedVaultAppRoleId: null },
      { vaultAppRoleId: 'svc-new', lastAppliedVaultAppRoleId: 'svc-old' },
    );
    expect(result.appRoleId).toBe('svc-new');
    expect(result.prevBoundAppRoleId).toBe('svc-old');
  });
});
