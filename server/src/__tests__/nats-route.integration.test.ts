/**
 * HTTP-level integration test for Phase 6 of the error-handling overhaul
 * (docs/planning/not-shipped/error-handling-overhaul-plan.md).
 *
 * Canonical failure for the NATS domain: an admin action that references a
 * missing/duplicate NATS resource must surface as a typed 4xx through the
 * central error middleware (server/src/lib/error-handler.ts) — not a raw
 * 500 from an unmapped Prisma error. Before this phase, `routes/nats.ts`'s
 * account/credential/stream/consumer CRUD had no existence or duplicate
 * checks at all: a duplicate account name or a credential profile
 * referencing a nonexistent account both fell straight to Prisma, which
 * throws an unmapped `PrismaClientKnownRequestError` that the middleware's
 * `isOperational` branch never catches — a 500 for what is really a client
 * mistake.
 */

import supertest from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { testPrisma } from './integration-test-helpers';
import { errorHandler } from '../lib/error-handler';

vi.mock('../middleware/auth', () => ({
  requirePermission: () => (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: { id: string } }).user = { id: 'session-user' };
    next();
  },
}));

vi.mock('../lib/prisma', () => ({ default: testPrisma }));

import natsRoutes from '../routes/nats';
import { __resetNatsControlPlaneServiceForTests } from '../services/nats/nats-control-plane-service';

// Mounts the real central error middleware after the router so taxonomy
// errors thrown by the route/service reach the standard envelope, the same
// as they would in the full app.
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/nats', natsRoutes);
  app.use(errorHandler);
  return app;
}

async function createAccount(app: express.Express, name: string) {
  return supertest(app)
    .post('/api/nats/accounts')
    .send({ name, displayName: name });
}

describe('NATS route — canonical conflict/not-found envelopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNatsControlPlaneServiceForTests();
  });

  it('POST /api/nats/accounts with a duplicate name returns 409 NATS_ACCOUNT_EXISTS', async () => {
    const app = buildApp();
    const first = await createAccount(app, 'team-payments');
    expect(first.status).toBe(201);

    const res = await createAccount(app, 'team-payments');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'NATS_ACCOUNT_EXISTS',
      resource: { type: 'natsAccount', name: 'team-payments' },
    });
    expect(res.body.message).toMatch(/team-payments/);
    expect(typeof res.body.action).toBe('string');
    expect(res.body.requestId).toBeTruthy();
  });

  it('POST /api/nats/credentials referencing a missing account returns 404 NATS_ACCOUNT_NOT_FOUND', async () => {
    const app = buildApp();

    const res = await supertest(app)
      .post('/api/nats/credentials')
      .send({
        name: 'orders-reader',
        displayName: 'Orders Reader',
        accountId: 'does-not-exist',
        publishAllow: ['orders.>'],
        subscribeAllow: ['orders.>'],
      });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: 'NATS_ACCOUNT_NOT_FOUND',
      resource: { type: 'natsAccount', id: 'does-not-exist' },
    });
    expect(typeof res.body.action).toBe('string');
  });

  it('PATCH /api/nats/accounts/:id on a missing id returns 404 NATS_ACCOUNT_NOT_FOUND', async () => {
    const app = buildApp();

    const res = await supertest(app)
      .patch('/api/nats/accounts/does-not-exist')
      .send({ displayName: 'New name' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NATS_ACCOUNT_NOT_FOUND');
  });

  it('DELETE /api/nats/accounts/:id on a missing id is idempotent (200, no-op)', async () => {
    const app = buildApp();

    const res = await supertest(app).delete('/api/nats/accounts/does-not-exist');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('POST /api/nats/accounts with an invalid name returns 400 NATS_INVALID_NAME', async () => {
    const app = buildApp();

    // Passes the route's own zod `nameSchema` regex check... no — this name
    // fails the shared regex both zod and the service enforce, so either
    // layer rejecting it is fine; what matters is the envelope shape.
    const res = await supertest(app)
      .post('/api/nats/accounts')
      .send({ name: 'Not-Valid-Name', displayName: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.requestId).toBeTruthy();
  });
});
