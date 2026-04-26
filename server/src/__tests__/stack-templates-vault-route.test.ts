/**
 * Route-level integration tests for the vault permission gate on
 * POST /:templateId/draft.
 *
 * Tests:
 *   - Returns 200 when caller has both stacks:write and template-vault:write
 *   - Returns 200 when caller is a session user (no API key) — session users
 *     always pass the scope check
 *   - Returns 403 with code=template_vault_scope_required when caller only
 *     has stacks:write (vault section present)
 *   - Returns 200 (no gate) when vault section is absent/empty
 *   - draftHasVaultSection: empty policies/appRoles/kv arrays do not trigger gate
 */

import supertest from 'supertest';
import express from 'express';

// ─── Hoisted mocks (must come before route imports) ──────────────────────────

const { mockCreateOrUpdateDraft, mockApiKeyRef, mockIsSessionRef } = vi.hoisted(() => {
  const mockApiKeyRef = { permissions: ['stacks:write'] as string[] | null };
  const mockIsSessionRef = { value: false };
  const mockCreateOrUpdateDraft = vi.fn();
  return { mockCreateOrUpdateDraft, mockApiKeyRef, mockIsSessionRef };
});

vi.mock('../middleware/auth', () => ({
  requirePermission: () => (req: any, _res: any, next: any) => {
    if (mockIsSessionRef.value) {
      req.user = { id: 'session-user' };
      // No apiKey on session users
    } else {
      req.user = { id: 'api-user' };
      req.apiKey = { id: 'test-key', permissions: mockApiKeyRef.permissions };
    }
    next();
  },
  // callerHasScope in the route uses hasPermission from @mini-infra/types directly,
  // so we don't need to mock this separately
}));

vi.mock('../lib/prisma', () => ({
  default: {},
}));

vi.mock('../services/stacks/stack-template-service', () => {
  class TemplateError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 500) {
      super(message);
      this.name = 'TemplateError';
      this.statusCode = statusCode;
    }
  }

  function StackTemplateService(_prisma: unknown) {
    return {
      createOrUpdateDraft: mockCreateOrUpdateDraft,
      listTemplates: vi.fn().mockResolvedValue([]),
      getTemplate: vi.fn().mockResolvedValue(null),
      listVersions: vi.fn().mockResolvedValue([]),
      getTemplateVersion: vi.fn().mockResolvedValue(null),
      createUserTemplate: vi.fn().mockResolvedValue({}),
      updateTemplateMeta: vi.fn().mockResolvedValue({}),
      publishDraft: vi.fn().mockResolvedValue({}),
      discardDraft: vi.fn().mockResolvedValue(undefined),
      deleteTemplate: vi.fn().mockResolvedValue(undefined),
      createStackFromTemplate: vi.fn().mockResolvedValue({}),
    };
  }

  return { StackTemplateService, TemplateError };
});

// stack-template-schemas imports from schemas.ts which in turn imports prisma-style
// validation that doesn't need mocking — the schema objects are pure Zod.

import stackTemplateRouter from '../routes/stack-templates';

// ─── App factory ──────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/stack-templates', stackTemplateRouter);
  return app;
}

// ─── Draft payload helpers ────────────────────────────────────────────────────

const baseService = {
  serviceName: 'web',
  serviceType: 'Stateful',
  dockerImage: 'nginx',
  dockerTag: 'latest',
  containerConfig: {},
  dependsOn: [],
  order: 0,
};

const baseDraft = {
  networks: [],
  volumes: [],
  services: [baseService],
};

const draftWithVaultPolicies = {
  ...baseDraft,
  vault: {
    policies: [
      { name: 'my-policy', body: 'path "secret/*" { capabilities = ["read"] }' },
    ],
    appRoles: [
      { name: 'my-role', policy: 'my-policy' },
    ],
  },
};

const draftWithEmptyVault = {
  ...baseDraft,
  vault: { policies: [], appRoles: [], kv: [] },
};

