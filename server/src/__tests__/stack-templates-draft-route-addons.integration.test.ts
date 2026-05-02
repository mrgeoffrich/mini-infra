/**
 * HTTP regression test for POST /api/stack-templates/:templateId/draft —
 * Service Addons authoring block (Phase 1, ALT-56).
 *
 * Mirrors the convention pinned in `server/CLAUDE.md` and `service-schema-
 * drift.test.ts`: a field that must round-trip from a real POST body to a
 * Prisma column has to be tested via supertest, not by seeding the DB
 * directly. Direct seeding bypasses the Zod boundary that previously
 * silently stripped `vaultAppRoleRef`; the same trap applies to `addons`.
 *
 * The test registers a no-op addon into `productionAddonRegistry` so the
 * schema's per-entry `superRefine` accepts the block. Vitest's `pool:
 * 'forks'` configuration isolates this mutation to one test file process.
 */

import supertest from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { testPrisma } from './integration-test-helpers';
import { productionAddonRegistry } from '../services/stack-addons/registry';
import { noopAddon } from '../services/stack-addons/test-addons/noop';

vi.mock('../middleware/auth', () => ({
  requirePermission: () => (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: { id: string } }).user = { id: 'session-user' };
    next();
  },
}));

vi.mock('../lib/prisma', () => ({ default: testPrisma }));

import stackTemplateRouter from '../routes/stack-templates';

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
      displayName: 'Addons Route Test Template',
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

describe('POST /api/stack-templates/:templateId/draft — addons persistence', () => {
  beforeAll(() => {
    // Vitest forks each test file into its own process, so this mutation is
    // confined to this file's worker. Registry is a runtime-only structure;
    // no clean-up needed because the worker exits at file end.
    if (!productionAddonRegistry.has('noop')) {
      productionAddonRegistry.register(noopAddon);
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists the addons block on the StackTemplateService row when noop addon is registered', async () => {
    const templateId = await createUserTemplateRow();

    const draftBody = {
      networks: [],
      volumes: [],
      services: [{ ...baseService, addons: { noop: { label: 'phase-1' } } }],
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
    expect(row!.addons).toEqual({ noop: { label: 'phase-1' } });
  });

  it('returns 400 when the addons block references an unregistered addon id', async () => {
    const templateId = await createUserTemplateRow();

    const draftBody = {
      networks: [],
      volumes: [],
      services: [{ ...baseService, addons: { 'does-not-exist': {} } }],
    };

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(draftBody);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    const issueMessages = (res.body.issues as Array<{ message: string }>).map((i) => i.message);
    expect(issueMessages.some((m) => m.includes('does-not-exist'))).toBe(true);
  });

  it('round-trips an empty addons block (no entries) on the column', async () => {
    const templateId = await createUserTemplateRow();

    const draftBody = {
      networks: [],
      volumes: [],
      services: [{ ...baseService, addons: {} }],
    };

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(draftBody);

    expect(res.status).toBe(200);
    const tmpl = await testPrisma.stackTemplate.findUnique({ where: { id: templateId } });
    const row = await testPrisma.stackTemplateService.findFirst({
      where: { versionId: tmpl!.draftVersionId! },
    });
    expect(row!.addons).toEqual({});
  });
});
