/**
 * Tests for EgressLogIngester (internal logic)
 *
 * We test the ingester's behaviour via the exported EgressLogIngester class,
 * but most logic lives in the private GatewayTailer and FwAgentTailer. We
 * test it indirectly by exercising the public `start()` method with mocked
 * DockerService and Prisma, and by triggering synthetic log lines.
 *
 * Key behaviours tested:
 *  1. Only recognised evt types are ingested; others are ignored.
 *  2. Lines without a stackId are dropped.
 *  3. Lines whose stackId has no matching EgressPolicy are dropped.
 *  4. Dedup window collapses repeated entries within 60 s.
 *  5. EgressRule.hits is bumped when matchedPattern is set.
 *  6. tcp/connect events persist target/bytes/matchedPattern.
 *  7. tcp/http events persist method/path/status/bytesDown.
 *  8. fw_drop events persist destIp/destPort/protocol/reason.
 *  9. fw_drop dedup collapses repeated (policyId, service, srcIp, destIp, destPort, protocol).
 * 10. fw_drop without stackId is dropped.
 * 11. fw_drop dedup window expiry starts a fresh window.
 * 12. fw_drop with no matching EgressPolicy is dropped.
 */

import { EgressLogIngester } from '../egress-log-ingester';
import type { PrismaClient } from '../../../generated/prisma/client';
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
let capturedContainerEventCallback: ((event: { action: string; containerName?: string; labels?: Record<string, string> }) => void) | null = null;

/** Raw dockerode mock — used by GatewayTailer for name-based container lookup + log streaming */
const mockDockerInstance = {
  listContainers: vi.fn(),
  getContainer: vi.fn(),
};

/**
 * DockerService wrapper mock — FwAgentTailer calls dockerService.listContainers()
 * (the wrapper) which returns DockerContainerInfo[] with a `labels` field.
 */
const mockDockerServiceListContainers = vi.fn();

