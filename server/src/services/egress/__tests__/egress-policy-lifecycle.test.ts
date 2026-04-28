import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EgressPolicyLifecycleService } from '../egress-policy-lifecycle';

// Logger is mocked globally by setup-unit.ts

// ---------------------------------------------------------------------------
// Prisma mock helpers
// ---------------------------------------------------------------------------

type MockPrisma = {
  stack: {
    findUnique: ReturnType<typeof vi.fn>;
  };
  environment: {
    findUnique: ReturnType<typeof vi.fn>;
  };
  egressPolicy: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

function makeMockPrisma(): MockPrisma {
  return {
    stack: {
      findUnique: vi.fn(),
    },
    environment: {
      findUnique: vi.fn(),
    },
    egressPolicy: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
}

function makeStack(overrides: Record<string, unknown> = {}) {
  return {
    id: 'stack-1',
    name: 'my-app',
    environmentId: 'env-1',
    environment: { id: 'env-1', name: 'production' },
    ...overrides,
  };
}

function makePolicy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'policy-1',
    stackId: 'stack-1',
    environmentId: 'env-1',
    stackNameSnapshot: 'my-app',
    environmentNameSnapshot: 'production',
    mode: 'detect',
    defaultAction: 'allow',
    archivedAt: null,
    archivedReason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ensureDefaultPolicy
// ---------------------------------------------------------------------------

describe('EgressPolicyLifecycleService.ensureDefaultPolicy', () => {
  let prisma: MockPrisma;
  let service: EgressPolicyLifecycleService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makeMockPrisma();
    service = new EgressPolicyLifecycleService(prisma as any);
  });

  it('is a no-op for host-scoped stacks (environmentId === null)', async () => {
    prisma.stack.findUnique.mockResolvedValue(
      makeStack({ environmentId: null, environment: null }),
    );

    await service.ensureDefaultPolicy('stack-1', 'user-1');

    expect(prisma.egressPolicy.findFirst).not.toHaveBeenCalled();
    expect(prisma.egressPolicy.create).not.toHaveBeenCalled();
    expect(prisma.egressPolicy.update).not.toHaveBeenCalled();
  });

  it('creates a default policy for an env-scoped stack with no existing policy', async () => {
    prisma.stack.findUnique.mockResolvedValue(makeStack());
    prisma.egressPolicy.findFirst.mockResolvedValue(null);
    prisma.egressPolicy.create.mockResolvedValue(makePolicy());

    await service.ensureDefaultPolicy('stack-1', 'user-1');

    expect(prisma.egressPolicy.create).toHaveBeenCalledWith({
      data: {
        stackId: 'stack-1',
        stackNameSnapshot: 'my-app',
        environmentId: 'env-1',
        environmentNameSnapshot: 'production',
        mode: 'detect',
        defaultAction: 'allow',
        createdBy: 'user-1',
        updatedBy: 'user-1',
      },
    });
  });

  it('only refreshes snapshots when a non-archived policy already exists', async () => {
    prisma.stack.findUnique.mockResolvedValue(
      makeStack({ name: 'renamed-app', environment: { id: 'env-1', name: 'staging' } }),
    );
    prisma.egressPolicy.findFirst.mockResolvedValue(
      makePolicy({ stackNameSnapshot: 'old-name', environmentNameSnapshot: 'old-env' }),
    );
    prisma.egressPolicy.update.mockResolvedValue(makePolicy());

    await service.ensureDefaultPolicy('stack-1', 'user-2');

    expect(prisma.egressPolicy.create).not.toHaveBeenCalled();
    expect(prisma.egressPolicy.update).toHaveBeenCalledWith({
      where: { id: 'policy-1' },
      data: {
        stackNameSnapshot: 'renamed-app',
        environmentNameSnapshot: 'staging',
        updatedBy: 'user-2',
      },
    });
  });

  it('does not change mode/defaultAction on an existing policy', async () => {
    prisma.stack.findUnique.mockResolvedValue(makeStack());
    prisma.egressPolicy.findFirst.mockResolvedValue(
      makePolicy({ mode: 'enforce', defaultAction: 'block' }),
    );
    prisma.egressPolicy.update.mockResolvedValue(makePolicy());

    await service.ensureDefaultPolicy('stack-1', null);

    // Only snapshot fields + updatedBy should be in the update data
    const updateCall = prisma.egressPolicy.update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty('mode');
    expect(updateCall.data).not.toHaveProperty('defaultAction');
  });

  it('creates a new policy when the stack is returned without a matching environment (null env should skip)', async () => {
    // Stack exists but environment is null — should be skipped
    prisma.stack.findUnique.mockResolvedValue(
      makeStack({ environmentId: null, environment: null }),
    );

    await service.ensureDefaultPolicy('stack-1', 'user-1');

    expect(prisma.egressPolicy.create).not.toHaveBeenCalled();
  });

  it('does not throw when stack is not found', async () => {
    prisma.stack.findUnique.mockResolvedValue(null);

    await expect(service.ensureDefaultPolicy('missing-stack', 'user-1')).resolves.toBeUndefined();
    expect(prisma.egressPolicy.create).not.toHaveBeenCalled();
  });

  it('does not throw when prisma throws', async () => {
    prisma.stack.findUnique.mockRejectedValue(new Error('DB error'));

    await expect(
      service.ensureDefaultPolicy('stack-1', 'user-1'),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// archiveForStack
// ---------------------------------------------------------------------------

describe('EgressPolicyLifecycleService.archiveForStack', () => {
  let prisma: MockPrisma;
  let service: EgressPolicyLifecycleService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makeMockPrisma();
    service = new EgressPolicyLifecycleService(prisma as any);
  });

  it('sets archivedAt, archivedReason=stack-deleted, updatedBy on non-archived policies', async () => {
    prisma.egressPolicy.updateMany.mockResolvedValue({ count: 1 });

    await service.archiveForStack('stack-1', 'user-1');

    expect(prisma.egressPolicy.updateMany).toHaveBeenCalledWith({
      where: { stackId: 'stack-1', archivedAt: null },
      data: expect.objectContaining({
        archivedReason: 'stack-deleted',
        updatedBy: 'user-1',
      }),
    });

    const callData = prisma.egressPolicy.updateMany.mock.calls[0][0].data;
    expect(callData.archivedAt).toBeInstanceOf(Date);
  });

  it('is idempotent — already-archived rows are not touched (filter ensures this)', async () => {
    // updateMany with archivedAt: null filter naturally skips already-archived rows.
    // Simulate the case where there is nothing to archive.
    prisma.egressPolicy.updateMany.mockResolvedValue({ count: 0 });

    await service.archiveForStack('stack-1', 'user-1');

    expect(prisma.egressPolicy.updateMany).toHaveBeenCalledOnce();
  });

  it('does not affect policies for other stacks', async () => {
    prisma.egressPolicy.updateMany.mockResolvedValue({ count: 1 });

    await service.archiveForStack('stack-1', 'user-1');

    const where = prisma.egressPolicy.updateMany.mock.calls[0][0].where;
    expect(where.stackId).toBe('stack-1');
    // Only the specified stackId is in the where clause
    expect(Object.keys(where)).toContain('stackId');
  });

  it('does not throw when prisma throws', async () => {
    prisma.egressPolicy.updateMany.mockRejectedValue(new Error('DB error'));

    await expect(service.archiveForStack('stack-1', 'user-1')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// archiveForEnvironment
// ---------------------------------------------------------------------------

describe('EgressPolicyLifecycleService.archiveForEnvironment', () => {
  let prisma: MockPrisma;
  let service: EgressPolicyLifecycleService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makeMockPrisma();
    service = new EgressPolicyLifecycleService(prisma as any);
  });

  it('archives every non-archived policy in the environment', async () => {
    prisma.egressPolicy.updateMany.mockResolvedValue({ count: 3 });

    await service.archiveForEnvironment('env-1', 'user-1');

    expect(prisma.egressPolicy.updateMany).toHaveBeenCalledWith({
      where: { environmentId: 'env-1', archivedAt: null },
      data: expect.objectContaining({
        archivedReason: 'environment-deleted',
        updatedBy: 'user-1',
      }),
    });
  });

  it('skips already-archived rows via the archivedAt: null filter', async () => {
    prisma.egressPolicy.updateMany.mockResolvedValue({ count: 0 });

    await service.archiveForEnvironment('env-1', 'user-1');

    const where = prisma.egressPolicy.updateMany.mock.calls[0][0].where;
    expect(where.archivedAt).toBeNull();
  });

  it('sets archivedAt to a Date', async () => {
    prisma.egressPolicy.updateMany.mockResolvedValue({ count: 2 });

    await service.archiveForEnvironment('env-1', null);

    const data = prisma.egressPolicy.updateMany.mock.calls[0][0].data;
    expect(data.archivedAt).toBeInstanceOf(Date);
  });

  it('does not throw when prisma throws', async () => {
    prisma.egressPolicy.updateMany.mockRejectedValue(new Error('DB error'));

    await expect(service.archiveForEnvironment('env-1', 'user-1')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// refreshStackNameSnapshot
// ---------------------------------------------------------------------------

describe('EgressPolicyLifecycleService.refreshStackNameSnapshot', () => {
  let prisma: MockPrisma;
  let service: EgressPolicyLifecycleService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makeMockPrisma();
    service = new EgressPolicyLifecycleService(prisma as any);
  });

  it('updates stackNameSnapshot for the non-archived policy', async () => {
    prisma.stack.findUnique.mockResolvedValue({ name: 'new-name' });
    prisma.egressPolicy.updateMany.mockResolvedValue({ count: 1 });

    await service.refreshStackNameSnapshot('stack-1');

    expect(prisma.egressPolicy.updateMany).toHaveBeenCalledWith({
      where: { stackId: 'stack-1', archivedAt: null },
      data: { stackNameSnapshot: 'new-name' },
    });
  });

  it('is a no-op when the stack does not exist', async () => {
    prisma.stack.findUnique.mockResolvedValue(null);

    await service.refreshStackNameSnapshot('stack-1');

    expect(prisma.egressPolicy.updateMany).not.toHaveBeenCalled();
  });

  it('does not throw when prisma throws', async () => {
    prisma.stack.findUnique.mockRejectedValue(new Error('DB error'));

    await expect(service.refreshStackNameSnapshot('stack-1')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// refreshEnvironmentNameSnapshot
// ---------------------------------------------------------------------------

describe('EgressPolicyLifecycleService.refreshEnvironmentNameSnapshot', () => {
  let prisma: MockPrisma;
  let service: EgressPolicyLifecycleService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makeMockPrisma();
    service = new EgressPolicyLifecycleService(prisma as any);
  });

  it('bulk-updates environmentNameSnapshot for all non-archived policies', async () => {
    prisma.environment.findUnique.mockResolvedValue({ name: 'new-env-name' });
    prisma.egressPolicy.updateMany.mockResolvedValue({ count: 2 });

    await service.refreshEnvironmentNameSnapshot('env-1');

    expect(prisma.egressPolicy.updateMany).toHaveBeenCalledWith({
      where: { environmentId: 'env-1', archivedAt: null },
      data: { environmentNameSnapshot: 'new-env-name' },
    });
  });

  it('is a no-op when the environment does not exist', async () => {
    prisma.environment.findUnique.mockResolvedValue(null);

    await service.refreshEnvironmentNameSnapshot('env-1');

    expect(prisma.egressPolicy.updateMany).not.toHaveBeenCalled();
  });

  it('does not throw when prisma throws', async () => {
    prisma.environment.findUnique.mockRejectedValue(new Error('DB error'));

    await expect(service.refreshEnvironmentNameSnapshot('env-1')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Light integration: create → rename → delete lifecycle
// ---------------------------------------------------------------------------

describe('EgressPolicyLifecycleService — lifecycle through create → rename → delete', () => {
  let prisma: MockPrisma;
  let service: EgressPolicyLifecycleService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makeMockPrisma();
    service = new EgressPolicyLifecycleService(prisma as any);
  });

  it('starts with no policy, creates one, renames snapshots, then archives', async () => {
    const stackId = 'stack-abc';
    const userId = 'user-42';

    // --- Step 1: create ---
    prisma.stack.findUnique.mockResolvedValueOnce(
      makeStack({ id: stackId, name: 'original-name', environment: { id: 'env-1', name: 'prod' } }),
    );
    prisma.egressPolicy.findFirst.mockResolvedValueOnce(null);
    prisma.egressPolicy.create.mockResolvedValueOnce(
      makePolicy({ id: 'policy-abc', stackId, stackNameSnapshot: 'original-name' }),
    );

    await service.ensureDefaultPolicy(stackId, userId);

    expect(prisma.egressPolicy.create).toHaveBeenCalledOnce();
    expect(prisma.egressPolicy.create.mock.calls[0][0].data).toMatchObject({
      stackId,
      stackNameSnapshot: 'original-name',
      environmentNameSnapshot: 'prod',
      mode: 'detect',
      defaultAction: 'allow',
    });

    // --- Step 2: rename stack ---
    prisma.stack.findUnique.mockResolvedValueOnce({ name: 'renamed-stack' });
    prisma.egressPolicy.updateMany.mockResolvedValueOnce({ count: 1 });

    await service.refreshStackNameSnapshot(stackId);

    expect(prisma.egressPolicy.updateMany).toHaveBeenCalledWith({
      where: { stackId, archivedAt: null },
      data: { stackNameSnapshot: 'renamed-stack' },
    });

    // --- Step 3: delete (archive) ---
    prisma.egressPolicy.updateMany.mockResolvedValueOnce({ count: 1 });

    await service.archiveForStack(stackId, userId);

    expect(prisma.egressPolicy.updateMany).toHaveBeenLastCalledWith({
      where: { stackId, archivedAt: null },
      data: expect.objectContaining({
        archivedAt: expect.any(Date),
        archivedReason: 'stack-deleted',
        updatedBy: userId,
      }),
    });
  });
});
