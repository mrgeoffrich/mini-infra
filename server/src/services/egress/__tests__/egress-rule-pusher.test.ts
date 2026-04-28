/**
 * Tests for EgressRulePusher
 */

import { EgressRulePusher } from '../egress-rule-pusher';
import type { PrismaClient } from '../../../generated/prisma/client';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('../../../lib/logger-factory', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Track pushRules calls — module-level so the mock closure can reference it.
const pushRulesCalls: Array<{ version: number; stackPolicies: Record<string, unknown> }> = [];

// Interceptor hook — tests may replace this to control gateway behaviour.
// Default: always succeed.
let gatewayInterceptor: ((req: {
  version: number;
  stackPolicies: Record<string, unknown>;
}) => Promise<{ version: number; ruleCount: number; stackCount: number; accepted: boolean }>) | null = null;

vi.mock('../egress-gateway-client', () => ({
  EgressGatewayClient: class {
    readonly ip: string;
    constructor(ip: string) {
      this.ip = ip;
    }
    async pushRules(req: { version: number; stackPolicies: Record<string, unknown> }) {
      if (gatewayInterceptor) {
        return gatewayInterceptor(req);
      }
      pushRulesCalls.push({ version: req.version, stackPolicies: req.stackPolicies });
      return {
        version: req.version,
        ruleCount: Object.values(req.stackPolicies).reduce(
          (acc, p) => acc + ((p as { rules: unknown[] }).rules?.length ?? 0),
          0,
        ),
        stackCount: Object.keys(req.stackPolicies).length,
        accepted: true as const,
      };
    }
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrisma(overrides: {
  environments?: unknown[];
  egressPolicies?: unknown[];
  stacks?: unknown[];
  updateManyResult?: { count: number };
} = {}): Mocked<PrismaClient> {
  const updateMany = vi.fn().mockResolvedValue(overrides.updateManyResult ?? { count: 0 });

  return {
    environment: {
      findMany: vi.fn().mockResolvedValue(
        overrides.environments ?? [
          { id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' },
        ],
      ),
      findUnique: vi.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        const envs = (overrides.environments ?? [
          { id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' },
        ]) as Array<{ id: string; name: string; egressGatewayIp: string | null }>;
        return Promise.resolve(envs.find((e) => e.id === where.id) ?? null);
      }),
    },
    egressPolicy: {
      findMany: vi.fn().mockResolvedValue(overrides.egressPolicies ?? []),
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany,
    },
    stack: {
      findUnique: vi.fn().mockResolvedValue(
        overrides.stacks?.[0] ?? null,
      ),
    },
  } as unknown as Mocked<PrismaClient>;
}

function makePolicy(overrides: {
  id?: string;
  stackId?: string | null;
  environmentId?: string;
  mode?: string;
  defaultAction?: string;
  version?: number;
  archivedAt?: Date | null;
  rules?: Array<{ id: string; pattern: string; action: string; targets: string[] }>;
} = {}) {
  return {
    id: overrides.id ?? 'pol-1',
    // Use 'stackId' in overrides so explicit null is preserved (null ?? 'stk-1' would be 'stk-1')
    stackId: 'stackId' in overrides ? overrides.stackId : 'stk-1',
    environmentId: overrides.environmentId ?? 'env-1',
    mode: overrides.mode ?? 'detect',
    defaultAction: overrides.defaultAction ?? 'allow',
    version: overrides.version ?? 1,
    archivedAt: overrides.archivedAt ?? null,
    rules: overrides.rules ?? [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EgressRulePusher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pushRulesCalls.length = 0;
    gatewayInterceptor = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------

  it('builds the right snapshot and calls gateway client on pushForEnvironment', async () => {
    const policy = makePolicy({
      stackId: 'stk-1',
      mode: 'enforce',
      defaultAction: 'block',
      version: 3,
      rules: [
        { id: 'r1', pattern: 'api.openai.com', action: 'allow', targets: ['web'] },
        { id: 'r2', pattern: '*.googleapis.com', action: 'allow', targets: [] },
      ],
    });

    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      egressPolicies: [policy],
      updateManyResult: { count: 1 },
    });

    const pusher = new EgressRulePusher(prisma);
    await pusher.pushForEnvironment('env-1');

    expect(pushRulesCalls).toHaveLength(1);
    const call = pushRulesCalls[0];
    expect(call.version).toBe(1); // first push, version increments from 0 → 1
    expect(call.stackPolicies['stk-1']).toEqual({
      mode: 'enforce',
      defaultAction: 'block',
      rules: [
        { id: 'r1', pattern: 'api.openai.com', action: 'allow', targets: ['web'] },
        { id: 'r2', pattern: '*.googleapis.com', action: 'allow', targets: [] },
      ],
    });
  });

  it('increments the version counter on each successful push', async () => {
    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      egressPolicies: [makePolicy()],
      updateManyResult: { count: 1 },
    });

    const pusher = new EgressRulePusher(prisma);

    await pusher.pushForEnvironment('env-1');
    await pusher.pushForEnvironment('env-1');
    await pusher.pushForEnvironment('env-1');

    expect(pushRulesCalls).toHaveLength(3);
    expect(pushRulesCalls[0].version).toBe(1);
    expect(pushRulesCalls[1].version).toBe(2);
    expect(pushRulesCalls[2].version).toBe(3);
  });

  it('updates appliedVersion for all policies in the snapshot after success', async () => {
    const policies = [
      makePolicy({ id: 'pol-1', stackId: 'stk-1' }),
      makePolicy({ id: 'pol-2', stackId: 'stk-2' }),
    ];

    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      egressPolicies: policies,
    });
    (prisma.egressPolicy.updateMany as ReturnType<typeof vi.fn>) = updateMany;

    const pusher = new EgressRulePusher(prisma);
    await pusher.pushForEnvironment('env-1');

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['pol-1', 'pol-2'] } },
      data: { appliedVersion: 1 },
    });
  });

  // -------------------------------------------------------------------------
  // 2. Skip envs without egressGatewayIp
  // -------------------------------------------------------------------------

  it('skips envs with no egressGatewayIp and does not call the gateway', async () => {
    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: null }],
    });

    const pusher = new EgressRulePusher(prisma);
    await pusher.pushForEnvironment('env-1');

    expect(pushRulesCalls).toHaveLength(0);
  });

  it('skips envs that do not exist', async () => {
    const prisma = makePrisma({ environments: [] });

    const pusher = new EgressRulePusher(prisma);
    await pusher.pushForEnvironment('env-missing');

    expect(pushRulesCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. Filter out archived policies (via WHERE clause check)
  // -------------------------------------------------------------------------

  it('queries with archivedAt: null to exclude archived policies', async () => {
    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      egressPolicies: [],
    });

    const pusher = new EgressRulePusher(prisma);
    await pusher.pushForEnvironment('env-1');

    const findManyCall = (prisma.egressPolicy.findMany as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(findManyCall?.where?.archivedAt).toBeNull();
    expect(findManyCall?.where?.environmentId).toBe('env-1');
  });

  // -------------------------------------------------------------------------
  // 4. Empty rule list → still pushes with rules: []
  // -------------------------------------------------------------------------

  it('pushes a policy with empty rules list when no rules exist', async () => {
    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      egressPolicies: [makePolicy({ stackId: 'stk-1', rules: [] })],
      updateManyResult: { count: 1 },
    });

    const pusher = new EgressRulePusher(prisma);
    await pusher.pushForEnvironment('env-1');

    expect(pushRulesCalls).toHaveLength(1);
    expect(pushRulesCalls[0].stackPolicies['stk-1']).toMatchObject({ rules: [] });
  });

  // -------------------------------------------------------------------------
  // 5. pushForStack and pushForPolicy resolve to the right env
  // -------------------------------------------------------------------------

  it('pushForStack resolves environmentId and calls pushForEnvironment', async () => {
    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      stacks: [{ id: 'stk-1', environmentId: 'env-1' }],
      egressPolicies: [makePolicy()],
      updateManyResult: { count: 1 },
    });

    (prisma.stack.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'stk-1',
      environmentId: 'env-1',
    });

    const pusher = new EgressRulePusher(prisma);
    await pusher.pushForStack('stk-1');

    expect(pushRulesCalls).toHaveLength(1);
  });

  it('pushForStack skips host-scoped stacks (no environmentId)', async () => {
    const prisma = makePrisma({
      environments: [],
      stacks: [{ id: 'stk-host', environmentId: null }],
    });

    (prisma.stack.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'stk-host',
      environmentId: null,
    });

    const pusher = new EgressRulePusher(prisma);
    await pusher.pushForStack('stk-host');

    expect(pushRulesCalls).toHaveLength(0);
  });

  it('pushForPolicy resolves environmentId and calls pushForEnvironment', async () => {
    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      egressPolicies: [makePolicy()],
      updateManyResult: { count: 1 },
    });

    (prisma.egressPolicy.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'pol-1',
      environmentId: 'env-1',
    });

    const pusher = new EgressRulePusher(prisma);
    await pusher.pushForPolicy('pol-1');

    expect(pushRulesCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 6. Concurrency: second call while in-flight queues exactly one follow-up
  // -------------------------------------------------------------------------

  it('queues exactly one follow-up when called while in-flight', async () => {
    // Use fake-timers-free real async approach: control the gateway via the interceptor.
    vi.useRealTimers();

    let releaseFirst: (() => void) | null = null;
    let gatewayCallCount = 0;

    gatewayInterceptor = (req) => {
      gatewayCallCount += 1;
      if (gatewayCallCount === 1) {
        // First call blocks until released
        return new Promise<{ version: number; ruleCount: number; stackCount: number; accepted: boolean }>((resolve) => {
          releaseFirst = () => {
            pushRulesCalls.push({ version: req.version, stackPolicies: req.stackPolicies });
            resolve({ version: req.version, ruleCount: 0, stackCount: 0, accepted: true });
          };
        });
      }
      // All subsequent calls resolve immediately
      pushRulesCalls.push({ version: req.version, stackPolicies: req.stackPolicies });
      return Promise.resolve({ version: req.version, ruleCount: 0, stackCount: 0, accepted: true });
    };

    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      egressPolicies: [makePolicy()],
      updateManyResult: { count: 1 },
    });

    const pusher = new EgressRulePusher(prisma);

    // Start first push (blocks in gateway)
    const p1 = pusher.pushForEnvironment('env-1');

    // Yield enough microtask ticks for p1's async chain to reach the gateway:
    // pushForEnvironment → await findUnique → _pushEnvWithRetry →
    // await _buildSnapshot → await egressPolicy.findMany → pushRules(interceptor)
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Queue 3 more calls — should coalesce into one follow-up
    void pusher.pushForEnvironment('env-1');
    void pusher.pushForEnvironment('env-1');
    void pusher.pushForEnvironment('env-1');

    // Release the first push
    expect(releaseFirst).not.toBeNull();
    releaseFirst!();
    await p1;

    // Allow the queued follow-up to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // 1 (initial in-flight) + 1 (coalesced follow-up) = 2
    expect(pushRulesCalls.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 7. Failure path: no bubbling, no appliedVersion update, version rollback
  // -------------------------------------------------------------------------

  it('does not throw when gateway fails on both attempts', async () => {
    // Make all gateway calls fail
    gatewayInterceptor = () => Promise.reject(new Error('gateway unreachable'));

    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      egressPolicies: [makePolicy()],
    });

    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    (prisma.egressPolicy.updateMany as ReturnType<typeof vi.fn>) = updateMany;

    const pusher = new EgressRulePusher(prisma);

    // Start the push — it will fail on attempt 1, then wait RETRY_DELAY_MS, then fail again
    const p = pusher.pushForEnvironment('env-1');

    // Advance past the retry delay (1 s)
    await vi.advanceTimersByTimeAsync(1100);

    // Must not throw
    await expect(p).resolves.toBeUndefined();

    // appliedVersion must NOT be updated on failure
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rolls back the version counter once after a double failure, so next success version is not double-incremented', async () => {
    // Phase 1: both attempts fail.
    // Internally: attempt1 → version=1 (fail), attempt2 → version=2 (fail), rollback → version=1.
    // The single rollback mirrors EgressContainerMapPusher's behaviour.
    gatewayInterceptor = () => Promise.reject(new Error('gateway unreachable'));

    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      egressPolicies: [makePolicy()],
      updateManyResult: { count: 1 },
    });

    const pusher = new EgressRulePusher(prisma);

    const p1 = pusher.pushForEnvironment('env-1');
    await vi.advanceTimersByTimeAsync(1100);
    await p1;

    // pushRulesCalls should still be empty (all failed)
    expect(pushRulesCalls).toHaveLength(0);

    // Phase 2: let the next push succeed
    gatewayInterceptor = null; // revert to default success handler

    await pusher.pushForEnvironment('env-1');

    // After rollback, version is 1. The successful push increments it to 2.
    // This is the same single-rollback behavior as EgressContainerMapPusher.
    expect(pushRulesCalls).toHaveLength(1);
    expect(pushRulesCalls[0].version).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 8. syncAll pushes all envs with egressGatewayIp
  // -------------------------------------------------------------------------

  it('syncAll pushes rules to every env that has an egressGatewayIp', async () => {
    const prisma = makePrisma({
      environments: [
        { id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' },
        { id: 'env-2', name: 'production', egressGatewayIp: '172.31.0.2' },
      ],
      egressPolicies: [],
    });

    (prisma.egressPolicy.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    // Override environment.findUnique to handle both envs
    (prisma.environment.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      ({ where }: { where: { id: string } }) => {
        const envs = [
          { id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' },
          { id: 'env-2', name: 'production', egressGatewayIp: '172.31.0.2' },
        ];
        return Promise.resolve(envs.find((e) => e.id === where.id) ?? null);
      },
    );

    const pusher = new EgressRulePusher(prisma);
    await pusher.syncAll();

    expect(pushRulesCalls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 9. Policies without stackId (stack deleted via SetNull) are excluded
  // -------------------------------------------------------------------------

  it('excludes policies without a stackId from the snapshot', async () => {
    const policyWithNullStack = makePolicy({ stackId: null });
    // Verify our helper correctly sets stackId to null
    expect(policyWithNullStack.stackId).toBeNull();

    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      egressPolicies: [policyWithNullStack],
    });

    const pusher = new EgressRulePusher(prisma);
    await pusher.pushForEnvironment('env-1');

    // Push should still happen (empty snapshot) — orphaned policy is excluded
    expect(pushRulesCalls).toHaveLength(1);
    expect(Object.keys(pushRulesCalls[0].stackPolicies)).toHaveLength(0);
  });
});
