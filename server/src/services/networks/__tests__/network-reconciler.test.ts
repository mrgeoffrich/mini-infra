import { reconcileStack, reconcileEnvironment, reconcileAll } from '../network-reconciler';

let selfContainerId: string | null = 'self-container-id';
vi.mock('../../self-update', () => ({
  getOwnContainerId: () => selfContainerId,
}));

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;

// ---------------------------------------------------------------------------
// Fake Prisma — generic in-memory tables with a tiny `where` matcher covering
// the query shapes network-reconciler.ts actually issues (equality + `{in:
// [...]}}`). Far simpler than a full ORM but enough to exercise the real
// query logic (filters, dedup) rather than stubbing return values per call.
// ---------------------------------------------------------------------------
function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && 'in' in (cond as object)) {
      return (cond as { in: unknown[] }).in.includes(row[key]);
    }
    return row[key] === cond;
  });
}

interface Fixtures {
  stacks?: Array<{ id: string; services: Array<{ id: string; serviceName: string; serviceType: string; adoptedContainer?: unknown }>; removedAt?: string | null }>;
  environments?: Array<{ id: string }>;
  managedNetworks?: Array<Record<string, unknown>>;
  networkMemberships?: Array<Record<string, unknown>>;
  stackServices?: Array<{ id: string; stackId: string; serviceName: string }>;
}

function makeMockPrisma(fixtures: Fixtures) {
  const stacks = fixtures.stacks ?? [];
  const environments = fixtures.environments ?? [];
  const managedNetworks = fixtures.managedNetworks ?? [];
  const networkMemberships = fixtures.networkMemberships ?? [];
  // `prisma.stackService.findMany` is a real, independent table in
  // production — auto-derive its fixture rows from `stacks[].services`
  // (adding `stackId`) unless the test explicitly overrides it, so every
  // test doesn't have to declare the same services twice.
  const stackServices = fixtures.stackServices ?? stacks.flatMap((s) =>
    s.services.map((svc) => ({ id: svc.id, stackId: s.id, serviceName: svc.serviceName })),
  );

  return {
    stack: {
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const found = stacks.find((s) => s.id === where.id);
        if (!found) throw new Error(`stack ${where.id} not found`);
        return found;
      }),
      findMany: vi.fn(async ({ where }: any) => stacks.filter((s) => matches(s as any, where))),
    },
    environment: {
      findMany: vi.fn(async () => environments),
    },
    managedNetwork: {
      findMany: vi.fn(async ({ where }: any) => managedNetworks.filter((n) => matches(n, where))),
    },
    networkMembership: {
      findMany: vi.fn(async ({ where }: any) => networkMemberships.filter((m) => matches(m, where))),
    },
    stackService: {
      findMany: vi.fn(async ({ where }: any) => stackServices.filter((s) => matches(s as any, where))),
    },
  } as any;
}

function net(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'net-1',
    scope: 'stack',
    environmentId: null,
    stackId: 'stack-1',
    purpose: 'default',
    name: 'stack-1-project_default',
    driver: 'bridge',
    options: null,
    ...overrides,
  };
}

function membership(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: `member-${Math.random()}`,
    networkId: 'net-1',
    stackServiceId: null,
    containerName: null,
    ...overrides,
  };
}

function containerInfo(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    Id: 'container-1',
    Names: ['/container-1'],
    Labels: {},
    ...overrides,
  };
}

function makeDockerExecutor(listContainersImpl: (opts: any) => any[]) {
  const listContainers = vi.fn(async (opts: any) => listContainersImpl(opts));
  return { getDockerClient: () => ({ listContainers }) };
}

function makeNetworkManager(inspectImpl: (name: string) => any) {
  return { inspectForReconcile: vi.fn(async (name: string) => inspectImpl(name)) } as any;
}

