/**
 * Integration coverage for the network overhaul Phase 6 membership compiler
 * + egress producer — see `services/networks/membership-compiler.ts` and
 * `services/stacks/egress-injection.ts`'s `recordEgressNetworkMemberships`.
 *
 * Drives a real `StackReconciler.apply()` (Docker mocked, DB real via
 * `testPrisma`) against a representative stack — two services, a
 * declared stack-owned network, a `joinResourceNetworks` purpose resolved
 * from a pre-seeded host-scoped `InfraResource`, a literal `joinNetworks`
 * entry, and an egress-enabled environment — then asserts every network
 * attachment the apply performed is mirrored by a `ManagedNetwork` +
 * `NetworkMembership` row with the correct `source`. Also proves the
 * compiler is idempotent (re-apply creates no duplicate rows) and that the
 * backfill converges on the same rows without inventing dangling ones.
 */
import { createId } from '@paralleldrive/cuid2';
import { StackReconciler } from '../services/stacks/stack-reconciler';
import { backfillNetworkMemberships } from '../services/networks';
import { testPrisma, createTestUser } from './integration-test-helpers';

// --- Docker mocks (mirrors stack-reconciler-apply.test.ts) ---

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

// NetworkManager talks to the raw Docker client — every network "already
// exists" so `ensure()`/`connect()` are pure no-ops here; this test is about
// the DB rows the compiler writes, not Docker network lifecycle mechanics
// (already covered by network-manager.test.ts et al).
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

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => log } as any;

interface Fixture {
  environmentId: string;
  stackId: string;
  svcAId: string;
  svcBId: string;
  vaultNetworkName: string;
  egressNetworkName: string;
  stackName: string;
  userId: string;
}

async function seedRepresentativeStack(): Promise<Fixture> {
  const user = await createTestUser();

  const environment = await testPrisma.environment.create({
    data: {
      name: `env-${createId().slice(0, 8)}`,
      type: 'nonproduction',
      networkType: 'local',
      egressGatewayIp: '10.44.0.2',
      // Egress injection now gates on this flag; enable it so the egress
      // network membership reconcile fires for this fixture.
      egressFirewallEnabled: true,
    },
  });

  const egressNetworkName = `${environment.name}-egress`;
  await testPrisma.infraResource.create({
    data: {
      type: 'docker-network',
      purpose: 'egress',
      scope: 'environment',
      environmentId: environment.id,
      name: egressNetworkName,
    },
  });

  const vaultNetworkName = 'mini-infra-vault';
  await testPrisma.infraResource.create({
    data: {
      type: 'docker-network',
      purpose: 'vault',
      scope: 'host',
      environmentId: null,
      name: vaultNetworkName,
    },
  });

  const templateId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: `phase6-app-${templateId.slice(0, 6)}`,
      displayName: 'Phase 6 membership compiler test app',
      source: 'user',
      scope: 'environment',
      createdById: user.id,
    },
  });

  const stackId = createId();
  const stackName = `phase6-${stackId.slice(0, 6)}`;
  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: stackName,
      environmentId: environment.id,
      version: 1,
      networks: [{ name: 'appnet' }],
      volumes: [],
      resourceInputs: [{ type: 'docker-network', purpose: 'vault', optional: true }],
      templateId,
      templateVersion: 1,
    },
  });

  const svcA = await testPrisma.stackService.create({
    data: {
      stackId,
      serviceName: 'api',
      serviceType: 'Stateful',
      dockerImage: 'alpine',
      dockerTag: 'latest',
      containerConfig: {
        joinNetworks: ['phase6-external-net'],
        joinResourceNetworks: ['vault'],
      },
      configFiles: [],
      initCommands: [],
      dependsOn: [],
      order: 0,
    },
  });

  const svcB = await testPrisma.stackService.create({
    data: {
      stackId,
      serviceName: 'worker',
      serviceType: 'Stateful',
      dockerImage: 'alpine',
      dockerTag: 'latest',
      containerConfig: {},
      configFiles: [],
      initCommands: [],
      dependsOn: [],
      order: 1,
    },
  });

  return {
    environmentId: environment.id,
    stackId,
    svcAId: svcA.id,
    svcBId: svcB.id,
    vaultNetworkName,
    egressNetworkName,
    stackName,
    userId: user.id,
  };
}

