/**
 * Phase 2 — Identity seed backup & durability.
 *
 * These tests pin the recovery path that lets an operator survive the exact
 * data loss Phase 1's re-key guard *refuses to regenerate through*. The
 * headline round-trip is the plan's "Done when": back up the seeds → wipe them
 * from Vault → restore → `applyConfig` → the operator identity is unchanged
 * (no regeneration) and Phase 1's guard is satisfied.
 *
 * Also covered:
 *   - the backup artifact is encrypted at rest (the raw seed never appears in
 *     the blob; a tampered blob fails to decrypt),
 *   - restore refuses to clobber a present-but-different seed without `force`.
 *
 * Harness mirrors `nats-control-plane-identity-guard.integration.test.ts`:
 *   - `vault-kv-service` → an in-memory fake KV store that throws the real
 *     `VaultKVError` so the not-found branches fire.
 *   - `nats-key-manager` → real crypto, with `generateOperator` /
 *     `generateAccount` spied so we can assert (non-)generation.
 *   - `nats` → `connect` disabled so the best-effort claim propagation stays
 *     non-fatal with no real network.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ErrorCode } from '@mini-infra/types';
import { testPrisma } from '../../../__tests__/integration-test-helpers';
import { VaultKVError } from '../../vault/vault-kv-paths';
import { internalSecrets } from '../../../lib/security-config';

// ── Fake Vault KV ───────────────────────────────────────────────────────────
class FakeVaultKV {
  store = new Map<string, Record<string, unknown>>();
  writes: Array<{ path: string; data: Record<string, unknown> }> = [];

  async readField(path: string, field: string): Promise<string> {
    const rec = this.store.get(path);
    if (!rec) {
      throw new VaultKVError(`KV path '${path}' not found`, ErrorCode.VAULT_KV_PATH_NOT_FOUND, 404);
    }
    const value = rec[field];
    if (value === null || value === undefined) {
      throw new VaultKVError(
        `KV path '${path}' has no field '${field}'`,
        ErrorCode.VAULT_KV_FIELD_NOT_FOUND,
        404,
      );
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

vi.mock('../nats-key-manager', async (orig) => {
  const real = await orig<typeof import('../nats-key-manager')>();
  return {
    ...real,
    generateOperator: vi.fn(real.generateOperator),
    generateAccount: vi.fn(real.generateAccount),
  };
});

vi.mock('nats', async (orig) => {
  const real = await orig<typeof import('nats')>();
  return {
    ...real,
    connect: vi.fn(async () => {
      throw new Error('nats connect disabled in seed-backup test');
    }),
  };
});

import * as keyManager from '../nats-key-manager';
import {
  NatsControlPlaneService,
  NATS_OPERATOR_KV_PATH,
} from '../nats-control-plane-service';
import {
  exportEncryptedIdentitySeeds,
  restoreEncryptedIdentitySeeds,
  IdentitySeedBackupError,
} from '../nats-identity-seed-backup';

const generateOperatorSpy = vi.mocked(keyManager.generateOperator);
const generateAccountSpy = vi.mocked(keyManager.generateAccount);

const FIELD_OPERATOR_SEED = 'operator_seed';
const FIELD_ACCOUNT_SEED = 'account_seed';

function service(): NatsControlPlaneService {
  return new NatsControlPlaneService(testPrisma);
}

async function getState() {
  return testPrisma.natsState.findUnique({ where: { kind: 'primary' } });
}

/** Read a seed string straight out of the fake Vault store. */
function seedAt(path: string, field: string): string {
  return vaultHolder.current!.store.get(path)?.[field] as string;
}

/** Wipe the operator + every account seed path (simulates Vault data loss). */
async function wipeAllSeeds(): Promise<void> {
  vaultHolder.current!.removePath(NATS_OPERATOR_KV_PATH);
  const accounts = await testPrisma.natsAccount.findMany();
  for (const account of accounts) {
    vaultHolder.current!.removePath(account.seedKvPath);
  }
}

