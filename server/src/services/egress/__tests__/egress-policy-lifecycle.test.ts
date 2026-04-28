import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EgressPolicyLifecycleService } from '../egress-policy-lifecycle';

// Logger is mocked globally by setup-unit.ts

// Mock the egress index module so reconcileTemplateRules gateway push is a no-op
// during tests. Must be at the top level for vitest's module hoisting to work.
vi.mock('../index', () => ({
  getEgressRulePusher: () => ({
    pushForStack: vi.fn().mockResolvedValue(undefined),
  }),
}));

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
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  egressRule: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
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
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    egressRule: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
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

// ---------------------------------------------------------------------------
// reconcileTemplateRules helpers
// ---------------------------------------------------------------------------

function makeStackWithServices(
  services: Array<{ serviceName: string; requiredEgress?: string[] }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'stack-1',
    environmentId: 'env-1',
    services: services.map((svc) => ({
      serviceName: svc.serviceName,
      containerConfig: svc.requiredEgress
        ? { requiredEgress: svc.requiredEgress }
        : {},
    })),
    ...overrides,
  };
}

function makeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    policyId: 'policy-1',
    pattern: 'api.example.com',
    action: 'allow',
    source: 'template',
    targets: ['svc-a'],
    hits: 0,
    lastHitAt: null,
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// reconcileTemplateRules
// ---------------------------------------------------------------------------

