/**
 * HTTP regression test for POST /api/stack-templates/:templateId/draft.
 *
 * Critical regression this file guards:
 *   `vaultAppRoleRef` on services in a draft body was being silently stripped
 *   by Zod's default unknown-key behavior because the field was missing from
 *   `stackServiceDefinitionSchema`. The drafted DB row ended up with
 *   `vaultAppRoleRef = NULL`, so apply-time the vault orchestrator filtered
 *   the service out and never bound it to its declared AppRole.
 *
 * These tests POST a real draft body through the route (via supertest) with
 * a vault section + vaultAppRoleRef on a service, then assert the column is
 * persisted in the integration DB. The unit-level test in
 * stack-template-schemas.test.ts proves the schema preserves the field; this
 * test proves the full HTTP → service → Prisma path persists it.
 */

import supertest from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { testPrisma } from './integration-test-helpers';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

vi.mock('../middleware/auth', () => ({
  requirePermission: () => (req: Request, _res: Response, next: NextFunction) => {
    // Session user — bypasses the template-vault:write scope gate.
    (req as Request & { user?: { id: string } }).user = { id: 'session-user' };
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

async function createUserTemplateRow(): Promise<string> {
  const templateId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: `tpl-${templateId.slice(0, 6)}`,
      displayName: 'Draft Route Test Template',
      source: 'user',
      scope: 'environment',
      currentVersionId: null,
      draftVersionId: null,
    },
  });
  return templateId;
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/stack-templates/:templateId/draft — vaultAppRoleRef persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists vaultAppRoleRef on the StackTemplateService row (regression: was silently stripped)', async () => {
    const templateId = await createUserTemplateRow();

    const draftBody = {
      networks: [],
      volumes: [],
      services: [{ ...baseService, vaultAppRoleRef: 'my-approle' }],
      vault: {
        policies: [{ name: 'my-policy', body: 'path "secret/*" { capabilities = ["read"] }' }],
        appRoles: [{ name: 'my-approle', policy: 'my-policy' }],
      },
    };

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(draftBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const tmpl = await testPrisma.stackTemplate.findUnique({ where: { id: templateId } });
    expect(tmpl?.draftVersionId).not.toBeNull();

    const row = await testPrisma.stackTemplateService.findFirst({
      where: { versionId: tmpl!.draftVersionId! },
    });
    expect(row).not.toBeNull();
    expect(row!.vaultAppRoleRef).toBe('my-approle');
  });

  it('returns 400 when vaultAppRoleRef does not resolve to a declared appRole', async () => {
    const templateId = await createUserTemplateRow();

    const draftBody = {
      networks: [],
      volumes: [],
      services: [{ ...baseService, vaultAppRoleRef: 'nonexistent-role' }],
      vault: {
        policies: [{ name: 'my-policy', body: 'path "secret/*" { capabilities = ["read"] }' }],
        appRoles: [{ name: 'my-approle', policy: 'my-policy' }],
      },
    };

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(draftBody);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/Validation failed/);
    const issueMessages = (res.body.issues as Array<{ message: string }>).map((i) => i.message);
    expect(issueMessages.some((m) => m.includes('nonexistent-role'))).toBe(true);
  });
});
