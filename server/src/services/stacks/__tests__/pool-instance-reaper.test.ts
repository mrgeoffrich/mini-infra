import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PoolInstanceReaper } from '../pool-instance-reaper';

// Stub the DockerExecutorService so we don't try to hit a real daemon.
const mockGetContainer = vi.fn();
const mockDockerClient = { getContainer: mockGetContainer };
const mockInitialize = vi.fn();
const mockGetDockerClient = vi.fn(() => mockDockerClient);

vi.mock('../../docker-executor', () => ({
  DockerExecutorService: class {
    initialize = mockInitialize;
    getDockerClient = mockGetDockerClient;
  },
}));

// Mute socket emitter — it has no listeners in tests.
vi.mock('../pool-socket-emitter', () => ({
  emitPoolInstanceIdleStopped: vi.fn(),
  emitPoolInstanceFailed: vi.fn(),
}));

function buildContainer(overrides: Record<string, unknown> = {}) {
  const stop = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  return { stop, remove, ...overrides };
}

function makePrismaMock(initial: {
  running?: Array<Record<string, unknown>>;
  starting?: Array<Record<string, unknown>>;
  /** Owning service rows for the kill-after-seconds reaper pass. */
  services?: Array<Record<string, unknown>>;
}) {
  const findMany = vi.fn().mockImplementation((args: { where: { status?: string } }) => {
    if (args.where.status === 'running') return Promise.resolve(initial.running ?? []);
    if (args.where.status === 'starting') return Promise.resolve(initial.starting ?? []);
    return Promise.resolve([]);
  });
  const update = vi.fn().mockResolvedValue({});
  const stackServiceFindMany = vi.fn().mockResolvedValue(initial.services ?? []);
  return {
    poolInstance: { findMany, update },
    stackService: { findMany: stackServiceFindMany },
  } as unknown as Parameters<typeof PoolInstanceReaper>[0];
}

