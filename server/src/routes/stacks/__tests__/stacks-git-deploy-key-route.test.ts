import supertest from 'supertest';
import express from 'express';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must be hoisted before route import) ─────────

// Stub the heavy VaultKVService module. The validators come from the lighter
// `vault-kv-paths` module so the route still exercises real path validation.
const mockKvService = {
  read: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
};
vi.mock('../../../services/vault/vault-kv-service', async () => {
  const paths = await vi.importActual<
    typeof import('../../../services/vault/vault-kv-paths')
  >('../../../services/vault/vault-kv-paths');
  return {
    KV_MOUNT: paths.KV_MOUNT,
    VaultKVError: paths.VaultKVError,
    validateKvPath: paths.validateKvPath,
    validateKvFieldName: paths.validateKvFieldName,
    getVaultKVService: () => mockKvService,
  };
});

// Auth middleware: bypass — every request authenticates as a test user with
// stacks:write.
vi.mock('../../../middleware/auth', () => ({
  requirePermission:
    () => (req: { user?: unknown; apiKey?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'test-user' };
      req.apiKey = { id: 'test-key', permissions: ['stacks:write'] };
      next();
    },
  getAuthenticatedUser: (req: { user?: unknown }) => req.user ?? null,
}));

// UserEventService stub — captures `createEvent` calls so the audit-trail
// regression tests can assert the per-action audit row was written without
// hitting Prisma. The route awaits these calls but the failure path is
// non-fatal, so resolving with a stub object is safe. `vi.hoisted` is
// required because `vi.mock` runs before normal top-level consts initialize.
const { mockCreateEvent, mockRunApplyInBackground, mockOperationLockHas } =
  vi.hoisted(() => ({
    mockCreateEvent: vi.fn().mockResolvedValue({ id: 'evt-1' }),
    mockRunApplyInBackground: vi.fn().mockResolvedValue(undefined),
    mockOperationLockHas: vi.fn().mockReturnValue(false),
  }));
vi.mock('../../../services/user-events/user-event-service', () => {
  class MockUserEventService {
    createEvent = mockCreateEvent;
  }
  return { UserEventService: MockUserEventService };
});

// Stub the apply-trigger surface so the DELETE-auto-reapply regression test
// can assert the trigger fires without standing up the apply pipeline.
vi.mock('../stacks-apply-route', () => ({
  runApplyInBackground: (...args: unknown[]) => mockRunApplyInBackground(...args),
}));

// Stub the operation lock so the test can drive the "apply already in
// flight → skip" branch deterministically.
vi.mock('../../../services/stacks/operation-lock', () => ({
  stackOperationLock: {
    has: (...args: unknown[]) => mockOperationLockHas(...args),
  },
}));

// Prisma stub: route guards "does this stack service exist?" via
// `stackService.findFirst`. Default returns a row; specific tests override
// with `null` to exercise the 404 path.
const mockStackServiceFindFirst = vi.fn();
vi.mock('../../../lib/prisma', () => ({
  default: {
    stackService: {
      findFirst: (...args: unknown[]) => mockStackServiceFindFirst(...args),
    },
  },
}));

vi.mock('../../../lib/logger-factory', () => {
  const mk = () => {
    const l: Record<string, unknown> = {};
    for (const fn of ['info', 'error', 'warn', 'debug', 'fatal', 'trace', 'silent']) {
      l[fn] = vi.fn();
    }
    l.child = vi.fn(() => l);
    return l;
  };
  return {
    getLogger: vi.fn(() => mk()),
    createLogger: vi.fn(() => mk()),
    appLogger: vi.fn(() => mk()),
    httpLogger: vi.fn(() => mk()),
    servicesLogger: vi.fn(() => mk()),
    buildPinoHttpOptions: vi.fn(() => ({ level: 'silent' })),
  };
});

import router from '../stacks-git-deploy-key-route';
import { VaultKVError } from '../../../services/vault/vault-kv-service';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/stacks', router);
  return app;
}

beforeEach(() => {
  mockKvService.read.mockReset();
  mockKvService.write.mockReset();
  mockKvService.delete.mockReset();
  mockStackServiceFindFirst.mockReset();
  mockCreateEvent.mockReset();
  mockCreateEvent.mockResolvedValue({ id: 'evt-1' });
  mockRunApplyInBackground.mockReset();
  mockRunApplyInBackground.mockResolvedValue(undefined);
  mockOperationLockHas.mockReset();
  mockOperationLockHas.mockReturnValue(false);
  // Default: stack service exists.
  mockStackServiceFindFirst.mockResolvedValue({ id: 'svc-1' });
});

