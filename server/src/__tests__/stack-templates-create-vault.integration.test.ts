/**
 * HTTP integration test for POST /api/stack-templates accepting `inputs`
 * and `vault` directly on create.
 *
 * Why this exists:
 *   The previous flow was create-template (no vault/inputs) → POST draft
 *   (with vault/inputs) → publish — three round-trips and a no-op stub
 *   draft. This route now collapses to a single create-with-spec call.
 *   The test posts a complete spec through the real route, then queries
 *   the DB to verify the v0 draft persists every input + vault column.
 *
 * Also guards the template-vault:write permission gate added on the
 * create endpoint to mirror the draft endpoint.
 */

import supertest from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { testPrisma } from './integration-test-helpers';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockApiKeyRef, mockIsSessionRef } = vi.hoisted(() => {
  const mockApiKeyRef = { permissions: ['stacks:write'] as string[] | null };
  const mockIsSessionRef = { value: false };
  return { mockApiKeyRef, mockIsSessionRef };
});

vi.mock('../middleware/auth', () => ({
  requirePermission: () => (req: Request, _res: Response, next: NextFunction) => {
    if (mockIsSessionRef.value) {
      (req as Request & { user?: { id: string } }).user = { id: 'session-user' };
    } else {
      (req as Request & {
        user?: { id: string };
        apiKey?: { id: string; permissions: string[] | null };
      }).user = { id: 'api-user' };
      (req as Request & { apiKey?: { id: string; permissions: string[] | null } }).apiKey = {
        id: 'test-key',
        permissions: mockApiKeyRef.permissions,
      };
    }
    next();
  },
}));

vi.mock('../lib/prisma', () => ({ default: testPrisma }));

import stackTemplateRouter from '../routes/stack-templates';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/stack-templates', stackTemplateRouter);
  return app;
}

const baseService = {
  serviceName: 'web',
  serviceType: 'Stateful',
  dockerImage: 'nginx',
  dockerTag: 'latest',
  containerConfig: {},
  dependsOn: [],
  order: 0,
};

function uniqueName(): string {
  return `tpl-create-${Math.random().toString(36).slice(2, 10)}`;
}

function createBody(extra: Record<string, unknown> = {}) {
  return {
    name: uniqueName(),
    displayName: 'Create-with-Spec Test',
    scope: 'environment' as const,
    networks: [],
    volumes: [],
    services: [baseService],
    ...extra,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/stack-templates — single-call create with vault + inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiKeyRef.permissions = ['stacks:write', 'template-vault:write'];
    mockIsSessionRef.value = false;
  });

  it('persists inputs[] on the v0 draft StackTemplateVersion row', async () => {
    const body = createBody({
      inputs: [
        { name: 'apiKey' },
        { name: 'dbPassword', sensitive: true, required: false, rotateOnUpgrade: true },
      ],
    });

    const res = await supertest(buildApp()).post('/api/stack-templates').send(body);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const tmplId = res.body.data.id;
    const tmpl = await testPrisma.stackTemplate.findUnique({
      where: { id: tmplId },
      include: { draftVersion: true },
    });
    expect(tmpl?.draftVersion?.inputs).toBeTruthy();
    const persistedInputs = tmpl!.draftVersion!.inputs as Array<{
      name: string;
      sensitive: boolean;
      required: boolean;
      rotateOnUpgrade: boolean;
    }>;
    expect(persistedInputs).toHaveLength(2);
    expect(persistedInputs.find((i) => i.name === 'apiKey')).toBeTruthy();
    expect(persistedInputs.find((i) => i.name === 'dbPassword')?.required).toBe(false);
  });

  it('persists every vault column (policies, appRoles, kv) on the v0 draft', async () => {
    const body = createBody({
      inputs: [{ name: 'token' }],
      vault: {
        policies: [
          { name: 'my-policy', body: 'path "secret/data/shared/*" { capabilities = ["read"] }' },
        ],
        appRoles: [{ name: 'my-role', policy: 'my-policy', tokenTtl: '1h' }],
        kv: [{ path: 'shared/cfg', fields: { token: { fromInput: 'token' } } }],
      },
    });

    const res = await supertest(buildApp()).post('/api/stack-templates').send(body);
    expect(res.status).toBe(201);

    const tmplId = res.body.data.id;
    const draft = await testPrisma.stackTemplateVersion.findFirst({
      where: { templateId: tmplId, status: 'draft' },
    });
    expect(draft).not.toBeNull();
    expect(draft!.vaultPolicies).toBeTruthy();
    expect(draft!.vaultAppRoles).toBeTruthy();
    expect(draft!.vaultKv).toBeTruthy();
    const policies = draft!.vaultPolicies as Array<{ name: string }>;
    const appRoles = draft!.vaultAppRoles as Array<{ name: string }>;
    const kv = draft!.vaultKv as Array<{ path: string }>;
    expect(policies[0].name).toBe('my-policy');
    expect(appRoles[0].name).toBe('my-role');
    expect(kv[0].path).toBe('shared/cfg');
  });

  it('still works for legacy creates without inputs/vault (back-compat)', async () => {
    const res = await supertest(buildApp()).post('/api/stack-templates').send(createBody());

    expect(res.status).toBe(201);
    const tmplId = res.body.data.id;
    const draft = await testPrisma.stackTemplateVersion.findFirst({
      where: { templateId: tmplId, status: 'draft' },
    });
    expect(draft!.inputs).toBeNull();
    expect(draft!.vaultPolicies).toBeNull();
    expect(draft!.vaultAppRoles).toBeNull();
    expect(draft!.vaultKv).toBeNull();
  });

  it('returns 403 when vault section is present and caller lacks template-vault:write', async () => {
    mockApiKeyRef.permissions = ['stacks:write']; // missing the vault scope

    const body = createBody({
      vault: {
        policies: [{ name: 'p', body: 'path "x" { capabilities = ["read"] }' }],
        appRoles: [{ name: 'r', policy: 'p' }],
      },
    });

    const res = await supertest(buildApp()).post('/api/stack-templates').send(body);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('template_vault_scope_required');
  });

  it('session users bypass the vault scope gate', async () => {
    mockIsSessionRef.value = true;

    const body = createBody({
      vault: {
        policies: [{ name: 'p', body: 'path "x" { capabilities = ["read"] }' }],
        appRoles: [{ name: 'r', policy: 'p' }],
      },
    });

    const res = await supertest(buildApp()).post('/api/stack-templates').send(body);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('returns 400 when a service field has a substitution typo (e.g. {{stak.id}})', async () => {
    // Pin behaviour: the substitution validator (same one used by
    // createOrUpdateDraft) runs at create time so authoring typos surface
    // immediately rather than at apply.
    const body = createBody({
      services: [
        {
          ...baseService,
          containerConfig: { env: { ID: '{{stak.id}}' } }, // typo of stack.id
        },
      ],
    });

    const res = await supertest(buildApp()).post('/api/stack-templates').send(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/substitution|stak\.id/i);
  });
});