describe('PoolInstanceReaper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInitialize.mockResolvedValue(undefined);
    mockGetContainer.mockReset();
  });

  it('stops and marks idle running instances', async () => {
    const container = buildContainer();
    mockGetContainer.mockReturnValue(container);

    const old = new Date(Date.now() - 40 * 60_000); // 40 min ago
    const prisma = makePrismaMock({
      running: [
        {
          id: 'inst-1',
          stackId: 'stack-1',
          serviceName: 'worker',
          instanceId: 'u1',
          containerId: 'c1',
          status: 'running',
          idleTimeoutMinutes: 30,
          lastActive: old,
          createdAt: old,
        },
      ],
    });

    const reaper = new PoolInstanceReaper(prisma);
    await reaper.tick();

    expect(container.stop).toHaveBeenCalled();
    expect(container.remove).toHaveBeenCalled();
    const updateFn = (prisma as unknown as { poolInstance: { update: ReturnType<typeof vi.fn> } })
      .poolInstance.update;
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inst-1' },
        data: expect.objectContaining({ status: 'stopped' }),
      }),
    );
  });

  it('leaves within-window instances untouched', async () => {
    const prisma = makePrismaMock({
      running: [
        {
          id: 'inst-2',
          stackId: 'stack-1',
          serviceName: 'worker',
          instanceId: 'u2',
          containerId: 'c2',
          status: 'running',
          idleTimeoutMinutes: 30,
          lastActive: new Date(Date.now() - 5 * 60_000),
          createdAt: new Date(Date.now() - 5 * 60_000),
        },
      ],
    });

    const reaper = new PoolInstanceReaper(prisma);
    await reaper.tick();

    const updateFn = (prisma as unknown as { poolInstance: { update: ReturnType<typeof vi.fn> } })
      .poolInstance.update;
    expect(updateFn).not.toHaveBeenCalled();
  });

  it('marks stuck-starting rows as error after 5 minutes', async () => {
    const container = buildContainer();
    mockGetContainer.mockReturnValue(container);

    const prisma = makePrismaMock({
      starting: [
        {
          id: 'inst-3',
          stackId: 'stack-1',
          serviceName: 'worker',
          instanceId: 'u3',
          containerId: null,
          status: 'starting',
          idleTimeoutMinutes: 30,
          lastActive: new Date(),
          createdAt: new Date(Date.now() - 10 * 60_000),
        },
      ],
    });

    const reaper = new PoolInstanceReaper(prisma);
    await reaper.tick();

    const updateFn = (prisma as unknown as { poolInstance: { update: ReturnType<typeof vi.fn> } })
      .poolInstance.update;
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inst-3' },
        data: expect.objectContaining({
          status: 'error',
          errorMessage: expect.stringContaining('timed out'),
        }),
      }),
    );
  });

  it('skips tick when Docker is unreachable — no DB mutation', async () => {
    mockInitialize.mockRejectedValueOnce(new Error('docker down'));

    const prisma = makePrismaMock({
      running: [
        {
          id: 'inst-4',
          stackId: 'stack-1',
          serviceName: 'worker',
          instanceId: 'u4',
          containerId: 'c4',
          status: 'running',
          idleTimeoutMinutes: 1,
          lastActive: new Date(Date.now() - 60 * 60_000),
          createdAt: new Date(Date.now() - 60 * 60_000),
        },
      ],
    });

    const reaper = new PoolInstanceReaper(prisma);
    await reaper.tick();

    const updateFn = (prisma as unknown as { poolInstance: { update: ReturnType<typeof vi.fn> } })
      .poolInstance.update;
    expect(updateFn).not.toHaveBeenCalled();
    const findManyFn = (prisma as unknown as { poolInstance: { findMany: ReturnType<typeof vi.fn> } })
      .poolInstance.findMany;
    expect(findManyFn).not.toHaveBeenCalled();
  });

  it('kills JobPool runs that exceed killAfterSeconds and marks errorMessage', async () => {
    const container = buildContainer();
    mockGetContainer.mockReturnValue(container);

    // lastActive 10 minutes ago, killAfterSeconds: 60 → over-run.
    const start = new Date(Date.now() - 10 * 60_000);
    const prisma = makePrismaMock({
      running: [
        {
          id: 'job-1',
          stackId: 'stack-jp',
          serviceName: 'backup',
          instanceId: 'run-1',
          containerId: 'c-jp',
          status: 'running',
          idleTimeoutMinutes: 24 * 60,
          lastActive: start,
          createdAt: start,
        },
      ],
      services: [
        {
          id: 'svc-1',
          stackId: 'stack-jp',
          serviceName: 'backup',
          serviceType: 'JobPool',
          jobPoolConfig: {
            maxConcurrent: 1,
            managedBy: null,
            triggers: [{ kind: 'manual', name: 'run-now' }],
            history: { retainDays: 7 },
            killAfterSeconds: 60,
          },
        },
      ],
    });

    const reaper = new PoolInstanceReaper(prisma);
    await reaper.tick();

    expect(container.stop).toHaveBeenCalled();
    expect(container.remove).toHaveBeenCalled();
    const updateFn = (prisma as unknown as { poolInstance: { update: ReturnType<typeof vi.fn> } })
      .poolInstance.update;
    // First call: errorMessage marker; the watcher will see the `die` event
    // afterwards and write the status transition. The reaper itself does
    // NOT transition status.
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1' },
        data: { errorMessage: 'killed: exceeded killAfterSeconds' },
      }),
    );
  });

  it('leaves JobPool runs under killAfterSeconds untouched', async () => {
    const prisma = makePrismaMock({
      running: [
        {
          id: 'job-2',
          stackId: 'stack-jp',
          serviceName: 'backup',
          instanceId: 'run-2',
          containerId: 'c-jp-2',
          status: 'running',
          idleTimeoutMinutes: 24 * 60,
          lastActive: new Date(Date.now() - 10_000), // 10 s ago
          createdAt: new Date(Date.now() - 10_000),
        },
      ],
      services: [
        {
          id: 'svc-2',
          stackId: 'stack-jp',
          serviceName: 'backup',
          serviceType: 'JobPool',
          jobPoolConfig: {
            maxConcurrent: 1,
            managedBy: null,
            triggers: [{ kind: 'manual', name: 'run-now' }],
            history: { retainDays: 7 },
            killAfterSeconds: 60,
          },
        },
      ],
    });

    const reaper = new PoolInstanceReaper(prisma);
    await reaper.tick();

    const updateFn = (prisma as unknown as { poolInstance: { update: ReturnType<typeof vi.fn> } })
      .poolInstance.update;
    expect(updateFn).not.toHaveBeenCalled();
  });
});
