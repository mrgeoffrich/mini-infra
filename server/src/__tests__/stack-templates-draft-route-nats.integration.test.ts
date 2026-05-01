/**
 * HTTP regression test for POST /api/stack-templates/:templateId/draft —
 * Phase 1 NATS app-roles surface (`natsRole`, `natsSigner`, plus the new
 * version-level `subjectPrefix`/`roles`/`signers`/`exports`/`imports` fields).
 *
 * Mirrors the `vaultAppRoleRef` regression test (see
 * `stack-templates-draft-route.integration.test.ts`). A reviewer flagged that
 * `toTemplateServiceCreate`, `serializeTemplateService`, `buildNatsSection`,
 * and `upsertBuiltinTemplate` were all silently dropping these fields on the
 * way to / from Prisma — the exact same bug class as `vaultAppRoleRef`. These
 * tests post a real body via supertest and assert the columns are persisted
 * AND echoed back through the GET path.
 */

import supertest from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { testPrisma } from './integration-test-helpers';

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
      displayName: 'NATS Draft Route Test Template',
      source: 'user',
      scope: 'environment',
      currentVersionId: null,
      draftVersionId: null,
    },
  });
  return templateId;
}

const baseService = {
  serviceName: 'manager',
  serviceType: 'Stateful',
  dockerImage: 'app',
  dockerTag: 'latest',
  containerConfig: {},
  dependsOn: [],
  order: 0,
};

describe('POST /api/stack-templates/:templateId/draft — NATS Phase 1 persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists service.natsRole and service.natsSigner on the StackTemplateService row', async () => {
    const templateId = await createUserTemplateRow();

    const draftBody = {
      networks: [],
      volumes: [],
      services: [
        { ...baseService, natsRole: 'manager-role', natsSigner: 'worker-minter' },
      ],
      nats: {
        roles: [{ name: 'manager-role', publish: ['agent.worker.>'] }],
        signers: [{ name: 'worker-minter', subjectScope: 'agent.worker' }],
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
    expect(row!.natsRole).toBe('manager-role');
    expect(row!.natsSigner).toBe('worker-minter');
  });

  it('persists subjectPrefix / roles / signers / exports / imports on the StackTemplateVersion row', async () => {
    const templateId = await createUserTemplateRow();

    const draftBody = {
      networks: [],
      volumes: [],
      services: [],
      nats: {
        subjectPrefix: 'app.{{stack.id}}',
        roles: [
          { name: 'gateway', publish: ['agent.in'], subscribe: ['slack.api'] },
        ],
        signers: [{ name: 'minter', subjectScope: 'agent.worker', maxTtlSeconds: 1800 }],
        exports: ['events.>'],
        imports: [{ fromStack: 'producer', subjects: ['x.>'], forRoles: ['gateway'] }],
      },
    };

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(draftBody);

    expect(res.status).toBe(200);

    const tmpl = await testPrisma.stackTemplate.findUnique({ where: { id: templateId } });
    const versionRow = await testPrisma.stackTemplateVersion.findUnique({
      where: { id: tmpl!.draftVersionId! },
    });
    expect(versionRow).not.toBeNull();
    expect(versionRow!.natsSubjectPrefix).toBe('app.{{stack.id}}');
    expect(versionRow!.natsRoles).toEqual([
      { name: 'gateway', publish: ['agent.in'], subscribe: ['slack.api'] },
    ]);
    expect(versionRow!.natsSigners).toEqual([
      { name: 'minter', subjectScope: 'agent.worker', maxTtlSeconds: 1800 },
    ]);
    expect(versionRow!.natsExports).toEqual(['events.>']);
    expect(versionRow!.natsImports).toEqual([
      { fromStack: 'producer', subjects: ['x.>'], forRoles: ['gateway'] },
    ]);
  });

  it('returns 400 when natsRole references an undeclared role', async () => {
    const templateId = await createUserTemplateRow();

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send({
        networks: [],
        volumes: [],
        services: [{ ...baseService, natsRole: 'absent' }],
        nats: { roles: [{ name: 'gateway', publish: ['x'] }] },
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/stack-templates/:id echoes Phase 1 NATS fields in the version response', async () => {
    const templateId = await createUserTemplateRow();

    await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send({
        networks: [],
        volumes: [],
        services: [{ ...baseService, natsRole: 'manager-role', natsSigner: 'minter' }],
        nats: {
          subjectPrefix: 'navi-test',
          roles: [{ name: 'manager-role', publish: ['agent.worker.>'] }],
          signers: [{ name: 'minter', subjectScope: 'agent.worker' }],
          exports: ['events.>'],
          imports: [{ fromStack: 'producer', subjects: ['x.>'], forRoles: ['manager-role'] }],
        },
      })
      .expect(200);

    const res = await supertest(buildApp())
      .get(`/api/stack-templates/${templateId}`)
      .expect(200);

    const draft = res.body.data.draftVersion;
    expect(draft).not.toBeNull();
    expect(draft.nats).toBeDefined();
    expect(draft.nats.subjectPrefix).toBe('navi-test');
    expect(draft.nats.roles).toEqual([
      { name: 'manager-role', publish: ['agent.worker.>'] },
    ]);
    expect(draft.nats.signers).toEqual([
      { name: 'minter', subjectScope: 'agent.worker' },
    ]);
    expect(draft.nats.exports).toEqual(['events.>']);
    expect(draft.nats.imports).toEqual([
      { fromStack: 'producer', subjects: ['x.>'], forRoles: ['manager-role'] },
    ]);

    expect(draft.services).toBeDefined();
    const svc = draft.services.find((s: { serviceName: string }) => s.serviceName === 'manager');
    expect(svc?.natsRole).toBe('manager-role');
    expect(svc?.natsSigner).toBe('minter');
  });

  it('returns 400 when legacy `nats.credentials` and new `nats.roles` are both declared (mixing rule)', async () => {
    const templateId = await createUserTemplateRow();

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send({
        networks: [],
        volumes: [],
        services: [],
        nats: {
          accounts: [{ name: 'app', scope: 'host' }],
          credentials: [
            { name: 'cred', account: 'app', publishAllow: ['x'], subscribeAllow: ['y'] },
          ],
          roles: [{ name: 'gateway', publish: ['x'] }],
        },
      });

    expect(res.status).toBe(400);
    const issueMessages = (res.body.issues as Array<{ message: string }> | undefined)?.map((i) => i.message) ?? [];
    expect(issueMessages.join('|')).toContain('cannot be declared in the same template');
  });
});
