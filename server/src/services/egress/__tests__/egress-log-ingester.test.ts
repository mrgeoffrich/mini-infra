/**
 * Tests for EgressLogIngester (internal logic)
 *
 * We test the ingester's behaviour via the exported EgressLogIngester class,
 * but most logic lives in the private GatewayTailer. We test it indirectly
 * by exercising the public `start()` method with mocked DockerService and
 * Prisma, and by triggering synthetic log lines.
 *
 * We also export helpers via a small test-only harness approach:
 * The key behaviours tested are:
 *  1. Only `dns.query` lines are ingested (other evt values are ignored).
 *  2. Lines without a stackId are dropped.
 *  3. Lines whose stackId has no matching EgressPolicy are dropped.
 *  4. Dedup window collapses repeated entries within 60 s.
 *  5. EgressRule.hits is bumped when matchedPattern is set.
 */

import { EgressLogIngester } from '../egress-log-ingester';
import type { PrismaClient } from '../../../generated/prisma/client';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

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

vi.mock('../../../lib/logging-context', () => ({
  withOperation: (_name: string, fn: () => Promise<void>) => fn(),
}));

// We'll set up Docker mock per test
let capturedContainerEventCallback: ((event: { action: string; name?: string }) => void) | null = null;
const mockDockerInstance = {
  listContainers: vi.fn(),
  getContainer: vi.fn(),
};

