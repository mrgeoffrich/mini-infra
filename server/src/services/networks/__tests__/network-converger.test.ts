import { applyConvergence, convergeContainer } from '../network-converger';
import type { NetworkReconcileReport } from '@mini-infra/types';

let selfContainerId: string | null = null;
vi.mock('../../self-update', () => ({
  getOwnContainerId: () => selfContainerId,
}));

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;

function net(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'net-1',
    scope: 'stack',
    environmentId: null,
    stackId: 'stack-1',
    purpose: 'default',
    name: 'proj_default',
    driver: 'bridge',
    options: null,
    enforceMemberships: false,
    ...overrides,
  };
}

function makeFakeNetworkManager(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ensure: vi.fn().mockResolvedValue({ name: 'x', created: true, existence: 'present' }),
    connect: vi.fn().mockResolvedValue({ connected: true, alreadyConnected: false }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function makeFakePrisma(opts: { networks?: Array<Record<string, unknown>>; memberships?: Array<Record<string, unknown>> } = {}) {
  const networks = opts.networks ?? [];
  const memberships = opts.memberships ?? [];
  return {
    managedNetwork: {
      findMany: vi.fn(async ({ where }: any) => networks.filter((n) => where.id.in.includes(n.id))),
    },
    networkMembership: {
      findMany: vi.fn(async ({ where }: any) => memberships.filter((m) => where.networkId.in.includes(m.networkId))),
    },
  } as any;
}

function makeFakeDockerExecutor(inspectImpl?: (id: string) => any) {
  const inspect = vi.fn(async (id: string) => (inspectImpl ? inspectImpl(id) : { State: { StartedAt: new Date(0).toISOString() }, Created: new Date(0).toISOString() }));
  const getContainer = vi.fn((id: string) => ({ inspect: () => inspect(id) }));
  return { getDockerClient: () => ({ getContainer }) } as any;
}

function report(items: NetworkReconcileReport['items'], scopeOverrides: Partial<NetworkReconcileReport['scope']> = {}): NetworkReconcileReport {
  return {
    scope: { kind: 'stack', stackId: 'stack-1', ...scopeOverrides },
    ranAt: new Date().toISOString(),
    networksChecked: 1,
    membershipsChecked: 1,
    items,
    notes: [],
  };
}

describe('applyConvergence', () => {
  it('ensures a missing network (network-missing → NetworkManager.ensure())', async () => {
    const networkManager = makeFakeNetworkManager();
    const prisma = makeFakePrisma({ networks: [net()] });
    const dockerExecutor = makeFakeDockerExecutor();

    const result = await applyConvergence(
      report([{ type: 'network-missing', networkName: 'proj_default', purpose: 'default', scope: 'stack', managedNetworkId: 'net-1', message: 'x' }]),
      { prisma, networkManager, dockerExecutor, log },
    );

    expect(networkManager.ensure).toHaveBeenCalledWith(expect.objectContaining({ name: 'proj_default' }));
    expect(result.networksEnsured).toBe(1);
    expect(result.networksCreated).toBe(1);
  });

  it('connects every missing container for a membership-missing item — not just the first (blue-green / pool worker sets)', async () => {
    const networkManager = makeFakeNetworkManager();
    const prisma = makeFakePrisma({
      networks: [net()],
      memberships: [{ networkId: 'net-1', stackServiceId: 'svc-pool', containerName: null, aliases: null, staticIp: null }],
    });
    const dockerExecutor = makeFakeDockerExecutor();

    const result = await applyConvergence(
      report([{
        type: 'membership-missing',
        networkName: 'proj_default',
        purpose: 'default',
        scope: 'stack',
        managedNetworkId: 'net-1',
        target: { stackServiceId: 'svc-pool', serviceName: 'worker' },
        containers: [{ id: 'worker-1', name: 'worker-1' }, { id: 'worker-2', name: 'worker-2' }],
        message: 'x',
      }]),
      { prisma, networkManager, dockerExecutor, log },
    );

    expect(networkManager.connect).toHaveBeenCalledTimes(2);
    expect(networkManager.connect).toHaveBeenCalledWith('worker-1', 'proj_default', expect.any(Object));
    expect(networkManager.connect).toHaveBeenCalledWith('worker-2', 'proj_default', expect.any(Object));
    expect(result.membershipsConnected).toBe(2);
  });

  it('passes the membership row\'s aliases/staticIp through to connect()', async () => {
    const networkManager = makeFakeNetworkManager();
    const prisma = makeFakePrisma({
      networks: [net()],
      memberships: [{ networkId: 'net-1', stackServiceId: 'svc-1', containerName: null, aliases: ['api'], staticIp: '10.0.0.5' }],
    });
    const dockerExecutor = makeFakeDockerExecutor();

    await applyConvergence(
      report([{
        type: 'membership-missing', networkName: 'proj_default', purpose: 'default', scope: 'stack', managedNetworkId: 'net-1',
        target: { stackServiceId: 'svc-1', serviceName: 'api' }, containers: [{ id: 'c-1', name: 'c-1' }], message: 'x',
      }]),
      { prisma, networkManager, dockerExecutor, log },
    );

    expect(networkManager.connect).toHaveBeenCalledWith('c-1', 'proj_default', { aliases: ['api'], staticIp: '10.0.0.5' });
  });

  describe('enforceMemberships gating (the disconnect safety model)', () => {
    it('never disconnects a stale endpoint when the network\'s enforceMemberships is false (default) — counts it as skipped instead', async () => {
      const networkManager = makeFakeNetworkManager();
      const prisma = makeFakePrisma({ networks: [net({ enforceMemberships: false })] });
      const dockerExecutor = makeFakeDockerExecutor();

      const result = await applyConvergence(
        report([{ type: 'membership-stale', networkName: 'proj_default', purpose: 'default', scope: 'stack', managedNetworkId: 'net-1', containers: [{ id: 'mystery-1', name: 'mystery' }], message: 'x' }]),
        { prisma, networkManager, dockerExecutor, log },
      );

      expect(networkManager.disconnect).not.toHaveBeenCalled();
      expect(result.membershipsDisconnected).toBe(0);
      expect(result.skippedDisconnects).toBe(1);
    });

    it('disconnects a stale endpoint once enforceMemberships is true on that specific network', async () => {
      const networkManager = makeFakeNetworkManager();
      const prisma = makeFakePrisma({ networks: [net({ enforceMemberships: true })] });
      // Container "created" long ago — outside the grace window.
      const dockerExecutor = makeFakeDockerExecutor(() => ({ State: { StartedAt: new Date(Date.now() - 10 * 60_000).toISOString() }, Created: new Date(Date.now() - 10 * 60_000).toISOString() }));

      const result = await applyConvergence(
        report([{ type: 'membership-stale', networkName: 'proj_default', purpose: 'default', scope: 'stack', managedNetworkId: 'net-1', containers: [{ id: 'mystery-1', name: 'mystery' }], message: 'x' }]),
        { prisma, networkManager, dockerExecutor, log },
      );

      expect(networkManager.disconnect).toHaveBeenCalledWith('mystery-1', 'proj_default');
      expect(result.membershipsDisconnected).toBe(1);
      expect(result.skippedDisconnects).toBe(0);
    });

    it('defers (does not disconnect) a stale container created within the grace window, even with enforceMemberships true — race-with-creation guard', async () => {
      const networkManager = makeFakeNetworkManager();
      const prisma = makeFakePrisma({ networks: [net({ enforceMemberships: true })] });
      // Container started 1 second ago — well within the grace window.
      const dockerExecutor = makeFakeDockerExecutor(() => ({ State: { StartedAt: new Date(Date.now() - 1000).toISOString() }, Created: new Date(Date.now() - 1000).toISOString() }));

      const result = await applyConvergence(
        report([{ type: 'membership-stale', networkName: 'proj_default', purpose: 'default', scope: 'stack', managedNetworkId: 'net-1', containers: [{ id: 'fresh-1', name: 'fresh' }], message: 'x' }]),
        { prisma, networkManager, dockerExecutor, log },
      );

      expect(networkManager.disconnect).not.toHaveBeenCalled();
      expect(result.membershipsDisconnected).toBe(0);
      expect(result.skippedRecentContainers).toBe(1);
    });

    it('a flag enabled on one network never causes a disconnect on another network\'s stale item in the same report', async () => {
      const networkManager = makeFakeNetworkManager();
      const prisma = makeFakePrisma({
        networks: [
          net({ id: 'net-flagged', name: 'net-flagged', enforceMemberships: true }),
          net({ id: 'net-unflagged', name: 'net-unflagged', enforceMemberships: false }),
        ],
      });
      const dockerExecutor = makeFakeDockerExecutor(() => ({ State: { StartedAt: new Date(Date.now() - 10 * 60_000).toISOString() }, Created: new Date(Date.now() - 10 * 60_000).toISOString() }));

      const result = await applyConvergence(
        report([
          { type: 'membership-stale', networkName: 'net-flagged', purpose: 'default', scope: 'stack', managedNetworkId: 'net-flagged', containers: [{ id: 'c-flagged', name: 'c-flagged' }], message: 'x' },
          { type: 'membership-stale', networkName: 'net-unflagged', purpose: 'default', scope: 'stack', managedNetworkId: 'net-unflagged', containers: [{ id: 'c-unflagged', name: 'c-unflagged' }], message: 'x' },
        ]),
        { prisma, networkManager, dockerExecutor, log },
      );

      expect(networkManager.disconnect).toHaveBeenCalledTimes(1);
      expect(networkManager.disconnect).toHaveBeenCalledWith('c-flagged', 'net-flagged');
      expect(result.membershipsDisconnected).toBe(1);
      expect(result.skippedDisconnects).toBe(1);
    });
  });

  it('never acts on a spec-mismatch item (no ensure/connect/disconnect call)', async () => {
    const networkManager = makeFakeNetworkManager();
    const prisma = makeFakePrisma({ networks: [net()] });
    const dockerExecutor = makeFakeDockerExecutor();

    const result = await applyConvergence(
      report([{ type: 'spec-mismatch', networkName: 'proj_default', purpose: 'default', scope: 'stack', managedNetworkId: 'net-1', mismatch: { driver: { expected: 'bridge', actual: 'host' } }, message: 'x' }]),
      { prisma, networkManager, dockerExecutor, log },
    );

    expect(networkManager.ensure).not.toHaveBeenCalled();
    expect(networkManager.connect).not.toHaveBeenCalled();
    expect(networkManager.disconnect).not.toHaveBeenCalled();
    expect(result).toMatchObject({ networksEnsured: 0, membershipsConnected: 0, membershipsDisconnected: 0, errors: 0 });
  });

  it('is a no-op returning zeroed counters when the report has no items', async () => {
    const networkManager = makeFakeNetworkManager();
    const prisma = makeFakePrisma();
    const dockerExecutor = makeFakeDockerExecutor();

    const result = await applyConvergence(report([]), { prisma, networkManager, dockerExecutor, log });

    expect(result).toMatchObject({ networksEnsured: 0, networksCreated: 0, membershipsConnected: 0, membershipsDisconnected: 0, errors: 0 });
    expect(prisma.managedNetwork.findMany).not.toHaveBeenCalled();
  });

  it('does not count an already-connected result as a fresh connection (accurate "restored attachment count" metric)', async () => {
    const networkManager = makeFakeNetworkManager({ connect: vi.fn().mockResolvedValue({ connected: true, alreadyConnected: true }) });
    const prisma = makeFakePrisma({ networks: [net()], memberships: [] });
    const dockerExecutor = makeFakeDockerExecutor();

    const result = await applyConvergence(
      report([{ type: 'membership-missing', networkName: 'proj_default', purpose: 'default', scope: 'stack', managedNetworkId: 'net-1', target: { stackServiceId: 'svc-1' }, containers: [{ id: 'c-1', name: 'c-1' }], message: 'x' }]),
      { prisma, networkManager, dockerExecutor, log },
    );

    expect(networkManager.connect).toHaveBeenCalledTimes(1);
    expect(result.membershipsConnected).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('counts (and does not throw on) a per-item connect failure', async () => {
    const networkManager = makeFakeNetworkManager({ connect: vi.fn().mockRejectedValue(new Error('boom')) });
    const prisma = makeFakePrisma({ networks: [net()], memberships: [] });
    const dockerExecutor = makeFakeDockerExecutor();

    const result = await applyConvergence(
      report([{ type: 'membership-missing', networkName: 'proj_default', purpose: 'default', scope: 'stack', managedNetworkId: 'net-1', target: { stackServiceId: 'svc-1' }, containers: [{ id: 'c-1', name: 'c-1' }], message: 'x' }]),
      { prisma, networkManager, dockerExecutor, log },
    );

    expect(result.errors).toBe(1);
    expect(result.membershipsConnected).toBe(0);
  });
});

describe('convergeContainer', () => {
  beforeEach(() => {
    selfContainerId = null;
  });

  it('resolves the self sentinel and connects the self container to every network it has a membership row for', async () => {
    selfContainerId = 'self-id';
    const networkManager = makeFakeNetworkManager();
    const prisma = {
      networkMembership: {
        findMany: vi.fn(async ({ where }: any) => {
          if (where.containerName === 'self') return [{ networkId: 'net-vault', stackServiceId: null, containerName: 'self', aliases: null, staticIp: null }];
          return [];
        }),
      },
      managedNetwork: {
        findMany: vi.fn(async () => [net({ id: 'net-vault', name: 'mini-infra-vault', scope: 'host', stackId: null })]),
      },
    } as any;
    const dockerExecutor = makeFakeDockerExecutor();

    const result = await convergeContainer('self-id', { prisma, networkManager, dockerExecutor, log });

    expect(networkManager.connect).toHaveBeenCalledWith('self-id', 'mini-infra-vault', expect.any(Object));
    expect(result.membershipsConnected).toBe(1);
    expect(result.scope).toEqual({ kind: 'container', containerId: 'self-id' });
  });

  it('resolves a labeled managed-service container via its stack-id/service labels and converges only its own memberships', async () => {
    const inspect = vi.fn(async () => ({ Config: { Labels: { 'mini-infra.stack-id': 'stack-1', 'mini-infra.service': 'api' } }, Name: '/c-api' }));
    const dockerExecutor = { getDockerClient: () => ({ getContainer: () => ({ inspect }) }) } as any;
    const networkManager = makeFakeNetworkManager();
    const prisma = {
      stackService: { findFirst: vi.fn(async () => ({ id: 'svc-1', serviceType: 'Stateful', adoptedContainer: null })) },
      networkMembership: {
        findMany: vi.fn(async ({ where }: any) => (where.stackServiceId === 'svc-1' ? [{ networkId: 'net-1', stackServiceId: 'svc-1', containerName: null, aliases: ['api'], staticIp: null }] : [])),
      },
      managedNetwork: { findMany: vi.fn(async () => [net()]) },
    } as any;

    const result = await convergeContainer('c-api', { prisma, networkManager, dockerExecutor, log });

    expect(networkManager.connect).toHaveBeenCalledWith('c-api', 'proj_default', { aliases: ['api'], staticIp: undefined });
    expect(result.membershipsConnected).toBe(1);
  });

  it('falls back to the container\'s own name for an unlabeled (adopted) container', async () => {
    const inspect = vi.fn(async () => ({ Config: { Labels: {} }, Name: '/legacy-app' }));
    const dockerExecutor = { getDockerClient: () => ({ getContainer: () => ({ inspect }) }) } as any;
    const networkManager = makeFakeNetworkManager();
    const prisma = {
      networkMembership: {
        findMany: vi.fn(async ({ where }: any) => (where.containerName === 'legacy-app' ? [{ networkId: 'net-1', stackServiceId: null, containerName: 'legacy-app', aliases: null, staticIp: null }] : [])),
      },
      managedNetwork: { findMany: vi.fn(async () => [net({ scope: 'environment', stackId: null, environmentId: 'env-1', name: 'env-1-applications' })]) },
    } as any;

    const result = await convergeContainer('legacy-id', { prisma, networkManager, dockerExecutor, log });

    expect(networkManager.connect).toHaveBeenCalledWith('legacy-id', 'env-1-applications', expect.any(Object));
    expect(result.membershipsConnected).toBe(1);
  });

  it('is a no-op when the container no longer exists (inspect fails) and is not the self container', async () => {
    const dockerExecutor = { getDockerClient: () => ({ getContainer: () => ({ inspect: vi.fn().mockRejectedValue(new Error('no such container')) }) }) } as any;
    const networkManager = makeFakeNetworkManager();
    const prisma = { networkMembership: { findMany: vi.fn() }, managedNetwork: { findMany: vi.fn() } } as any;

    const result = await convergeContainer('gone-id', { prisma, networkManager, dockerExecutor, log });

    expect(networkManager.connect).not.toHaveBeenCalled();
    expect(prisma.networkMembership.findMany).not.toHaveBeenCalled();
    expect(result.membershipsConnected).toBe(0);
  });
});