const draftWithOnlyKv = {
  ...baseDraft,
  vault: {
    kv: [{ path: 'shared/config', fields: { k: { value: 'v' } } }],
  },
};

// ─── Test setup ───────────────────────────────────────────────────────────────

const FAKE_VERSION = {
  id: 'ver-1',
  templateId: 'tmpl-1',
  version: 1,
  isDraft: true,
  services: [],
  networks: [],
  volumes: [],
  configFiles: [],
  parameters: [],
  resourceInputs: [],
  resourceOutputs: [],
  notes: null,
  publishedAt: null,
  publishedBy: null,
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsSessionRef.value = false;
  mockApiKeyRef.permissions = ['stacks:write'];
  mockCreateOrUpdateDraft.mockResolvedValue(FAKE_VERSION);
});

// ─── Permission gate tests ────────────────────────────────────────────────────

describe('POST /api/stack-templates/:templateId/draft — vault permission gate', () => {
  it('returns 200 when caller has both stacks:write and template-vault:write', async () => {
    mockApiKeyRef.permissions = ['stacks:write', 'template-vault:write'];

    const res = await supertest(buildApp())
      .post('/api/stack-templates/tmpl-1/draft')
      .send(draftWithVaultPolicies)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(mockCreateOrUpdateDraft).toHaveBeenCalledOnce();
  });

  it('returns 403 when vault section is present but caller only has stacks:write', async () => {
    mockApiKeyRef.permissions = ['stacks:write']; // missing template-vault:write

    const res = await supertest(buildApp())
      .post('/api/stack-templates/tmpl-1/draft')
      .send(draftWithVaultPolicies)
      .expect(403);

    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('template_vault_scope_required');
    expect(mockCreateOrUpdateDraft).not.toHaveBeenCalled();
  });

  it('returns 403 with message mentioning template-vault:write when vault scope missing', async () => {
    mockApiKeyRef.permissions = ['stacks:write'];

    const res = await supertest(buildApp())
      .post('/api/stack-templates/tmpl-1/draft')
      .send(draftWithVaultPolicies)
      .expect(403);

    expect(res.body.message).toMatch(/template-vault:write/);
  });

  it('returns 403 when vault has only kv[] and scope is missing', async () => {
    mockApiKeyRef.permissions = ['stacks:write'];

    const res = await supertest(buildApp())
      .post('/api/stack-templates/tmpl-1/draft')
      .send(draftWithOnlyKv)
      .expect(403);

    expect(res.body.code).toBe('template_vault_scope_required');
  });

  it('returns 200 for session users even with vault section (session bypasses scope check)', async () => {
    mockIsSessionRef.value = true;

    const res = await supertest(buildApp())
      .post('/api/stack-templates/tmpl-1/draft')
      .send(draftWithVaultPolicies)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(mockCreateOrUpdateDraft).toHaveBeenCalledOnce();
  });

  it('returns 200 when vault section is absent (no gate triggered)', async () => {
    mockApiKeyRef.permissions = ['stacks:write']; // only stacks:write — fine because no vault

    const res = await supertest(buildApp())
      .post('/api/stack-templates/tmpl-1/draft')
      .send(baseDraft)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(mockCreateOrUpdateDraft).toHaveBeenCalledOnce();
  });

  it('returns 200 when vault section has all empty arrays (gate not triggered)', async () => {
    mockApiKeyRef.permissions = ['stacks:write']; // no template-vault:write

    const res = await supertest(buildApp())
      .post('/api/stack-templates/tmpl-1/draft')
      .send(draftWithEmptyVault)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(mockCreateOrUpdateDraft).toHaveBeenCalledOnce();
  });

  it('returns 400 on schema validation failure (does not leak as 500)', async () => {
    mockApiKeyRef.permissions = ['stacks:write', 'template-vault:write'];

    const res = await supertest(buildApp())
      .post('/api/stack-templates/tmpl-1/draft')
      .send({ vault: 'not-an-object', networks: [], volumes: [], services: [] })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/Validation failed/);
    expect(mockCreateOrUpdateDraft).not.toHaveBeenCalled();
  });
});
