/**
 * Integration tests for DELETE /api/stacks/:stackId — Vault cascade.
 *
 * Uses a real SQLite DB (via testPrisma) and mocks Vault services.
 *
 * Scenarios:
 *   A. Stack with no snapshot → deleted, no Vault calls
 *   B. Stack with snapshot, no sharing → Vault resources deleted
 *   C. Two stacks sharing a policy/AppRole → first delete skips shared;
 *      second delete removes them (now last owner)
 *   D. Stack not found → 404
 *   E. Stack with running containers → 400 (existing behaviour preserved)
 *   F. Vault cascade failure → stack row still removed (non-fatal)
 *   G. Idempotent re-DELETE (already-deleted stack) → 404
 *   H. status=undeployed but containers still labelled → 400 (regression
 *      guard: status field used to short-circuit the docker check, leading
 *      to silent partial-deletes that orphaned the Docker resources)
 *   I. Docker unreachable → 400 (cannot verify container state)
 */

import supertest from 'supertest';
import express from 'express';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testPrisma } from '../integration-test-helpers';
import { createId } from '@paralleldrive/cuid2';
import { encryptSnapshot, type SnapshotV2 } from '../../services/stacks/stack-vault-snapshot';

// ─── Mocks (hoisted before route imports) ──────────────────────────────────────

const mockPolicySvc = {
  getByName: vi.fn(),
  delete: vi.fn(),
};

const mockAppRoleSvc = {
  getByName: vi.fn(),
  delete: vi.fn(),
};

const mockKVSvc = {
  delete: vi.fn(),
};

vi.mock('../../services/vault/vault-policy-service', () => {
  function VaultPolicyService() { return mockPolicySvc; }
  return { VaultPolicyService };
});

vi.mock('../../services/vault/vault-approle-service', () => {
  function VaultAppRoleService() { return mockAppRoleSvc; }
  return { VaultAppRoleService };
});

vi.mock('../../services/vault/vault-kv-service', async () => {
  const paths = await vi.importActual<typeof import('../../services/vault/vault-kv-paths')>(
    '../../services/vault/vault-kv-paths',
  );
  return {
    ...paths,
    getVaultKVService: () => mockKVSvc,
  };
});

vi.mock('../../services/vault/vault-services', () => ({
  getVaultServices: () => ({ admin: {} }),
  vaultServicesReady: () => false,
}));

vi.mock('../../lib/logger-factory', () => {
  const mk = (): Record<string, unknown> => {
    const l: Record<string, unknown> = {};
    for (const fn of ['info', 'error', 'warn', 'debug', 'fatal', 'trace', 'silent']) l[fn] = vi.fn();
    l.child = vi.fn(() => l);
    return l;
  };
  return {
    getLogger: vi.fn(() => mk()),
    createLogger: vi.fn(() => mk()),
    buildPinoHttpOptions: vi.fn(() => ({ level: 'silent' })),
  };
});

vi.mock('../../services/user-events/user-event-service', () => {
  function UserEventService() {}
  UserEventService.prototype.createEvent = vi.fn().mockResolvedValue({ id: 'evt-test' });
  return { UserEventService };
});

