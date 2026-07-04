import { runNetworkGc, NetworkGcScheduler } from '../network-gc';
import type { NetworkManager, ManagedNetworkInfo, NetworkInspectResult, RemoveNetworkResult } from '../network-manager';

/** Minimal fake NetworkManager — runNetworkGc only calls listManaged/inspect/remove. */
function makeFakeNetworkManager(overrides: Partial<NetworkManager> = {}): NetworkManager {
  return {
    listManaged: vi.fn().mockResolvedValue([]),
    inspect: vi.fn().mockResolvedValue({ name: 'x', labels: {}, connectedContainerIds: [] }),
    remove: vi.fn().mockResolvedValue({ name: 'x', removed: true }),
    ...overrides,
  } as unknown as NetworkManager;
}

/**
 * Minimal fake PrismaClient — runNetworkGc calls stack.findMany/environment.findMany
 * (owner resolution) plus networkMembership.findMany/deleteMany + stackService.findMany
 * (orphaned-membership prune). Memberships/liveServiceIds default empty → prune is a no-op.
 */
function makeFakePrisma(
  opts: {
    stackIds?: string[];
    environmentIds?: string[];
    memberships?: Array<{ id: string; stackServiceId: string | null }>;
    liveServiceIds?: string[];
  } = {},
) {
  return {
    stack: {
      findMany: vi.fn().mockResolvedValue((opts.stackIds ?? []).map((id) => ({ id }))),
    },
    environment: {
      findMany: vi.fn().mockResolvedValue((opts.environmentIds ?? []).map((id) => ({ id }))),
    },
    networkMembership: {
      // mirrors the `where: { stackServiceId: { not: null } }` filter
      findMany: vi.fn().mockResolvedValue((opts.memberships ?? []).filter((m) => m.stackServiceId != null)),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    stackService: {
      findMany: vi.fn().mockResolvedValue((opts.liveServiceIds ?? []).map((id) => ({ id }))),
    },
  } as unknown as Parameters<typeof runNetworkGc>[1];
}

function managed(overrides: Partial<ManagedNetworkInfo>): ManagedNetworkInfo {
  return {
    name: 'net',
    ownerKind: 'stack',
    ownerId: 'stack-1',
    purpose: '_stack',
    labels: {},
    ...overrides,
  };
}

describe('runNetworkGc', () => {
  it('never treats a host-scoped network as an orphan candidate', async () => {
    const networkManager = makeFakeNetworkManager({
      listManaged: vi.fn().mockResolvedValue([managed({ name: 'mini-infra-dataplane', ownerKind: 'host', ownerId: undefined })]),
    });
    const prisma = makeFakePrisma();

    const report = await runNetworkGc(networkManager, prisma);

    expect(report.orphans).toEqual([]);
    expect(networkManager.inspect).not.toHaveBeenCalled();
  });

  it('does not flag a network whose owning stack still exists', async () => {
    const networkManager = makeFakeNetworkManager({
      listManaged: vi.fn().mockResolvedValue([managed({ name: 'stk-proj_default', ownerKind: 'stack', ownerId: 'stack-1' })]),
    });
    const prisma = makeFakePrisma({ stackIds: ['stack-1'] });

    const report = await runNetworkGc(networkManager, prisma);

    expect(report.orphans).toEqual([]);
    expect(networkManager.inspect).not.toHaveBeenCalled();
  });

  it('does not flag a network whose owning environment still exists', async () => {
    const networkManager = makeFakeNetworkManager({
      listManaged: vi.fn().mockResolvedValue([managed({ name: 'env-egress', ownerKind: 'environment', ownerId: 'env-1' })]),
    });
    const prisma = makeFakePrisma({ environmentIds: ['env-1'] });

    const report = await runNetworkGc(networkManager, prisma);

    expect(report.orphans).toEqual([]);
  });

  it('flags a network whose owner no longer exists and has zero attached containers as eligible, but does not remove it in dry-run mode (default)', async () => {
    const networkManager = makeFakeNetworkManager({
      listManaged: vi.fn().mockResolvedValue([managed({ name: 'stk-gone_default', ownerKind: 'stack', ownerId: 'gone-stack' })]),
      inspect: vi.fn().mockResolvedValue({ name: 'stk-gone_default', labels: {}, connectedContainerIds: [] } as NetworkInspectResult),
    });
    const prisma = makeFakePrisma(); // gone-stack resolves to nothing

    const report = await runNetworkGc(networkManager, prisma);

    expect(report.dryRun).toBe(true);
    expect(report.orphans).toEqual([
      {
        name: 'stk-gone_default',
        ownerKind: 'stack',
        ownerId: 'gone-stack',
        purpose: '_stack',
        connectedContainerCount: 0,
        eligibleForRemoval: true,
      },
    ]);
    expect(report.removedCount).toBe(0);
    expect(networkManager.remove).not.toHaveBeenCalled();
  });

  it('actually removes an eligible orphan when dryRun is explicitly false', async () => {
    const networkManager = makeFakeNetworkManager({
      listManaged: vi.fn().mockResolvedValue([managed({ name: 'stk-gone_default', ownerKind: 'stack', ownerId: 'gone-stack' })]),
      inspect: vi.fn().mockResolvedValue({ name: 'stk-gone_default', labels: {}, connectedContainerIds: [] } as NetworkInspectResult),
      remove: vi.fn().mockResolvedValue({ name: 'stk-gone_default', removed: true } as RemoveNetworkResult),
    });
    const prisma = makeFakePrisma();

    const report = await runNetworkGc(networkManager, prisma, { dryRun: false });

    expect(networkManager.remove).toHaveBeenCalledWith('stk-gone_default');
    expect(report.orphans[0]).toMatchObject({ eligibleForRemoval: true, removed: true });
    expect(report.removedCount).toBe(1);
  });

  it('never removes an orphan that still has attached containers, even with dryRun:false', async () => {
    const networkManager = makeFakeNetworkManager({
      listManaged: vi.fn().mockResolvedValue([managed({ name: 'stk-gone_default', ownerKind: 'stack', ownerId: 'gone-stack' })]),
      inspect: vi.fn().mockResolvedValue({
        name: 'stk-gone_default',
        labels: {},
        connectedContainerIds: ['c1'],
      } as NetworkInspectResult),
    });
    const prisma = makeFakePrisma();

    const report = await runNetworkGc(networkManager, prisma, { dryRun: false });

    expect(networkManager.remove).not.toHaveBeenCalled();
    expect(report.orphans).toEqual([
      {
        name: 'stk-gone_default',
        ownerKind: 'stack',
        ownerId: 'gone-stack',
        purpose: '_stack',
        connectedContainerCount: 1,
        eligibleForRemoval: false,
      },
    ]);
    expect(report.removedCount).toBe(0);
  });

  it('skips a candidate whose inspect fails (Docker hiccup) rather than guessing it is removable', async () => {
    const networkManager = makeFakeNetworkManager({
      listManaged: vi.fn().mockResolvedValue([managed({ name: 'flaky-net', ownerKind: 'stack', ownerId: 'gone-stack' })]),
      inspect: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    });
    const prisma = makeFakePrisma();

    const report = await runNetworkGc(networkManager, prisma, { dryRun: false });

    expect(report.orphans).toEqual([]);
    expect(networkManager.remove).not.toHaveBeenCalled();
  });

  it('only queries stack/environment tables for owner ids actually present among managed networks', async () => {
    const networkManager = makeFakeNetworkManager({
      listManaged: vi.fn().mockResolvedValue([
        managed({ name: 'stk-a_default', ownerKind: 'stack', ownerId: 'stack-a' }),
        managed({ name: 'env-b-egress', ownerKind: 'environment', ownerId: 'env-b' }),
      ]),
    });
    const prisma = makeFakePrisma({ stackIds: ['stack-a'], environmentIds: ['env-b'] });

    await runNetworkGc(networkManager, prisma);

    expect(prisma.stack.findMany).toHaveBeenCalledWith({ where: { id: { in: ['stack-a'] } }, select: { id: true } });
    expect(prisma.environment.findMany).toHaveBeenCalledWith({ where: { id: { in: ['env-b'] } }, select: { id: true } });
  });

  it('never queries the DB when there are no managed networks at all', async () => {
    const networkManager = makeFakeNetworkManager({ listManaged: vi.fn().mockResolvedValue([]) });
    const prisma = makeFakePrisma();

    const report = await runNetworkGc(networkManager, prisma);

    expect(report).toMatchObject({ scannedCount: 0, orphans: [], removedCount: 0 });
    expect(prisma.stack.findMany).not.toHaveBeenCalled();
    expect(prisma.environment.findMany).not.toHaveBeenCalled();
  });

  describe('orphaned NetworkMembership pruning', () => {
    it('deletes membership rows whose stackServiceId no longer resolves to a live StackService (dryRun:false)', async () => {
      const networkManager = makeFakeNetworkManager();
      const prisma = makeFakePrisma({
        memberships: [
          { id: 'm-dead', stackServiceId: 'svc-gone' },
          { id: 'm-live', stackServiceId: 'svc-live' },
        ],
        liveServiceIds: ['svc-live'],
      });

      await runNetworkGc(networkManager, prisma, { dryRun: false });

      // only the row pointing at the removed service is deleted
      expect(prisma.networkMembership.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['m-dead'] } } });
    });

    it('counts but does not delete orphaned memberships in dry-run mode (default)', async () => {
      const networkManager = makeFakeNetworkManager();
      const prisma = makeFakePrisma({
        memberships: [{ id: 'm-dead', stackServiceId: 'svc-gone' }],
        liveServiceIds: [],
      });

      await runNetworkGc(networkManager, prisma); // dryRun defaults true

      expect(prisma.networkMembership.deleteMany).not.toHaveBeenCalled();
    });

    it('leaves memberships whose service still exists untouched', async () => {
      const networkManager = makeFakeNetworkManager();
      const prisma = makeFakePrisma({
        memberships: [{ id: 'm-live', stackServiceId: 'svc-live' }],
        liveServiceIds: ['svc-live'],
      });

      await runNetworkGc(networkManager, prisma, { dryRun: false });

      expect(prisma.networkMembership.deleteMany).not.toHaveBeenCalled();
    });

    it('does not query StackService when there are no service-keyed memberships', async () => {
      const networkManager = makeFakeNetworkManager();
      const prisma = makeFakePrisma({ memberships: [] });

      await runNetworkGc(networkManager, prisma, { dryRun: false });

      expect(prisma.stackService.findMany).not.toHaveBeenCalled();
      expect(prisma.networkMembership.deleteMany).not.toHaveBeenCalled();
    });
  });
});

