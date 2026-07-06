/**
 * Equivalence test for the network overhaul Phase 10 unified `networks[]`
 * declaration (`server/src/services/networks/unified-network-declarations.ts`).
 *
 * Phase 10's whole premise is that the unified shape is reader-side sugar —
 * translated to the exact legacy shapes at the authoring boundary so the
 * rest of the pipeline (membership-compiler, StackReconciler,
 * attachServiceNetworks) can't tell which shape was authored. This test
 * proves that two templates — one authored with the legacy fields, one with
 * the unified shape, describing the same desired state — produce:
 *
 *  1. The same normalized `StackTemplateVersion`/`StackTemplateService` rows
 *     (via the real `POST /api/stack-templates` HTTP route, per
 *     server/CLAUDE.md's "field-persistence tests go through the route").
 *  2. The same `ManagedNetwork`/`NetworkMembership` rows after a real
 *     `StackReconciler.apply()` (Docker mocked, DB real).
 *
 * Both templates are host-scoped (no environment) so the equivalence check
 * doesn't need an Environment fixture: `resourceOutputs` purposes resolve to
 * a single global `mini-infra-<purpose>` network either way.
 */
import supertest from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createId } from '@paralleldrive/cuid2';
import { testPrisma } from './integration-test-helpers';
import { StackReconciler } from '../services/stacks/stack-reconciler';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

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

// ─── Docker mocks (mirrors network-membership-compiler.integration.test.ts) ──

const mockContainerStart = vi.fn().mockResolvedValue(undefined);
const mockContainerStop = vi.fn().mockResolvedValue(undefined);
const mockContainerRemove = vi.fn().mockResolvedValue(undefined);
const mockContainerInspect = vi.fn().mockResolvedValue({
  Config: { Healthcheck: null },
  State: { Status: 'running', Health: null },
});
const mockCreateContainer = vi.fn().mockResolvedValue({
  id: 'init-container-id',
  start: mockContainerStart,
  wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
  remove: mockContainerRemove,
});
const mockGetContainer = vi.fn().mockReturnValue({
  start: mockContainerStart,
  stop: mockContainerStop,
  remove: mockContainerRemove,
  inspect: mockContainerInspect,
});
const mockPullImageWithAutoAuth = vi.fn().mockResolvedValue(undefined);
const mockVolumeExists = vi.fn().mockResolvedValue(true);
const mockCreateVolume = vi.fn().mockResolvedValue(undefined);
const mockGetContainerStatus = vi.fn().mockResolvedValue({ status: 'running', running: true });

const mockNetworkInspect = vi.fn().mockResolvedValue({
  Name: 'existing-network',
  Driver: 'bridge',
  Labels: {},
  Options: {},
  Containers: {},
});
const mockGetNetwork = vi.fn().mockReturnValue({
  inspect: mockNetworkInspect,
  connect: vi.fn().mockResolvedValue(undefined),
});
const mockDockerCreateNetwork = vi.fn().mockResolvedValue({ id: 'net-id' });

const mockListContainers = vi.fn().mockResolvedValue([]);

const mockLongRunningContainer = { id: 'new-container-id', start: vi.fn().mockResolvedValue(undefined) };
const mockCreateLongRunningContainer = vi.fn().mockResolvedValue(mockLongRunningContainer);

const mockDockerExecutor = {
  getDockerClient: () => ({
    listContainers: mockListContainers,
    createContainer: mockCreateContainer,
    getContainer: mockGetContainer,
    getNetwork: mockGetNetwork,
    createNetwork: mockDockerCreateNetwork,
  }),
  pullImageWithAutoAuth: mockPullImageWithAutoAuth,
  createLongRunningContainer: mockCreateLongRunningContainer,
  getContainerStatus: mockGetContainerStatus,
  volumeExists: mockVolumeExists,
  createVolume: mockCreateVolume,
  initialize: vi.fn().mockResolvedValue(undefined),
} as any;

// ─── Fixture builders ─────────────────────────────────────────────────────────

const baseServiceFields = {
  serviceType: 'Stateful' as const,
  dockerImage: 'alpine',
  dockerTag: 'latest',
  dependsOn: [] as string[],
};

function legacyTemplateBody(name: string) {
  return {
    name,
    displayName: 'Equivalence — legacy fields',
    scope: 'host',
    networks: [{ name: 'default' }],
    resourceOutputs: [{ type: 'docker-network', purpose: 'shared' }],
    volumes: [],
    services: [
      { ...baseServiceFields, serviceName: 'api', containerConfig: {}, order: 0 },
      {
        ...baseServiceFields,
        serviceName: 'worker',
        containerConfig: { joinResourceNetworks: ['shared'] },
        order: 1,
      },
    ],
  };
}

