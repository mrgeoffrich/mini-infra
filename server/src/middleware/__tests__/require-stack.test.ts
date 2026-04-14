import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const findUnique = vi.fn();

vi.mock('../../lib/prisma', () => ({
  default: { stack: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

import { requireStack, getLoadedStack } from '../require-stack';

function makeApp(mw: express.RequestHandler, handler: express.RequestHandler) {
  const app = express();
  app.get('/stacks/:stackId', mw, handler);
  return app;
}

describe('requireStack middleware', () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it('404s when the stack does not exist', async () => {
    findUnique.mockResolvedValue(null);
    const app = makeApp(requireStack(), (_req, res) => res.json({ ok: true }));
    const res = await supertest(app).get('/stacks/missing').expect(404);
    expect(res.body).toEqual({ success: false, message: 'Stack not found' });
  });

  it('attaches the loaded stack for downstream handlers on hit', async () => {
    findUnique.mockResolvedValue({ id: 'stack-1', name: 'web' });
    const app = makeApp(requireStack(), (req, res) => {
      const stack = getLoadedStack<{ id: string; name: string }>(req);
      res.json({ success: true, id: stack.id, name: stack.name });
    });

    const res = await supertest(app).get('/stacks/stack-1').expect(200);
    expect(res.body).toEqual({ success: true, id: 'stack-1', name: 'web' });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'stack-1' } });
  });

  it('forwards the select option to prisma', async () => {
    findUnique.mockResolvedValue({ id: 'stack-1' });
    const app = makeApp(
      requireStack({ select: { id: true } }),
      (_req, res) => res.json({ ok: true }),
    );
    await supertest(app).get('/stacks/stack-1').expect(200);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'stack-1' },
      select: { id: true },
    });
  });

  it('forwards the include option to prisma', async () => {
    findUnique.mockResolvedValue({ id: 'stack-1', services: [] });
    const app = makeApp(
      requireStack({ include: { services: true } }),
      (_req, res) => res.json({ ok: true }),
    );
    await supertest(app).get('/stacks/stack-1').expect(200);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'stack-1' },
      include: { services: true },
    });
  });

  it('honours custom param names', async () => {
    findUnique.mockResolvedValue({ id: 'abc' });
    const app = express();
    app.get('/s/:id', requireStack({ param: 'id' }), (_req, res) => res.json({ ok: true }));
    await supertest(app).get('/s/abc').expect(200);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'abc' } });
  });

  it('forwards prisma errors to the error handler', async () => {
    findUnique.mockRejectedValue(new Error('db down'));

    const app = express();
    app.get('/stacks/:stackId', requireStack(), (_req, res) => res.json({ ok: true }));
    // Final error handler so the test sees a clean 500
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    const res = await supertest(app).get('/stacks/stack-1').expect(500);
    expect(res.body).toEqual({ error: 'db down' });
  });
});