vi.mock('../../docker', () => ({
  default: {
    getInstance: vi.fn(() => ({
      isConnected: vi.fn().mockReturnValue(true),
      onContainerEvent: vi.fn((cb: (event: { action: string; name?: string }) => void) => {
        capturedContainerEventCallback = cb;
      }),
      getDockerInstance: vi.fn().mockResolvedValue(mockDockerInstance),
    })),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrisma(overrides: {
  policy?: { id: string } | null;
  egressEventCreateMany?: ReturnType<typeof vi.fn>;
  egressRuleUpdateMany?: ReturnType<typeof vi.fn>;
} = {}): Mocked<PrismaClient> {
  return {
    environment: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' },
      ]),
    },
    egressPolicy: {
      findFirst: vi.fn().mockResolvedValue(
        overrides.policy !== undefined ? overrides.policy : { id: 'policy-1' },
      ),
    },
    egressEvent: {
      createMany: overrides.egressEventCreateMany ?? vi.fn().mockResolvedValue({ count: 1 }),
    },
    egressRule: {
      updateMany: overrides.egressRuleUpdateMany ?? vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as unknown as Mocked<PrismaClient>;
}

/** Build a minimal docker.logs() mock stream */
function makeLogStream(): { stream: Readable; pushLine: (json: object) => void } {
  const readable = new Readable({ read() {} });

  const pushLine = (json: object) => {
    const line = JSON.stringify(json) + '\n';
    const buf = Buffer.from(line);
    // Build a Docker multiplexed frame: 8-byte header + payload
    const header = Buffer.alloc(8);
    header.writeUInt8(1, 0); // stream type 1 = stdout
    header.writeUInt32BE(buf.length, 4);
    readable.push(Buffer.concat([header, buf]));
  };

  return { stream: readable, pushLine };
}

function makeDnsQueryLine(overrides: object = {}): object {
  return {
    ts: new Date().toISOString(),
    level: 'info',
    evt: 'dns.query',
    srcIp: '172.30.0.10',
    qname: 'api.example.com',
    qtype: 'A',
    action: 'observed',
    stackId: 'stk-1',
    serviceName: 'web',
    mergedHits: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EgressLogIngester', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedContainerEventCallback = null;
    mockDockerInstance.listContainers.mockResolvedValue([
      {
        Id: 'gw-container-1',
        Names: ['/staging-egress-gateway-egress-gateway'],
        NetworkSettings: { Networks: {} },
      },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Only dns.query lines are ingested
  // -------------------------------------------------------------------------

  it('ingests dns.query lines and ignores other evt types', async () => {
    const { stream, pushLine } = makeLogStream();
    const mockContainer = { logs: vi.fn().mockResolvedValue(stream) };
    mockDockerInstance.getContainer.mockReturnValue(mockContainer);

    const prisma = makePrisma();
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    // Push a dns.query line and a startup line
    pushLine(makeDnsQueryLine());
    pushLine({ ts: new Date().toISOString(), level: 'info', evt: 'startup', msg: 'listening' });
    pushLine({ ts: new Date().toISOString(), level: 'info', evt: 'admin.rules-update', version: 1 });

    // Advance to trigger flush
    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    // Only the dns.query line should produce a row
    expect(createMany).toHaveBeenCalledTimes(1);
    const [args] = createMany.mock.calls[0] as [{ data: { destination: string }[] }];
    expect(args.data).toHaveLength(1);
    expect(args.data[0].destination).toBe('api.example.com');

    ingester.stop();
  });

  // -------------------------------------------------------------------------
  // Policy lookup miss drops event
  // -------------------------------------------------------------------------

  it('drops events when stackId has no matching EgressPolicy', async () => {
    const { stream, pushLine } = makeLogStream();
    const mockContainer = { logs: vi.fn().mockResolvedValue(stream) };
    mockDockerInstance.getContainer.mockReturnValue(mockContainer);

    const prisma = makePrisma({ policy: null }); // no policy found
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    pushLine(makeDnsQueryLine({ stackId: 'unknown-stack' }));

    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).not.toHaveBeenCalled();

    ingester.stop();
  });

  // -------------------------------------------------------------------------
  // Lines without stackId are dropped
  // -------------------------------------------------------------------------

  it('drops events without stackId', async () => {
    const { stream, pushLine } = makeLogStream();
    const mockContainer = { logs: vi.fn().mockResolvedValue(stream) };
    mockDockerInstance.getContainer.mockReturnValue(mockContainer);

    const prisma = makePrisma();
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    // Push a line without stackId
    pushLine(makeDnsQueryLine({ stackId: undefined }));

    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).not.toHaveBeenCalled();

    ingester.stop();
  });

  // -------------------------------------------------------------------------
  // Dedup window collapses repeated entries
  // -------------------------------------------------------------------------

  it('collapses repeated (policyId, service, destination, action) within 60 s window', async () => {
    const { stream, pushLine } = makeLogStream();
    const mockContainer = { logs: vi.fn().mockResolvedValue(stream) };
    mockDockerInstance.getContainer.mockReturnValue(mockContainer);

    const prisma = makePrisma();
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    // Push 5 identical lines — same key
    for (let i = 0; i < 5; i++) {
      pushLine(makeDnsQueryLine({ qname: 'api.openai.com', action: 'observed', stackId: 'stk-1', serviceName: 'web' }));
    }

    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    // Only the first occurrence should be flushed — the rest are deduped
    expect(createMany).toHaveBeenCalledTimes(1);
    const [args] = createMany.mock.calls[0] as [{ data: { mergedHits: number }[] }];
    expect(args.data).toHaveLength(1);
    // mergedHits should be 1 (from the sidecar line)
    expect(args.data[0].mergedHits).toBe(1);

    ingester.stop();
  });

  it('starts a fresh window after the dedup window expires', async () => {
    const { stream, pushLine } = makeLogStream();
    const mockContainer = { logs: vi.fn().mockResolvedValue(stream) };
    mockDockerInstance.getContainer.mockReturnValue(mockContainer);

    const prisma = makePrisma();
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    // First occurrence
    pushLine(makeDnsQueryLine({ qname: 'api.openai.com', action: 'observed' }));
    await vi.advanceTimersByTimeAsync(1500);

    // Advance past 60-second dedup window
    await vi.advanceTimersByTimeAsync(61_000);

    // Second occurrence after window expiry — should produce a new row
    pushLine(makeDnsQueryLine({ qname: 'api.openai.com', action: 'observed' }));
    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).toHaveBeenCalledTimes(2);

    ingester.stop();
  });

  // -------------------------------------------------------------------------
  // EgressRule.hits is bumped when matchedPattern is set
  // -------------------------------------------------------------------------

  it('bumps EgressRule.hits when matchedPattern is present', async () => {
    const { stream, pushLine } = makeLogStream();
    const mockContainer = { logs: vi.fn().mockResolvedValue(stream) };
    mockDockerInstance.getContainer.mockReturnValue(mockContainer);

    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = makePrisma({ egressRuleUpdateMany: updateMany });
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    pushLine(makeDnsQueryLine({
      qname: 'api.openai.com',
      matchedPattern: 'api.openai.com',
      action: 'allowed',
    }));

    await vi.advanceTimersByTimeAsync(1500);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { policyId: 'policy-1', pattern: 'api.openai.com' },
        data: expect.objectContaining({ hits: { increment: 1 } }),
      }),
    );

    ingester.stop();
  });

  it('does not bump EgressRule.hits when matchedPattern is absent', async () => {
    const { stream, pushLine } = makeLogStream();
    const mockContainer = { logs: vi.fn().mockResolvedValue(stream) };
    mockDockerInstance.getContainer.mockReturnValue(mockContainer);

    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = makePrisma({ egressRuleUpdateMany: updateMany });
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    // Line with no matchedPattern
    pushLine(makeDnsQueryLine({ matchedPattern: undefined }));
    await vi.advanceTimersByTimeAsync(1500);

    expect(updateMany).not.toHaveBeenCalled();

    ingester.stop();
  });
});