function unifiedTemplateBody(name: string) {
  return {
    name,
    displayName: 'Equivalence — unified shape',
    scope: 'host',
    networks: [{ purpose: 'default' }, { purpose: 'shared', scope: 'host' }],
    volumes: [],
    services: [
      { ...baseServiceFields, serviceName: 'api', containerConfig: {}, networks: ['default'], order: 0 },
      { ...baseServiceFields, serviceName: 'worker', containerConfig: {}, networks: ['shared'], order: 1 },
    ],
  };
}

interface CreatedTemplate {
  templateId: string;
  versionId: string;
}

async function createPublishInstantiate(app: express.Express, body: unknown): Promise<{ template: CreatedTemplate; stackId: string }> {
  const createRes = await supertest(app).post('/api/stack-templates').send(body);
  expect(createRes.status).toBe(201);
  const templateId = createRes.body.data.id as string;

  const tmpl = await testPrisma.stackTemplate.findUniqueOrThrow({ where: { id: templateId } });
  const versionId = tmpl.draftVersionId as string;
  expect(versionId).toBeTruthy();

  const publishRes = await supertest(app).post(`/api/stack-templates/${templateId}/publish`).send({});
  expect(publishRes.status).toBe(200);

  const instantiateRes = await supertest(app)
    .post(`/api/stack-templates/${templateId}/instantiate`)
    .send({});
  expect(instantiateRes.status).toBe(201);

  return { template: { templateId, versionId }, stackId: instantiateRes.body.data.id as string };
}

// Deep-clone with the given keys stripped at every array-of-objects leaf we
// care about — used to strip identity fields (id/timestamps/versionId) that
// are legitimately different between the two templates before comparing.
function serviceShape(svc: { serviceName: string; serviceType: string; containerConfig: unknown }) {
  return {
    serviceName: svc.serviceName,
    serviceType: svc.serviceType,
    containerConfig: svc.containerConfig,
  };
}

