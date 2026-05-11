import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobPoolConfig, JobPoolTrigger } from '@mini-infra/types';
import { stackDefinitionSchema, jobPoolConfigSchema } from '../schemas';
import { runJobPool } from '../job-pool-spawner';

function baseJobPool(overrides: Record<string, unknown> = {}) {
  return {
    serviceName: 'backup',
    serviceType: 'JobPool' as const,
    dockerImage: 'ghcr.io/org/backup',
    dockerTag: '1.0.0',
    dependsOn: [],
    order: 0,
    containerConfig: { env: {} },
    jobPoolConfig: {
      maxConcurrent: 2,
      managedBy: null,
      triggers: [{ kind: 'manual', name: 'run-now' }],
      history: { retainDays: 14 },
    },
    ...overrides,
  };
}

function wrap(services: unknown[]) {
  return {
    name: 'pg-az-backup',
    networks: [],
    volumes: [],
    services,
  };
}

describe('JobPool schema validation', () => {
  it('accepts a valid JobPool with a manual trigger', () => {
    const result = stackDefinitionSchema.safeParse(wrap([baseJobPool()]));
    expect(result.success).toBe(true);
  });

  it('rejects a JobPool service without jobPoolConfig', () => {
    const result = stackDefinitionSchema.safeParse(
      wrap([baseJobPool({ jobPoolConfig: undefined })]),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a JobPool service with routing', () => {
    const result = stackDefinitionSchema.safeParse(
      wrap([
        baseJobPool({
          routing: { hostname: 'x.example.com', listeningPort: 80 },
        }),
      ]),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a JobPool with no triggers', () => {
    const result = jobPoolConfigSchema.safeParse({
      maxConcurrent: 1,
      managedBy: null,
      triggers: [],
      history: { retainDays: 7 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a JobPool with maxConcurrent: 0', () => {
    const result = jobPoolConfigSchema.safeParse({
      maxConcurrent: 0,
      managedBy: null,
      triggers: [{ kind: 'manual', name: 'go' }],
      history: { retainDays: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts maxConcurrent: null (unlimited)', () => {
    const result = jobPoolConfigSchema.safeParse({
      maxConcurrent: null,
      managedBy: null,
      triggers: [{ kind: 'manual', name: 'go' }],
      history: { retainDays: 7 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unparseable cron schedule', () => {
    const result = jobPoolConfigSchema.safeParse({
      maxConcurrent: 1,
      managedBy: null,
      triggers: [
        { kind: 'cron', schedule: 'not a cron expression', name: 'nightly' },
      ],
      history: { retainDays: 7 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid cron schedule', () => {
    const result = jobPoolConfigSchema.safeParse({
      maxConcurrent: 1,
      managedBy: null,
      triggers: [
        { kind: 'cron', schedule: '0 2 * * *', name: 'nightly' },
      ],
      history: { retainDays: 7 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a NATS subject starting with a wildcard', () => {
    const result = jobPoolConfigSchema.safeParse({
      maxConcurrent: 1,
      managedBy: null,
      triggers: [
        { kind: 'nats-request', subject: '>.run', ackWithRunId: false, name: 'bus' },
      ],
      history: { retainDays: 7 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a NATS subject under $SYS', () => {
    const result = jobPoolConfigSchema.safeParse({
      maxConcurrent: 1,
      managedBy: null,
      triggers: [
        { kind: 'nats-request', subject: '$SYS.run', ackWithRunId: false, name: 'sys' },
      ],
      history: { retainDays: 7 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a well-formed NATS subject', () => {
    const result = jobPoolConfigSchema.safeParse({
      maxConcurrent: 1,
      managedBy: null,
      triggers: [
        {
          kind: 'nats-request',
          subject: 'mini-infra.backup.run',
          ackWithRunId: true,
          name: 'bus',
        },
      ],
      history: { retainDays: 7 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects duplicate trigger names within one pool', () => {
    const result = jobPoolConfigSchema.safeParse({
      maxConcurrent: 1,
      managedBy: null,
      triggers: [
        { kind: 'manual', name: 'run' },
        { kind: 'cron', schedule: '*/5 * * * *', name: 'run' },
      ],
      history: { retainDays: 1 },
    });
    expect(result.success).toBe(false);
  });
});

describe('JobPoolTrigger type narrowing', () => {
  // Compile-time + runtime check: the discriminated union narrows correctly so
  // downstream code reads only the fields a given kind exposes.
  it('narrows a cron trigger to its kind-specific fields', () => {
    const trigger: JobPoolTrigger = {
      kind: 'cron',
      schedule: '0 0 * * *',
      timezone: 'UTC',
      name: 'midnight',
    };
    expect(trigger.kind).toBe('cron');
    if (trigger.kind === 'cron') {
      // schedule + timezone visible only on the cron branch
      expect(trigger.schedule).toBe('0 0 * * *');
      expect(trigger.timezone).toBe('UTC');
    }
  });

  it('narrows a nats-request trigger to its kind-specific fields', () => {
    const trigger: JobPoolTrigger = {
      kind: 'nats-request',
      subject: 'mini-infra.backup.run',
      ackWithRunId: true,
      name: 'bus',
    };
    if (trigger.kind === 'nats-request') {
      expect(trigger.subject).toBe('mini-infra.backup.run');
      expect(trigger.ackWithRunId).toBe(true);
    }
  });

  it('narrows a manual trigger to only `name`', () => {
    const trigger: JobPoolTrigger = { kind: 'manual', name: 'run-now' };
    if (trigger.kind === 'manual') {
      expect(trigger.name).toBe('run-now');
    }
  });
});

describe('runJobPool cap-check logic', () => {
  type MockedPrisma = {
    stackService: { findFirst: ReturnType<typeof vi.fn> };
    stack: { findUnique: ReturnType<typeof vi.fn> };
    poolInstance: {
      count: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };

  function buildPrisma(
    jobPoolConfig: JobPoolConfig,
    initialActiveCount: number,
  ): MockedPrisma {
    const prisma: MockedPrisma = {
      stackService: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'svc-1',
          stackId: 'stack-1',
          serviceName: 'backup',
          serviceType: 'JobPool',
          jobPoolConfig,
        }),
      },
      stack: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'stack-1',
          name: 'pg-az-backup',
          status: 'synced',
          environmentId: null,
          environment: null,
        }),
      },
      poolInstance: {
        count: vi.fn().mockResolvedValue(initialActiveCount),
        create: vi.fn().mockImplementation(async ({ data }) => ({
          id: 'row-1',
          ...data,
          containerId: null,
          lastActive: new Date(),
          createdAt: new Date(),
          stoppedAt: null,
          errorMessage: null,
        })),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn().mockImplementation(async (fn: (tx: MockedPrisma) => unknown) => fn(prisma)),
    };
    return prisma;
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fails fast with concurrency_cap when active >= maxConcurrent', async () => {
    const jobPoolConfig: JobPoolConfig = {
      maxConcurrent: 2,
      managedBy: null,
      triggers: [{ kind: 'manual', name: 'run-now' }],
      history: { retainDays: 7 },
    };
    const prisma = buildPrisma(jobPoolConfig, 2);

    const result = await runJobPool(
      prisma as unknown as Parameters<typeof runJobPool>[0],
      // dockerExecutor isn't touched on the cap-hit path — pass undefined
      // cast through `unknown` so the test stays a pure unit test.
      undefined as unknown as Parameters<typeof runJobPool>[1],
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        trigger: { kind: 'manual', name: 'run-now' },
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'concurrency_cap',
      maxConcurrent: 2,
    });
    expect(prisma.poolInstance.create).not.toHaveBeenCalled();
  });

  it('does NOT cap-check when maxConcurrent is null (unlimited)', async () => {
    const jobPoolConfig: JobPoolConfig = {
      maxConcurrent: null,
      managedBy: null,
      triggers: [{ kind: 'manual', name: 'run-now' }],
      history: { retainDays: 7 },
    };
    const prisma = buildPrisma(jobPoolConfig, 9999);

    // spawnPoolInstance will be invoked but we don't want to wire the whole
    // docker executor up. Throw from the spawn step to short-circuit cleanly
    // — the assertion is that the reservation happened (cap-check skipped)
    // before the spawn call.
    const dockerExecutor = {} as unknown;

    const result = await runJobPool(
      prisma as unknown as Parameters<typeof runJobPool>[0],
      dockerExecutor as Parameters<typeof runJobPool>[1],
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        trigger: { kind: 'manual', name: 'run-now' },
      },
    );

    expect(prisma.poolInstance.count).not.toHaveBeenCalled();
    expect(prisma.poolInstance.create).toHaveBeenCalledTimes(1);
    // Spawn step crashes because the docker executor isn't wired up — runJobPool
    // catches and reports `spawn_failed`. The fact that we got that far is the
    // assertion: cap was not enforced, reservation happened.
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('spawn_failed');
    }
  });

  it('returns service_not_found when the service does not exist', async () => {
    const prisma = buildPrisma(
      {
        maxConcurrent: 1,
        managedBy: null,
        triggers: [{ kind: 'manual', name: 'go' }],
        history: { retainDays: 1 },
      },
      0,
    );
    prisma.stackService.findFirst.mockResolvedValueOnce(null);

    const result = await runJobPool(
      prisma as unknown as Parameters<typeof runJobPool>[0],
      undefined as unknown as Parameters<typeof runJobPool>[1],
      {
        stackId: 'stack-1',
        serviceName: 'nonexistent',
        trigger: { kind: 'manual', name: 'go' },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('service_not_found');
    }
  });

  it('returns stack_in_error when the stack is in error state', async () => {
    const prisma = buildPrisma(
      {
        maxConcurrent: 1,
        managedBy: null,
        triggers: [{ kind: 'manual', name: 'go' }],
        history: { retainDays: 1 },
      },
      0,
    );
    prisma.stack.findUnique.mockResolvedValueOnce({
      id: 'stack-1',
      name: 'pg-az-backup',
      status: 'error',
      environmentId: null,
      environment: null,
    });

    const result = await runJobPool(
      prisma as unknown as Parameters<typeof runJobPool>[0],
      undefined as unknown as Parameters<typeof runJobPool>[1],
      {
        stackId: 'stack-1',
        serviceName: 'backup',
        trigger: { kind: 'manual', name: 'go' },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('stack_in_error');
    }
    expect(prisma.poolInstance.create).not.toHaveBeenCalled();
  });
});