describe('EgressPolicyLifecycleService.reconcileTemplateRules', () => {
  let prisma: MockPrisma;
  let service: EgressPolicyLifecycleService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makeMockPrisma();
    service = new EgressPolicyLifecycleService(prisma as any);
  });

  it('is a no-op for host-scoped stacks (environmentId === null)', async () => {
    prisma.stack.findUnique.mockResolvedValue(
      makeStackWithServices([], { environmentId: null }),
    );

    await service.reconcileTemplateRules('stack-1', 'user-1');

    expect(prisma.egressPolicy.findFirst).not.toHaveBeenCalled();
    expect(prisma.egressRule.create).not.toHaveBeenCalled();
  });

  it('is a no-op when stack is not found', async () => {
    prisma.stack.findUnique.mockResolvedValue(null);

    await service.reconcileTemplateRules('stack-1', 'user-1');

    expect(prisma.egressPolicy.findFirst).not.toHaveBeenCalled();
  });

  it('is a no-op when no active policy exists', async () => {
    prisma.stack.findUnique.mockResolvedValue(
      makeStackWithServices([{ serviceName: 'svc-a', requiredEgress: ['api.example.com'] }]),
    );
    prisma.egressPolicy.findFirst.mockResolvedValue(null);

    await service.reconcileTemplateRules('stack-1', 'user-1');

    expect(prisma.egressRule.create).not.toHaveBeenCalled();
  });

  it('creates rules for new required egress patterns', async () => {
    prisma.stack.findUnique.mockResolvedValue(
      makeStackWithServices([{ serviceName: 'svc-a', requiredEgress: ['api.example.com'] }]),
    );
    prisma.egressPolicy.findFirst.mockResolvedValue(makePolicy());
    prisma.egressRule.findMany.mockResolvedValue([]);
    const newRule = makeRule({ id: 'rule-new', targets: ['svc-a'] });
    prisma.egressRule.create.mockResolvedValue(newRule);
    prisma.egressPolicy.update.mockResolvedValue({ ...makePolicy(), version: 2 });

    await service.reconcileTemplateRules('stack-1', 'user-1');

    expect(prisma.egressRule.create).toHaveBeenCalledWith({
      data: {
        policyId: 'policy-1',
        pattern: 'api.example.com',
        action: 'allow',
        source: 'template',
        targets: ['svc-a'],
        createdBy: 'user-1',
        updatedBy: 'user-1',
      },
    });
  });

  it('deletes template rules whose pattern is no longer declared', async () => {
    prisma.stack.findUnique.mockResolvedValue(
      makeStackWithServices([]), // no requiredEgress
    );
    prisma.egressPolicy.findFirst.mockResolvedValue(makePolicy());
    prisma.egressRule.findMany.mockResolvedValue([
      makeRule({ id: 'rule-stale', pattern: 'old.example.com', targets: ['svc-x'] }),
    ]);
    prisma.egressRule.delete.mockResolvedValue({});
    prisma.egressPolicy.update.mockResolvedValue({ ...makePolicy(), version: 2 });

    await service.reconcileTemplateRules('stack-1', 'user-1');

    expect(prisma.egressRule.delete).toHaveBeenCalledWith({
      where: { id: 'rule-stale' },
    });
    expect(prisma.egressRule.create).not.toHaveBeenCalled();
  });

  it('updates targets when service set changes for an existing pattern', async () => {
    prisma.stack.findUnique.mockResolvedValue(
      makeStackWithServices([
        { serviceName: 'svc-a', requiredEgress: ['api.example.com'] },
        { serviceName: 'svc-b', requiredEgress: ['api.example.com'] },
      ]),
    );
    prisma.egressPolicy.findFirst.mockResolvedValue(makePolicy());
    // Existing rule only lists svc-a — now svc-b also declares it
    prisma.egressRule.findMany.mockResolvedValue([
      makeRule({ id: 'rule-1', pattern: 'api.example.com', targets: ['svc-a'] }),
    ]);
    prisma.egressRule.update.mockResolvedValue(
      makeRule({ id: 'rule-1', pattern: 'api.example.com', targets: ['svc-a', 'svc-b'] }),
    );
    prisma.egressPolicy.update.mockResolvedValue({ ...makePolicy(), version: 2 });

    await service.reconcileTemplateRules('stack-1', 'user-1');

    expect(prisma.egressRule.update).toHaveBeenCalledWith({
      where: { id: 'rule-1' },
      data: {
        targets: ['svc-a', 'svc-b'],
        updatedBy: 'user-1',
      },
    });
  });

  it('does not update a rule when targets are unchanged (idempotent)', async () => {
    prisma.stack.findUnique.mockResolvedValue(
      makeStackWithServices([{ serviceName: 'svc-a', requiredEgress: ['api.example.com'] }]),
    );
    prisma.egressPolicy.findFirst.mockResolvedValue(makePolicy());
    prisma.egressRule.findMany.mockResolvedValue([
      makeRule({ id: 'rule-1', pattern: 'api.example.com', targets: ['svc-a'] }),
    ]);
    // No update should be called — targets match exactly

    await service.reconcileTemplateRules('stack-1', 'user-1');

    expect(prisma.egressRule.update).not.toHaveBeenCalled();
    expect(prisma.egressRule.create).not.toHaveBeenCalled();
    expect(prisma.egressRule.delete).not.toHaveBeenCalled();
    expect(prisma.egressPolicy.update).not.toHaveBeenCalled();
  });

  it('merges multiple services declaring the same pattern into one rule', async () => {
    prisma.stack.findUnique.mockResolvedValue(
      makeStackWithServices([
        { serviceName: 'svc-a', requiredEgress: ['shared.example.com'] },
        { serviceName: 'svc-b', requiredEgress: ['shared.example.com'] },
        { serviceName: 'svc-c', requiredEgress: ['shared.example.com'] },
      ]),
    );
    prisma.egressPolicy.findFirst.mockResolvedValue(makePolicy());
    prisma.egressRule.findMany.mockResolvedValue([]);
    prisma.egressRule.create.mockResolvedValue(
      makeRule({ pattern: 'shared.example.com', targets: ['svc-a', 'svc-b', 'svc-c'] }),
    );
    prisma.egressPolicy.update.mockResolvedValue({ ...makePolicy(), version: 2 });

    await service.reconcileTemplateRules('stack-1', null);

    // Only ONE rule should be created (shared pattern)
    expect(prisma.egressRule.create).toHaveBeenCalledOnce();
    const createArgs = prisma.egressRule.create.mock.calls[0][0].data;
    expect(createArgs.pattern).toBe('shared.example.com');
    expect(createArgs.targets).toEqual(['svc-a', 'svc-b', 'svc-c']);
  });

  it('handles a mix of creates, updates, and deletes in one call', async () => {
    prisma.stack.findUnique.mockResolvedValue(
      makeStackWithServices([
        { serviceName: 'svc-a', requiredEgress: ['new.example.com', 'keep.example.com'] },
      ]),
    );
    prisma.egressPolicy.findFirst.mockResolvedValue(makePolicy());
    prisma.egressRule.findMany.mockResolvedValue([
      makeRule({ id: 'rule-keep', pattern: 'keep.example.com', targets: ['svc-a'] }),
      makeRule({ id: 'rule-old', pattern: 'stale.example.com', targets: ['svc-a'] }),
    ]);
    prisma.egressRule.create.mockResolvedValue(makeRule({ id: 'rule-new', pattern: 'new.example.com', targets: ['svc-a'] }));
    prisma.egressRule.delete.mockResolvedValue({});
    prisma.egressPolicy.update.mockResolvedValue({ ...makePolicy(), version: 3 });

    await service.reconcileTemplateRules('stack-1', 'user-1');

    // new.example.com should be created
    expect(prisma.egressRule.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pattern: 'new.example.com' }) }),
    );
    // keep.example.com targets unchanged — no update
    expect(prisma.egressRule.update).not.toHaveBeenCalled();
    // stale.example.com should be deleted
    expect(prisma.egressRule.delete).toHaveBeenCalledWith({ where: { id: 'rule-old' } });
    // policy version bumped twice (one create, one delete)
    expect(prisma.egressPolicy.update).toHaveBeenCalledWith({
      where: { id: 'policy-1' },
      data: expect.objectContaining({ version: { increment: 2 } }),
    });
  });

  it('does not throw when prisma throws', async () => {
    prisma.stack.findUnique.mockRejectedValue(new Error('DB error'));

    await expect(service.reconcileTemplateRules('stack-1', 'user-1')).resolves.toBeUndefined();
  });

  it('is a no-op for archived policy (policy not found via findFirst with archivedAt: null)', async () => {
    prisma.stack.findUnique.mockResolvedValue(
      makeStackWithServices([{ serviceName: 'svc-a', requiredEgress: ['api.example.com'] }]),
    );
    // findFirst with archivedAt: null returns null — simulates archived/no-policy scenario
    prisma.egressPolicy.findFirst.mockResolvedValue(null);

    await service.reconcileTemplateRules('stack-1', 'user-1');

    expect(prisma.egressRule.create).not.toHaveBeenCalled();
    expect(prisma.egressRule.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Schema validation for requiredEgress
// ---------------------------------------------------------------------------

describe('stackContainerConfigSchema — requiredEgress validation', () => {
  it('accepts valid FQDN entries', async () => {
    const { stackContainerConfigSchema } = await import('../../stacks/schemas');
    const result = stackContainerConfigSchema.safeParse({
      requiredEgress: ['api.example.com', 'storage.googleapis.com'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid wildcard entries', async () => {
    const { stackContainerConfigSchema } = await import('../../stacks/schemas');
    const result = stackContainerConfigSchema.safeParse({
      requiredEgress: ['*.cloudflare.com', '*.argotunnel.com'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects garbage patterns', async () => {
    const { stackContainerConfigSchema } = await import('../../stacks/schemas');
    const result = stackContainerConfigSchema.safeParse({
      requiredEgress: ['not-a-domain', '*.', '**bad.com'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects bare wildcard without suffix', async () => {
    const { stackContainerConfigSchema } = await import('../../stacks/schemas');
    const result = stackContainerConfigSchema.safeParse({
      requiredEgress: ['*'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts undefined requiredEgress (field is optional)', async () => {
    const { stackContainerConfigSchema } = await import('../../stacks/schemas');
    const result = stackContainerConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts empty array requiredEgress', async () => {
    const { stackContainerConfigSchema } = await import('../../stacks/schemas');
    const result = stackContainerConfigSchema.safeParse({ requiredEgress: [] });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration-style: create stack from template with requiredEgress → rules appear
// ---------------------------------------------------------------------------

describe('reconcileTemplateRules — integration-style: stack with requiredEgress creates template rules', () => {
  let prisma: MockPrisma;
  let service: EgressPolicyLifecycleService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makeMockPrisma();
    service = new EgressPolicyLifecycleService(prisma as any);
  });

  it('creates allow rules with source=template after stack creation', async () => {
    const stackId = 'stack-cf';
    const userId = 'user-1';

    // Simulate: cloudflare-tunnel template stack with requiredEgress
    prisma.stack.findUnique.mockResolvedValue({
      id: stackId,
      environmentId: 'env-internet',
      services: [
        {
          serviceName: 'cloudflared',
          containerConfig: {
            requiredEgress: ['*.cloudflare.com', '*.argotunnel.com'],
          },
        },
      ],
    });

    prisma.egressPolicy.findFirst.mockResolvedValue(
      makePolicy({ id: 'policy-cf', stackId, environmentId: 'env-internet' }),
    );
    prisma.egressRule.findMany.mockResolvedValue([]); // No existing template rules

    const ruleA = makeRule({ id: 'rule-cf-1', pattern: '*.cloudflare.com', targets: ['cloudflared'] });
    const ruleB = makeRule({ id: 'rule-cf-2', pattern: '*.argotunnel.com', targets: ['cloudflared'] });
    prisma.egressRule.create
      .mockResolvedValueOnce(ruleA)
      .mockResolvedValueOnce(ruleB);
    prisma.egressPolicy.update.mockResolvedValue({ ...makePolicy({ id: 'policy-cf' }), version: 3 });

    await service.reconcileTemplateRules(stackId, userId);

    // Verify two rules were created
    expect(prisma.egressRule.create).toHaveBeenCalledTimes(2);
    const patterns = prisma.egressRule.create.mock.calls.map(
      (call: [{ data: { pattern: string } }]) => call[0].data.pattern,
    );
    expect(patterns).toContain('*.cloudflare.com');
    expect(patterns).toContain('*.argotunnel.com');

    // Verify both rules use source='template' and action='allow'
    for (const [call] of prisma.egressRule.create.mock.calls as Array<[{ data: { source: string; action: string } }]>) {
      expect(call.data.source).toBe('template');
      expect(call.data.action).toBe('allow');
    }

    // Verify policy version was bumped
    expect(prisma.egressPolicy.update).toHaveBeenCalledWith({
      where: { id: 'policy-cf' },
      data: expect.objectContaining({ version: { increment: 2 } }),
    });
  });
});
