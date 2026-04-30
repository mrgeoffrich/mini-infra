/**
 * HTTP regression test for the wrapped-secret-id + restartPolicy guard.
 *
 * Customer feedback #3: a service that combines `vault-wrapped-secret-id`
 * with `restartPolicy: "always"` (or `"unless-stopped"`) hits a buried-error
 * trap — the wrapped token is consumed on first unwrap, every restart
 * thereafter spams "wrapping token is not valid", and the original
 * first-boot failure scrolls off the operator's logs.
 *
 * The validator now rejects this combo at template-draft validation time.
 * This test posts both the bad combo and a valid combo through the real
 * HTTP draft route to confirm the guard is on the wire.
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
      displayName: 'Wrapped-secret restart-guard test',
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
  dependsOn: [],
  order: 0,
};

describe('POST /api/stack-templates/:id/draft — wrapped-secret-id + restartPolicy guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects services that combine vault-wrapped-secret-id with restartPolicy="always"', async () => {
    const templateId = await createUserTemplateRow();

    const draftBody = {
      networks: [],
      volumes: [],
      services: [
        {
          ...baseService,
          containerConfig: {
            dynamicEnv: { VAULT_WRAPPED_SECRET_ID: { kind: 'vault-wrapped-secret-id' } },
            restartPolicy: 'always',
          },
        },
      ],
    };

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(draftBody);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/Validation failed/);
    const issueMessages = (res.body.issues as Array<{ message: string }>).map((i) => i.message);
    expect(issueMessages.some((m) => m.includes('wrapped') && m.includes('always'))).toBe(true);
    expect(issueMessages.some((m) => m.includes('redeploy'))).toBe(true);
  });

  it('rejects the same combo with restartPolicy="unless-stopped"', async () => {
    const templateId = await createUserTemplateRow();

    const draftBody = {
      networks: [],
      volumes: [],
      services: [
        {
          ...baseService,
          containerConfig: {
            dynamicEnv: { VAULT_WRAPPED_SECRET_ID: { kind: 'vault-wrapped-secret-id' } },
            restartPolicy: 'unless-stopped',
          },
        },
      ],
    };

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(draftBody);

    expect(res.status).toBe(400);
    const issueMessages = (res.body.issues as Array<{ message: string }>).map((i) => i.message);
    expect(issueMessages.some((m) => m.includes('unless-stopped'))).toBe(true);
  });

  it('accepts the same dynamicEnv when restartPolicy is "no"', async () => {
    const templateId = await createUserTemplateRow();

    const draftBody = {
      networks: [],
      volumes: [],
      services: [
        {
          ...baseService,
          containerConfig: {
            dynamicEnv: { VAULT_WRAPPED_SECRET_ID: { kind: 'vault-wrapped-secret-id' } },
            restartPolicy: 'no',
          },
        },
      ],
    };

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(draftBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('still allows restartPolicy="always" when no wrapped-secret-id is in dynamicEnv', async () => {
    const templateId = await createUserTemplateRow();

    const draftBody = {
      networks: [],
      volumes: [],
      services: [
        {
          ...baseService,
          containerConfig: {
            dynamicEnv: { VAULT_ROLE_ID: { kind: 'vault-role-id' } },
            restartPolicy: 'always',
          },
        },
      ],
    };

    const res = await supertest(buildApp())
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(draftBody);

    expect(res.status).toBe(200);
  });
});