/**
 * Minimal but realistic PEM private key shape — enough to satisfy the
 * BEGIN/END marker regex without hardcoding a real key. The key material is
 * never sent over the wire by the route (it goes only to Vault), so a
 * synthetic placeholder is safe for tests.
 */
const FAKE_PEM = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'AAAA-test-payload-not-a-real-key-AAAA',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

describe('GET /:stackId/services/:serviceName/git-deploy-key', () => {
  it('returns hasKey: false when the Vault path is absent', async () => {
    mockKvService.read.mockResolvedValue(null);

    const res = await supertest(buildApp())
      .get('/api/stacks/stack-1/services/shell/git-deploy-key')
      .expect(200);

    expect(res.body).toEqual({ success: true, data: { hasKey: false } });
    expect(mockKvService.read).toHaveBeenCalledWith(
      'stacks/stack-1/services/shell/git-deploy-key',
    );
  });

  it('returns hasKey: true when the Vault path holds a privateKey field', async () => {
    mockKvService.read.mockResolvedValue({ privateKey: FAKE_PEM });

    const res = await supertest(buildApp())
      .get('/api/stacks/stack-1/services/shell/git-deploy-key')
      .expect(200);

    expect(res.body).toEqual({ success: true, data: { hasKey: true } });
  });

  it('NEVER returns the private key material', async () => {
    mockKvService.read.mockResolvedValue({ privateKey: FAKE_PEM });

    const res = await supertest(buildApp())
      .get('/api/stacks/stack-1/services/shell/git-deploy-key')
      .expect(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_PEM);
    expect(body).not.toContain('privateKey');
  });

  it('returns 404 when the stack service does not exist', async () => {
    mockStackServiceFindFirst.mockResolvedValue(null);

    const res = await supertest(buildApp())
      .get('/api/stacks/missing-stack/services/shell/git-deploy-key')
      .expect(404);

    expect(res.body).toMatchObject({ success: false });
    // Don't read Vault when the upstream check already short-circuited.
    expect(mockKvService.read).not.toHaveBeenCalled();
  });

  it('returns hasKey: false when path exists but privateKey field is missing', async () => {
    mockKvService.read.mockResolvedValue({ wrongField: 'oops' });

    const res = await supertest(buildApp())
      .get('/api/stacks/stack-1/services/shell/git-deploy-key')
      .expect(200);

    expect(res.body).toEqual({ success: true, data: { hasKey: false } });
  });

  it('maps Vault sealed errors to 503', async () => {
    mockKvService.read.mockRejectedValue(
      new VaultKVError('Vault is sealed', 'vault_sealed', 503),
    );

    const res = await supertest(buildApp())
      .get('/api/stacks/stack-1/services/shell/git-deploy-key')
      .expect(503);

    expect(res.body.code).toBe('vault_sealed');
  });

  it('does NOT record an audit event for GET (reads are not mutations)', async () => {
    mockKvService.read.mockResolvedValue({ privateKey: FAKE_PEM });

    await supertest(buildApp())
      .get('/api/stacks/stack-1/services/shell/git-deploy-key')
      .expect(200);

    expect(mockCreateEvent).not.toHaveBeenCalled();
  });
});

