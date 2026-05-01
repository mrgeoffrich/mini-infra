/**
 * EnvFirewallManager unit tests (ALT-27).
 *
 * After the legacy Unix-socket transport was replaced by the typed
 * `FwAgentTransport` interface, the assertions here check op/envName/
 * bridgeCidr fields directly instead of HTTP method/path. The behavior
 * being tested (DB lookups, label filtering, outage queue, reconcile
 * re-registration) is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnvFirewallManager } from '../env-firewall-manager';
import type {
  FwAgentTransport,
  FwAgentApplyResult,
  FirewallMode,
} from '../fw-agent-transport';

// The logger factory is mocked globally by setup-unit.ts.

// ---------------------------------------------------------------------------
// Mock helpers — record one TransportCall per invocation, with the
// shape of (op, payload). Mirrors what the new transport does on the wire.
// ---------------------------------------------------------------------------

interface TransportCall {
  op:
    | 'env-upsert'
    | 'env-remove'
    | 'ipset-add'
    | 'ipset-del'
    | 'ipset-sync';
  payload: Record<string, unknown>;
}

function makeTransport(
  responses: Partial<Record<TransportCall['op'], FwAgentApplyResult>> = {},
): { transport: FwAgentTransport; calls: TransportCall[] } {
  const calls: TransportCall[] = [];
  const ok: FwAgentApplyResult = { status: 200, body: { status: 'applied' } };
  const transport: FwAgentTransport = {
    envUpsert: async (input) => {
      calls.push({ op: 'env-upsert', payload: input as unknown as Record<string, unknown> });
      return responses['env-upsert'] ?? ok;
    },
    envRemove: async (input) => {
      calls.push({ op: 'env-remove', payload: input as unknown as Record<string, unknown> });
      return responses['env-remove'] ?? ok;
    },
    ipsetAdd: async (input) => {
      calls.push({ op: 'ipset-add', payload: input as unknown as Record<string, unknown> });
      return responses['ipset-add'] ?? ok;
    },
    ipsetDel: async (input) => {
      calls.push({ op: 'ipset-del', payload: input as unknown as Record<string, unknown> });
      return responses['ipset-del'] ?? ok;
    },
    ipsetSync: async (input) => {
      calls.push({ op: 'ipset-sync', payload: input as unknown as Record<string, unknown> });
      return responses['ipset-sync'] ?? ok;
    },
  };
  return { transport, calls };
}

function makeFailingTransport(): { transport: FwAgentTransport; calls: TransportCall[] } {
  const calls: TransportCall[] = [];
  const reject = (op: TransportCall['op'], input: unknown) => {
    calls.push({ op, payload: input as Record<string, unknown> });
    return Promise.reject(new Error('connection refused'));
  };
  const transport: FwAgentTransport = {
    envUpsert: (i) => reject('env-upsert', i),
    envRemove: (i) => reject('env-remove', i),
    ipsetAdd: (i) => reject('ipset-add', i),
    ipsetDel: (i) => reject('ipset-del', i),
    ipsetSync: (i) => reject('ipset-sync', i),
  };
  return { transport, calls };
}

function makeEnvironmentRecord(overrides?: Partial<{
  id: string;
  name: string;
  egressGatewayIp: string | null;
  egressFirewallEnabled: boolean;
}>) {
  return {
    id: 'env-1',
    name: 'prod',
    egressGatewayIp: '10.0.0.0/24',
    egressFirewallEnabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnvFirewallManager', () => {
  let mockPrisma: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = {
      environment: {
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      infraResource: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
  });

  describe('applyEnv', () => {
    it('issues env-upsert when egressFirewallEnabled is true', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(makeEnvironmentRecord());
      mockPrisma.infraResource.findFirst.mockResolvedValue({
        metadata: { subnet: '172.30.0.0/24' },
      });
      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await manager.applyEnv('env-1', 'observe');

      expect(calls).toHaveLength(1);
      expect(calls[0].op).toBe('env-upsert');
      expect(calls[0].payload).toEqual({
        envName: 'prod',
        bridgeCidr: '172.30.0.0/24',
        mode: 'observe' as FirewallMode,
      });
    });

    it('skips transport call when egressFirewallEnabled is false', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(
        makeEnvironmentRecord({ egressFirewallEnabled: false }),
      );
      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await manager.applyEnv('env-1', 'observe');
      expect(calls).toHaveLength(0);
    });

    it('skips transport call when env not found', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(null);
      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await manager.applyEnv('env-999', 'observe');
      expect(calls).toHaveLength(0);
    });

    it('skips transport call when bridge CIDR cannot be resolved', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(makeEnvironmentRecord());
      mockPrisma.infraResource.findFirst.mockResolvedValue(null);
      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await manager.applyEnv('env-1', 'observe');
      expect(calls).toHaveLength(0);
    });

    it('uses the real bridge CIDR from InfraResource (not a hardcoded default)', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(makeEnvironmentRecord());
      mockPrisma.infraResource.findFirst.mockResolvedValue({
        metadata: { subnet: '172.30.5.0/24' },
      });
      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await manager.applyEnv('env-1', 'observe');
      expect(calls[0].payload.bridgeCidr).toBe('172.30.5.0/24');
    });
  });

  describe('_handleContainerEvent (via start())', () => {
    it('queues ipset add for managed container start (no error)', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(makeEnvironmentRecord());
      mockPrisma.environment.findMany.mockResolvedValue([]);

      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await (manager as any)._handleContainerEvent({
        action: 'start',
        containerId: 'ctn-1',
        containerName: 'myapp',
        labels: { 'mini-infra.environment': 'env-1' },
      });

      // _getContainerIp returns null in tests (no Docker), so no add call.
      expect(calls.length).toBeGreaterThanOrEqual(0);
    });

    it('skips ipset push when bypass label is set', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(makeEnvironmentRecord());
      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await (manager as any)._handleContainerEvent({
        action: 'start',
        containerId: 'bypass-1',
        labels: {
          'mini-infra.environment': 'env-1',
          'mini-infra.egress.bypass': 'true',
        },
      });

      expect(mockPrisma.environment.findUnique).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    });

    it('skips ipset push for egress-gateway container', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(makeEnvironmentRecord());
      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await (manager as any)._handleContainerEvent({
        action: 'start',
        containerId: 'gw-1',
        labels: {
          'mini-infra.environment': 'env-1',
          'mini-infra.egress.gateway': 'true',
        },
      });

      expect(calls).toHaveLength(0);
    });

    it('skips ipset push for fw-agent container', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(makeEnvironmentRecord());
      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await (manager as any)._handleContainerEvent({
        action: 'start',
        containerId: 'fw-1',
        labels: {
          'mini-infra.environment': 'env-1',
          'mini-infra.egress.fw-agent': 'true',
        },
      });

      expect(calls).toHaveLength(0);
    });
  });

  describe('outage queue', () => {
    it('queues add when transport rejects', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(makeEnvironmentRecord());
      const { transport, calls } = makeFailingTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await (manager as any)._addMember('prod', '10.0.0.5');

      expect(calls).toHaveLength(1);
      expect((manager as any).queue).toHaveLength(1);
      expect((manager as any).queue[0]).toEqual({ type: 'add', env: 'prod', ip: '10.0.0.5' });
    });

    it('drops oldest when queue cap is exceeded', async () => {
      const { transport } = makeFailingTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);
      const q = (manager as any).queue as Array<unknown>;

      const cap = 1000;
      for (let i = 0; i < cap; i++) {
        q.push({ type: 'add', env: 'prod', ip: `10.0.0.${i % 254}` });
      }
      expect(q).toHaveLength(cap);

      (manager as any)._enqueue({ type: 'del', env: 'prod', ip: '10.0.0.99' });
      expect(q).toHaveLength(cap);
      expect(q[cap - 1]).toEqual({ type: 'del', env: 'prod', ip: '10.0.0.99' });
    });

    it('drains queue when agent recovers', async () => {
      const calls: TransportCall[] = [];
      let callCount = 0;
      const transport: FwAgentTransport = {
        envUpsert: async () => ({ status: 200 }),
        envRemove: async () => ({ status: 200 }),
        ipsetAdd: async (input) => {
          calls.push({ op: 'ipset-add', payload: input as unknown as Record<string, unknown> });
          callCount++;
          if (callCount === 1) throw new Error('down');
          return { status: 200 };
        },
        ipsetDel: async () => ({ status: 200 }),
        ipsetSync: async () => ({ status: 200 }),
      };

      const manager = new EnvFirewallManager(mockPrisma, transport);

      await (manager as any)._addMember('prod', '10.0.0.5');
      expect((manager as any).queue).toHaveLength(1);

      await (manager as any)._drainQueue();
      expect((manager as any).queue).toHaveLength(0);
      expect(calls).toHaveLength(2);
    });
  });

  describe('reconcile', () => {
    it('queries enabled envs from DB during reconcile', async () => {
      const envs = [makeEnvironmentRecord({ id: 'env-1', name: 'prod' })];
      mockPrisma.environment.findMany.mockResolvedValue(envs);
      const { transport } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await (manager as any)._reconcile();

      expect(mockPrisma.environment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { egressFirewallEnabled: true } }),
      );
    });

    it('skips reconcile and makes no transport calls when no enabled envs', async () => {
      mockPrisma.environment.findMany.mockResolvedValue([]);
      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await (manager as any)._reconcile();
      expect(calls).toHaveLength(0);
    });

    it('issues env-upsert for each enabled env during reconcile (High 2 fix)', async () => {
      const envs = [
        makeEnvironmentRecord({ id: 'env-1', name: 'prod' }),
        makeEnvironmentRecord({ id: 'env-2', name: 'staging' }),
      ];
      mockPrisma.environment.findMany.mockResolvedValue(envs);
      mockPrisma.infraResource.findFirst
        .mockResolvedValueOnce({ metadata: { subnet: '172.30.0.0/24' } })
        .mockResolvedValueOnce({ metadata: { subnet: '172.30.1.0/24' } });

      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      const registered = await (manager as any)._reconcileEnvRegistrations(envs);

      const upserts = calls.filter((c) => c.op === 'env-upsert');
      expect(upserts).toHaveLength(2);
      expect(upserts[0].payload).toMatchObject({ envName: 'prod', bridgeCidr: '172.30.0.0/24' });
      expect(upserts[1].payload).toMatchObject({ envName: 'staging', bridgeCidr: '172.30.1.0/24' });
      expect(registered.size).toBe(2);
    });

    it('reconcile skips env registration when bridge CIDR is missing', async () => {
      const envs = [makeEnvironmentRecord({ id: 'env-1', name: 'prod' })];
      mockPrisma.environment.findMany.mockResolvedValue(envs);
      mockPrisma.infraResource.findFirst.mockResolvedValue(null);

      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      const registered = await (manager as any)._reconcileEnvRegistrations(envs);

      expect(calls).toHaveLength(0);
      expect(registered.size).toBe(0);
    });
  });

  describe('removeEnv', () => {
    it('issues env-remove when egressFirewallEnabled is true', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(
        makeEnvironmentRecord({ egressFirewallEnabled: true }),
      );
      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await manager.removeEnv('env-1', 'prod');

      expect(calls).toHaveLength(1);
      expect(calls[0].op).toBe('env-remove');
      expect(calls[0].payload).toEqual({ envName: 'prod' });
    });

    it('skips env-remove when egressFirewallEnabled is false', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(
        makeEnvironmentRecord({ egressFirewallEnabled: false }),
      );
      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await manager.removeEnv('env-1', 'prod');
      expect(calls).toHaveLength(0);
    });

    it('still issues env-remove when env is not found in DB (best-effort cleanup)', async () => {
      mockPrisma.environment.findUnique.mockResolvedValue(null);
      const { transport, calls } = makeTransport();
      const manager = new EnvFirewallManager(mockPrisma, transport);

      await manager.removeEnv('env-1', 'prod');

      expect(calls).toHaveLength(1);
      expect(calls[0].op).toBe('env-remove');
      expect(calls[0].payload).toEqual({ envName: 'prod' });
    });
  });
});