vi.mock('../../middleware/auth', () => ({
  requirePermission: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as Record<string, unknown>).user = { id: 'test-user' };
    next();
  },
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

const mockDockerClient = {
  listContainers: vi.fn().mockResolvedValue([]),
};

vi.mock('../../services/docker-executor', () => {
  function DockerExecutorService() {}
  DockerExecutorService.prototype.initialize = vi.fn().mockResolvedValue(undefined);
  DockerExecutorService.prototype.getDockerClient = vi.fn(() => mockDockerClient);
  return { DockerExecutorService };
});

vi.mock('../../lib/prisma', () => ({
  default: testPrisma,
}));

import stacksRouter from '../../routes/stacks/stacks-crud-routes';

// ─── App ──────────────────────────────────────────────────────────────────────

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/stacks', stacksRouter);
  return app;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createStack(opts: {
  status?: string;
  lastAppliedVaultSnapshot?: string | null;
} = {}): Promise<string> {
  const id = createId();
  await testPrisma.stack.create({
    data: {
      id,
      name: `cascade-test-${id.slice(0, 6)}`,
      networks: JSON.stringify([]),
      volumes: JSON.stringify([]),
      status: (opts.status ?? 'undeployed') as 'undeployed',
      lastAppliedVaultSnapshot: opts.lastAppliedVaultSnapshot ?? null,
    },
  });
  return id;
}

async function addVaultResource(
  stackId: string,
  type: 'policy' | 'approle' | 'kv',
  concreteName: string,
  scope: string | null = null,
): Promise<void> {
  await testPrisma.stackVaultResource.create({
    data: { stackId, type, concreteName, scope },
  });
}

function snap(overrides: Partial<SnapshotV2> = {}): string {
  return encryptSnapshot({ version: 2, policies: {}, appRoles: {}, kv: {}, ...overrides });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockDockerClient.listContainers.mockResolvedValue([]);
  mockPolicySvc.getByName.mockResolvedValue(null);
  mockPolicySvc.delete.mockResolvedValue(undefined);
  mockAppRoleSvc.getByName.mockResolvedValue(null);
  mockAppRoleSvc.delete.mockResolvedValue(undefined);
  mockKVSvc.delete.mockResolvedValue(undefined);
});