describe('PUT /:stackId/services/:serviceName/git-deploy-key', () => {
  it('writes the key to the convention path and returns hasKey: true', async () => {
    mockKvService.write.mockResolvedValue(undefined);

    const res = await supertest(buildApp())
      .put('/api/stacks/stack-1/services/shell/git-deploy-key')
      .send({ privateKey: FAKE_PEM })
      .expect(200);

    expect(res.body).toEqual({ success: true, data: { hasKey: true } });
    expect(mockKvService.write).toHaveBeenCalledWith(
      'stacks/stack-1/services/shell/git-deploy-key',
      { privateKey: FAKE_PEM },
    );
  });

  it('records a write audit event with the right userId on success', async () => {
    // Root-CLAUDE rule: "All configuration mutations require `userId` for
    // audit trail". Same shape as the `vault_kv_write` audit row the brokered
    // Vault KV route writes (see `routes/vault/kv.ts`).
    mockKvService.write.mockResolvedValue(undefined);

    await supertest(buildApp())
      .put('/api/stacks/stack-1/services/shell/git-deploy-key')
      .send({ privateKey: FAKE_PEM })
      .expect(200);

    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'vault_kv_write',
        eventCategory: 'security',
        userId: 'test-user',
        resourceId: 'stack-1',
        resourceType: 'stack',
        status: 'completed',
        metadata: expect.objectContaining({
          stackId: 'stack-1',
          serviceName: 'shell',
          action: 'git-deploy-key:put',
          apiKeyId: 'test-key',
        }),
      }),
    );
  });

  it('NEVER includes the private key in the audit event metadata', async () => {
    mockKvService.write.mockResolvedValue(undefined);

    await supertest(buildApp())
      .put('/api/stacks/stack-1/services/shell/git-deploy-key')
      .send({ privateKey: FAKE_PEM })
      .expect(200);

    expect(mockCreateEvent).toHaveBeenCalled();
    const eventArg = JSON.stringify(mockCreateEvent.mock.calls[0]?.[0]);
    expect(eventArg).not.toContain(FAKE_PEM);
    expect(eventArg).not.toContain('AAAA-test-payload');
    expect(eventArg).not.toContain('privateKey');
  });

  it('records a failed audit event when Vault write rejects', async () => {
    mockKvService.write.mockRejectedValue(
      new VaultKVError('permission denied', 'vault_permission_denied', 403),
    );

    await supertest(buildApp())
      .put('/api/stacks/stack-1/services/shell/git-deploy-key')
      .send({ privateKey: FAKE_PEM })
      .expect(403);

    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'vault_kv_write',
        status: 'failed',
      }),
    );
  });

  it('NEVER echoes the private key in the response body', async () => {
    mockKvService.write.mockResolvedValue(undefined);

    const res = await supertest(buildApp())
      .put('/api/stacks/stack-1/services/shell/git-deploy-key')
      .send({ privateKey: FAKE_PEM })
      .expect(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_PEM);
    expect(body).not.toContain('AAAA-test-payload');
  });

  it('rejects body with no privateKey field', async () => {
    const res = await supertest(buildApp())
      .put('/api/stacks/stack-1/services/shell/git-deploy-key')
      .send({})
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(mockKvService.write).not.toHaveBeenCalled();
  });

  it('rejects empty-string privateKey', async () => {
    const res = await supertest(buildApp())
      .put('/api/stacks/stack-1/services/shell/git-deploy-key')
      .send({ privateKey: '' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(mockKvService.write).not.toHaveBeenCalled();
  });

  it('rejects an obviously non-PEM input (e.g. a UUID)', async () => {
    const res = await supertest(buildApp())
      .put('/api/stacks/stack-1/services/shell/git-deploy-key')
      .send({ privateKey: '00000000-1111-2222-3333-444444444444' })
      .expect(400);

    expect(res.body.code).toBe('invalid_pem');
    expect(mockKvService.write).not.toHaveBeenCalled();
  });

  it('rejects a public key sent in place of a private key', async () => {
    const publicKey =
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx phase5-test';

    const res = await supertest(buildApp())
      .put('/api/stacks/stack-1/services/shell/git-deploy-key')
      .send({ privateKey: publicKey })
      .expect(400);

    expect(res.body.code).toBe('invalid_pem');
    expect(mockKvService.write).not.toHaveBeenCalled();
  });

  it('rejects unknown body fields (strict schema)', async () => {
    const res = await supertest(buildApp())
      .put('/api/stacks/stack-1/services/shell/git-deploy-key')
      .send({ privateKey: FAKE_PEM, extra: 'no' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(mockKvService.write).not.toHaveBeenCalled();
  });

  it('returns 404 when the stack service does not exist', async () => {
    mockStackServiceFindFirst.mockResolvedValue(null);

    const res = await supertest(buildApp())
      .put('/api/stacks/missing/services/shell/git-deploy-key')
      .send({ privateKey: FAKE_PEM })
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(mockKvService.write).not.toHaveBeenCalled();
  });

  it('maps Vault permission_denied to 403', async () => {
    mockKvService.write.mockRejectedValue(
      new VaultKVError('permission denied', 'vault_permission_denied', 403),
    );

    const res = await supertest(buildApp())
      .put('/api/stacks/stack-1/services/shell/git-deploy-key')
      .send({ privateKey: FAKE_PEM })
      .expect(403);

    expect(res.body.code).toBe('vault_permission_denied');
  });

  it('accepts a traditional RSA PRIVATE KEY block', async () => {
    const rsaPem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'AAAA-rsa-payload-AAAA',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    mockKvService.write.mockResolvedValue(undefined);

    await supertest(buildApp())
      .put('/api/stacks/stack-1/services/shell/git-deploy-key')
      .send({ privateKey: rsaPem })
      .expect(200);

    expect(mockKvService.write).toHaveBeenCalled();
  });

  it('accepts an unprefixed PEM PRIVATE KEY block (PKCS#8)', async () => {
    const pkcs8 = [
      '-----BEGIN PRIVATE KEY-----',
      'AAAA-pkcs8-payload-AAAA',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    mockKvService.write.mockResolvedValue(undefined);

    await supertest(buildApp())
      .put('/api/stacks/stack-1/services/shell/git-deploy-key')
      .send({ privateKey: pkcs8 })
      .expect(200);

    expect(mockKvService.write).toHaveBeenCalled();
  });
});

describe('DELETE /:stackId/services/:serviceName/git-deploy-key', () => {
  it('deletes the Vault path and returns hasKey: false', async () => {
    mockKvService.read.mockResolvedValue({ privateKey: FAKE_PEM });
    mockKvService.delete.mockResolvedValue(undefined);

    const res = await supertest(buildApp())
      .delete('/api/stacks/stack-1/services/shell/git-deploy-key')
      .expect(200);

    expect(res.body).toEqual({ success: true, data: { hasKey: false } });
    expect(mockKvService.delete).toHaveBeenCalledWith(
      'stacks/stack-1/services/shell/git-deploy-key',
    );
  });

  it('records a delete audit event with the right userId on success', async () => {
    mockKvService.read.mockResolvedValue({ privateKey: FAKE_PEM });
    mockKvService.delete.mockResolvedValue(undefined);

    await supertest(buildApp())
      .delete('/api/stacks/stack-1/services/shell/git-deploy-key')
      .expect(200);

    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'vault_kv_delete',
        eventCategory: 'security',
        userId: 'test-user',
        resourceId: 'stack-1',
        resourceType: 'stack',
        status: 'completed',
        metadata: expect.objectContaining({
          stackId: 'stack-1',
          serviceName: 'shell',
          action: 'git-deploy-key:delete',
          apiKeyId: 'test-key',
        }),
      }),
    );
  });

  it('auto-triggers a re-apply on successful delete so GIT_SSH_KEY clears (review #5)', async () => {
    mockKvService.read.mockResolvedValue({ privateKey: FAKE_PEM });
    mockKvService.delete.mockResolvedValue(undefined);

    await supertest(buildApp())
      .delete('/api/stacks/stack-1/services/shell/git-deploy-key')
      .expect(200);

    expect(mockRunApplyInBackground).toHaveBeenCalledTimes(1);
    expect(mockRunApplyInBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        stackId: 'stack-1',
        triggeredBy: 'test-user',
        isForcePull: false,
      }),
    );
  });

  it('skips the auto-reapply when an apply is already in flight on this stack', async () => {
    mockKvService.read.mockResolvedValue({ privateKey: FAKE_PEM });
    mockKvService.delete.mockResolvedValue(undefined);
    mockOperationLockHas.mockReturnValue(true);

    await supertest(buildApp())
      .delete('/api/stacks/stack-1/services/shell/git-deploy-key')
      .expect(200);

    // Vault delete still happened — only the trigger is gated.
    expect(mockKvService.delete).toHaveBeenCalled();
    expect(mockRunApplyInBackground).not.toHaveBeenCalled();
  });

  it('does NOT trigger a re-apply when DELETE is a 404 (no key was set)', async () => {
    mockKvService.read.mockResolvedValue(null);

    await supertest(buildApp())
      .delete('/api/stacks/stack-1/services/shell/git-deploy-key')
      .expect(404);

    expect(mockRunApplyInBackground).not.toHaveBeenCalled();
  });

  it('does NOT trigger a re-apply when DELETE fails (Vault error)', async () => {
    mockKvService.read.mockResolvedValue({ privateKey: FAKE_PEM });
    mockKvService.delete.mockRejectedValue(
      new VaultKVError('permission denied', 'vault_permission_denied', 403),
    );

    await supertest(buildApp())
      .delete('/api/stacks/stack-1/services/shell/git-deploy-key')
      .expect(403);

    expect(mockRunApplyInBackground).not.toHaveBeenCalled();
  });

  it('returns 404 when no key is set for this service', async () => {
    mockKvService.read.mockResolvedValue(null);

    const res = await supertest(buildApp())
      .delete('/api/stacks/stack-1/services/shell/git-deploy-key')
      .expect(404);

    expect(res.body.code).toBe('path_not_found');
    expect(mockKvService.delete).not.toHaveBeenCalled();
  });

  it('returns 404 when the stack service does not exist', async () => {
    mockStackServiceFindFirst.mockResolvedValue(null);

    const res = await supertest(buildApp())
      .delete('/api/stacks/missing/services/shell/git-deploy-key')
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(mockKvService.delete).not.toHaveBeenCalled();
  });

  it('maps Vault sealed to 503', async () => {
    mockKvService.read.mockRejectedValue(
      new VaultKVError('vault is sealed', 'vault_sealed', 503),
    );

    const res = await supertest(buildApp())
      .delete('/api/stacks/stack-1/services/shell/git-deploy-key')
      .expect(503);

    expect(res.body.code).toBe('vault_sealed');
  });
});
