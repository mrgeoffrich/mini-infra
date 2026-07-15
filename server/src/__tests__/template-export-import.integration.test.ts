/**
 * HTTP contract test for template export/import
 * (GET /api/stack-templates/:id/versions/:vid/export + POST /api/stack-templates/import).
 *
 * Per server/CLAUDE.md, a field-persistence contract must be exercised through
 * the real Express routes, not a direct Prisma insert — a unit test of the pure
 * mapper can't prove the server accepts the shapes it emits, nor that Zod's
 * default unknown-key stripping doesn't quietly drop a section on the way in.
 *
 * The headline cases:
 *   - a full round-trip (create → export → import) preserves services/networks,
 *   - a literal Vault secret is redacted on export and never lands on the copy,
 *   - a system-scope quirk (`scope: any`) is coerced, and the import always
 *     produces a *user* template,
 *   - a custom NATS subject prefix is surfaced as a warning.
 */
import supertest from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import * as yaml from 'js-yaml';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import {
  REDACTED_SECRET_PLACEHOLDER,
  TEMPLATE_EXPORT_FORMAT,
  type TemplateExportDocument,
} from '@mini-infra/types';
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
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/stack-templates', stackTemplateRouter);
  return app;
}

const baseService = {
  serviceName: 'web',
  serviceType: 'Stateful',
  dockerImage: 'nginx',
  dockerTag: '1.25',
  containerConfig: { joinNetworks: ['app-net'] },
  dependsOn: [],
  order: 0,
};

async function createTemplate(body: Record<string, unknown>) {
  const res = await supertest(buildApp()).post('/api/stack-templates').send(body);
  return res;
}

async function exportVersion(templateId: string, versionId: string) {
  return supertest(buildApp()).get(
    `/api/stack-templates/${templateId}/versions/${versionId}/export`,
  );
}

async function importYaml(body: string, overrides: { name?: string; displayName?: string } = {}) {
  return supertest(buildApp())
    .post('/api/stack-templates/import')
    .send({ yaml: body, ...overrides });
}