describe('DELETE /api/stacks/:stackId — Vault cascade', () => {
  it('A. stack with no snapshot is deleted; no Vault calls', async () => {
    const stackId = await createStack();
    const res = await supertest(makeApp()).delete(`/api/stacks/${stackId}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const gone = await testPrisma.stack.findUnique({ where: { id: stackId } });
    expect(gone).toBeNull();
    expect(mockKVSvc.delete).not.toHaveBeenCalled();
  });

  it('B. stack with snapshot deletes all Vault resources then removes row', async () => {
    const stackId = await createStack({
      lastAppliedVaultSnapshot: snap({
        policies: { 'b-policy': { body: 'path "s/*" {}', scope: 'stack', hash: 'h1' } },
        appRoles: { 'b-approle': { policy: 'b-policy', tokenTtl: null, tokenMaxTtl: null, tokenPeriod: null, secretIdNumUses: 1, secretIdTtl: null, scope: 'stack', hash: 'h2' } },
        kv: { 'stacks/b/cfg': { fields: { k: 'v' }, hash: 'h3' } },
      }),
    });
    await addVaultResource(stackId, 'policy', 'b-policy', 'stack');
    await addVaultResource(stackId, 'approle', 'b-approle', 'stack');
    await addVaultResource(stackId, 'kv', 'stacks/b/cfg', null);

    mockPolicySvc.getByName.mockResolvedValue({ id: 'pol-id' });
    mockAppRoleSvc.getByName.mockResolvedValue({ id: 'ar-id' });

    const res = await supertest(makeApp()).delete(`/api/stacks/${stackId}`);

    expect(res.status).toBe(200);
    expect((await testPrisma.stack.findUnique({ where: { id: stackId } }))).toBeNull();
    expect(mockKVSvc.delete).toHaveBeenCalledWith('stacks/b/cfg');
    expect(mockAppRoleSvc.delete).toHaveBeenCalledWith('ar-id');
    expect(mockPolicySvc.delete).toHaveBeenCalledWith('pol-id');
  });

  it('C. sharing: first delete skips shared; second delete removes them', async () => {
    const sharedSnap = snap({
      policies: { 'shared-p': { body: 'path "s/*" {}', scope: 'host', hash: 'hp' } },
      appRoles: { 'shared-ar': { policy: 'shared-p', tokenTtl: null, tokenMaxTtl: null, tokenPeriod: null, secretIdNumUses: 1, secretIdTtl: null, scope: 'host', hash: 'ha' } },
      kv: { 'stacks/c1/cfg': { fields: {}, hash: 'hk' } },
    });
    const stackId1 = await createStack({ lastAppliedVaultSnapshot: sharedSnap });
    const stackId2 = await createStack({ lastAppliedVaultSnapshot: sharedSnap });

    await addVaultResource(stackId1, 'policy', 'shared-p', 'host');
    await addVaultResource(stackId1, 'approle', 'shared-ar', 'host');
    await addVaultResource(stackId1, 'kv', 'stacks/c1/cfg', null);
    await addVaultResource(stackId2, 'policy', 'shared-p', 'host');
    await addVaultResource(stackId2, 'approle', 'shared-ar', 'host');

    const res1 = await supertest(makeApp()).delete(`/api/stacks/${stackId1}`);
    expect(res1.status).toBe(200);
    expect((await testPrisma.stack.findUnique({ where: { id: stackId1 } }))).toBeNull();

    // Shared resources NOT deleted; per-instance KV was deleted
    expect(mockPolicySvc.delete).not.toHaveBeenCalled();
    expect(mockAppRoleSvc.delete).not.toHaveBeenCalled();
    expect(mockKVSvc.delete).toHaveBeenCalledWith('stacks/c1/cfg');

    vi.clearAllMocks();
    mockPolicySvc.getByName.mockResolvedValue({ id: 'pol-id' });
    mockAppRoleSvc.getByName.mockResolvedValue({ id: 'ar-id' });
    mockPolicySvc.delete.mockResolvedValue(undefined);
    mockAppRoleSvc.delete.mockResolvedValue(undefined);
    mockKVSvc.delete.mockResolvedValue(undefined);

    const res2 = await supertest(makeApp()).delete(`/api/stacks/${stackId2}`);
    expect(res2.status).toBe(200);
    expect((await testPrisma.stack.findUnique({ where: { id: stackId2 } }))).toBeNull();
    expect(mockPolicySvc.delete).toHaveBeenCalledWith('pol-id');
    expect(mockAppRoleSvc.delete).toHaveBeenCalledWith('ar-id');
  });

  it('D. 404 for nonexistent stack', async () => {
    const res = await supertest(makeApp()).delete('/api/stacks/no-such-id');
    expect(res.status).toBe(404);
  });

  it('E. 400 when stack has running containers', async () => {
    const stackId = await createStack({ status: 'synced' });
    mockDockerClient.listContainers.mockResolvedValue([{ Id: 'ctr-1' }]);
    const res = await supertest(makeApp()).delete(`/api/stacks/${stackId}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('F. Vault cascade failure is non-fatal — stack row still removed', async () => {
    const stackId = await createStack({
      lastAppliedVaultSnapshot: snap({
        kv: { 'failing/path': { fields: {}, hash: 'hx' } },
      }),
    });
    await addVaultResource(stackId, 'kv', 'failing/path', null);
    mockKVSvc.delete.mockRejectedValue(new Error('Vault unreachable'));

    const res = await supertest(makeApp()).delete(`/api/stacks/${stackId}`);
    expect(res.status).toBe(200);
    expect((await testPrisma.stack.findUnique({ where: { id: stackId } }))).toBeNull();
  });

  it('G. idempotent re-DELETE of already-deleted stack → 404', async () => {
    const stackId = await createStack();
    await testPrisma.stack.delete({ where: { id: stackId } });

    const res = await supertest(makeApp()).delete(`/api/stacks/${stackId}`);
    expect(res.status).toBe(404);
  });

  it('H. status=undeployed but containers still labelled → 400 (no silent orphan)', async () => {
    // Regression: a partial /destroy can flip status to "undeployed" while
    // leaving labelled containers behind. The DELETE handler used to skip
    // the docker check whenever status was "undeployed" or "pending", so
    // this exact state would tombstone the DB row and orphan the containers.
    const stackId = await createStack({ status: 'undeployed' });
    mockDockerClient.listContainers.mockResolvedValue([{ Id: 'orphan-1' }]);

    const res = await supertest(makeApp()).delete(`/api/stacks/${stackId}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/labelled with this stack ID|containers/i);
    // The stack row must still exist — silent partial delete was the bug.
    const still = await testPrisma.stack.findUnique({ where: { id: stackId } });
    expect(still).not.toBeNull();
  });

  it('I. Docker unreachable → 400 (cannot verify, even for undeployed stacks)', async () => {
    const stackId = await createStack({ status: 'undeployed' });
    mockDockerClient.listContainers.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await supertest(makeApp()).delete(`/api/stacks/${stackId}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Cannot verify|Docker/i);
    const still = await testPrisma.stack.findUnique({ where: { id: stackId } });
    expect(still).not.toBeNull();
  });
});
