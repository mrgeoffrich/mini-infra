import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted to make state available to the hoisted vi.mock factories.
const mocks = vi.hoisted(() => {
  type FakeTask = { stop: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  const scheduledTasks: Array<{ schedule: string; timezone: string | undefined; task: FakeTask }> = [];
  return {
    scheduledTasks,
    scheduleMock: vi.fn((schedule: string, _handler: unknown, opts?: { timezone?: string }) => {
      const task: FakeTask = { stop: vi.fn(), destroy: vi.fn() };
      scheduledTasks.push({ schedule, timezone: opts?.timezone, task });
      return task;
    }),
    validateMock: vi.fn((schedule: string) => schedule !== 'not-a-cron'),
    runJobPoolMock: vi.fn(async () => ({
      ok: true,
      runId: 'r1',
      instanceRowId: 'row-1',
      containerId: 'c1',
    })),
  };
});

vi.mock('node-cron', () => ({
  schedule: mocks.scheduleMock,
  validate: mocks.validateMock,
}));

vi.mock('../job-pool-spawner', () => ({
  runJobPool: mocks.runJobPoolMock,
}));

type FakeTask = { stop: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
const scheduledTasks = mocks.scheduledTasks;

import { JobPoolCronRegistry } from '../job-pool-cron-registry';

interface FakePrisma {
  stackService: {
    findMany: ReturnType<typeof vi.fn>;
  };
}

function makePrisma(rows: Array<{ stackId: string; serviceName: string; jobPoolConfig: unknown }>): FakePrisma {
  return {
    stackService: {
      findMany: vi.fn(async ({ where }: { where: { stackId?: string } }) => {
        if (where.stackId) {
          return rows.filter((r) => r.stackId === where.stackId);
        }
        // distinct stack-id call shape: returns [{ stackId }]
        const seen = new Set<string>();
        const out: Array<{ stackId: string }> = [];
        for (const r of rows) {
          if (!seen.has(r.stackId)) {
            seen.add(r.stackId);
            out.push({ stackId: r.stackId });
          }
        }
        return out;
      }),
    },
  };
}

const dockerExecutor = {} as unknown;
const resolveDockerExecutor = async () => dockerExecutor as never;

beforeEach(() => {
  scheduledTasks.length = 0;
  mocks.validateMock.mockClear();
  mocks.scheduleMock.mockClear();
  // Reset to the default implementation
  mocks.scheduleMock.mockImplementation(
    (schedule: string, _handler: unknown, opts?: { timezone?: string }) => {
      const task: FakeTask = { stop: vi.fn(), destroy: vi.fn() };
      scheduledTasks.push({ schedule, timezone: opts?.timezone, task });
      return task;
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('JobPoolCronRegistry.refresh', () => {
  it('registers a new cron trigger on first refresh', async () => {
    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [
            { kind: 'cron', schedule: '0 2 * * *', name: 'nightly' },
            { kind: 'manual', name: 'go' }, // ignored
          ],
          history: { retainDays: 7 },
        },
      },
    ]);
    const reg = new JobPoolCronRegistry(prisma as never, resolveDockerExecutor);

    await reg.refresh('stack-1');

    expect(reg.size()).toBe(1);
    expect(scheduledTasks).toHaveLength(1);
    expect(scheduledTasks[0].schedule).toBe('0 2 * * *');
  });

  it('removes a trigger on refresh after it disappears from the config', async () => {
    const prismaWithTrigger = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'cron', schedule: '*/5 * * * *', name: 'every-five' }],
          history: { retainDays: 7 },
        },
      },
    ]);
    const reg = new JobPoolCronRegistry(prismaWithTrigger as never, resolveDockerExecutor);
    await reg.refresh('stack-1');
    expect(reg.size()).toBe(1);
    const originalTask = scheduledTasks[0].task;

    // Re-point the mock at the same service with no triggers — refresh
    // should tear down the original registration.
    prismaWithTrigger.stackService.findMany = vi.fn(async () => [
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'manual', name: 'go' }],
          history: { retainDays: 7 },
        },
      },
    ]);

    await reg.refresh('stack-1');

    expect(reg.size()).toBe(0);
    expect(originalTask.stop).toHaveBeenCalledTimes(1);
  });

  it('orders unsubscribe before subscribe when a trigger schedule changes', async () => {
    // Order assertion is the plan §7 invariant — a rescheduled trigger
    // must have its old node-cron handle stopped *before* the new one is
    // scheduled. We track the absolute event order via a shared counter.
    let eventOrder = 0;
    const stopOrder: number[] = [];
    const scheduleOrder: number[] = [];

    // Re-mock to record order
    mocks.scheduleMock.mockImplementation(
      (schedule: string, _handler: unknown, opts?: { timezone?: string }) => {
        scheduleOrder.push(++eventOrder);
        const task: FakeTask = {
          stop: vi.fn(() => {
            stopOrder.push(++eventOrder);
          }),
          destroy: vi.fn(),
        };
        scheduledTasks.push({ schedule, timezone: opts?.timezone, task });
        return task;
      },
    );

    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'cron', schedule: '0 2 * * *', name: 'nightly' }],
          history: { retainDays: 7 },
        },
      },
    ]);
    const reg = new JobPoolCronRegistry(prisma as never, resolveDockerExecutor);
    await reg.refresh('stack-1');
    expect(scheduleOrder).toHaveLength(1);

    // Change the schedule and re-refresh
    prisma.stackService.findMany = vi.fn(async () => [
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'cron', schedule: '0 3 * * *', name: 'nightly' }],
          history: { retainDays: 7 },
        },
      },
    ]);
    await reg.refresh('stack-1');

    // Old task stopped, new task scheduled — *and* the stop ran before the
    // new schedule call.
    expect(stopOrder).toHaveLength(1);
    expect(scheduleOrder).toHaveLength(2);
    expect(stopOrder[0]).toBeLessThan(scheduleOrder[1]);
    expect(reg.size()).toBe(1);
    expect(scheduledTasks[1].schedule).toBe('0 3 * * *');
  });

  it('skips an unparseable cron schedule without failing the whole refresh', async () => {
    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [
            { kind: 'cron', schedule: 'not-a-cron', name: 'bad' },
            { kind: 'cron', schedule: '0 0 * * *', name: 'good' },
          ],
          history: { retainDays: 1 },
        },
      },
    ]);
    const reg = new JobPoolCronRegistry(prisma as never, resolveDockerExecutor);

    await reg.refresh('stack-1');

    // Only the good schedule was registered
    expect(reg.size()).toBe(1);
    expect(scheduledTasks).toHaveLength(1);
    expect(scheduledTasks[0].schedule).toBe('0 0 * * *');
  });

  it('removeStack tears down every trigger for the stack', async () => {
    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'a',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'cron', schedule: '* * * * *', name: 't1' }],
          history: { retainDays: 1 },
        },
      },
      {
        stackId: 'stack-1',
        serviceName: 'b',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'cron', schedule: '*/2 * * * *', name: 't2' }],
          history: { retainDays: 1 },
        },
      },
      {
        stackId: 'stack-2',
        serviceName: 'c',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'cron', schedule: '*/3 * * * *', name: 't3' }],
          history: { retainDays: 1 },
        },
      },
    ]);
    const reg = new JobPoolCronRegistry(prisma as never, resolveDockerExecutor);
    await reg.refresh('stack-1');
    await reg.refresh('stack-2');
    expect(reg.size()).toBe(3);

    reg.removeStack('stack-1');

    expect(reg.size()).toBe(1);
    expect(reg.registeredKeys()).toEqual(['stack-2::c::t3']);
  });

  it('loadAll re-establishes triggers from every JobPool stack in the DB', async () => {
    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'a',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'cron', schedule: '0 1 * * *', name: 't1' }],
          history: { retainDays: 1 },
        },
      },
      {
        stackId: 'stack-2',
        serviceName: 'c',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'cron', schedule: '0 2 * * *', name: 't2' }],
          history: { retainDays: 1 },
        },
      },
    ]);
    const reg = new JobPoolCronRegistry(prisma as never, resolveDockerExecutor);

    await reg.loadAll();

    expect(reg.size()).toBe(2);
    expect(reg.registeredKeys()).toEqual(['stack-1::a::t1', 'stack-2::c::t2']);
  });

  it('is idempotent on a no-change refresh', async () => {
    // beforeEach already reset the schedule mock to the default
    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'cron', schedule: '0 2 * * *', name: 'nightly' }],
          history: { retainDays: 7 },
        },
      },
    ]);
    const reg = new JobPoolCronRegistry(prisma as never, resolveDockerExecutor);
    await reg.refresh('stack-1');
    const firstCount = scheduledTasks.length;

    await reg.refresh('stack-1');

    // No new schedule calls — the existing entry was reused.
    expect(scheduledTasks.length).toBe(firstCount);
    expect(reg.size()).toBe(1);
  });
});