describe('template export/import round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('round-trips services + networks and redacts a literal vault secret', async () => {
    const suffix = createId().slice(0, 6);
    const create = await createTemplate({
      name: `export-src-${suffix}`,
      displayName: 'Export Source',
      description: 'the original',
      scope: 'environment',
      networks: [{ name: 'app-net' }],
      volumes: [{ name: 'data' }],
      services: [baseService],
      vault: {
        kv: [
          {
            path: 'app/db',
            fields: {
              PASSWORD: { value: 'super-secret' },
              USERNAME: { fromInput: 'dbUser' },
            },
          },
        ],
      },
    });
    expect(create.status).toBe(201);
    const srcTemplateId = create.body.data.id as string;
    const srcVersionId = create.body.data.draftVersionId as string;
    expect(srcVersionId).toBeTruthy();

    // ── Export ────────────────────────────────────────────────────────────
    const exp = await exportVersion(srcTemplateId, srcVersionId);
    expect(exp.status).toBe(200);
    const { yaml: exportedYaml, issues: exportIssues } = exp.body.data;

    // The literal secret was redacted and reported; the fromInput ref was not.
    const doc = yaml.load(exportedYaml) as TemplateExportDocument;
    expect(doc.format).toBe(TEMPLATE_EXPORT_FORMAT);
    const kv = doc.version.vault?.kv?.[0];
    expect(kv?.fields.PASSWORD).toEqual({ value: REDACTED_SECRET_PLACEHOLDER });
    expect(kv?.fields.USERNAME).toEqual({ fromInput: 'dbUser' });
    expect(exportIssues.some((i: { path: string }) => i.path.includes('PASSWORD'))).toBe(true);

    // Re-importing under the same name on the same instance collides.
    const collide = await importYaml(exportedYaml);
    expect(collide.status).toBe(409);

    // ── Import (renamed, as a cross-instance import effectively is) ────────
    const imp = await importYaml(exportedYaml, {
      name: `export-copy-${suffix}`,
      displayName: 'Export Copy',
    });
    expect(imp.status).toBe(201);
    const newTemplateId = imp.body.data.id as string;
    expect(newTemplateId).not.toBe(srcTemplateId);
    expect(imp.body.data.name).toBe(`export-copy-${suffix}`);
    // Import always produces a user template.
    expect(imp.body.data.source).toBe('user');
    // The redaction notice rides along so the UI can warn the operator.
    expect(imp.body.issues.some((i: { path: string }) => i.path.includes('PASSWORD'))).toBe(true);

    // ── Persistence (through the route, not a fixture) ────────────────────
    const newTmpl = await testPrisma.stackTemplate.findUnique({ where: { id: newTemplateId } });
    const newVersionId = newTmpl?.draftVersionId ?? newTmpl?.currentVersionId;
    expect(newVersionId).toBeTruthy();

    const svcRow = await testPrisma.stackTemplateService.findFirst({
      where: { versionId: newVersionId! },
    });
    expect(svcRow?.serviceName).toBe('web');
    expect((svcRow?.containerConfig as { joinNetworks?: string[] }).joinNetworks).toEqual(['app-net']);

    const versionRow = await testPrisma.stackTemplateVersion.findUnique({
      where: { id: newVersionId! },
    });
    expect(versionRow?.networks).toEqual([{ name: 'app-net' }]);
    // The secret never travelled — the copy holds the placeholder, not the value.
    const importedKv = versionRow?.vaultKv as Array<{ fields: Record<string, unknown> }>;
    expect(importedKv?.[0]?.fields.PASSWORD).toEqual({ value: REDACTED_SECRET_PLACEHOLDER });
  });

  it('coerces scope "any" to environment and imports as a user template', async () => {
    const suffix = createId().slice(0, 6);
    const doc: TemplateExportDocument = {
      format: TEMPLATE_EXPORT_FORMAT,
      sourceVersion: 1,
      template: {
        name: `any-scope-${suffix}`,
        displayName: 'Any Scope',
        scope: 'any',
      },
      version: {
        networks: [],
        volumes: [],
        services: [baseService],
      },
    };

    const imp = await importYaml(yaml.dump(doc));
    expect(imp.status).toBe(201);
    expect(imp.body.data.scope).toBe('environment');
    expect(imp.body.data.source).toBe('user');
    expect(
      imp.body.issues.some(
        (i: { level: string; path: string }) => i.level === 'defaulted' && i.path === 'template.scope',
      ),
    ).toBe(true);
  });

  it('warns when an imported template claims a custom NATS subject prefix', async () => {
    const suffix = createId().slice(0, 6);
    const doc: TemplateExportDocument = {
      format: TEMPLATE_EXPORT_FORMAT,
      template: {
        name: `custom-prefix-${suffix}`,
        displayName: 'Custom Prefix',
        scope: 'environment',
      },
      version: {
        networks: [],
        volumes: [],
        services: [baseService],
        nats: { subjectPrefix: 'events.custom' },
      },
    };

    const imp = await importYaml(yaml.dump(doc));
    expect(imp.status).toBe(201);
    expect(
      imp.body.issues.some(
        (i: { level: string; path: string }) =>
          i.level === 'lossy' && i.path === 'version.nats.subjectPrefix',
      ),
    ).toBe(true);
  });

  it('rejects a file that is not a template export', async () => {
    const imp = await importYaml(yaml.dump({ hello: 'world' }));
    expect(imp.status).toBe(400);
    expect(
      imp.body.issues.some((i: { level: string; path: string }) => i.level === 'error' && i.path === 'format'),
    ).toBe(true);
  });

  it('rejects a non-YAML body', async () => {
    const imp = await importYaml('this: : : not valid');
    expect(imp.status).toBe(400);
  });

  it('404s exporting a version that does not belong to the template', async () => {
    const exp = await exportVersion('nonexistent-template', 'nonexistent-version');
    expect(exp.status).toBe(404);
  });
});