vi.mock('../../docker', () => ({
  default: {
    getInstance: vi.fn(() => ({
      isConnected: vi.fn().mockReturnValue(true),
      onContainerEvent: vi.fn((cb: (event: { action: string; containerName?: string; labels?: Record<string, string> }) => void) => {
        capturedContainerEventCallback = cb;
      }),
      getDockerInstance: vi.fn().mockResolvedValue(mockDockerInstance),
      listContainers: mockDockerServiceListContainers,
    })),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrisma(overrides: {
  policy?: { id: string; stackNameSnapshot: string; environmentNameSnapshot: string; environmentId: string | null } | null;
  egressEventCreateMany?: ReturnType<typeof vi.fn>;
  egressRuleUpdateMany?: ReturnType<typeof vi.fn>;
} = {}): Mocked<PrismaClient> {
  const defaultPolicy = {
    id: 'policy-1',
    stackNameSnapshot: 'my-stack',
    environmentNameSnapshot: 'staging',
    environmentId: 'env-1',
  };
  return {
    environment: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'env-1', name: 'staging', egressGatewayIp: '172.30.0.2' },
      ]),
    },
    egressPolicy: {
      findFirst: vi.fn().mockResolvedValue(
        overrides.policy !== undefined ? overrides.policy : defaultPolicy,
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

function makeTcpConnectLine(overrides: object = {}): object {
  return {
    ts: new Date().toISOString(),
    evt: 'tcp',
    protocol: 'connect',
    srcIp: '172.30.0.10',
    target: 'api.example.com:443',
    action: 'allowed',
    matchedPattern: '*.example.com',
    stackId: 'stk-1',
    serviceName: 'web',
    bytesUp: 1024,
    bytesDown: 4096,
    mergedHits: 1,
    ...overrides,
  };
}

function makeTcpHttpLine(overrides: object = {}): object {
  return {
    ts: new Date().toISOString(),
    evt: 'tcp',
    protocol: 'http',
    srcIp: '172.30.0.10',
    target: 'example.com',
    method: 'GET',
    path: '/some/path',
    status: 200,
    bytesDown: 1234,
    action: 'allowed',
    matchedPattern: '*.example.com',
    stackId: 'stk-1',
    serviceName: 'web',
    mergedHits: 1,
    ...overrides,
  };
}

function makeFwDropLine(overrides: object = {}): object {
  return {
    ts: new Date().toISOString(),
    evt: 'fw_drop',
    protocol: 'tcp',
    srcIp: '172.30.0.10',
    destIp: '10.20.30.40',
    destPort: 5432,
    stackId: 'stk-1',
    serviceName: 'web',
    reason: 'non-allowed-egress',
    mergedHits: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup: gateway container is the default; fw-agent is added per test
// ---------------------------------------------------------------------------

/**
 * Set up the raw docker mock for GatewayTailer (name-based container lookup).
 * GatewayTailer still calls docker.listContainers() with a name filter.
 */
function setupGatewayContainerMock() {
  mockDockerInstance.listContainers.mockImplementation((opts: { filters?: string }) => {
    const filters = opts?.filters ? (JSON.parse(opts.filters) as Record<string, string[]>) : {};
    // Gateway container lookup (by name)
    if (filters['name']) {
      return Promise.resolve([
        {
          Id: 'gw-container-1',
          Names: ['/staging-egress-gateway-egress-gateway'],
          NetworkSettings: { Networks: {} },
        },
      ]);
    }
    return Promise.resolve([]);
  });
}

/**
 * Set up the DockerService.listContainers() wrapper mock for FwAgentTailer.
 * Returns DockerContainerInfo[] with a `labels` field.
 */
function setupFwAgentServiceMock(includeFwAgent = false) {
  if (includeFwAgent) {
    mockDockerServiceListContainers.mockResolvedValue([
      {
        id: 'fw-agent-container-1',
        name: 'egress-fw-agent',
        labels: { 'mini-infra.egress.fw-agent': 'true' },
        status: 'running',
        image: 'fw-agent',
        imageTag: 'latest',
        ports: [],
        volumes: [],
        createdAt: new Date(),
      },
    ]);
  } else {
    mockDockerServiceListContainers.mockResolvedValue([]);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EgressLogIngester', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedContainerEventCallback = null;
    // Default: gateway container present, no fw-agent
    setupGatewayContainerMock();
    setupFwAgentServiceMock(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Only dns.query lines are ingested (existing behaviour)
  // -------------------------------------------------------------------------

  it('ingests dns.query lines and ignores other evt types', async () => {
    const { stream, pushLine } = makeLogStream();
    const fwAgentStream = new Readable({ read() {} }); // idle fw-agent stream
    mockDockerInstance.getContainer.mockImplementation((id: string) => ({
      logs: vi.fn().mockResolvedValue(id === 'gw-container-1' ? stream : fwAgentStream),
    }));

    const prisma = makePrisma();
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    // Push a dns.query line and unrecognised event lines
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
    const fwAgentStream = new Readable({ read() {} });
    mockDockerInstance.getContainer.mockImplementation((id: string) => ({
      logs: vi.fn().mockResolvedValue(id === 'gw-container-1' ? stream : fwAgentStream),
    }));

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
    const fwAgentStream = new Readable({ read() {} });
    mockDockerInstance.getContainer.mockImplementation((id: string) => ({
      logs: vi.fn().mockResolvedValue(id === 'gw-container-1' ? stream : fwAgentStream),
    }));

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
    const fwAgentStream = new Readable({ read() {} });
    mockDockerInstance.getContainer.mockImplementation((id: string) => ({
      logs: vi.fn().mockResolvedValue(id === 'gw-container-1' ? stream : fwAgentStream),
    }));

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
    const fwAgentStream = new Readable({ read() {} });
    mockDockerInstance.getContainer.mockImplementation((id: string) => ({
      logs: vi.fn().mockResolvedValue(id === 'gw-container-1' ? stream : fwAgentStream),
    }));

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
    const fwAgentStream = new Readable({ read() {} });
    mockDockerInstance.getContainer.mockImplementation((id: string) => ({
      logs: vi.fn().mockResolvedValue(id === 'gw-container-1' ? stream : fwAgentStream),
    }));

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
    const fwAgentStream = new Readable({ read() {} });
    mockDockerInstance.getContainer.mockImplementation((id: string) => ({
      logs: vi.fn().mockResolvedValue(id === 'gw-container-1' ? stream : fwAgentStream),
    }));

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

  // -------------------------------------------------------------------------
  // tcp/connect events
  // -------------------------------------------------------------------------

  it('parses tcp connect event (allowed) and persists target/bytes/matchedPattern', async () => {
    const { stream, pushLine } = makeLogStream();
    const fwAgentStream = new Readable({ read() {} });
    mockDockerInstance.getContainer.mockImplementation((id: string) => ({
      logs: vi.fn().mockResolvedValue(id === 'gw-container-1' ? stream : fwAgentStream),
    }));

    const prisma = makePrisma();
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    pushLine(makeTcpConnectLine({
      target: 'api.example.com:443',
      action: 'allowed',
      matchedPattern: '*.example.com',
      bytesUp: 1024,
      bytesDown: 4096,
    }));

    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).toHaveBeenCalledTimes(1);
    const [args] = createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    const row = args.data[0];
    expect(row.destination).toBe('api.example.com:443');
    expect(row.target).toBe('api.example.com:443');
    expect(row.protocol).toBe('connect');
    expect(row.action).toBe('allowed');
    expect(row.matchedPattern).toBe('*.example.com');
    expect(row.bytesUp).toBe(BigInt(1024));
    expect(row.bytesDown).toBe(BigInt(4096));
    expect(row.reason).toBeNull();

    ingester.stop();
  });

  it('parses tcp connect event (blocked) and persists reason', async () => {
    const { stream, pushLine } = makeLogStream();
    const fwAgentStream = new Readable({ read() {} });
    mockDockerInstance.getContainer.mockImplementation((id: string) => ({
      logs: vi.fn().mockResolvedValue(id === 'gw-container-1' ? stream : fwAgentStream),
    }));

    const prisma = makePrisma();
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    pushLine(makeTcpConnectLine({
      target: 'evil.example.com:443',
      action: 'blocked',
      reason: 'rule-deny',
      matchedPattern: undefined,
      bytesUp: undefined,
      bytesDown: undefined,
    }));

    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).toHaveBeenCalledTimes(1);
    const [args] = createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    const row = args.data[0];
    expect(row.action).toBe('blocked');
    expect(row.reason).toBe('rule-deny');
    expect(row.bytesUp).toBeNull();
    expect(row.bytesDown).toBeNull();

    ingester.stop();
  });

  // -------------------------------------------------------------------------
  // tcp/http events
  // -------------------------------------------------------------------------

  it('parses tcp http event (allowed) and persists method/path/status/bytesDown', async () => {
    const { stream, pushLine } = makeLogStream();
    const fwAgentStream = new Readable({ read() {} });
    mockDockerInstance.getContainer.mockImplementation((id: string) => ({
      logs: vi.fn().mockResolvedValue(id === 'gw-container-1' ? stream : fwAgentStream),
    }));

    const prisma = makePrisma();
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    pushLine(makeTcpHttpLine({
      target: 'example.com',
      method: 'GET',
      path: '/api/v1/data',
      status: 200,
      bytesDown: 5678,
      action: 'allowed',
      matchedPattern: '*.example.com',
    }));

    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).toHaveBeenCalledTimes(1);
    const [args] = createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    const row = args.data[0];
    expect(row.destination).toBe('example.com');
    expect(row.target).toBe('example.com');
    expect(row.method).toBe('GET');
    expect(row.path).toBe('/api/v1/data');
    expect(row.status).toBe(200);
    expect(row.bytesDown).toBe(BigInt(5678));
    expect(row.bytesUp).toBeNull();
    expect(row.protocol).toBe('http');
    expect(row.action).toBe('allowed');
    expect(row.matchedPattern).toBe('*.example.com');

    ingester.stop();
  });

  it('parses tcp http event (blocked) and persists reason', async () => {
    const { stream, pushLine } = makeLogStream();
    const fwAgentStream = new Readable({ read() {} });
    mockDockerInstance.getContainer.mockImplementation((id: string) => ({
      logs: vi.fn().mockResolvedValue(id === 'gw-container-1' ? stream : fwAgentStream),
    }));

    const prisma = makePrisma();
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    pushLine(makeTcpHttpLine({
      target: 'blocked.example.com',
      method: 'POST',
      path: '/submit',
      action: 'blocked',
      reason: 'ip-literal',
      status: undefined,
      bytesDown: undefined,
      matchedPattern: undefined,
    }));

    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).toHaveBeenCalledTimes(1);
    const [args] = createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    const row = args.data[0];
    expect(row.action).toBe('blocked');
    expect(row.reason).toBe('ip-literal');
    expect(row.status).toBeNull();
    expect(row.bytesDown).toBeNull();
    expect(row.matchedPattern).toBeNull();

    ingester.stop();
  });

  // -------------------------------------------------------------------------
  // fw_drop events (ALT-27 — now via JetStream durable consumer)
  //
  // These tests exercise `FwAgentJsConsumer._handleJsEvent` directly. The
  // legacy docker-logs/NDJSON path is gone; events arrive as typed
  // `EgressFwEvent` messages. The dedup/batch logic in BaseTailer is
  // unchanged so the behavior assertions match the legacy ones.
  // -------------------------------------------------------------------------

  // Helper: typed event payload shape matching `payload-schemas.ts`.
  function makeFwDropEvent(overrides: object = {}): {
    occurredAtMs: number;
    protocol: 'tcp' | 'udp' | 'icmp';
    srcIp: string;
    destIp: string;
    destPort?: number;
    stackId?: string;
    serviceName?: string;
    reason?: string;
    mergedHits: number;
  } {
    return {
      occurredAtMs: Date.now(),
      protocol: 'tcp',
      srcIp: '172.30.0.10',
      destIp: '10.20.30.40',
      destPort: 5432,
      stackId: 'stk-1',
      serviceName: 'web',
      reason: 'non-allowed-egress',
      mergedHits: 1,
      ...overrides,
    };
  }

  // Construct a bare consumer wired to a fake prisma, no NATS connection.
  // We invoke `_handleJsEvent` directly via `as any` — `FwAgentJsConsumer`
  // is exported intentionally lightly because its only public surface is
  // start/stop and the orchestrator. The dedup/batch helpers come from
  // BaseTailer and don't need NATS to exercise.
  async function newFwAgentConsumer(prisma: ReturnType<typeof makePrisma>) {
    // Lazy import to avoid pulling NATS bus deps before tests need them.
    const mod = await import('../egress-log-ingester');
    // Access the (non-exported) FwAgentJsConsumer via a small reflective
    // hack: instantiate `EgressLogIngester` and pull its private member
    // before .start() is called, then construct a fresh JS consumer
    // through the same constructor signature.
    void mod;
    // The class is private to the module. We export-by-effect: a sibling
    // accessor would be cleaner, but for unit-testing scope a constructor
    // shim works. The cast walks one prototype chain off the
    // EgressLogIngester start path — but that's an integration setup;
    // simpler: reconstruct directly via the BaseTailer parent. The
    // semantics under test (`_ingestFwDrop`) live on BaseTailer, so
    // any subclass with a public `start()` + `stop()` will do. We use
    // the JS consumer because that's what runs in production.
    const ingester = new EgressLogIngester(prisma);
    // Don't start the ingester (would require docker mocks). Instead
    // reach into the orchestrator's seam: spawn a JS consumer directly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = (mod as any).FwAgentJsConsumer ?? null;
    if (!Ctor) {
      // Fallback — reach via the orchestrator's start path. We only
      // do this if the module changes its export shape later.
      void ingester;
      throw new Error("FwAgentJsConsumer not exported from egress-log-ingester");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const consumer = new Ctor(prisma);
    // Start the batch timer so flushes happen on the existing 1s cadence.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (consumer as any)._startBatchTimer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return consumer as { _handleJsEvent: (e: object) => Promise<void>; stop(): void };
  }

  it('parses fw_drop event and persists destIp/destPort/protocol/reason', async () => {
    const prisma = makePrisma();
    const consumer = await newFwAgentConsumer(prisma);

    await consumer._handleJsEvent(makeFwDropEvent({
      destIp: '10.20.30.40',
      destPort: 5432,
      protocol: 'tcp',
      reason: 'non-allowed-egress',
      stackId: 'stk-1',
      serviceName: 'web',
    }));

    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).toHaveBeenCalledTimes(1);
    const [args] = createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    const row = args.data[0];
    expect(row.destIp).toBe('10.20.30.40');
    expect(row.destPort).toBe(5432);
    expect(row.protocol).toBe('tcp');
    expect(row.reason).toBe('non-allowed-egress');
    expect(row.action).toBe('blocked');
    expect(row.destination).toBe('10.20.30.40:5432');
    expect(row.matchedPattern).toBeNull();

    consumer.stop();
  });

  it('fw_drop dedup: collapses repeated (policyId, service, srcIp, destIp, destPort, protocol) within 60 s', async () => {
    const prisma = makePrisma();
    const consumer = await newFwAgentConsumer(prisma);

    // Send 5 identical events
    for (let i = 0; i < 5; i++) {
      await consumer._handleJsEvent(makeFwDropEvent({
        destIp: '10.20.30.40',
        destPort: 5432,
        protocol: 'tcp',
        stackId: 'stk-1',
        serviceName: 'web',
      }));
    }

    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    // Only first should produce a row
    expect(createMany).toHaveBeenCalledTimes(1);
    const [args] = createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    expect(args.data).toHaveLength(1);

    consumer.stop();
  });

  it('fw_drop without stackId is dropped', async () => {
    const prisma = makePrisma();
    const consumer = await newFwAgentConsumer(prisma);

    await consumer._handleJsEvent(makeFwDropEvent({ stackId: undefined }));

    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).not.toHaveBeenCalled();

    consumer.stop();
  });

  it('fw_drop: starts a fresh window after the dedup window expires', async () => {
    const prisma = makePrisma();
    const consumer = await newFwAgentConsumer(prisma);

    await consumer._handleJsEvent(makeFwDropEvent({
      destIp: '10.20.30.40',
      destPort: 5432,
      protocol: 'tcp',
    }));
    await vi.advanceTimersByTimeAsync(1500);

    // Advance past 60-second dedup window
    await vi.advanceTimersByTimeAsync(61_000);

    // Second occurrence — should produce a new row
    await consumer._handleJsEvent(makeFwDropEvent({
      destIp: '10.20.30.40',
      destPort: 5432,
      protocol: 'tcp',
    }));
    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).toHaveBeenCalledTimes(2);

    consumer.stop();
  });

  it('fw_drop: drops events when stackId has no matching EgressPolicy', async () => {
    const prisma = makePrisma({ policy: null }); // no policy found
    const consumer = await newFwAgentConsumer(prisma);

    await consumer._handleJsEvent(makeFwDropEvent({ stackId: 'unknown-stack' }));

    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).not.toHaveBeenCalled();

    consumer.stop();
  });
});