describe('NATS identity seed backup & restore — Phase 2', () => {
  beforeEach(() => {
    vaultHolder.current = new FakeVaultKV();
    // The backup encryption key is derived from the internal auth secret.
    if (!internalSecrets.isInitialized()) {
      internalSecrets.setAuthSecret('test-auth-secret-for-seed-backup');
    }
    vi.clearAllMocks();
  });

  it('round-trip: back up → wipe Vault → restore → applyConfig keeps the same operatorPublic (Done-when)', async () => {
    // First boot establishes the identity + seeds in Vault.
    const first = await service().applyConfig();
    const stateBefore = await getState();
    expect(stateBefore?.operatorPublic).toBe(first.operatorPublic);

    // Back up the seeds.
    const backup = await exportEncryptedIdentitySeeds(testPrisma);
    expect(backup).not.toBeNull();
    // Operator + default account + system account are all captured.
    expect(backup!.meta.count).toBeGreaterThanOrEqual(3);

    // Simulate Vault losing every seed (the DR case Phase 1 detects).
    await wipeAllSeeds();

    // Guard should now trip if we tried to apply — proving the seeds are gone.
    await expect(service().applyConfig()).rejects.toThrow();

    // Restore the seeds back into Vault at their canonical paths.
    const restore = await restoreEncryptedIdentitySeeds(backup!.blob, {
      db: testPrisma,
    });
    expect(restore.applied).toBe(true);
    expect(restore.restored).toBeGreaterThanOrEqual(3);
    expect(restore.conflicts).toBe(0);

    // Now applyConfig must reconcile the RESTORED identity — no regeneration.
    vi.clearAllMocks();
    const after = await service().applyConfig();

    expect(generateOperatorSpy).not.toHaveBeenCalled();
    expect(generateAccountSpy).not.toHaveBeenCalled();
    expect(after.generatedSeeds).toBe(false);
    expect(after.operatorPublic).toBe(first.operatorPublic);

    const stateAfter = await getState();
    expect(stateAfter?.operatorPublic).toBe(stateBefore?.operatorPublic);
    expect(stateAfter?.systemAccountPublic).toBe(stateBefore?.systemAccountPublic);

    // Phase 1's guard is satisfied on the restored identity.
    await expect(service().assertRecordedIdentitiesHaveSeeds()).resolves.toBeUndefined();
  });

  it('backup produces an encrypted artifact (raw seed absent; tampering detected)', async () => {
    await service().applyConfig();
    const operatorSeed = seedAt(NATS_OPERATOR_KV_PATH, FIELD_OPERATOR_SEED);
    expect(operatorSeed).toBeTruthy();

    const backup = await exportEncryptedIdentitySeeds(testPrisma);
    expect(backup).not.toBeNull();
    expect(Buffer.isBuffer(backup!.blob)).toBe(true);

    // The plaintext seed must NOT be recoverable from the blob bytes.
    expect(backup!.blob.toString('latin1')).not.toContain(operatorSeed);
    expect(backup!.blob.toString('utf8')).not.toContain(operatorSeed);

    // A tampered blob fails authenticated decryption (AES-256-GCM tag check).
    const tampered = Buffer.from(backup!.blob);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(
      restoreEncryptedIdentitySeeds(tampered, { db: testPrisma }),
    ).rejects.toBeInstanceOf(IdentitySeedBackupError);

    // And the untampered blob round-trips: restore into an emptied Vault
    // reproduces the exact operator seed.
    await wipeAllSeeds();
    const restore = await restoreEncryptedIdentitySeeds(backup!.blob, { db: testPrisma });
    expect(restore.applied).toBe(true);
    expect(seedAt(NATS_OPERATOR_KV_PATH, FIELD_OPERATOR_SEED)).toBe(operatorSeed);
  });

  it('restore refuses to clobber a present-but-different seed without force', async () => {
    await service().applyConfig();
    const originalOperatorSeed = seedAt(NATS_OPERATOR_KV_PATH, FIELD_OPERATOR_SEED);

    const backup = await exportEncryptedIdentitySeeds(testPrisma);
    expect(backup).not.toBeNull();

    // Replace the operator seed in Vault with a *different* valid one.
    const foreign = await keyManager.generateOperator('foreign-operator');
    vaultHolder.current!.store.set(NATS_OPERATOR_KV_PATH, { [FIELD_OPERATOR_SEED]: foreign.seed });

    // Without force: the conflict aborts the whole restore — nothing written.
    const refused = await restoreEncryptedIdentitySeeds(backup!.blob, { db: testPrisma });
    expect(refused.applied).toBe(false);
    expect(refused.conflicts).toBeGreaterThanOrEqual(1);
    expect(seedAt(NATS_OPERATOR_KV_PATH, FIELD_OPERATOR_SEED)).toBe(foreign.seed);
    // The conflicting entry is surfaced with both public keys for the operator.
    const conflictEntry = refused.entries.find((e) => e.outcome === 'conflict');
    expect(conflictEntry).toBeTruthy();
    expect(conflictEntry!.currentPublicKey).toBe(foreign.publicKey);

    // With force: the backed-up seed overwrites the foreign one.
    const forced = await restoreEncryptedIdentitySeeds(backup!.blob, {
      db: testPrisma,
      force: true,
    });
    expect(forced.applied).toBe(true);
    expect(forced.restored).toBeGreaterThanOrEqual(1);
    expect(seedAt(NATS_OPERATOR_KV_PATH, FIELD_OPERATOR_SEED)).toBe(originalOperatorSeed);
  });

  it('records a queryable audit event on restore', async () => {
    await service().applyConfig();
    const backup = await exportEncryptedIdentitySeeds(testPrisma);
    await wipeAllSeeds();
    await restoreEncryptedIdentitySeeds(backup!.blob, { db: testPrisma });

    const events = await testPrisma.userEvent.findMany({
      where: { eventCategory: 'infrastructure', resourceName: 'nats-identity', status: 'completed' },
    });
    expect(events.length).toBe(1);
    expect(events[0]?.eventName).toContain('restored');
  });
});
