import { describe, it, expect, vi, beforeEach } from 'vitest';

type Subscription = {
  subject: string;
  handler: (req: unknown) => Promise<unknown> | unknown;
  cancel: ReturnType<typeof vi.fn>;
};

// Hoisted shared state so the vi.mock factories below can see it.
const mocks = vi.hoisted(() => {
  const state = {
    liveSubs: [] as Array<{
      subject: string;
      handler: (req: unknown) => Promise<unknown> | unknown;
      cancel: ReturnType<typeof vi.fn>;
    }>,
    subscribeOrder: [] as Array<{ subject: string; op: number }>,
    cancelOrder: [] as Array<{ subject: string; op: number }>,
    opCounter: 0,
  };
  return {
    state,
    runJobPoolMock: vi.fn(async () => ({
      ok: true,
      runId: 'run-123',
      instanceRowId: 'row-1',
      containerId: 'c1',
    })),
    respondMock: vi.fn(
      (
        subject: string,
        handler: (req: unknown) => Promise<unknown> | unknown,
      ) => {
        const op = ++state.opCounter;
        state.subscribeOrder.push({ subject, op });
        const sub = {
          subject,
          handler,
          cancel: vi.fn(() => {
            state.cancelOrder.push({ subject: sub.subject, op: ++state.opCounter });
            const idx = state.liveSubs.indexOf(sub);
            if (idx >= 0) state.liveSubs.splice(idx, 1);
          }),
        };
        state.liveSubs.push(sub);
        return sub.cancel as () => void;
      },
    ),
  };
});

vi.mock('../job-pool-spawner', () => ({
  runJobPool: mocks.runJobPoolMock,
}));

vi.mock('../../nats/nats-bus', () => ({
  NatsBus: {
    getInstance: () => ({
      respond: mocks.respondMock,
    }),
  },
}));

const liveSubs = mocks.state.liveSubs as Subscription[];
const subscribeOrder = mocks.state.subscribeOrder;
const cancelOrder = mocks.state.cancelOrder;
const runJobPoolMock = mocks.runJobPoolMock;

import { JobPoolNatsRegistry } from '../job-pool-nats-registry';