describe('network membership compiler (Phase 6) — integration', () => {
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

  it('applies a representative stack and mirrors every network attachment with a membership row carrying the correct source', async () => {
    const fx = await seedRepresentativeStack();
    const reconciler = new StackReconciler(mockDockerExecutor, testPrisma as any);

    const result = await reconciler.apply(fx.stackId);
    expect(result.success).toBe(true);

    const projectName = `${(await testPrisma.environment.findUniqueOrThrow({ where: { id: fx.environmentId } })).name}-${fx.stackName}`;
    const stackNetworkFullName = `${projectName}_appnet`;

    // --- ManagedNetwork rows ---
    const stackNet = await testPrisma.managedNetwork.findFirst({ where: { name: stackNetworkFullName } });
    expect(stackNet).toMatchObject({ scope: 'stack', stackId: fx.stackId, purpose: 'appnet' });

    const vaultNet = await testPrisma.managedNetwork.findFirst({ where: { name: fx.vaultNetworkName } });
    expect(vaultNet).toMatchObject({ scope: 'host', purpose: 'vault' });

    const externalNet = await testPrisma.managedNetwork.findFirst({ where: { name: 'phase6-external-net' } });
    expect(externalNet).toMatchObject({ scope: 'host', purpose: 'phase6-external-net' });

    const egressNet = await testPrisma.managedNetwork.findFirst({ where: { name: fx.egressNetworkName } });
    expect(egressNet).toMatchObject({ scope: 'environment', environmentId: fx.environmentId, purpose: 'egress' });

    // --- NetworkMembership rows: service "api" (svcA) ---
    const apiOnStackNet = await testPrisma.networkMembership.findFirst({
      where: { networkId: stackNet!.id, stackServiceId: fx.svcAId },
    });
    expect(apiOnStackNet).toMatchObject({ source: 'template' });
    expect(apiOnStackNet!.aliases).toEqual(['api']);

    const apiOnVault = await testPrisma.networkMembership.findFirst({
      where: { networkId: vaultNet!.id, stackServiceId: fx.svcAId },
    });
    expect(apiOnVault).toMatchObject({ source: 'template' });

    const apiOnExternal = await testPrisma.networkMembership.findFirst({
      where: { networkId: externalNet!.id, stackServiceId: fx.svcAId },
    });
    // Stack's template is source:'user' (an Application) — joinNetworks
    // entries carry the deliberate 'user' provenance deviation (see
    // membership-compiler.ts module doc), with createdBy = the template's
    // creator.
    expect(apiOnExternal).toMatchObject({ source: 'user', createdBy: fx.userId });

    const apiOnEgress = await testPrisma.networkMembership.findFirst({
      where: { networkId: egressNet!.id, stackServiceId: fx.svcAId },
    });
    expect(apiOnEgress).toMatchObject({ source: 'egress' });

    // --- NetworkMembership rows: service "worker" (svcB) — only stack-owned + egress, nothing declared ---
    const workerOnStackNet = await testPrisma.networkMembership.findFirst({
      where: { networkId: stackNet!.id, stackServiceId: fx.svcBId },
    });
    expect(workerOnStackNet).toMatchObject({ source: 'template' });

    const workerOnEgress = await testPrisma.networkMembership.findFirst({
      where: { networkId: egressNet!.id, stackServiceId: fx.svcBId },
    });
    expect(workerOnEgress).toMatchObject({ source: 'egress' });

    const workerOnVault = await testPrisma.networkMembership.findFirst({
      where: { networkId: vaultNet!.id, stackServiceId: fx.svcBId },
    });
    expect(workerOnVault).toBeNull();
    const workerOnExternal = await testPrisma.networkMembership.findFirst({
      where: { networkId: externalNet!.id, stackServiceId: fx.svcBId },
    });
    expect(workerOnExternal).toBeNull();

    // --- Idempotency: re-apply creates no duplicate rows ---
    const networksBefore = await testPrisma.managedNetwork.count();
    const membershipsBefore = await testPrisma.networkMembership.count();

    const secondResult = await reconciler.apply(fx.stackId);
    expect(secondResult.success).toBe(true);

    const networksAfter = await testPrisma.managedNetwork.count();
    const membershipsAfter = await testPrisma.networkMembership.count();
    expect(networksAfter).toBe(networksBefore);
    expect(membershipsAfter).toBe(membershipsBefore);

    // Re-applying must not have clobbered the 'user' provenance back to 'template'.
    const apiOnExternalAfter = await testPrisma.networkMembership.findFirst({
      where: { networkId: externalNet!.id, stackServiceId: fx.svcAId },
    });
    expect(apiOnExternalAfter).toMatchObject({ source: 'user', createdBy: fx.userId });

    // --- Backfill converges on the same rows, no duplicates, no dangling invention ---
    const backfillSummary = await backfillNetworkMemberships(mockDockerExecutor, testPrisma as any, log);
    expect(backfillSummary.managedNetworksTotal).toBe(networksAfter);
    expect(await testPrisma.networkMembership.count()).toBe(membershipsAfter);
  });
});
