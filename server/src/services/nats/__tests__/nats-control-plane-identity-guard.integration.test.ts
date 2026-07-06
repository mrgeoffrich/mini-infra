/**
 * Phase 1 — Guarded NATS identity: split bootstrap from apply.
 *
 * These tests pin the behaviour that fixes the production incident where a
 * spurious post-unseal Vault 404 caused `applyConfig()` to silently re-key the
 * NATS operator/account identity, orphaning every running egress agent's
 * baked-in `NATS_CREDS`.
 *
 * The guard must:
 *   - still generate identity on a genuine first boot (no recorded public key),
 *   - reconcile unchanged when seeds are present,
 *   - and, when the DB records an identity but Vault has no (or a mismatched)
 *     seed, throw a typed error and touch NOTHING — no generate call, no Vault
 *     write, no `natsState` overwrite.
 *
 * Collaborators are stubbed at the module boundary, mirroring the existing
 * NATS test harness:
 *   - `vault-kv-service` → an in-memory fake KV store (throws the real
 *     `VaultKVError` so `tryReadField`'s instanceof branch still fires).
 *   - `nats-key-manager` → real crypto, but `generateOperator` /
 *     `generateAccount` are wrapped in spies so we can assert (non-)generation.
 *   - `nats` → `connect` is disabled so the best-effort `$SYS.REQ.CLAIMS.UPDATE`
 *     propagation fails fast and stays non-fatal, with no real network I/O.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { testPrisma } from '../../../__tests__/integration-test-helpers';
import { VaultKVError } from '../../vault/vault-kv-paths';

// ── Fake Vault KV ───────────────────────────────────────────────────────────
// Defined as a real class (instantiated at test time, after imports resolve)
// so it can throw the genuine VaultKVError. A hoisted holder lets the mock
// factory reach the per-test instance.
class FakeVaultKV {
  store = new Map<string, Record<string, unknown>>();
  writes: Array<{ path: string; data: Record<string, unknown> }> = [];

  async readField(path: string, field: string): Promise<string> {
    const rec = this.store.get(path);
    if (!rec) {
      throw new VaultKVError(`KV path '${path}' not found`, 'path_not_found', 404);
    }
    const value = rec[field];
    if (value === null || value === undefined) {
      throw new VaultKVError(`KV path '${path}' has no field '${field}'`, 'field_not_found', 404);
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  async write(path: string, data: Record<string, unknown>): Promise<void> {
    this.writes.push({ path, data });
    this.store.set(path, { ...(this.store.get(path) ?? {}), ...data });
  }

  async read(path: string): Promise<Record<string, unknown> | null> {
    return this.store.get(path) ?? null;
  }

  async patch(): Promise<void> {}
  async delete(path: string): Promise<void> {
    this.store.delete(path);
  }

  /** Test helper — simulate Vault losing a seed (data loss / read race). */
  removePath(path: string): void {
    this.store.delete(path);
  }
}

const vaultHolder = vi.hoisted(() => ({ current: null as FakeVaultKV | null }));

vi.mock('../../vault/vault-kv-service', () => ({
  getVaultKVService: () => {
    if (!vaultHolder.current) throw new Error('fake Vault KV not initialised in test');
    return vaultHolder.current;
  },
}));

// Real key-manager behaviour, but spy on the two generation functions so we
// can assert they run only on a genuine first boot.
vi.mock('../nats-key-manager', async (orig) => {
  const real = await orig<typeof import('../nats-key-manager')>();
  return {
    ...real,
    generateOperator: vi.fn(real.generateOperator),
    generateAccount: vi.fn(real.generateAccount),
  };
});

// Disable the live NATS connection — the claim-update propagation at the tail
// of applyConfig is best-effort and must stay non-fatal without real network.
vi.mock('nats', async (orig) => {
  const real = await orig<typeof import('nats')>();
  return {
    ...real,
    connect: vi.fn(async () => {
      throw new Error('nats connect disabled in identity-guard test');
    }),
  };
});

import * as keyManager from '../nats-key-manager';
import {
  NatsControlPlaneService,
  NATS_OPERATOR_KV_PATH,
  NATS_DEFAULT_ACCOUNT_KV_PATH,
} from '../nats-control-plane-service';
import {
  NatsIdentityMissing,
  NatsIdentityMismatch,
} from '../nats-identity-errors';

const generateOperatorSpy = vi.mocked(keyManager.generateOperator);
const generateAccountSpy = vi.mocked(keyManager.generateAccount);

function service(): NatsControlPlaneService {
  return new NatsControlPlaneService(testPrisma);
}

async function getState() {
  return testPrisma.natsState.findUnique({ where: { kind: 'primary' } });
}