describe('unified network declaration (Phase 10) — equivalence with legacy fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContainerInspect.mockResolvedValue({
      Config: { Healthcheck: null },
      State: { Status: 'running', Health: null },
    });
    mockListContainers.mockResolvedValue([]);
    mockNetworkInspect.mockResolvedValue({
      Name: 'existing-network', Driver: 'bridge', Labels: {}, Options: {}, Containers: {},
    });
  });

  it('normalizes to the same StackTemplateVersion/StackTemplateService shape as the legacy-field equivalent', async () => {
    const app = buildApp();
    const suffix = createId().slice(0, 8);

    const legacy = await createPublishInstantiate(app, legacyTemplateBody(`equiv-legacy-${suffix}`));
    const unified = await createPublishInstantiate(app, unifiedTemplateBody(`equiv-unified-${suffix}`));

    const legacyVersion = await testPrisma.stackTemplateVersion.findUniqueOrThrow({
      where: { id: legacy.template.versionId },
    });
    const unifiedVersion = await testPrisma.stackTemplateVersion.findUniqueOrThrow({
      where: { id: unified.template.versionId },
    });

    // Same stack-owned networks[] and resourceOutputs[] — the unified
    // `{purpose, scope}` shape must have translated to the identical legacy
    // `StackNetwork`/`StackResourceOutput` shape.
    expect(unifiedVersion.networks).toEqual(legacyVersion.networks);
    expect(unifiedVersion.networks).toEqual([{ name: 'default' }]);
    expect(unifiedVersion.resourceOutputs).toEqual(legacyVersion.resourceOutputs);
    expect(unifiedVersion.resourceOutputs).toEqual([{ type: 'docker-network', purpose: 'shared' }]);
    expect(unifiedVersion.resourceInputs).toEqual(legacyVersion.resourceInputs);

    const legacyServices = await testPrisma.stackTemplateService.findMany({
      where: { versionId: legacy.template.versionId },
      orderBy: { order: 'asc' },
    });
    const unifiedServices = await testPrisma.stackTemplateService.findMany({
      where: { versionId: unified.template.versionId },
      orderBy: { order: 'asc' },
    });

    expect(unifiedServices.map(serviceShape)).toEqual(legacyServices.map(serviceShape));
    // Pin the exact expected shape too, not just cross-equality — a bug that
    // made both sides wrong the same way would otherwise slip through.
    expect(unifiedServices.map(serviceShape)).toEqual([
      { serviceName: 'api', serviceType: 'Stateful', containerConfig: {} },
      { serviceName: 'worker', serviceType: 'Stateful', containerConfig: { joinResourceNetworks: ['shared'] } },
    ]);

    // The unified per-service `networks` sugar is authoring-time-only — it
    // must never reach the stored containerConfig.
    for (const svc of unifiedServices) {
      expect((svc.containerConfig as Record<string, unknown>).networks).toBeUndefined();
    }
  });

  it('produces the same ManagedNetwork + NetworkMembership rows after apply as the legacy-field equivalent', async () => {
    const app = buildApp();
    const suffix = createId().slice(0, 8);

    const legacy = await createPublishInstantiate(app, legacyTemplateBody(`equiv-legacy-apply-${suffix}`));
    const unified = await createPublishInstantiate(app, unifiedTemplateBody(`equiv-unified-apply-${suffix}`));

    const reconciler = new StackReconciler(mockDockerExecutor, testPrisma as any);
    const legacyApply = await reconciler.apply(legacy.stackId);
    expect(legacyApply.success).toBe(true);
    const unifiedApply = await reconciler.apply(unified.stackId);
    expect(unifiedApply.success).toBe(true);

    async function stackServiceId(stackId: string, serviceName: string): Promise<string> {
      const row = await testPrisma.stackService.findFirstOrThrow({ where: { stackId, serviceName } });
      return row.id;
    }

    const legacyApiId = await stackServiceId(legacy.stackId, 'api');
    const legacyWorkerId = await stackServiceId(legacy.stackId, 'worker');
    const unifiedApiId = await stackServiceId(unified.stackId, 'api');
    const unifiedWorkerId = await stackServiceId(unified.stackId, 'worker');

    // --- Stack-owned 'default' network: same shape, different (per-stack) name ---
    const legacyStackNet = await testPrisma.managedNetwork.findFirstOrThrow({
      where: { stackId: legacy.stackId, purpose: 'default' },
    });
    const unifiedStackNet = await testPrisma.managedNetwork.findFirstOrThrow({
      where: { stackId: unified.stackId, purpose: 'default' },
    });
    expect(unifiedStackNet).toMatchObject({ scope: 'stack', purpose: 'default' });
    expect(legacyStackNet).toMatchObject({ scope: 'stack', purpose: 'default' });

    for (const [apiId, workerId, stackNet] of [
      [legacyApiId, legacyWorkerId, legacyStackNet],
      [unifiedApiId, unifiedWorkerId, unifiedStackNet],
    ] as const) {
      const apiMembership = await testPrisma.networkMembership.findFirst({
        where: { networkId: stackNet.id, stackServiceId: apiId },
      });
      expect(apiMembership).toMatchObject({ source: 'template', aliases: ['api'] });
      const workerMembership = await testPrisma.networkMembership.findFirst({
        where: { networkId: stackNet.id, stackServiceId: workerId },
      });
      expect(workerMembership).toMatchObject({ source: 'template', aliases: ['worker'] });
    }

    // --- 'shared' resourceOutput network: host-scoped, so BOTH stacks
    // resolve to the very same ManagedNetwork row (mini-infra-shared) ---
    const sharedNets = await testPrisma.managedNetwork.findMany({ where: { purpose: 'shared', scope: 'host' } });
    expect(sharedNets).toHaveLength(1);
    const sharedNet = sharedNets[0];
    expect(sharedNet.name).toBe('mini-infra-shared');

    const legacyWorkerOnShared = await testPrisma.networkMembership.findFirst({
      where: { networkId: sharedNet.id, stackServiceId: legacyWorkerId },
    });
    const unifiedWorkerOnShared = await testPrisma.networkMembership.findFirst({
      where: { networkId: sharedNet.id, stackServiceId: unifiedWorkerId },
    });
    expect(legacyWorkerOnShared).toMatchObject({ source: 'template' });
    expect(unifiedWorkerOnShared).toMatchObject({ source: 'template' });
    expect(unifiedWorkerOnShared!.aliases).toEqual(legacyWorkerOnShared!.aliases);

    // 'api' never declared 'shared' on either side — no membership either way.
    const legacyApiOnShared = await testPrisma.networkMembership.findFirst({
      where: { networkId: sharedNet.id, stackServiceId: legacyApiId },
    });
    const unifiedApiOnShared = await testPrisma.networkMembership.findFirst({
      where: { networkId: sharedNet.id, stackServiceId: unifiedApiId },
    });
    expect(legacyApiOnShared).toBeNull();
    expect(unifiedApiOnShared).toBeNull();
  });
});
