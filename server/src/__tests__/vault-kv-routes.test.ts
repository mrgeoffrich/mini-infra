import supertest from 'supertest';
import express from 'express';

// ── Mocks (must be hoisted before route import) ─────────

const mockKvService = {
  read: vi.fn(),
  readField: vi.fn(),
  write: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

// Mock the heavy service module fully (it transitively imports prisma via
// vault-services). Re-export the validators + error class from the lighter
// vault-kv-paths module so the route's parsePath still exercises real
// validation surface.
vi.mock('../services/vault/vault-kv-service', async () => {
  const paths = await vi.importActual<typeof import('../services/vault/vault-kv-paths')>(
    '../services/vault/vault-kv-paths',
  );
  return {
    KV_MOUNT: paths.KV_MOUNT,
    VaultKVError: paths.VaultKVError,
    validateKvPath: paths.validateKvPath,
    validateKvFieldName: paths.validateKvFieldName,
    getVaultKVService: () => mockKvService,
  };
});

vi.mock('../lib/logger-factory', () => {
  const mk = (): any => {
    const l: any = {};
    for (const fn of ['info', 'error', 'warn', 'debug', 'fatal', 'trace', 'silent']) l[fn] = vi.fn();
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

// Stub the audit event recorder so we don't need a DB connection.
vi.mock('../services/user-events/user-event-service', () => {
  const createEvent = vi.fn().mockResolvedValue({ id: 'evt-1' });
  return {
    UserEventService: vi.fn().mockImplementation(() => ({ createEvent })),
  };
});

// Auth middleware: pluggable per-request via the keyPermissions module-level
// variable so each test can simulate different API key scopes. Fully mocked
// (no importActual) because the real module transitively imports prisma,
// which would require DATABASE_URL in the unit test environment.
let mockApiKeyPermissions: string[] | null = ['vault-kv:read', 'vault-kv:write'];

vi.mock('../middleware/auth', () => ({
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.apiKey = { id: 'test-key', permissions: mockApiKeyPermissions };
    req.user = { id: 'test-user' };
    next();
  },
  getAuthenticatedUser: (req: any) => req.user ?? null,
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAuthorization: () => (_req: any, _res: any, next: any) => next(),
  requireOwnership: () => (_req: any, _res: any, next: any) => next(),
  requireSessionOrApiKey: (_req: any, _res: any, next: any) => next(),
  getCurrentUserId: (req: any) => req.user?.id ?? null,
  getCurrentUser: (req: any) => req.user ?? null,
  isAuthenticated: () => true,
  getAuthMethod: () => 'api-key',
  createAuthErrorResponse: () => ({ success: false }),
}));

import kvRouter from '../routes/vault/kv';
import { VaultKVError } from '../services/vault/vault-kv-service';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/vault/kv', kvRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApiKeyPermissions = ['vault-kv:read', 'vault-kv:write'];
});

describe('GET /api/vault/kv/*splat — read', () => {
  it('returns the stored object when found', async () => {
    mockKvService.read.mockResolvedValue({ bot_token: 'xoxb-1', app_token: 'xapp-1' });
    const res = await supertest(buildApp()).get('/api/vault/kv/shared/slack').expect(200);
    expect(res.body).toEqual({
      success: true,
      data: { path: 'shared/slack', data: { bot_token: 'xoxb-1', app_token: 'xapp-1' } },
    });
    expect(mockKvService.read).toHaveBeenCalledWith('shared/slack');
  });

  it('joins multi-segment splat into a slash-delimited path', async () => {
    mockKvService.read.mockResolvedValue({ k: 'v' });
    await supertest(buildApp()).get('/api/vault/kv/users/alice/api-keys').expect(200);
    expect(mockKvService.read).toHaveBeenCalledWith('users/alice/api-keys');
  });

  it('returns 404 when service returns null (path missing)', async () => {
    mockKvService.read.mockResolvedValue(null);
    const res = await supertest(buildApp()).get('/api/vault/kv/shared/none').expect(404);
    expect(res.body.code).toBe('path_not_found');
  });

  it('rejects path containing .. anywhere in a segment', async () => {
    // Express normalises explicit ../ traversals at the URL level, so the
    // attack surface for the validator is `..` embedded in a segment
    // (e.g. `sh..are`) that survives URL parsing intact.
    const res = await supertest(buildApp()).get('/api/vault/kv/sh..are/x').expect(400);
    expect(res.body.code).toBe('invalid_path');
    expect(mockKvService.read).not.toHaveBeenCalled();
  });

  it('rejects forbidden characters in path', async () => {
    const res = await supertest(buildApp()).get('/api/vault/kv/shared/sl%3Aack').expect(400);
    expect(res.body.code).toBe('invalid_path');
  });
});

describe('POST /api/vault/kv/*splat — write', () => {
  it('writes the data and returns 200 with the path', async () => {
    mockKvService.write.mockResolvedValue(undefined);
    const res = await supertest(buildApp())
      .post('/api/vault/kv/shared/slack')
      .send({ data: { bot_token: 'xoxb' } })
      .expect(200);
    expect(res.body).toEqual({ success: true, data: { path: 'shared/slack' } });
    expect(mockKvService.write).toHaveBeenCalledWith('shared/slack', { bot_token: 'xoxb' });
  });

  it('rejects body without `data` key', async () => {
    const res = await supertest(buildApp())
      .post('/api/vault/kv/shared/x')
      .send({})
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it('maps Vault sealed (503) to 503 with vault_sealed code', async () => {
    mockKvService.write.mockRejectedValue(
      new VaultKVError("Vault KV write failed for 'x': sealed", 'vault_sealed', 503),
    );
    const res = await supertest(buildApp())
      .post('/api/vault/kv/shared/x')
      .send({ data: { k: 'v' } })
      .expect(503);
    expect(res.body.code).toBe('vault_sealed');
  });

  it('maps Vault permission denied (403) to 403', async () => {
    mockKvService.write.mockRejectedValue(
      new VaultKVError("permission denied", 'vault_permission_denied', 403),
    );
    await supertest(buildApp())
      .post('/api/vault/kv/shared/x')
      .send({ data: { k: 'v' } })
      .expect(403);
  });

  it('maps Vault rate-limited (429) to 429', async () => {
    mockKvService.write.mockRejectedValue(
      new VaultKVError("rate limited", 'vault_rate_limited', 429),
    );
    await supertest(buildApp())
      .post('/api/vault/kv/shared/x')
      .send({ data: { k: 'v' } })
      .expect(429);
  });
});

describe('PATCH /api/vault/kv/*splat — partial update', () => {
  it('patches the data and returns 200', async () => {
    mockKvService.patch.mockResolvedValue(undefined);
    await supertest(buildApp())
      .patch('/api/vault/kv/shared/slack')
      .send({ data: { bot_token: 'rotated' } })
      .expect(200);
    expect(mockKvService.patch).toHaveBeenCalledWith('shared/slack', { bot_token: 'rotated' });
  });
});

describe('DELETE /api/vault/kv/*splat — destroy gate', () => {
  it('soft-deletes by default (no permanent flag)', async () => {
    mockKvService.delete.mockResolvedValue(undefined);
    const res = await supertest(buildApp()).delete('/api/vault/kv/shared/x').expect(200);
    expect(mockKvService.delete).toHaveBeenCalledWith('shared/x', { permanent: false });
    expect(res.body.data.permanent).toBe(false);
  });

  it('rejects ?permanent=true when API key lacks vault-kv:destroy', async () => {
    mockApiKeyPermissions = ['vault-kv:read', 'vault-kv:write']; // no destroy
    const res = await supertest(buildApp())
      .delete('/api/vault/kv/shared/x?permanent=true')
      .expect(403);
    expect(res.body.code).toBe('vault_destroy_forbidden');
    expect(mockKvService.delete).not.toHaveBeenCalled();
  });

  it('allows ?permanent=true when API key has vault-kv:destroy', async () => {
    mockApiKeyPermissions = ['vault-kv:read', 'vault-kv:write', 'vault-kv:destroy'];
    mockKvService.delete.mockResolvedValue(undefined);
    const res = await supertest(buildApp())
      .delete('/api/vault/kv/shared/x?permanent=true')
      .expect(200);
    expect(mockKvService.delete).toHaveBeenCalledWith('shared/x', { permanent: true });
    expect(res.body.data.permanent).toBe(true);
  });

  it('treats permanent=1 the same as permanent=true', async () => {
    mockApiKeyPermissions = ['vault-kv:read', 'vault-kv:write', 'vault-kv:destroy'];
    mockKvService.delete.mockResolvedValue(undefined);
    await supertest(buildApp()).delete('/api/vault/kv/shared/x?permanent=1').expect(200);
    expect(mockKvService.delete).toHaveBeenCalledWith('shared/x', { permanent: true });
  });
});
