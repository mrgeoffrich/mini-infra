/**
 * Tests for EgressContainerMapPusher
 */

import { EgressContainerMapPusher } from '../egress-container-map-pusher';
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

// Capture the onContainerChange callback so tests can trigger it manually
let capturedContainerChangeCallback: (() => void) | null = null;

const mockDockerInstance = {
  listContainers: vi.fn(),
};

const mockIsConnected = vi.fn().mockReturnValue(true);

vi.mock('../../docker', () => ({
  default: {
    getInstance: vi.fn(() => ({
      isConnected: mockIsConnected,
      onContainerChange: vi.fn((cb: () => void) => {
        capturedContainerChangeCallback = cb;
      }),
      getDockerInstance: vi.fn().mockResolvedValue(mockDockerInstance),
    })),
  },
}));

// Track pushContainerMap calls
const pushCalls: Array<{ version: number; entries: unknown[] }> = [];

vi.mock('../egress-gateway-client', () => ({
  EgressGatewayClient: class {
    readonly ip: string;
    constructor(ip: string) { this.ip = ip; }
    async pushContainerMap(req: { version: number; entries: unknown[] }) {
      pushCalls.push(req);
      return { version: req.version, entryCount: req.entries.length };
    }
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrisma(overrides: {
  environments?: unknown[];
  stacks?: unknown[];
} = {}): Mocked<PrismaClient> {
  return {
    environment: {
      findMany: vi.fn().mockResolvedValue(
        overrides.environments ?? [
          { id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' },
        ],
      ),
    },
    stack: {
      findMany: vi.fn().mockResolvedValue(overrides.stacks ?? []),
    },
  } as unknown as Mocked<PrismaClient>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EgressContainerMapPusher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedContainerChangeCallback = null;
    pushCalls.length = 0; // reset
    mockDockerInstance.listContainers.mockResolvedValue([]);
    mockIsConnected.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Debounce: rapid events produce one push
  // -------------------------------------------------------------------------

  it('collapses rapid container-change events into a single push per env', async () => {
    const prisma = makePrisma();
    const pusher = new EgressContainerMapPusher(prisma);
    pusher.start();

    // Let the initial push settle (runAllTimersAsync flushes microtasks + timers)
    await vi.runAllTimersAsync();

    const callCountAfterInit = pushCalls.length;

    // Simulate 5 rapid container-change events
    for (let i = 0; i < 5; i++) {
      capturedContainerChangeCallback?.();
    }

    // Before debounce fires, no additional pushes
    expect(pushCalls.length).toBe(callCountAfterInit);

    // Advance past debounce window (500 ms)
    await vi.advanceTimersByTimeAsync(600);

    // Only 1 additional push despite 5 events
    expect(pushCalls.length).toBe(callCountAfterInit + 1);

    pusher.stop();
  });

  // -------------------------------------------------------------------------
  // Map computation: skips egressBypass services
  // -------------------------------------------------------------------------

  it('skips services with egressBypass=true in the container map', async () => {
    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      stacks: [
        {
          id: 'stk-1',
          name: 'myapp',
          services: [
            { serviceName: 'web', containerConfig: {} },
            { serviceName: 'egress-gateway', containerConfig: { egressBypass: true } },
          ],
        },
      ],
    });

    // Docker has both containers running on the applications network.
    // Names follow `${env}-${stack}-${service}` (StackContainerManager convention).
    mockDockerInstance.listContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/staging-myapp-web'],
        NetworkSettings: {
          Networks: { 'staging-applications': { IPAddress: '172.30.0.10' } },
        },
      },
      {
        Id: 'c2',
        Names: ['/staging-myapp-egress-gateway'],
        NetworkSettings: {
          Networks: { 'staging-applications': { IPAddress: '172.30.0.2' } },
        },
      },
    ]);

    const pusher = new EgressContainerMapPusher(prisma);
    pusher.start();
    await vi.runAllTimersAsync();

    expect(pushCalls.length).toBeGreaterThan(0);
    const { entries } = pushCalls[pushCalls.length - 1];
    const entryServiceNames = (entries as { serviceName: string }[]).map((e) => e.serviceName);
    // egressBypass service should NOT appear
    expect(entryServiceNames).not.toContain('egress-gateway');
    expect(entryServiceNames).toContain('web');

    pusher.stop();
  });

  // -------------------------------------------------------------------------
  // Map computation: looks up containers by env-prefixed name
  // -------------------------------------------------------------------------

  it('matches containers using ${env.name}-${stack.name}-${serviceName}', async () => {
    const prisma = makePrisma({
      environments: [{ id: 'env-local', name: 'local', egressGatewayIp: '172.30.0.2' }],
      stacks: [
        {
          id: 'stk-egress-test',
          name: 'egress-test',
          services: [{ serviceName: 'alpine', containerConfig: {} }],
        },
      ],
    });

    // StackContainerManager names this `local-egress-test-alpine` (env + stack + service).
    // The pusher must look up that exact name — not `egress-test-alpine`.
    mockDockerInstance.listContainers.mockResolvedValue([
      {
        Id: 'c-alpine',
        Names: ['/local-egress-test-alpine'],
        NetworkSettings: {
          Networks: { 'local-applications': { IPAddress: '172.30.0.10' } },
        },
      },
    ]);

    const pusher = new EgressContainerMapPusher(prisma);
    pusher.start();
    await vi.runAllTimersAsync();

    expect(pushCalls.length).toBeGreaterThan(0);
    const { entries } = pushCalls[pushCalls.length - 1];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      ip: '172.30.0.10',
      stackId: 'stk-egress-test',
      serviceName: 'alpine',
      containerId: 'c-alpine',
    });

    pusher.stop();
  });

  it('excludes removed stacks from the container map query', async () => {
    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      stacks: [], // Prisma returns empty (simulates status:removed filtered out)
    });

    const pusher = new EgressContainerMapPusher(prisma);
    pusher.start();
    await vi.runAllTimersAsync();

    // Confirm query sent the right WHERE clause
    const stackFindMany = (prisma.stack.findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(stackFindMany?.where?.status).toEqual({ not: 'removed' });
    expect(stackFindMany?.where?.removedAt).toBeNull();

    pusher.stop();
  });

  // -------------------------------------------------------------------------
  // Per-env independence
  // -------------------------------------------------------------------------

  it('creates a separate gateway client for each env with its own IP', async () => {
    const { EgressGatewayClient } = await import('../egress-gateway-client');
    const clientIps: string[] = [];
    const OrigClient = EgressGatewayClient as unknown as { new(ip: string): { ip: string; pushContainerMap: (r: unknown) => Promise<unknown> } };

    const prisma = makePrisma({
      environments: [
        { id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' },
        { id: 'env-2', name: 'production', egressGatewayIp: '172.31.0.2' },
      ],
    });

    // Spy on constructor via the mock class
    const origPush = OrigClient.prototype.pushContainerMap;
    OrigClient.prototype.pushContainerMap = async function(this: { ip: string }, req: unknown) {
      clientIps.push(this.ip);
      return origPush.call(this, req);
    };

    const pusher = new EgressContainerMapPusher(prisma);
    pusher.start();
    await vi.runAllTimersAsync();

    // Both env IPs should have been called
    expect(clientIps).toContain('172.30.0.2');
    expect(clientIps).toContain('172.31.0.2');

    // Restore
    OrigClient.prototype.pushContainerMap = origPush;

    pusher.stop();
  });

  // -------------------------------------------------------------------------
  // Version counter increments monotonically per env
  // -------------------------------------------------------------------------

  it('increments the version counter monotonically on each push', async () => {
    const prisma = makePrisma();
    const pusher = new EgressContainerMapPusher(prisma);
    pusher.start();

    // First push (initial sync)
    await vi.runAllTimersAsync();

    // Trigger a second push
    capturedContainerChangeCallback?.();
    await vi.advanceTimersByTimeAsync(600);

    if (pushCalls.length >= 2) {
      expect(pushCalls[1].version).toBeGreaterThan(pushCalls[0].version);
    }

    pusher.stop();
  });
});
