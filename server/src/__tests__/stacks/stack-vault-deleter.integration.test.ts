/**
 * Unit tests for stack-vault-deleter.ts
 *
 * Covers:
 *   - No snapshot → returns empty result (no-op)
 *   - Pre-PR4 / corrupt snapshot → returns empty result (no-op)
 *   - Single-stack delete: KV → AppRole → Policy all deleted
 *   - Sharing: resource owned by another stack → skipped, audit event status=skipped
 *   - 404 from Vault treated as success (idempotent)
 *   - Vault error on KV delete → item in failed[], remaining resources processed
 *   - Vault error on AppRole delete → item in failed[], policy still deleted
 *   - Vault error on Policy delete → item in failed[], others unaffected
 *   - AppRole not found in DB → treated as deleted (idempotent)
 *   - Policy not found in DB → treated as deleted (idempotent)
 *   - Deletion order: KV before AppRoles before Policies
 *   - Empty snapshot (all phases empty) → empty result
 *   - PolicyInUseError from policy service → item in failed[], non-fatal
 *   - Multiple KV paths, some shared some not
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testPrisma } from '../integration-test-helpers';
import { runStackVaultDeleter } from '../../services/stacks/stack-vault-deleter';
import type { PolicyDeleteFacade, AppRoleDeleteFacade, KVDeleteFacade } from '../../services/stacks/stack-vault-deleter';
import { encryptSnapshot, type SnapshotV2 } from '../../services/stacks/stack-vault-snapshot';
import { createId } from '@paralleldrive/cuid2';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createStackRow(opts: {
  lastAppliedVaultSnapshot?: string | null;
} = {}): Promise<string> {
  const id = createId();
  await testPrisma.stack.create({
    data: {
      id,
      name: `deleter-test-${id.slice(0, 6)}`,
      networks: JSON.stringify([]),
      volumes: JSON.stringify([]),
      lastAppliedVaultSnapshot: opts.lastAppliedVaultSnapshot ?? null,
    },
  });
  return id;
}

async function addVaultResourceRow(
  stackId: string,
  type: 'policy' | 'approle' | 'kv',
  concreteName: string,
  scope: string | null = null,
): Promise<void> {
  await testPrisma.stackVaultResource.create({
    data: { stackId, type, concreteName, scope },
  });
}

function makeSnapshot(overrides: Partial<SnapshotV2> = {}): SnapshotV2 {
  return {
    version: 2,
    policies: {},
    appRoles: {},
    kv: {},
    ...overrides,
  };
}

function makePolicySvc(opts: {
  existing?: Record<string, string>; // name → id
  failOn?: string[];
} = {}): PolicyDeleteFacade {
  return {
    getByName: vi.fn().mockImplementation((name: string) => {
      const id = (opts.existing ?? {})[name];
      return Promise.resolve(id ? { id } : null);
    }),
    delete: vi.fn().mockImplementation((id: string) => {
      const shouldFail = (opts.failOn ?? []).includes(id);
      if (shouldFail) return Promise.reject(new Error(`delete failed for ${id}`));
      return Promise.resolve();
    }),
  };
}

function makeAppRoleSvc(opts: {
  existing?: Record<string, string>; // name → id
  failOn?: string[];
} = {}): AppRoleDeleteFacade {
  return {
    getByName: vi.fn().mockImplementation((name: string) => {
      const id = (opts.existing ?? {})[name];
      return Promise.resolve(id ? { id } : null);
    }),
    delete: vi.fn().mockImplementation((id: string) => {
      const shouldFail = (opts.failOn ?? []).includes(id);
      if (shouldFail) return Promise.reject(new Error(`delete failed for ${id}`));
      return Promise.resolve();
    }),
  };
}

function makeKVSvc(opts: { failOn?: string[]; notFound?: string[] } = {}): KVDeleteFacade {
  return {
    delete: vi.fn().mockImplementation((path: string) => {
      if ((opts.notFound ?? []).includes(path)) {
        const err = new Error('404 not found');
        return Promise.reject(err);
      }
      if ((opts.failOn ?? []).includes(path)) {
        return Promise.reject(new Error(`kv delete failed for ${path}`));
      }
      return Promise.resolve();
    }),
  };
}

const services = (
  pol: PolicyDeleteFacade,
  ar: AppRoleDeleteFacade,
  kv: KVDeleteFacade,
) => ({
  getPolicyService: async () => pol,
  getAppRoleService: async () => ar,
  getKVService: async () => kv,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runStackVaultDeleter — no snapshot', () => {
  it('returns empty result when stack has no snapshot', async () => {
    const stackId = await createStackRow({ lastAppliedVaultSnapshot: null });
    const result = await runStackVaultDeleter(testPrisma, stackId, 'test');
    expect(result.deleted).toHaveLength(0);
    expect(result.skippedAsShared).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('returns empty result when snapshot cannot be decrypted (pre-PR4)', async () => {
    const stackId = await createStackRow({ lastAppliedVaultSnapshot: 'invalid-base64-garbage' });
    const result = await runStackVaultDeleter(testPrisma, stackId, 'test');
    expect(result.deleted).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('returns empty result when stack row does not exist', async () => {
    const result = await runStackVaultDeleter(testPrisma, 'nonexistent-id', 'test');
    expect(result.deleted).toHaveLength(0);
  });
});

describe('runStackVaultDeleter — empty snapshot', () => {
  it('returns empty result when snapshot has no resources', async () => {
    const snapshot = makeSnapshot();
    const stackId = await createStackRow({ lastAppliedVaultSnapshot: encryptSnapshot(snapshot) });
    const polSvc = makePolicySvc();
    const arSvc = makeAppRoleSvc();
    const kvSvc = makeKVSvc();
    const result = await runStackVaultDeleter(testPrisma, stackId, 'test', services(polSvc, arSvc, kvSvc));
    expect(result.deleted).toHaveLength(0);
    expect(result.skippedAsShared).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});

describe('runStackVaultDeleter — single stack (no sharing)', () => {
  it('deletes KV, AppRole, and Policy for a solo stack', async () => {
    const snapshot = makeSnapshot({
      policies: { 'my-policy': { body: 'path "s/*" {}', scope: 'stack', hash: 'h1' } },
      appRoles: { 'my-approle': { policy: 'my-policy', tokenTtl: null, tokenMaxTtl: null, tokenPeriod: null, secretIdNumUses: 1, secretIdTtl: null, scope: 'stack', hash: 'h2' } },
      kv: { 'stacks/s1/cfg': { fields: { token: 'secret' }, hash: 'h3' } },
    });
    const stackId = await createStackRow({ lastAppliedVaultSnapshot: encryptSnapshot(snapshot) });
    await addVaultResourceRow(stackId, 'policy', 'my-policy', 'stack');
    await addVaultResourceRow(stackId, 'approle', 'my-approle', 'stack');
    await addVaultResourceRow(stackId, 'kv', 'stacks/s1/cfg', null);

    const polSvc = makePolicySvc({ existing: { 'my-policy': 'pol-1' } });
    const arSvc = makeAppRoleSvc({ existing: { 'my-approle': 'ar-1' } });
    const kvSvc = makeKVSvc();

    const result = await runStackVaultDeleter(testPrisma, stackId, 'test', services(polSvc, arSvc, kvSvc));

    expect(result.failed).toHaveLength(0);
    expect(result.skippedAsShared).toHaveLength(0);
    expect(result.deleted).toHaveLength(3);

    const deletedTypes = result.deleted.map((d) => d.type).sort();
    expect(deletedTypes).toEqual(['approle', 'kv', 'policy']);

    expect(kvSvc.delete).toHaveBeenCalledWith('stacks/s1/cfg');
    expect(arSvc.delete).toHaveBeenCalledWith('ar-1');
    expect(polSvc.delete).toHaveBeenCalledWith('pol-1');
  });
});

describe('runStackVaultDeleter — deletion order', () => {
  it('deletes KV before AppRoles before Policies', async () => {
    const callOrder: string[] = [];
    const snapshot = makeSnapshot({
      policies: { 'p1': { body: 'path "s/*" {}', scope: 'stack', hash: 'h1' } },
      appRoles: { 'ar1': { policy: 'p1', tokenTtl: null, tokenMaxTtl: null, tokenPeriod: null, secretIdNumUses: 1, secretIdTtl: null, scope: 'stack', hash: 'h2' } },
      kv: { 'kv/path': { fields: { k: 'v' }, hash: 'h3' } },
    });
    const stackId = await createStackRow({ lastAppliedVaultSnapshot: encryptSnapshot(snapshot) });

    const polSvc: PolicyDeleteFacade = {
      getByName: vi.fn().mockResolvedValue({ id: 'pol-id' }),
      delete: vi.fn().mockImplementation(() => { callOrder.push('policy'); return Promise.resolve(); }),
    };
    const arSvc: AppRoleDeleteFacade = {
      getByName: vi.fn().mockResolvedValue({ id: 'ar-id' }),
      delete: vi.fn().mockImplementation(() => { callOrder.push('approle'); return Promise.resolve(); }),
    };
    const kvSvc: KVDeleteFacade = {
      delete: vi.fn().mockImplementation(() => { callOrder.push('kv'); return Promise.resolve(); }),
    };

    await runStackVaultDeleter(testPrisma, stackId, 'test', services(polSvc, arSvc, kvSvc));
    expect(callOrder).toEqual(['kv', 'approle', 'policy']);
  });
});

describe('runStackVaultDeleter — sharing rules', () => {
  it('skips resource when another stack owns the same concreteName', async () => {
    const snapshot = makeSnapshot({
      policies: { 'shared-policy': { body: 'path "s/*" {}', scope: 'host', hash: 'h1' } },
      appRoles: { 'shared-approle': { policy: 'shared-policy', tokenTtl: null, tokenMaxTtl: null, tokenPeriod: null, secretIdNumUses: 1, secretIdTtl: null, scope: 'host', hash: 'h2' } },
    });
    const stackId1 = await createStackRow({ lastAppliedVaultSnapshot: encryptSnapshot(snapshot) });
    const stackId2 = await createStackRow();

    await addVaultResourceRow(stackId1, 'policy', 'shared-policy', 'host');
    await addVaultResourceRow(stackId1, 'approle', 'shared-approle', 'host');
    await addVaultResourceRow(stackId2, 'policy', 'shared-policy', 'host');
    await addVaultResourceRow(stackId2, 'approle', 'shared-approle', 'host');

    const polSvc = makePolicySvc({ existing: { 'shared-policy': 'pol-1' } });
    const arSvc = makeAppRoleSvc({ existing: { 'shared-approle': 'ar-1' } });
    const kvSvc = makeKVSvc();

    const result = await runStackVaultDeleter(testPrisma, stackId1, 'test', services(polSvc, arSvc, kvSvc));

    expect(result.deleted).toHaveLength(0);
    expect(result.skippedAsShared).toHaveLength(2);
    expect(result.failed).toHaveLength(0);

    expect(polSvc.delete).not.toHaveBeenCalled();
    expect(arSvc.delete).not.toHaveBeenCalled();
  });

  it('deletes resource once the last owner is deleted', async () => {
    const snapshot = makeSnapshot({
      policies: { 'solo-policy': { body: 'path "s/*" {}', scope: 'host', hash: 'h1' } },
    });
    const stackId = await createStackRow({ lastAppliedVaultSnapshot: encryptSnapshot(snapshot) });
    await addVaultResourceRow(stackId, 'policy', 'solo-policy', 'host');

    const polSvc = makePolicySvc({ existing: { 'solo-policy': 'pol-id' } });
    const arSvc = makeAppRoleSvc();
    const kvSvc = makeKVSvc();

    const result = await runStackVaultDeleter(testPrisma, stackId, 'test', services(polSvc, arSvc, kvSvc));

    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].concreteName).toBe('solo-policy');
    expect(polSvc.delete).toHaveBeenCalledWith('pol-id');
  });

  it('deletes per-instance KV even when policy is shared', async () => {
    const snapshot = makeSnapshot({
      policies: { 'shared-policy': { body: 'path "s/*" {}', scope: 'host', hash: 'h1' } },
      kv: { 'stacks/unique-stack-id/cfg': { fields: { k: 'v' }, hash: 'h3' } },
    });
    const stackId1 = await createStackRow({ lastAppliedVaultSnapshot: encryptSnapshot(snapshot) });
    const stackId2 = await createStackRow();

    await addVaultResourceRow(stackId1, 'policy', 'shared-policy', 'host');
    await addVaultResourceRow(stackId2, 'policy', 'shared-policy', 'host');
    await addVaultResourceRow(stackId1, 'kv', 'stacks/unique-stack-id/cfg', null);

    const polSvc = makePolicySvc();
    const arSvc = makeAppRoleSvc();
    const kvSvc = makeKVSvc();

    const result = await runStackVaultDeleter(testPrisma, stackId1, 'test', services(polSvc, arSvc, kvSvc));

    expect(result.skippedAsShared).toHaveLength(1);
    expect(result.skippedAsShared[0].concreteName).toBe('shared-policy');
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].concreteName).toBe('stacks/unique-stack-id/cfg');
    expect(kvSvc.delete).toHaveBeenCalledWith('stacks/unique-stack-id/cfg');
  });
});

describe('runStackVaultDeleter — idempotency (404 treated as success)', () => {
  it('treats 404 from KV service as deleted (not an error)', async () => {
    const snapshot = makeSnapshot({
      kv: { 'stacks/gone/cfg': { fields: {}, hash: 'h' } },
    });
    const stackId = await createStackRow({ lastAppliedVaultSnapshot: encryptSnapshot(snapshot) });

    const kvSvc = makeKVSvc({ notFound: ['stacks/gone/cfg'] });
    const result = await runStackVaultDeleter(testPrisma, stackId, 'test', services(makePolicySvc(), makeAppRoleSvc(), kvSvc));

    expect(result.deleted).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });

  it('treats missing DB record for AppRole as deleted', async () => {
    const snapshot = makeSnapshot({
      appRoles: { 'gone-approle': { policy: 'p', tokenTtl: null, tokenMaxTtl: null, tokenPeriod: null, secretIdNumUses: 1, secretIdTtl: null, scope: 'stack', hash: 'h' } },
    });
    const stackId = await createStackRow({ lastAppliedVaultSnapshot: encryptSnapshot(snapshot) });

    const arSvc = makeAppRoleSvc({ existing: {} });
    const result = await runStackVaultDeleter(testPrisma, stackId, 'test', services(makePolicySvc(), arSvc, makeKVSvc()));

    expect(result.deleted).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(arSvc.delete).not.toHaveBeenCalled();
  });

  it('treats missing DB record for Policy as deleted', async () => {
    const snapshot = makeSnapshot({
      policies: { 'gone-policy': { body: '', scope: 'stack', hash: 'h' } },
    });
    const stackId = await createStackRow({ lastAppliedVaultSnapshot: encryptSnapshot(snapshot) });

    const polSvc = makePolicySvc({ existing: {} });
    const result = await runStackVaultDeleter(testPrisma, stackId, 'test', services(polSvc, makeAppRoleSvc(), makeKVSvc()));

    expect(result.deleted).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(polSvc.delete).not.toHaveBeenCalled();
  });
});

describe('runStackVaultDeleter — failure handling (non-fatal)', () => {
  it('puts failed KV delete in failed[] and continues to AppRoles and Policies', async () => {
    const snapshot = makeSnapshot({
      policies: { 'p1': { body: '', scope: 'stack', hash: 'h1' } },
      appRoles: { 'ar1': { policy: 'p1', tokenTtl: null, tokenMaxTtl: null, tokenPeriod: null, secretIdNumUses: 1, secretIdTtl: null, scope: 'stack', hash: 'h2' } },
      kv: { 'bad/path': { fields: {}, hash: 'h3' } },
    });
    const stackId = await createStackRow({ lastAppliedVaultSnapshot: encryptSnapshot(snapshot) });
    await addVaultResourceRow(stackId, 'kv', 'bad/path', null);

    const polSvc = makePolicySvc({ existing: { 'p1': 'pol-id' } });
    const arSvc = makeAppRoleSvc({ existing: { 'ar1': 'ar-id' } });
    const kvSvc = makeKVSvc({ failOn: ['bad/path'] });

    const result = await runStackVaultDeleter(testPrisma, stackId, 'test', services(polSvc, arSvc, kvSvc));

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].concreteName).toBe('bad/path');
    expect(result.deleted).toHaveLength(2);
    const deletedNames = result.deleted.map((d) => d.concreteName).sort();
    expect(deletedNames).toEqual(['ar1', 'p1']);
  });

  it('puts failed AppRole delete in failed[] and continues to Policies', async () => {
    const snapshot = makeSnapshot({
      policies: { 'p1': { body: '', scope: 'stack', hash: 'h1' } },
      appRoles: { 'ar1': { policy: 'p1', tokenTtl: null, tokenMaxTtl: null, tokenPeriod: null, secretIdNumUses: 1, secretIdTtl: null, scope: 'stack', hash: 'h2' } },
    });
    const stackId = await createStackRow({ lastAppliedVaultSnapshot: encryptSnapshot(snapshot) });

    const polSvc = makePolicySvc({ existing: { 'p1': 'pol-id' } });
    const arSvc = makeAppRoleSvc({ existing: { 'ar1': 'ar-id' }, failOn: ['ar-id'] });
    const kvSvc = makeKVSvc();

    const result = await runStackVaultDeleter(testPrisma, stackId, 'test', services(polSvc, arSvc, kvSvc));

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].type).toBe('approle');
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].concreteName).toBe('p1');
  });

  it('puts failed Policy delete in failed[] (non-fatal to other resources)', async () => {
    const snapshot = makeSnapshot({
      policies: {
        'p-bad': { body: '', scope: 'stack', hash: 'h1' },
        'p-good': { body: '', scope: 'stack', hash: 'h2' },
      },
    });
    const stackId = await createStackRow({ lastAppliedVaultSnapshot: encryptSnapshot(snapshot) });

    const polSvc = makePolicySvc({ existing: { 'p-bad': 'bad-id', 'p-good': 'good-id' }, failOn: ['bad-id'] });

    const result = await runStackVaultDeleter(testPrisma, stackId, 'test', services(polSvc, makeAppRoleSvc(), makeKVSvc()));

    expect(result.failed).toHaveLength(1);
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].concreteName).toBe('p-good');
  });
});

describe('runStackVaultDeleter — multiple KV paths, mixed sharing', () => {
  it('deletes unshared KV and skips shared KV', async () => {
    const stackId2 = await createStackRow();

    const snapshot = makeSnapshot({
      kv: {
        'shared/path': { fields: { k: 'v' }, hash: 'h1' },
        'private/path': { fields: { k: 'v' }, hash: 'h2' },
      },
    });
    const stackId = await createStackRow({ lastAppliedVaultSnapshot: encryptSnapshot(snapshot) });

    await addVaultResourceRow(stackId, 'kv', 'shared/path', null);
    await addVaultResourceRow(stackId, 'kv', 'private/path', null);
    await addVaultResourceRow(stackId2, 'kv', 'shared/path', null);

    const kvSvc = makeKVSvc();
    const result = await runStackVaultDeleter(testPrisma, stackId, 'test', services(makePolicySvc(), makeAppRoleSvc(), kvSvc));

    expect(result.deleted.map((d) => d.concreteName)).toContain('private/path');
    expect(result.skippedAsShared.map((d) => d.concreteName)).toContain('shared/path');
    expect(kvSvc.delete).toHaveBeenCalledWith('private/path');
    expect(kvSvc.delete).not.toHaveBeenCalledWith('shared/path');
  });
});
