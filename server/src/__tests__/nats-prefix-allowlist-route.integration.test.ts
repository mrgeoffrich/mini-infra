/**
 * Integration tests for the NATS subject-prefix allowlist (Phase 2).
 *
 * These exercise the full HTTP → service → SystemSettings round-trip plus
 * every validation rule from the design (§2.6). The route uses CRUD-per-
 * entry, NOT blob PUT — verified here by deletion of one entry leaving
 * others untouched.
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

import natsPrefixAllowlistRoutes from '../routes/nats-prefix-allowlist';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/nats/prefix-allowlist', natsPrefixAllowlistRoutes);
  return app;
}

async function createUserTemplate(name?: string): Promise<string> {
  const id = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id,
      name: name ?? `tpl-${id.slice(0, 6)}`,
      displayName: 'Allowlist Test Template',
      source: 'user',
      scope: 'environment',
      currentVersionId: null,
      draftVersionId: null,
    },
  });
  return id;
}

describe('NATS prefix allowlist route — happy paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET / returns empty array by default', async () => {
    const res = await supertest(buildApp()).get('/api/nats/prefix-allowlist').expect(200);
    expect(res.body).toEqual({ success: true, data: [] });
  });

  it('POST → GET round-trips an entry (default state was empty)', async () => {
    const tplId = await createUserTemplate();

    const created = await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: 'navi', allowedTemplateIds: [tplId] })
      .expect(201);
    expect(created.body.success).toBe(true);
    expect(created.body.data.prefix).toBe('navi');
    expect(created.body.data.allowedTemplateIds).toEqual([tplId]);

    const list = await supertest(buildApp()).get('/api/nats/prefix-allowlist').expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].prefix).toBe('navi');

    const single = await supertest(buildApp()).get('/api/nats/prefix-allowlist/navi').expect(200);
    expect(single.body.data.prefix).toBe('navi');
  });

  it('PUT updates allowedTemplateIds without changing prefix or createdAt', async () => {
    const tplA = await createUserTemplate();
    const tplB = await createUserTemplate();

    const created = await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: 'navi', allowedTemplateIds: [tplA] })
      .expect(201);
    const createdAt = created.body.data.createdAt;

    const updated = await supertest(buildApp())
      .put('/api/nats/prefix-allowlist/navi')
      .send({ allowedTemplateIds: [tplA, tplB] })
      .expect(200);
    expect(updated.body.data.allowedTemplateIds).toEqual([tplA, tplB]);
    expect(updated.body.data.createdAt).toBe(createdAt);
  });

  it('DELETE removes only the specified entry', async () => {
    const tplA = await createUserTemplate();
    const tplB = await createUserTemplate();

    await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: 'navi', allowedTemplateIds: [tplA] })
      .expect(201);
    await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: 'platform-events', allowedTemplateIds: [tplB] })
      .expect(201);

    await supertest(buildApp()).delete('/api/nats/prefix-allowlist/navi').expect(200);

    const list = await supertest(buildApp()).get('/api/nats/prefix-allowlist').expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].prefix).toBe('platform-events');
  });

  it('DELETE on a missing prefix returns 404', async () => {
    await supertest(buildApp()).delete('/api/nats/prefix-allowlist/nope').expect(404);
  });

  it('GET on a missing prefix returns 404', async () => {
    await supertest(buildApp()).get('/api/nats/prefix-allowlist/nope').expect(404);
  });
});

describe('NATS prefix allowlist route — validation rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects empty prefix', async () => {
    await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: '', allowedTemplateIds: ['tpl1'] })
      .expect(400);
  });

  it.each([
    ['contains >', 'navi.>'],
    ['contains *', 'navi.*'],
    ['leading dot', '.navi'],
    ['trailing dot', 'navi.'],
    ['starts with $SYS.', '$SYS.foo'],
    ['equals $SYS', '$SYS'],
    ['has empty token', 'navi..foo'],
  ])('rejects prefix that %s', async (_label, prefix) => {
    const tpl = await createUserTemplate();
    const res = await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix, allowedTemplateIds: [tpl] });
    expect(res.status).toBe(400);
  });

  it('rejects empty allowedTemplateIds', async () => {
    const res = await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: 'navi', allowedTemplateIds: [] });
    expect(res.status).toBe(400);
  });

  it('rejects allowedTemplateIds that reference a nonexistent template', async () => {
    const res = await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: 'navi', allowedTemplateIds: ['does-not-exist'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown template/);
  });

  it('rejects an entry whose prefix is a strict ancestor of an existing entry', async () => {
    const tpl = await createUserTemplate();
    await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: 'events.platform', allowedTemplateIds: [tpl] })
      .expect(201);

    const res = await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: 'events', allowedTemplateIds: [tpl] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/overlap/);
  });

  it('rejects an entry whose prefix is a strict descendant of an existing entry', async () => {
    const tpl = await createUserTemplate();
    await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: 'events', allowedTemplateIds: [tpl] })
      .expect(201);

    const res = await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: 'events.platform', allowedTemplateIds: [tpl] });
    expect(res.status).toBe(409);
  });

  it('rejects creating a duplicate prefix', async () => {
    const tpl = await createUserTemplate();
    await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: 'navi', allowedTemplateIds: [tpl] })
      .expect(201);

    const res = await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: 'navi', allowedTemplateIds: [tpl] });
    expect(res.status).toBe(409);
  });

  it('PUT rejects allowedTemplateIds that reference a nonexistent template', async () => {
    const tpl = await createUserTemplate();
    await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: 'navi', allowedTemplateIds: [tpl] })
      .expect(201);

    const res = await supertest(buildApp())
      .put('/api/nats/prefix-allowlist/navi')
      .send({ allowedTemplateIds: ['does-not-exist'] });
    expect(res.status).toBe(400);
  });

  it('PUT on a missing prefix returns 404', async () => {
    const tpl = await createUserTemplate();
    const res = await supertest(buildApp())
      .put('/api/nats/prefix-allowlist/nope')
      .send({ allowedTemplateIds: [tpl] });
    expect(res.status).toBe(404);
  });

  it('rejects duplicate templateIds in allowedTemplateIds', async () => {
    const tpl = await createUserTemplate();
    const res = await supertest(buildApp())
      .post('/api/nats/prefix-allowlist')
      .send({ prefix: 'navi', allowedTemplateIds: [tpl, tpl] });
    expect(res.status).toBe(400);
  });
});