describe('NetworkGcScheduler', () => {
  it('always ticks in dry-run mode, even if called with a real-removal-capable NetworkManager', async () => {
    const networkManager = makeFakeNetworkManager({
      listManaged: vi.fn().mockResolvedValue([managed({ name: 'stk-gone_default', ownerKind: 'stack', ownerId: 'gone-stack' })]),
      inspect: vi.fn().mockResolvedValue({ name: 'stk-gone_default', labels: {}, connectedContainerIds: [] } as NetworkInspectResult),
    });
    const prisma = makeFakePrisma();
    const scheduler = new NetworkGcScheduler(prisma, { createNetworkManager: async () => networkManager });

    const report = await scheduler.tick();

    expect(report?.dryRun).toBe(true);
    expect(networkManager.remove).not.toHaveBeenCalled();
  });

  it('does not throw and returns undefined when Docker/NetworkManager construction fails', async () => {
    const prisma = makeFakePrisma();
    const scheduler = new NetworkGcScheduler(prisma, {
      createNetworkManager: async () => {
        throw new Error('Docker unreachable');
      },
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  it('start()/stop() toggle isRunning without throwing', () => {
    const prisma = makeFakePrisma();
    const scheduler = new NetworkGcScheduler(
      prisma,
      { createNetworkManager: async () => makeFakeNetworkManager() },
      { intervalMs: 60_000 },
    );

    expect(scheduler.isRunning()).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });
});