function makePrisma(
  rows: Array<{ stackId: string; serviceName: string; jobPoolConfig: unknown; natsCredentialId?: string | null }>,
) {
  return {
    stackService: {
      findMany: vi.fn(async ({ where }: { where: { stackId?: string } }) => {
        if (where.stackId) return rows.filter((r) => r.stackId === where.stackId);
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

const resolveDockerExecutor = async () => ({} as never);

beforeEach(() => {
  liveSubs.length = 0;
  subscribeOrder.length = 0;
  cancelOrder.length = 0;
  mocks.state.opCounter = 0;
  runJobPoolMock.mockClear();
  mocks.respondMock.mockClear();
});

describe('JobPoolNatsRegistry.refresh', () => {
  it('subscribes a new nats-request trigger on first refresh', async () => {
    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [
            {
              kind: 'nats-request',
              subject: 'mini-infra.backup.run',
              ackWithRunId: true,
              name: 'bus',
            },
            { kind: 'manual', name: 'go' }, // ignored
          ],
          history: { retainDays: 7 },
        },
      },
    ]);
    const reg = new JobPoolNatsRegistry(prisma as never, resolveDockerExecutor);

    await reg.refresh('stack-1');

    expect(reg.size()).toBe(1);
    expect(reg.registeredSubjects()).toEqual(['mini-infra.backup.run']);
    expect(liveSubs).toHaveLength(1);
  });

  it('orders unsubscribe before subscribe when the subject changes', async () => {
    // Plan §7 ordering invariant — unsubscribe-on-apply runs before
    // subscribe-on-apply within a refresh cycle so two handlers never
    // race on the same subject.
    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [
            { kind: 'nats-request', subject: 'a.b.c', ackWithRunId: true, name: 'r1' },
          ],
          history: { retainDays: 1 },
        },
      },
    ]);
    const reg = new JobPoolNatsRegistry(prisma as never, resolveDockerExecutor);
    await reg.refresh('stack-1');
    expect(subscribeOrder.map((s) => s.subject)).toEqual(['a.b.c']);

    // Rename the subject — the refresh must cancel the old subscription
    // before creating the new one.
    prisma.stackService.findMany = vi.fn(async () => [
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [
            { kind: 'nats-request', subject: 'd.e.f', ackWithRunId: true, name: 'r1' },
          ],
          history: { retainDays: 1 },
        },
      },
    ]);
    await reg.refresh('stack-1');

    expect(cancelOrder).toHaveLength(1);
    expect(cancelOrder[0].subject).toBe('a.b.c');
    expect(subscribeOrder).toHaveLength(2);
    expect(subscribeOrder[1].subject).toBe('d.e.f');
    expect(cancelOrder[0].op).toBeLessThan(subscribeOrder[1].op);
    expect(reg.registeredSubjects()).toEqual(['d.e.f']);
  });

  it('returns { runId } on successful trigger fire', async () => {
    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [
            { kind: 'nats-request', subject: 'x.run', ackWithRunId: true, name: 'r1' },
          ],
          history: { retainDays: 1 },
        },
      },
    ]);
    const reg = new JobPoolNatsRegistry(prisma as never, resolveDockerExecutor);
    await reg.refresh('stack-1');

    const sub = liveSubs[0];
    const reply = await sub.handler({ foo: 'bar' });

    expect(runJobPoolMock).toHaveBeenCalledTimes(1);
    const passed = runJobPoolMock.mock.calls[0][2];
    expect(passed).toMatchObject({
      stackId: 'stack-1',
      serviceName: 'backup',
      trigger: { kind: 'nats-request', name: 'r1' },
      payload: { foo: 'bar' },
    });
    expect(reply).toEqual({ runId: 'run-123' });
  });

  it('returns concurrency_cap_reached reply on cap-hit', async () => {
    runJobPoolMock.mockResolvedValueOnce({
      ok: false,
      reason: 'concurrency_cap',
      maxConcurrent: 2,
    } as never);

    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 2,
          managedBy: null,
          triggers: [
            { kind: 'nats-request', subject: 'x.run', ackWithRunId: true, name: 'r1' },
          ],
          history: { retainDays: 1 },
        },
      },
    ]);
    const reg = new JobPoolNatsRegistry(prisma as never, resolveDockerExecutor);
    await reg.refresh('stack-1');

    const reply = await liveSubs[0].handler({});

    expect(reply).toEqual({ error: 'concurrency_cap_reached', maxConcurrent: 2 });
  });

  it('tolerates a null request body (empty payload)', async () => {
    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [
            { kind: 'nats-request', subject: 'x.run', ackWithRunId: true, name: 'r1' },
          ],
          history: { retainDays: 1 },
        },
      },
    ]);
    const reg = new JobPoolNatsRegistry(prisma as never, resolveDockerExecutor);
    await reg.refresh('stack-1');

    const reply = await liveSubs[0].handler(null);

    expect(reply).toEqual({ runId: 'run-123' });
    expect(runJobPoolMock.mock.calls[0][2]).toMatchObject({
      payload: undefined,
    });
  });

  it('rejects malformed payloads with an error reply (does not spawn)', async () => {
    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [
            { kind: 'nats-request', subject: 'x.run', ackWithRunId: true, name: 'r1' },
          ],
          history: { retainDays: 1 },
        },
      },
    ]);
    const reg = new JobPoolNatsRegistry(prisma as never, resolveDockerExecutor);
    await reg.refresh('stack-1');

    // Non-object — should fail validation
    const reply = await liveSubs[0].handler('this is not an object');

    expect(runJobPoolMock).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ error: expect.any(String) });
  });

  it('removeStack cancels every subscription for the stack', async () => {
    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'a',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'nats-request', subject: 's1', ackWithRunId: true, name: 'r1' }],
          history: { retainDays: 1 },
        },
      },
      {
        stackId: 'stack-1',
        serviceName: 'b',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'nats-request', subject: 's2', ackWithRunId: true, name: 'r2' }],
          history: { retainDays: 1 },
        },
      },
      {
        stackId: 'stack-2',
        serviceName: 'c',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'nats-request', subject: 's3', ackWithRunId: true, name: 'r3' }],
          history: { retainDays: 1 },
        },
      },
    ]);
    const reg = new JobPoolNatsRegistry(prisma as never, resolveDockerExecutor);
    await reg.refresh('stack-1');
    await reg.refresh('stack-2');
    expect(reg.size()).toBe(3);

    reg.removeStack('stack-1');

    expect(reg.size()).toBe(1);
    expect(reg.registeredSubjects()).toEqual(['s3']);
  });

  it('loadAll subscribes triggers from every JobPool stack in the DB', async () => {
    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'a',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'nats-request', subject: 's1', ackWithRunId: true, name: 'r1' }],
          history: { retainDays: 1 },
        },
      },
      {
        stackId: 'stack-2',
        serviceName: 'c',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'nats-request', subject: 's2', ackWithRunId: true, name: 'r2' }],
          history: { retainDays: 1 },
        },
      },
    ]);
    const reg = new JobPoolNatsRegistry(prisma as never, resolveDockerExecutor);

    await reg.loadAll();

    expect(reg.size()).toBe(2);
    expect(reg.registeredSubjects()).toEqual(['s1', 's2']);
  });

  it('is idempotent on a no-change refresh', async () => {
    const prisma = makePrisma([
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        jobPoolConfig: {
          maxConcurrent: 1,
          managedBy: null,
          triggers: [{ kind: 'nats-request', subject: 's1', ackWithRunId: true, name: 'r1' }],
          history: { retainDays: 1 },
        },
      },
    ]);
    const reg = new JobPoolNatsRegistry(prisma as never, resolveDockerExecutor);
    await reg.refresh('stack-1');
    const firstSubCount = subscribeOrder.length;

    await reg.refresh('stack-1');

    expect(subscribeOrder.length).toBe(firstSubCount);
    expect(cancelOrder.length).toBe(0);
    expect(reg.size()).toBe(1);
  });
});