describe('reconcileStack', () => {
  it('reports network-missing when a stack-owned network does not exist in Docker', async () => {
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', services: [{ id: 'svc-1', serviceName: 'api', serviceType: 'Stateful' }] }],
      managedNetworks: [net()],
      networkMemberships: [membership({ networkId: 'net-1', stackServiceId: 'svc-1' })],
    });
    const networkManager = makeNetworkManager(() => ({ existence: 'absent' }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([
      expect.objectContaining({ type: 'network-missing', networkName: 'stack-1-project_default', managedNetworkId: 'net-1' }),
    ]);
  });

  it('reports membership-missing when the resolved live container for a service is not attached', async () => {
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', services: [{ id: 'svc-1', serviceName: 'api', serviceType: 'Stateful' }] }],
      managedNetworks: [net()],
      networkMemberships: [membership({ networkId: 'net-1', stackServiceId: 'svc-1' })],
    });
    const networkManager = makeNetworkManager(() => ({
      existence: 'present',
      connectedContainers: [], // the service's container is NOT attached
    }));
    const dockerExecutor = makeDockerExecutor(() => [
      containerInfo({ Id: 'c-api', Names: ['/c-api'], Labels: { 'mini-infra.stack-id': 'stack-1', 'mini-infra.service': 'api' } }),
    ]);

    const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([
      expect.objectContaining({
        type: 'membership-missing',
        target: expect.objectContaining({ stackServiceId: 'svc-1', serviceName: 'api' }),
        containers: [{ id: 'c-api', name: 'c-api' }],
      }),
    ]);
  });

  it('is a no-op when the resolved container IS attached', async () => {
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', services: [{ id: 'svc-1', serviceName: 'api', serviceType: 'Stateful' }] }],
      managedNetworks: [net()],
      networkMemberships: [membership({ networkId: 'net-1', stackServiceId: 'svc-1' })],
    });
    const networkManager = makeNetworkManager(() => ({
      existence: 'present',
      connectedContainers: [{ id: 'c-api', name: 'c-api' }],
    }));
    const dockerExecutor = makeDockerExecutor(() => [
      containerInfo({ Id: 'c-api', Names: ['/c-api'], Labels: { 'mini-infra.stack-id': 'stack-1', 'mini-infra.service': 'api' } }),
    ]);

    const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([]);
    expect(report.notes).toEqual([]);
  });

  it('skips membership check entirely when the service has no live container yet (not yet deployed)', async () => {
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', services: [{ id: 'svc-1', serviceName: 'api', serviceType: 'Stateful' }] }],
      managedNetworks: [net()],
      networkMemberships: [membership({ networkId: 'net-1', stackServiceId: 'svc-1' })],
    });
    const networkManager = makeNetworkManager(() => ({ existence: 'present', connectedContainers: [] }));
    const dockerExecutor = makeDockerExecutor(() => []); // no containers at all — service never deployed.

    const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([]);
  });

  it('sweeps up every pool worker for a single Pool-service stackServiceId membership (blue-green/pool resolution)', async () => {
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', services: [{ id: 'svc-pool', serviceName: 'worker', serviceType: 'Pool' }] }],
      managedNetworks: [net()],
      networkMemberships: [membership({ networkId: 'net-1', stackServiceId: 'svc-pool' })],
    });
    const networkManager = makeNetworkManager(() => ({
      existence: 'present',
      connectedContainers: [{ id: 'worker-1', name: 'worker-1' }], // only one of two workers attached
    }));
    const dockerExecutor = makeDockerExecutor(() => [
      containerInfo({
        Id: 'worker-1', Names: ['/worker-1'],
        Labels: { 'mini-infra.stack-id': 'stack-1', 'mini-infra.service': 'worker', 'mini-infra.pool-instance': 'true' },
      }),
      containerInfo({
        Id: 'worker-2', Names: ['/worker-2'],
        Labels: { 'mini-infra.stack-id': 'stack-1', 'mini-infra.service': 'worker', 'mini-infra.pool-instance': 'true' },
      }),
    ]);

    const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

    // Both pool workers resolved for the one stackServiceId row; only the
    // unattached one (worker-2) is reported missing.
    expect(report.items).toEqual([
      expect.objectContaining({ type: 'membership-missing', containers: [{ id: 'worker-2', name: 'worker-2' }] }),
    ]);
  });

  it('resolves a blue-green pair (two containers sharing the same service label) and flags only the unattached one', async () => {
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', services: [{ id: 'svc-web', serviceName: 'web', serviceType: 'StatelessWeb' }] }],
      managedNetworks: [net()],
      networkMemberships: [membership({ networkId: 'net-1', stackServiceId: 'svc-web' })],
    });
    const networkManager = makeNetworkManager(() => ({
      existence: 'present',
      connectedContainers: [{ id: 'web-blue', name: 'web-blue' }],
    }));
    const dockerExecutor = makeDockerExecutor(() => [
      containerInfo({ Id: 'web-blue', Names: ['/web-blue'], Labels: { 'mini-infra.stack-id': 'stack-1', 'mini-infra.service': 'web' } }),
      containerInfo({ Id: 'web-green', Names: ['/web-green'], Labels: { 'mini-infra.stack-id': 'stack-1', 'mini-infra.service': 'web' } }),
    ]);

    const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([
      expect.objectContaining({ type: 'membership-missing', containers: [{ id: 'web-green', name: 'web-green' }] }),
    ]);
  });

  it('reports spec-mismatch when the network exists but its spec differs', async () => {
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', services: [] }],
      managedNetworks: [net()],
      networkMemberships: [],
    });
    const networkManager = makeNetworkManager(() => ({
      existence: 'present',
      connectedContainers: [],
      mismatch: { driver: { expected: 'bridge', actual: 'host' } },
    }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([expect.objectContaining({ type: 'spec-mismatch' })]);
  });

  it('never reports spec-mismatch for a LABEL-only difference (found live in dev: stack-owned networks are labelled mini-infra.purpose=_stack regardless of the network\'s own name, so a naive comparison against the DB\'s per-network purpose value spuriously "mismatches" on every multi-network stack)', async () => {
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', services: [] }],
      managedNetworks: [net({ purpose: 'appnet' })],
      networkMemberships: [],
    });
    const networkManager = makeNetworkManager(() => ({
      existence: 'present',
      connectedContainers: [],
      mismatch: {
        labels: {
          expected: { 'mini-infra.purpose': 'appnet' },
          actual: { 'mini-infra.purpose': '_stack' },
          missing: [],
          changed: ['mini-infra.purpose'],
        },
      },
    }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([]);
  });

  it('never reports spec-mismatch for a legacy pre-Phase-1 network whose only difference is missing mini-infra.* labels (found live in dev on an environment egress network created before the labelling convention existed — permanent and unfixable-by-the-operator, not real drift)', async () => {
    const prisma = makeMockPrisma({
      managedNetworks: [net({ id: 'net-egress', scope: 'environment', environmentId: 'env-1', stackId: null, purpose: 'egress', name: 'env-1-egress' })],
      networkMemberships: [],
    });
    const networkManager = makeNetworkManager(() => ({
      existence: 'present',
      connectedContainers: [],
      mismatch: {
        labels: {
          expected: { 'mini-infra.managed': 'true', 'mini-infra.owner-kind': 'environment', 'mini-infra.purpose': 'egress' },
          actual: { 'mini-infra.managed': 'true', 'mini-infra.infra-resource': 'true', 'mini-infra.resource-purpose': 'egress' },
          missing: ['mini-infra.owner-kind', 'mini-infra.purpose'],
          changed: [],
        },
      },
    }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const report = await reconcileEnvironment('env-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([]);
  });

  it('still reports spec-mismatch when driver or options genuinely differ, even alongside a label difference', async () => {
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', services: [] }],
      managedNetworks: [net()],
      networkMemberships: [],
    });
    const networkManager = makeNetworkManager(() => ({
      existence: 'present',
      connectedContainers: [],
      mismatch: {
        driver: { expected: 'bridge', actual: 'host' },
        labels: { expected: {}, actual: {}, missing: [], changed: ['mini-infra.purpose'] },
      },
    }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([
      expect.objectContaining({ type: 'spec-mismatch', mismatch: { driver: { expected: 'bridge', actual: 'host' }, options: undefined } }),
    ]);
  });

  it('resolves an AdoptedWeb containerName target via an exact by-name lookup', async () => {
    const prisma = makeMockPrisma({
      stacks: [{
        id: 'stack-1',
        services: [{ id: 'svc-legacy', serviceName: 'legacy', serviceType: 'AdoptedWeb', adoptedContainer: { containerName: 'legacy-app', listeningPort: 80 } }],
      }],
      managedNetworks: [net({ scope: 'environment', environmentId: 'env-1', stackId: null, purpose: 'applications', name: 'env-1-applications' })],
      networkMemberships: [membership({ networkId: 'net-1', containerName: 'legacy-app' })],
    });
    const networkManager = makeNetworkManager(() => ({ existence: 'present', connectedContainers: [] }));
    const dockerExecutor = makeDockerExecutor((opts: any) => {
      if (opts.filters?.name?.includes('legacy-app')) {
        return [containerInfo({ Id: 'legacy-id', Names: ['/legacy-app'] })];
      }
      return [];
    });

    const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([
      expect.objectContaining({
        type: 'membership-missing',
        target: expect.objectContaining({ containerName: 'legacy-app' }),
        containers: [{ id: 'legacy-id', name: 'legacy-app' }],
      }),
    ]);
  });

  it('resolves the "self" sentinel via getOwnContainerId()', async () => {
    selfContainerId = 'self-container-id';
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', services: [] }],
      managedNetworks: [net()],
      networkMemberships: [membership({ networkId: 'net-1', containerName: 'self' })],
    });
    const networkManager = makeNetworkManager(() => ({ existence: 'present', connectedContainers: [] }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([
      expect.objectContaining({ type: 'membership-missing', containers: [{ id: 'self-container-id', name: 'self' }] }),
    ]);
  });

  it('skips the "self" check entirely when getOwnContainerId() cannot resolve (not running as a container)', async () => {
    selfContainerId = null;
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', services: [] }],
      managedNetworks: [net()],
      networkMemberships: [membership({ networkId: 'net-1', containerName: 'self' })],
    });
    const networkManager = makeNetworkManager(() => ({ existence: 'present', connectedContainers: [] }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([]);
    selfContainerId = 'self-container-id';
  });

  it('skips reporting entirely when Docker existence cannot be confirmed (unknown, not absent)', async () => {
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', services: [] }],
      managedNetworks: [net()],
      networkMemberships: [],
    });
    const networkManager = makeNetworkManager(() => ({ existence: 'unknown' }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([]);
  });

  describe('conservative membership-stale rule', () => {
    it('flags membership-stale ONLY for a real, non-synthetic container of this stack attached to its own owned network with no matching row', async () => {
      const prisma = makeMockPrisma({
        stacks: [{ id: 'stack-1', services: [] }], // no declared services/memberships at all
        managedNetworks: [net()],
        networkMemberships: [],
      });
      const networkManager = makeNetworkManager(() => ({
        existence: 'present',
        connectedContainers: [{ id: 'mystery-1', name: 'mystery-container' }],
      }));
      const dockerExecutor = makeDockerExecutor(() => [
        containerInfo({ Id: 'mystery-1', Names: ['/mystery-container'], Labels: { 'mini-infra.stack-id': 'stack-1', 'mini-infra.service': 'orphaned' } }),
      ]);

      const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

      expect(report.items).toEqual([
        expect.objectContaining({ type: 'membership-stale', containers: [{ id: 'mystery-1', name: 'mystery-container' }] }),
      ]);
      expect(report.notes).toEqual([]);
    });

    it('never flags a synthetic (addon/pool-addon sidecar) container as stale — not even as a note (gap 1)', async () => {
      const prisma = makeMockPrisma({
        stacks: [{ id: 'stack-1', services: [] }],
        managedNetworks: [net()],
        networkMemberships: [],
      });
      const networkManager = makeNetworkManager(() => ({
        existence: 'present',
        connectedContainers: [{ id: 'sidecar-1', name: 'app-tailscale' }],
      }));
      const dockerExecutor = makeDockerExecutor(() => [
        containerInfo({
          Id: 'sidecar-1', Names: ['/app-tailscale'],
          Labels: { 'mini-infra.stack-id': 'stack-1', 'mini-infra.service': 'app-tailscale', 'mini-infra.synthetic': 'true' },
        }),
      ]);

      const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

      expect(report.items).toEqual([]);
      expect(report.notes).toEqual([]);
    });

    it('demotes an unexplained attachment from a container NOT carrying this stack\'s own labels to a low-confidence note, never membership-stale', async () => {
      const prisma = makeMockPrisma({
        stacks: [{ id: 'stack-1', services: [] }],
        managedNetworks: [net()],
        networkMemberships: [],
      });
      const networkManager = makeNetworkManager(() => ({
        existence: 'present',
        connectedContainers: [{ id: 'foreign-1', name: 'foreign-container' }],
      }));
      // The stack-id-scoped listContainers query legitimately returns nothing —
      // this container doesn't carry stack-1's own label at all.
      const dockerExecutor = makeDockerExecutor(() => []);

      const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

      expect(report.items).toEqual([]);
      expect(report.notes).toEqual([
        expect.objectContaining({ containerId: 'foreign-1', containerName: 'foreign-container' }),
      ]);
    });

    it('never flags membership-stale on a shared (non-owned) network the stack merely joins', async () => {
      const sharedNet = net({ id: 'net-shared', scope: 'environment', environmentId: 'env-1', stackId: null, purpose: 'applications', name: 'env-1-applications' });
      const prisma = makeMockPrisma({
        stacks: [{ id: 'stack-1', services: [{ id: 'svc-1', serviceName: 'api', serviceType: 'Stateful' }] }],
        managedNetworks: [sharedNet],
        networkMemberships: [membership({ networkId: 'net-shared', stackServiceId: 'svc-1' })],
      });
      const networkManager = makeNetworkManager(() => ({
        existence: 'present',
        // A container from stack-1 itself, resolved via the stack-id label
        // query, but attached with no matching row — even so, since the
        // network isn't OWNED by stack-1, this must never become
        // membership-stale.
        connectedContainers: [{ id: 'c-api', name: 'c-api' }, { id: 'c-other', name: 'c-other' }],
      }));
      const dockerExecutor = makeDockerExecutor(() => [
        containerInfo({ Id: 'c-api', Names: ['/c-api'], Labels: { 'mini-infra.stack-id': 'stack-1', 'mini-infra.service': 'api' } }),
        containerInfo({ Id: 'c-other', Names: ['/c-other'], Labels: { 'mini-infra.stack-id': 'stack-1', 'mini-infra.service': 'unrelated-extra' } }),
      ]);

      const report = await reconcileStack('stack-1', { prisma, networkManager, dockerExecutor, log });

      expect(report.items.filter((i) => i.type === 'membership-stale')).toEqual([]);
      expect(report.notes).toEqual([
        expect.objectContaining({ containerId: 'c-other' }),
      ]);
    });
  });
});

describe('reconcileEnvironment', () => {
  it('never computes membership-stale for an environment-scoped network — unexplained attachments are notes only', async () => {
    const prisma = makeMockPrisma({
      managedNetworks: [net({ scope: 'environment', environmentId: 'env-1', stackId: null, purpose: 'egress', name: 'env-1-egress' })],
      networkMemberships: [],
    });
    const networkManager = makeNetworkManager(() => ({
      existence: 'present',
      connectedContainers: [{ id: 'gateway-1', name: 'env-1-egress-gateway' }],
    }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const report = await reconcileEnvironment('env-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([]);
    expect(report.notes).toEqual([expect.objectContaining({ containerId: 'gateway-1' })]);
  });

  it('reports network-missing for an environment-owned network that no longer exists', async () => {
    const prisma = makeMockPrisma({
      managedNetworks: [net({ scope: 'environment', environmentId: 'env-1', stackId: null, purpose: 'egress', name: 'env-1-egress' })],
      networkMemberships: [],
    });
    const networkManager = makeNetworkManager(() => ({ existence: 'absent' }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const report = await reconcileEnvironment('env-1', { prisma, networkManager, dockerExecutor, log });

    expect(report.items).toEqual([expect.objectContaining({ type: 'network-missing' })]);
  });

  it('returns an empty report when the environment owns no networks', async () => {
    const prisma = makeMockPrisma({ managedNetworks: [] });
    const networkManager = makeNetworkManager(() => ({ existence: 'present', connectedContainers: [] }));
    const dockerExecutor = makeDockerExecutor(() => []);

    const report = await reconcileEnvironment('env-1', { prisma, networkManager, dockerExecutor, log });

    expect(report).toMatchObject({ networksChecked: 0, membershipsChecked: 0, items: [], notes: [] });
  });
});

describe('reconcileAll', () => {
  it('aggregates drift across every stack, every environment, and host-scoped networks', async () => {
    const prisma = makeMockPrisma({
      stacks: [{ id: 'stack-1', services: [], removedAt: null }],
      environments: [{ id: 'env-1' }],
      managedNetworks: [
        net({ id: 'net-stack', scope: 'stack', stackId: 'stack-1', environmentId: null }),
        net({ id: 'net-env', scope: 'environment', stackId: null, environmentId: 'env-1', purpose: 'egress', name: 'env-1-egress' }),
        net({ id: 'net-host', scope: 'host', stackId: null, environmentId: null, purpose: 'vault', name: 'mini-infra-vault' }),
      ],
      networkMemberships: [],
    });
    const networkManager = makeNetworkManager((name: string) => {
      if (name === 'mini-infra-vault') return { existence: 'absent' };
      return { existence: 'present', connectedContainers: [] };
    });
    const dockerExecutor = makeDockerExecutor(() => []);

    const report = await reconcileAll({ prisma, networkManager, dockerExecutor, log });

    expect(report.scope).toEqual({ kind: 'all' });
    expect(report.networksChecked).toBe(3);
    expect(report.items).toEqual([expect.objectContaining({ type: 'network-missing', networkName: 'mini-infra-vault' })]);
  });
});
