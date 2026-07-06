/**
 * HTTP regression test for POST /api/stack-templates — containerConfig.joinNetworks.
 *
 * The "connect to a database/container" feature on the application forms folds
 * the user's linked-container selections into `containerConfig.joinNetworks`,
 * which the create route must persist verbatim so the app joins those networks
 * at apply time. Per server/CLAUDE.md, a field-persistence contract like this is
 * tested through the real HTTP route (not a direct Prisma insert) so a future
 * Zod-strip on the create path can't silently drop it — exactly the class of bug
 * that hit `vaultAppRoleRef`.
 */

import supertest from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { testPrisma } from './integration-test-helpers';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

vi.mock('../middleware/auth', () => ({
  requirePermission: () => (req: Request, _res: Response, next: NextFunction) => {
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

describe('POST /api/stack-templates — containerConfig.joinNetworks persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists containerConfig.joinNetworks on the v0 draft service row', async () => {
    const suffix = createId().slice(0, 6);
    const createBody = {
      name: `join-net-${suffix}`,
      displayName: 'Join Networks Test',
      scope: 'environment',
      networks: [],
      volumes: [],
      services: [
        {
          ...baseService,
          containerConfig: { joinNetworks: ['some-db_default'] },
        },
      ],
    };

    const res = await supertest(buildApp())
      .post('/api/stack-templates')
      .send(createBody);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const templateId = res.body.data.id as string;
    const tmpl = await testPrisma.stackTemplate.findUnique({
      where: { id: templateId },
    });
    const versionId = tmpl?.draftVersionId ?? tmpl?.currentVersionId;
    expect(versionId).toBeTruthy();

    const row = await testPrisma.stackTemplateService.findFirst({
      where: { versionId: versionId! },
    });
    expect(row).not.toBeNull();
    const containerConfig = row!.containerConfig as { joinNetworks?: string[] };
    expect(containerConfig.joinNetworks).toEqual(['some-db_default']);
  });
});
