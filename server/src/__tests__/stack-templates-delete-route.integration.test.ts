/**
 * Integration test for DELETE /api/stack-templates/:templateId.
 *
 * deleteTemplate() used to only remove DB rows (the StackTemplate and any
 * linked Stack records) with no teardown of the real Docker containers,
 * networks, or volumes a deployed stack owns — orphaning them with no UI
 * path left to find or clean up. The route now blocks the delete while any
 * linked stack is still deployed (not `undeployed` and not yet `removed`),
 * pointing the caller at the existing stack-destroy flow (the "Stop" button)
 * instead of silently leaking resources.
 */

import supertest from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { describe, it, expect } from 'vitest';
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

async function createTemplateWithStack(opts: {
  stackStatus: string;
  removedAt?: Date | null;
}): Promise<{ templateId: string; stackId: string }> {
  const templateId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: `delete-test-${templateId.slice(0, 6)}`,
      displayName: 'Delete Test',
      source: 'user',
      scope: 'host',
    },
  });

  const stackId = createId();
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: `delete-test-stack-${stackId.slice(0, 6)}`,
      networks: [],
      volumes: [],
      templateId,
      templateVersion: 1,
      status: opts.stackStatus as never,
      removedAt: opts.removedAt ?? null,
    },
  });

  return { templateId, stackId };
}

describe('DELETE /api/stack-templates/:templateId — deployed-stack guard', () => {
  it('rejects with 409 when a linked stack is still deployed', async () => {
    const { templateId } = await createTemplateWithStack({ stackStatus: 'synced' });

    const res = await supertest(buildApp()).delete(`/api/stack-templates/${templateId}`);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/still deployed/i);

    const stillThere = await testPrisma.stackTemplate.findUnique({ where: { id: templateId } });
    expect(stillThere).not.toBeNull();
  });

  it('allows delete once the linked stack has been destroyed (removedAt set)', async () => {
    const { templateId, stackId } = await createTemplateWithStack({
      stackStatus: 'synced',
      removedAt: new Date(0),
    });

    const res = await supertest(buildApp()).delete(`/api/stack-templates/${templateId}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const gone = await testPrisma.stackTemplate.findUnique({ where: { id: templateId } });
    expect(gone).toBeNull();
    const stackGone = await testPrisma.stack.findUnique({ where: { id: stackId } });
    expect(stackGone).toBeNull();
  });

  it('allows delete when the linked stack was never deployed (undeployed)', async () => {
    const { templateId } = await createTemplateWithStack({ stackStatus: 'undeployed' });

    const res = await supertest(buildApp()).delete(`/api/stack-templates/${templateId}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const gone = await testPrisma.stackTemplate.findUnique({ where: { id: templateId } });
    expect(gone).toBeNull();
  });
});
