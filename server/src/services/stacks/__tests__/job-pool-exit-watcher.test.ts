import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobPoolExitWatcher, KILL_AFTER_SECONDS_ERROR } from '../job-pool-exit-watcher';
import { jobHistoryStreamName } from '@mini-infra/types';
import type { DockerContainerEvent } from '../../../lib/docker-event-pattern-detector';

// Mock DockerService.onContainerEvent + NatsBus so the watcher's
// start() registration doesn't try to reach a real Docker socket / NATS
// connection inside the unit test.
vi.mock('../../docker', () => ({
  default: {
    getInstance: () => ({
      onContainerEvent: vi.fn(),
    }),
  },
}));

const publishedEvents: { kind: string; payload: unknown }[] = [];
vi.mock('../job-pool-history-publisher', () => ({
  publishJobPoolCompleted: vi.fn(async (p: unknown) => {
    publishedEvents.push({ kind: 'completed', payload: p });
  }),
  publishJobPoolFailed: vi.fn(async (p: unknown) => {
    publishedEvents.push({ kind: 'failed', payload: p });
  }),
  publishJobPoolRunSkipped: vi.fn(async (p: unknown) => {
    publishedEvents.push({ kind: 'skipped', payload: p });
  }),
}));

const scheduledRetries: unknown[] = [];
vi.mock('../job-pool-retry-scheduler', () => ({
  scheduleJobPoolRetry: vi.fn((_prisma, _exec, ctx: unknown) => {
    scheduledRetries.push(ctx);
  }),
}));

type MockPrisma = {
  poolInstance: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  stackService: {
    findFirst: ReturnType<typeof vi.fn>;
  };
};

function buildPrismaWithRow(opts: {
  status?: string;
  errorMessage?: string | null;
  serviceType?: string;
  jobPoolConfig?: unknown;
}): MockPrisma {
  const row = {
    id: 'row-1',
    stackId: 'stack-1',
    serviceName: 'backup',
    instanceId: 'run-1',
    containerId: 'cnt-1',
    status: opts.status ?? 'running',
    lastActive: new Date(Date.now() - 5_000),
    errorMessage: opts.errorMessage ?? null,
  };
  const svc = {
    id: 'svc-1',
    stackId: 'stack-1',
    serviceName: 'backup',
    serviceType: opts.serviceType ?? 'JobPool',
    jobPoolConfig: opts.jobPoolConfig ?? {
      maxConcurrent: 1,
      managedBy: null,
      triggers: [{ kind: 'manual', name: 'run-now' }],
      history: { retainDays: 7 },
    },
  };
  return {
    poolInstance: {
      findFirst: vi.fn().mockResolvedValue(row),
      update: vi.fn().mockResolvedValue({}),
    },
    stackService: {
      findFirst: vi.fn().mockResolvedValue(svc),
    },
  };
}

function makeDieEvent(overrides: Partial<DockerContainerEvent> = {}): DockerContainerEvent {
  return {
    action: 'die',
    containerId: 'cnt-1',
    containerName: '/cnt-1',
    labels: {
      'mini-infra.pool-instance': 'true',
      'mini-infra.pool-instance-id': 'run-1',
      'mini-infra.stack-id': 'stack-1',
      'mini-infra.job-pool-trigger-kind': 'manual',
      'mini-infra.job-pool-trigger-name': 'run-now',
    },
    time: Date.now() / 1000,
    ...overrides,
  };
}

