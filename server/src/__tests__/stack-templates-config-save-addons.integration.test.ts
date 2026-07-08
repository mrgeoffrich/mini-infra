/**
 * HTTP regression test for the application Configuration-tab save path —
 * addon-authoring-ui plan, Phase 1 ("Config-tab addon-safety fix").
 *
 * The Configuration tab's `onSubmit`
 * (`client/src/app/applications/[id]/configuration/page.tsx`) used to rebuild
 * `services[]` from scratch, which silently dropped a service's `addons`
 * block (plus `vault`/`nats`/`requires` and any container-config field the
 * form doesn't model). The fix rebuilds the draft losslessly via
 * `buildDraftFromVersion(existingVersion)` and overlays only the form-edited
 * fields — mirroring the Connected Networks card's `persistJoinNetworks`.
 *
 * Per `server/CLAUDE.md`, a field-persistence regression must exercise the
 * real HTTP boundary via supertest (direct Prisma seeding bypasses the Zod
 * layer that previously stripped `vaultAppRoleRef`/`addons`). This test:
 *   1. POSTs an initial draft carrying an `addons` block + unmodeled
 *      container-config (`labels`) on services[0].
 *   2. Reads the persisted row back — this is the "existing version" the
 *      client loads and feeds through `buildDraftFromVersion`.
 *   3. POSTs a Configuration-tab-shaped save that carries `addons` +
 *      `containerConfig` forward and overlays a changed `dockerTag`/`env`
 *      (exactly what the fixed `onSubmit` produces).
 *   4. Asserts the `addons` block (and the unmodeled `labels`) survive on the
 *      resulting draft version, and that the edited field did change.
 *
 * A no-op addon is registered into `productionAddonRegistry` so the draft
 * schema's per-entry `superRefine` accepts the block. Vitest's `pool: 'forks'`
 * isolates this mutation to this file's worker.
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
      displayName: 'Config-save Addons Test Template',
      source: 'user',
      scope: 'environment',
      currentVersionId: null,
      draftVersionId: null,
    },
  });
  return templateId;
}

async function readDraftService(templateId: string) {
  const tmpl = await testPrisma.stackTemplate.findUnique({ where: { id: templateId } });
  expect(tmpl?.draftVersionId).not.toBeNull();
  const row = await testPrisma.stackTemplateService.findFirst({
    where: { versionId: tmpl!.draftVersionId! },
  });
  expect(row).not.toBeNull();
  return row!;
}

describe('Configuration-tab save preserves a service addons block (Phase 1)', () => {
  beforeAll(() => {
    if (!productionAddonRegistry.has('noop')) {
      productionAddonRegistry.register(noopAddon);
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries `addons` (and unmodeled container-config) through a config-tab-shaped save while applying the edited field', async () => {
    const templateId = await createUserTemplateRow();
    const app = buildApp();

    // 1. Initial application state — a service with an addon attached plus a
    //    container-config field (`labels`) the Configuration form never models.
    const initialBody = {
      networks: [{ name: 'app-net' }],
      volumes: [],
      services: [
        {
          serviceName: 'web',
          serviceType: 'Stateful',
          dockerImage: 'nginx',
          dockerTag: 'latest',
          containerConfig: {
            labels: { 'mini-infra.owner': 'phase-1-test' },
            joinNetworks: ['app-net'],
          },
          dependsOn: [],
          order: 0,
          addons: { noop: { label: 'phase-1' } },
        },
      ],
    };

    const initialRes = await supertest(app)
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(initialBody);
    expect(initialRes.status).toBe(200);

    // 2. Read the persisted version back — this is what the client loads and
    //    feeds through `buildDraftFromVersion` to seed a lossless overlay.
    const existing = await readDraftService(templateId);
    expect(existing.addons).toEqual({ noop: { label: 'phase-1' } });
    const existingContainerConfig =
      (existing.containerConfig as Record<string, unknown>) ?? {};

    // 3. Configuration-tab save. The fixed `onSubmit` rebuilds the draft from
    //    the existing version and overlays only the form-edited fields — the
    //    `addons` block and unmodeled `containerConfig.labels` ride along on
    //    services[0]. Here we mirror that exact shape: carry them forward and
    //    change `dockerTag` + `env` as the form would.
    const configSaveBody = {
      networks: [{ name: 'app-net' }],
      volumes: [],
      services: [
        {
          serviceName: 'web',
          serviceType: 'Stateful',
          dockerImage: 'nginx',
          dockerTag: '1.27', // edited by the form
          containerConfig: {
            ...existingContainerConfig, // preserves `labels`
            env: { FOO: 'bar' }, // edited by the form
            joinNetworks: ['app-net'],
            restartPolicy: 'unless-stopped',
          },
          dependsOn: [],
          order: 0,
          addons: existing.addons, // carried forward by buildDraftFromVersion
        },
      ],
    };

    const saveRes = await supertest(app)
      .post(`/api/stack-templates/${templateId}/draft`)
      .send(configSaveBody);
    expect(saveRes.status).toBe(200);
    expect(saveRes.body.success).toBe(true);

    // 4. The addon block survived, the unmodeled label survived, and the
    //    edited field actually changed.
    const saved = await readDraftService(templateId);
    expect(saved.addons).toEqual({ noop: { label: 'phase-1' } });
    expect(saved.dockerTag).toBe('1.27');
    const savedContainerConfig = saved.containerConfig as Record<string, unknown>;
    expect(savedContainerConfig.labels).toEqual({ 'mini-infra.owner': 'phase-1-test' });
    expect(savedContainerConfig.env).toEqual({ FOO: 'bar' });
  });
});
