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
    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      stacks: [
        {
          id: 'stk-1',
          name: 'app',
          services: [{ serviceName: 'web', containerConfig: {} }],
        },
      ],
    });

    // First listContainers call (initial push) sees one container.
    // Second call (after the burst of events) sees a different container.
    // We have to vary the content so the no-op-skip path doesn't suppress
    // the debounced push — that's tested separately below.
    mockDockerInstance.listContainers
      .mockResolvedValueOnce([
        {
          Id: 'c1',
          Names: ['/staging-app-web'],
          Labels: { 'mini-infra.stack-id': 'stk-1', 'mini-infra.service': 'web' },
          NetworkSettings: { Networks: { 'staging-egress': { IPAddress: '172.30.0.10' } } },
        },
      ])
      .mockResolvedValue([
        {
          Id: 'c1',
          Names: ['/staging-app-web'],
          Labels: { 'mini-infra.stack-id': 'stk-1', 'mini-infra.service': 'web' },
          NetworkSettings: { Networks: { 'staging-egress': { IPAddress: '172.30.0.11' } } },
        },
      ]);

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
  // No-op suppression: skip pushes when entries haven't changed
  // -------------------------------------------------------------------------

  it('skips the push when the entries fingerprint matches the last successful push', async () => {
    // Idle env: same single container reported for every Docker poll, so
    // every container-change event produces an identical map snapshot.
    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      stacks: [
        {
          id: 'stk-1',
          name: 'app',
          services: [{ serviceName: 'web', containerConfig: {} }],
        },
      ],
    });
    mockDockerInstance.listContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/staging-app-web'],
        Labels: { 'mini-infra.stack-id': 'stk-1', 'mini-infra.service': 'web' },
        NetworkSettings: { Networks: { 'staging-egress': { IPAddress: '172.30.0.10' } } },
      },
    ]);

    const pusher = new EgressContainerMapPusher(prisma);
    pusher.start();

    // Initial push lands.
    await vi.runAllTimersAsync();
    const seedCount = pushCalls.length;
    expect(seedCount).toBeGreaterThan(0);

    // Fire 10 separate debounced bursts of container events. Each one
    // would result in a push under the old behaviour — under the new
    // behaviour the gateway should not be hit again because the snapshot
    // is identical.
    for (let burst = 0; burst < 10; burst++) {
      capturedContainerChangeCallback?.();
      await vi.advanceTimersByTimeAsync(600);
    }

    expect(pushCalls.length).toBe(seedCount);

    pusher.stop();
  });

  // -------------------------------------------------------------------------
  // No-op suppression: a real change still produces a push
  // -------------------------------------------------------------------------

  it('pushes again when entries change after a stretch of identical snapshots', async () => {
    const prisma = makePrisma({
      environments: [{ id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' }],
      stacks: [
        {
          id: 'stk-1',
          name: 'app',
          services: [
            { serviceName: 'web', containerConfig: {} },
            { serviceName: 'api', containerConfig: {} },
          ],
        },
      ],
    });

    const baseContainer = {
      Id: 'c-web',
      Names: ['/staging-app-web'],
      Labels: { 'mini-infra.stack-id': 'stk-1', 'mini-infra.service': 'web' },
      NetworkSettings: { Networks: { 'staging-egress': { IPAddress: '172.30.0.10' } } },
    };
    const apiContainer = {
      Id: 'c-api',
      Names: ['/staging-app-api'],
      Labels: { 'mini-infra.stack-id': 'stk-1', 'mini-infra.service': 'api' },
      NetworkSettings: { Networks: { 'staging-egress': { IPAddress: '172.30.0.11' } } },
    };

    // Initial push: just web. Three idle bursts: still just web (skipped).
    // Then a real change: api joins. Push must fire.
    mockDockerInstance.listContainers
      .mockResolvedValueOnce([baseContainer])
      .mockResolvedValueOnce([baseContainer])
      .mockResolvedValueOnce([baseContainer])
      .mockResolvedValueOnce([baseContainer])
      .mockResolvedValue([baseContainer, apiContainer]);

    const pusher = new EgressContainerMapPusher(prisma);
    pusher.start();
    await vi.runAllTimersAsync();
    const seedCount = pushCalls.length;

    // Three idle bursts — all suppressed.
    for (let i = 0; i < 3; i++) {
      capturedContainerChangeCallback?.();
      await vi.advanceTimersByTimeAsync(600);
    }
    expect(pushCalls.length).toBe(seedCount);

    // Real change: api appeared. Push should fire on the next event.
    capturedContainerChangeCallback?.();
    await vi.advanceTimersByTimeAsync(600);
    expect(pushCalls.length).toBe(seedCount + 1);

    const last = pushCalls[pushCalls.length - 1];
    expect(last.entries).toHaveLength(2);

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

    // Both containers are running on the egress network. Discovery is
    // label-driven: stackId + serviceName come from container labels, not
    // names. The bypassed service should still be skipped because its
    // service definition has egressBypass=true in Prisma.
    mockDockerInstance.listContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/staging-myapp-web'],
        Labels: { 'mini-infra.stack-id': 'stk-1', 'mini-infra.service': 'web' },
        NetworkSettings: {
          Networks: { 'staging-egress': { IPAddress: '172.30.0.10' } },
        },
      },
      {
        Id: 'c2',
        Names: ['/staging-myapp-egress-gateway'],
        Labels: {
          'mini-infra.stack-id': 'stk-1',
          'mini-infra.service': 'egress-gateway',
        },
        NetworkSettings: {
          Networks: { 'staging-egress': { IPAddress: '172.30.0.2' } },
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
  // Map computation: discovery is label-driven (works regardless of name)
  // -------------------------------------------------------------------------

  it('discovers containers via mini-infra.stack-id / mini-infra.service labels', async () => {
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

    // Container name is whatever the spawner chose — discovery doesn't care
    // about the name, only about the labels.
    mockDockerInstance.listContainers.mockResolvedValue([
      {
        Id: 'c-alpine',
        Names: ['/some-arbitrary-name'],
        Labels: {
          'mini-infra.stack-id': 'stk-egress-test',
          'mini-infra.service': 'alpine',
        },
        NetworkSettings: {
          Networks: { 'local-egress': { IPAddress: '172.30.0.10' } },
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

  // -------------------------------------------------------------------------
  // Map computation: pool instances are included even though their names
  // don't match the static `${env}-${stack}-${service}` pattern
  // -------------------------------------------------------------------------

  it('includes pool instance containers (multiple per service)', async () => {
    const prisma = makePrisma({
      environments: [{ id: 'env-local', name: 'local', egressGatewayIp: '172.30.0.2' }],
      stacks: [
        {
          id: 'stk-slackbot',
          name: 'slackbot',
          services: [{ serviceName: 'worker', containerConfig: {} }],
        },
      ],
    });

    // Pool instance names follow `${env}-${stack}-pool-${service}-${instanceId}`
    // (pool-spawner.ts), so a name-based lookup would miss them entirely.
    mockDockerInstance.listContainers.mockResolvedValue([
      {
        Id: 'c-worker-1',
        Names: ['/local-slackbot-pool-worker-slack-user-u0at5jhr7d3'],
        Labels: {
          'mini-infra.stack-id': 'stk-slackbot',
          'mini-infra.service': 'worker',
          'mini-infra.pool-instance': 'true',
          'mini-infra.pool-instance-id': 'slack-user-u0at5jhr7d3',
        },
        NetworkSettings: {
          Networks: { 'local-egress': { IPAddress: '172.30.0.20' } },
        },
      },
      {
        Id: 'c-worker-2',
        Names: ['/local-slackbot-pool-worker-slack-user-u0at5jhr7d4'],
        Labels: {
          'mini-infra.stack-id': 'stk-slackbot',
          'mini-infra.service': 'worker',
          'mini-infra.pool-instance': 'true',
          'mini-infra.pool-instance-id': 'slack-user-u0at5jhr7d4',
        },
        NetworkSettings: {
          Networks: { 'local-egress': { IPAddress: '172.30.0.21' } },
        },
      },
    ]);

    const pusher = new EgressContainerMapPusher(prisma);
    pusher.start();
    await vi.runAllTimersAsync();

    expect(pushCalls.length).toBeGreaterThan(0);
    const { entries } = pushCalls[pushCalls.length - 1];
    expect(entries).toHaveLength(2);
    const ips = (entries as { ip: string }[]).map((e) => e.ip).sort();
    expect(ips).toEqual(['172.30.0.20', '172.30.0.21']);
    // Both should map to the same stack/service, distinct container IDs.
    expect(new Set((entries as { stackId: string }[]).map((e) => e.stackId))).toEqual(
      new Set(['stk-slackbot']),
    );
    expect(new Set((entries as { containerId: string }[]).map((e) => e.containerId))).toEqual(
      new Set(['c-worker-1', 'c-worker-2']),
    );

    pusher.stop();
  });

  // -------------------------------------------------------------------------
  // Map computation: foreign / unknown labels are dropped
  // -------------------------------------------------------------------------

  it('skips containers whose stack-id label does not belong to this env', async () => {
    const prisma = makePrisma({
      environments: [{ id: 'env-local', name: 'local', egressGatewayIp: '172.30.0.2' }],
      stacks: [
        {
          id: 'stk-known',
          name: 'known',
          services: [{ serviceName: 'web', containerConfig: {} }],
        },
      ],
    });

    mockDockerInstance.listContainers.mockResolvedValue([
      {
        Id: 'c-known',
        Names: ['/local-known-web'],
        Labels: { 'mini-infra.stack-id': 'stk-known', 'mini-infra.service': 'web' },
        NetworkSettings: { Networks: { 'local-egress': { IPAddress: '172.30.0.10' } } },
      },
      {
        Id: 'c-unknown-stack',
        Names: ['/foreign-app-svc'],
        Labels: { 'mini-infra.stack-id': 'stk-other-env', 'mini-infra.service': 'svc' },
        NetworkSettings: { Networks: { 'local-egress': { IPAddress: '172.30.0.99' } } },
      },
      {
        Id: 'c-unlabeled',
        Names: ['/random-container'],
        Labels: {},
        NetworkSettings: { Networks: { 'local-egress': { IPAddress: '172.30.0.50' } } },
      },
    ]);

    const pusher = new EgressContainerMapPusher(prisma);
    pusher.start();
    await vi.runAllTimersAsync();

    expect(pushCalls.length).toBeGreaterThan(0);
    const { entries } = pushCalls[pushCalls.length - 1];
    expect(entries).toHaveLength(1);
    expect((entries as { containerId: string }[])[0].containerId).toBe('c-known');

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