describe('JobPoolExitWatcher', () => {
  beforeEach(() => {
    publishedEvents.length = 0;
    scheduledRetries.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('transitions row to completed on exit 0 and emits completed event', async () => {
    const prisma = buildPrismaWithRow({});
    const watcher = new JobPoolExitWatcher(
      prisma as unknown as ConstructorParameters<typeof JobPoolExitWatcher>[0],
      async () => null as unknown as Awaited<ReturnType<ConstructorParameters<typeof JobPoolExitWatcher>[1]>>,
    );

    const ok = await watcher.handleEvent(makeDieEvent({ exitCode: 0 }));
    expect(ok).toBe(true);

    expect(prisma.poolInstance.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'row-1' },
      data: expect.objectContaining({
        status: 'completed',
        exitCode: 0,
      }),
    }));
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toMatchObject({
      kind: 'completed',
      payload: { exitCode: 0, runId: 'run-1' },
    });
  });

  it('transitions row to failed on non-zero exit and emits failed event', async () => {
    const prisma = buildPrismaWithRow({});
    const watcher = new JobPoolExitWatcher(
      prisma as unknown as ConstructorParameters<typeof JobPoolExitWatcher>[0],
      async () => null as unknown as Awaited<ReturnType<ConstructorParameters<typeof JobPoolExitWatcher>[1]>>,
    );

    await watcher.handleEvent(makeDieEvent({ exitCode: 17 }));

    expect(prisma.poolInstance.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'failed',
        exitCode: 17,
        errorMessage: expect.stringContaining('exit'),
      }),
    }));
    expect(publishedEvents).toEqual([
      expect.objectContaining({
        kind: 'failed',
        payload: expect.objectContaining({ exitCode: 17, runId: 'run-1' }),
      }),
    ]);
  });

  it('preserves the kill-marker errorMessage on a kill-after-seconds row', async () => {
    const prisma = buildPrismaWithRow({ errorMessage: KILL_AFTER_SECONDS_ERROR });
    const watcher = new JobPoolExitWatcher(
      prisma as unknown as ConstructorParameters<typeof JobPoolExitWatcher>[0],
      async () => null as unknown as Awaited<ReturnType<ConstructorParameters<typeof JobPoolExitWatcher>[1]>>,
    );

    await watcher.handleEvent(makeDieEvent({ exitCode: 137 }));

    expect(prisma.poolInstance.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'failed',
        errorMessage: KILL_AFTER_SECONDS_ERROR,
      }),
    }));
    expect(publishedEvents[0].payload).toMatchObject({
      errorMessage: KILL_AFTER_SECONDS_ERROR,
    });
  });

  it('ignores die events without pool-instance labels', async () => {
    const prisma = buildPrismaWithRow({});
    const watcher = new JobPoolExitWatcher(
      prisma as unknown as ConstructorParameters<typeof JobPoolExitWatcher>[0],
      async () => null as unknown as Awaited<ReturnType<ConstructorParameters<typeof JobPoolExitWatcher>[1]>>,
    );

    const bareEvent: DockerContainerEvent = {
      action: 'die',
      containerId: 'other',
      containerName: '/other',
      labels: {},
      time: 0,
    };
    await watcher.handleEvent(bareEvent);

    expect(prisma.poolInstance.findFirst).not.toHaveBeenCalled();
    expect(publishedEvents).toHaveLength(0);
  });

  it('ignores die events whose row has serviceType !== JobPool', async () => {
    const prisma = buildPrismaWithRow({ serviceType: 'Pool' });
    const watcher = new JobPoolExitWatcher(
      prisma as unknown as ConstructorParameters<typeof JobPoolExitWatcher>[0],
      async () => null as unknown as Awaited<ReturnType<ConstructorParameters<typeof JobPoolExitWatcher>[1]>>,
    );

    await watcher.handleEvent(makeDieEvent({ exitCode: 0 }));

    expect(prisma.poolInstance.update).not.toHaveBeenCalled();
    expect(publishedEvents).toHaveLength(0);
  });

  it('is idempotent — duplicate die for an already-terminal row is a no-op', async () => {
    const prisma = buildPrismaWithRow({ status: 'failed' });
    const watcher = new JobPoolExitWatcher(
      prisma as unknown as ConstructorParameters<typeof JobPoolExitWatcher>[0],
      async () => null as unknown as Awaited<ReturnType<ConstructorParameters<typeof JobPoolExitWatcher>[1]>>,
    );

    await watcher.handleEvent(makeDieEvent({ exitCode: 1 }));

    expect(prisma.poolInstance.update).not.toHaveBeenCalled();
    expect(publishedEvents).toHaveLength(0);
  });

  it('schedules a retry on non-zero exit when onFailure.retries > 0', async () => {
    const prisma = buildPrismaWithRow({
      jobPoolConfig: {
        maxConcurrent: 1,
        managedBy: null,
        triggers: [{ kind: 'manual', name: 'run-now' }],
        history: { retainDays: 7 },
        onFailure: { retries: 1, backoff: 'fixed' },
      },
    });
    const watcher = new JobPoolExitWatcher(
      prisma as unknown as ConstructorParameters<typeof JobPoolExitWatcher>[0],
      // Returns a placeholder executor object — the test mocks the scheduler.
      async () => ({} as unknown as Awaited<ReturnType<ConstructorParameters<typeof JobPoolExitWatcher>[1]>>),
    );

    await watcher.handleEvent(makeDieEvent({ exitCode: 1 }));

    expect(scheduledRetries).toHaveLength(1);
    expect(scheduledRetries[0]).toMatchObject({
      stackId: 'stack-1',
      serviceName: 'backup',
      // The watcher post-increments: a die event with no retry-attempt
      // label is treated as attempt 0, so the next retry it schedules is
      // attempt 1 (MINI-50 review finding H1 — pre-fix this was always
      // `0` and the retry chain ran forever).
      attemptedRetries: 1,
      onFailure: { retries: 1, backoff: 'fixed' },
    });
  });
});

describe('jobHistoryStreamName', () => {
  it('keeps short names intact', () => {
    const name = jobHistoryStreamName('abc', 'backup');
    expect(name).toBe('JobHistory-abc-backup');
    expect(name.length).toBeLessThanOrEqual(32);
  });

  it('shortens long stackIds via hash suffix and stays under 32 chars', () => {
    const longStack = 'cm1234567890abcdefghijklmnopqrstuvwxyz';
    const name = jobHistoryStreamName(longStack, 'pg-az-backup');
    expect(name.startsWith('JobHistory-')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(32);
    // Should still carry a readable service prefix for operator scans
    expect(name).toContain('pg-az-backup'.slice(0, 12));
  });

  it('different (stackId, serviceName) pairs produce different names even when shortened', () => {
    const longStackA = 'cm0000000000000000000000000000000aaaa';
    const longStackB = 'cm0000000000000000000000000000000bbbb';
    const a = jobHistoryStreamName(longStackA, 'pg-az-backup');
    const b = jobHistoryStreamName(longStackB, 'pg-az-backup');
    expect(a).not.toBe(b);
  });

  it('sanitises invalid characters out of the service name', () => {
    const name = jobHistoryStreamName('stack-1', 'has.dots*and>wild');
    // The output cannot contain `.`, `*`, or `>` — those are forbidden in
    // JetStream stream names.
    expect(name).not.toMatch(/[.*>]/);
  });
});