describe('NatsControlPlaneService — Phase 1 identity re-key guard', () => {
  beforeEach(() => {
    vaultHolder.current = new FakeVaultKV();
    vi.clearAllMocks();
  });

  it('first boot generates a fresh identity (no natsState record yet)', async () => {
    // No natsState, no accounts, empty Vault → genuine first boot.
    const result = await service().applyConfig();

    expect(generateOperatorSpy).toHaveBeenCalledTimes(1);
    // Default app account + system account are both generated on first boot.
    expect(generateAccountSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.generatedSeeds).toBe(true);
    expect(result.operatorPublic).toBeTruthy();

    const state = await getState();
    expect(state?.operatorPublic).toBe(result.operatorPublic);
    // The operator seed is now durably in the fake Vault.
    expect(vaultHolder.current!.store.get(NATS_OPERATOR_KV_PATH)).toBeDefined();
  });

  it('reconcile with seeds present does not regenerate and keeps the identity stable', async () => {
    // First boot establishes the identity.
    const first = await service().applyConfig();
    const stateAfterFirst = await getState();

    vi.clearAllMocks();

    // Second apply: seeds are all present → pure reconcile.
    const second = await service().applyConfig();

    expect(generateOperatorSpy).not.toHaveBeenCalled();
    expect(generateAccountSpy).not.toHaveBeenCalled();
    expect(second.generatedSeeds).toBe(false);
    // Same operator identity across the two applies.
    expect(second.operatorPublic).toBe(first.operatorPublic);
    const stateAfterSecond = await getState();
    expect(stateAfterSecond?.operatorPublic).toBe(stateAfterFirst?.operatorPublic);
  });

  it('operator seed missing → throws NatsIdentityMissing and touches nothing (acceptance test)', async () => {
    // Establish the identity, then simulate Vault losing the operator seed.
    await service().applyConfig();
    const stateBefore = await getState();
    expect(stateBefore?.operatorPublic).toBeTruthy();

    vaultHolder.current!.removePath(NATS_OPERATOR_KV_PATH);
    const writeCountBefore = vaultHolder.current!.writes.length;
    vi.clearAllMocks();

    await expect(service().applyConfig()).rejects.toBeInstanceOf(NatsIdentityMissing);

    // No regeneration, no Vault writes.
    expect(generateOperatorSpy).not.toHaveBeenCalled();
    expect(generateAccountSpy).not.toHaveBeenCalled();
    expect(vaultHolder.current!.writes.length).toBe(writeCountBefore);

    // natsState identity is left completely untouched.
    const stateAfter = await getState();
    expect(stateAfter?.operatorPublic).toBe(stateBefore?.operatorPublic);
    expect(stateAfter?.systemAccountPublic).toBe(stateBefore?.systemAccountPublic);

    // A loud, queryable alarm was raised: failed, infrastructure-category.
    const events = await testPrisma.userEvent.findMany({
      where: { eventCategory: 'infrastructure', status: 'failed' },
    });
    expect(events.length).toBe(1);
    expect(events[0]?.eventName).toContain('refusing to re-key');
  });

  it('account seed missing → throws NatsIdentityMissing without regenerating', async () => {
    await service().applyConfig();
    const stateBefore = await getState();

    // Drop the default app account's seed but keep the operator's.
    vaultHolder.current!.removePath(NATS_DEFAULT_ACCOUNT_KV_PATH);
    const writeCountBefore = vaultHolder.current!.writes.length;
    vi.clearAllMocks();

    await expect(service().applyConfig()).rejects.toBeInstanceOf(NatsIdentityMissing);

    expect(generateOperatorSpy).not.toHaveBeenCalled();
    expect(generateAccountSpy).not.toHaveBeenCalled();
    expect(vaultHolder.current!.writes.length).toBe(writeCountBefore);

    const stateAfter = await getState();
    expect(stateAfter?.operatorPublic).toBe(stateBefore?.operatorPublic);
  });

  it('operator seed present but mismatched → throws NatsIdentityMismatch', async () => {
    await service().applyConfig();
    const stateBefore = await getState();

    // Overwrite the operator seed with a *different* valid operator seed, so
    // the derived public key no longer matches the recorded one.
    const foreign = await keyManager.generateOperator('foreign-operator');
    vaultHolder.current!.store.set(NATS_OPERATOR_KV_PATH, { operator_seed: foreign.seed });
    const writeCountBefore = vaultHolder.current!.writes.length;
    vi.clearAllMocks();

    await expect(service().applyConfig()).rejects.toBeInstanceOf(NatsIdentityMismatch);

    expect(generateOperatorSpy).not.toHaveBeenCalled();
    expect(generateAccountSpy).not.toHaveBeenCalled();
    expect(vaultHolder.current!.writes.length).toBe(writeCountBefore);

    const stateAfter = await getState();
    expect(stateAfter?.operatorPublic).toBe(stateBefore?.operatorPublic);
  });

  it('assertRecordedIdentitiesHaveSeeds passes cleanly when seeds are present', async () => {
    await service().applyConfig();
    // The gate the health-watcher calls directly must not throw on a healthy DB.
    await expect(service().assertRecordedIdentitiesHaveSeeds()).resolves.toBeUndefined();
  });
});
