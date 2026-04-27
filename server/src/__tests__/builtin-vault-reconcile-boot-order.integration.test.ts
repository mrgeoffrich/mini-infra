/**
 * Boot-ordering integration test for the builtin Vault reconciler.
 *
 * Verifies that `runBuiltinVaultReconcile` is called AFTER Vault services are
 * ready — the ordering bug that shipped in PR #250 where the reconciler was
 * invoked from inside `syncBuiltinStacks`, which runs before Vault init.
 *
 * Strategy: spy on `vaultServicesReady` and `runBuiltinVaultReconcile` to
 * assert they are called in the correct order relative to the startup sequence.
 * Uses real DB (SQLite) so `syncBuiltinStacks` can complete normally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testPrisma } from './integration-test-helpers';

describe('boot ordering — builtin vault reconciler runs after Vault init', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('syncBuiltinStacks does NOT call runBuiltinVaultReconcile', async () => {
    const reconcileMod = await import('../services/stacks/builtin-vault-reconcile');
    const reconciledSpy = vi.spyOn(reconcileMod, 'runBuiltinVaultReconcile');

    const { syncBuiltinStacks } = await import('../services/stacks/builtin-stack-sync');
    await syncBuiltinStacks(testPrisma);

    expect(reconciledSpy).not.toHaveBeenCalled();
  });

  it('runBuiltinVaultReconcile is only reachable after vaultServicesReady returns true', async () => {
    const vaultServicesMod = await import('../services/vault/vault-services');
    const readySpy = vi.spyOn(vaultServicesMod, 'vaultServicesReady').mockReturnValue(false);

    const reconcileMod = await import('../services/stacks/builtin-vault-reconcile');

    const fakeLog = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as ReturnType<typeof import('../lib/logger-factory').getLogger>;

    const templateByName = new Map<string, { id: string; template: import('../services/stacks/template-file-loader').LoadedTemplate }>();

    await reconcileMod.runBuiltinVaultReconcile(testPrisma, templateByName, fakeLog);

    expect(readySpy).toHaveBeenCalled();
    expect(fakeLog.info).toHaveBeenCalledWith(
      expect.stringContaining('Vault services not ready'),
    );
  });

  it('after Vault services are marked ready, runBuiltinVaultReconcile proceeds past the guard', async () => {
    const vaultServicesMod = await import('../services/vault/vault-services');
    vi.spyOn(vaultServicesMod, 'vaultServicesReady').mockReturnValue(true);

    const reconcileMod = await import('../services/stacks/builtin-vault-reconcile');

    const fakeLog = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as ReturnType<typeof import('../lib/logger-factory').getLogger>;

    const templateByName = new Map<string, { id: string; template: import('../services/stacks/template-file-loader').LoadedTemplate }>();

    await reconcileMod.runBuiltinVaultReconcile(testPrisma, templateByName, fakeLog);

    const warnedNotReady = (fakeLog.info as ReturnType<typeof vi.fn>).mock.calls.some(
      (args) => typeof args[0] === 'string' && args[0].includes('Vault services not ready'),
    );
    expect(warnedNotReady).toBe(false);
  });

  it('syncBuiltinStacks returns templateByName so the caller can thread it to the reconciler', async () => {
    const { syncBuiltinStacks } = await import('../services/stacks/builtin-stack-sync');
    const result = await syncBuiltinStacks(testPrisma);

    expect(result).toBeInstanceOf(Map);
  });
});
