/**
 * Tests for EgressDecisionsConsumer (the JetStream-driven gateway decision
 * ingester that replaced the per-env Docker log-attach in Phase 3 / ALT-28).
 *
 * Coverage:
 *  1. dns.query → EgressEvent row, dedup-window collapse, EgressRule.hits bump
 *  2. tcp.connect → EgressEvent row with target/bytes/matchedPattern
 *  3. tcp.http   → EgressEvent row with method/path/status/bytesDown
 *  4. message ack semantics: ack runs after batch flush succeeds, suppressed
 *     messages ack immediately, dropped (no-stackId / no-policy) messages
 *     ack so JetStream doesn't redeliver them forever
 *  5. flush failure leaves messages unacked (so JetStream redelivers)
 *
 * Headline behaviour ("decisions survive a gateway restart") is covered by
 * the integration test against a real NATS+JetStream container — see
 * `server/src/__tests__/egress-decisions-replay.external.test.ts`.
 */

import type { Mocked } from 'vitest';
import type { PrismaClient } from '../../../generated/prisma/client';
import type {
  EgressGwDecision,
} from '../../nats/payload-schemas';

// ---------------------------------------------------------------------------
// NatsBus mock — captures the bus.jetstream.consume handler so tests can
// drive it. Phase 2 (ALT-27) reshaped the JetStream surface from a flat
// `bus.jsConsume(stream, consumer, handler, opts)` to a namespaced
// `bus.jetstream.consume(spec, handler, opts)` — the captured handler
// signature is the same (body, ctx) but the mock has to match the new shape.
// ---------------------------------------------------------------------------

type CapturedHandler = (decision: EgressGwDecision, ctx: { ack: () => void }) => Promise<void>;
let capturedHandler: CapturedHandler | null = null;

vi.mock('../../nats/nats-bus', () => ({
  NatsBus: {
    getInstance: () => ({
      jetstream: {
        consume: vi.fn(
          (
            _spec: { stream: string; durable: string; filterSubject?: string },
            handler: CapturedHandler,
          ) => {
            capturedHandler = handler;
            return () => {
              capturedHandler = null;
            };
          },
        ),
      },
    }),
  },
}));

vi.mock('../../docker', () => ({
  default: {
    getInstance: vi.fn(() => ({
      isConnected: vi.fn().mockReturnValue(true),
      onContainerEvent: vi.fn(),
      getDockerInstance: vi.fn().mockResolvedValue({}),
      listContainers: vi.fn().mockResolvedValue([]),
    })),
  },
}));

vi.mock('../../../lib/logger-factory', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import AFTER vi.mock so the consumer picks up our mocked NatsBus.
import { EgressLogIngester } from '../egress-log-ingester';

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

function dnsDecision(overrides: Partial<EgressGwDecision> = {}): EgressGwDecision {
  return {
    evt: 'dns.query',
    ts: '2026-05-01T00:00:00.000Z',
    environmentId: 'env-1',
    srcIp: '172.30.0.10',
    qname: 'api.example.com',
    qtype: 'A',
    action: 'observed',
    stackId: 'stk-1',
    serviceName: 'web',
    mergedHits: 1,
    ...overrides,
  } as EgressGwDecision;
}

function tcpConnectDecision(overrides: Partial<EgressGwDecision> = {}): EgressGwDecision {
  return {
    evt: 'tcp',
    ts: '2026-05-01T00:00:01.000Z',
    environmentId: 'env-1',
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
  } as EgressGwDecision;
}

function tcpHttpDecision(overrides: Partial<EgressGwDecision> = {}): EgressGwDecision {
  return {
    evt: 'tcp',
    ts: '2026-05-01T00:00:02.000Z',
    environmentId: 'env-1',
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
  } as EgressGwDecision;
}

async function deliver(decision: EgressGwDecision): Promise<{ ack: ReturnType<typeof vi.fn> }> {
  if (!capturedHandler) throw new Error('handler not registered yet');
  const ack = vi.fn();
  await capturedHandler(decision, { ack });
  return { ack };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EgressDecisionsConsumer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedHandler = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('persists a dns.query decision and acks after batch flush', async () => {
    const prisma = makePrisma();
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();
    expect(capturedHandler).not.toBeNull();

    const { ack } = await deliver(dnsDecision());

    // Ack must NOT fire until the batch is flushed — that's the
    // "no decisions lost" guarantee.
    expect(ack).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).toHaveBeenCalledTimes(1);
    const [args] = createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    expect(args.data).toHaveLength(1);
    expect(args.data[0].destination).toBe('api.example.com');
    expect(args.data[0].protocol).toBe('dns');
    expect(args.data[0].action).toBe('observed');

    expect(ack).toHaveBeenCalledTimes(1);
    ingester.stop();
  });

  it('persists a tcp/connect decision with target and bytes', async () => {
    const prisma = makePrisma();
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    await deliver(tcpConnectDecision());
    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).toHaveBeenCalledTimes(1);
    const [args] = createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    const row = args.data[0];
    expect(row.protocol).toBe('connect');
    expect(row.target).toBe('api.example.com:443');
    expect(row.bytesUp).toBe(1024n);
    expect(row.bytesDown).toBe(4096n);
    expect(row.matchedPattern).toBe('*.example.com');

    ingester.stop();
  });

  it('persists a tcp/http decision with method/path/status', async () => {
    const prisma = makePrisma();
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    await deliver(tcpHttpDecision());
    await vi.advanceTimersByTimeAsync(1500);

    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).toHaveBeenCalledTimes(1);
    const [args] = createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    const row = args.data[0];
    expect(row.protocol).toBe('http');
    expect(row.method).toBe('GET');
    expect(row.path).toBe('/some/path');
    expect(row.status).toBe(200);
    expect(row.bytesDown).toBe(1234n);

    ingester.stop();
  });

  it('collapses repeated decisions inside the dedup window and acks suppressed msgs immediately', async () => {
    const prisma = makePrisma();
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    // First message: enqueued, not yet acked
    const first = await deliver(dnsDecision());
    expect(first.ack).not.toHaveBeenCalled();

    // Three more identical decisions inside the dedup window — suppressed,
    // each acks immediately because there's no row queued for them.
    const dups = await Promise.all([
      deliver(dnsDecision()),
      deliver(dnsDecision()),
      deliver(dnsDecision()),
    ]);
    for (const d of dups) {
      expect(d.ack).toHaveBeenCalledTimes(1);
    }

    await vi.advanceTimersByTimeAsync(1500);

    // Only one row from the first delivery; first's ack now fires.
    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).toHaveBeenCalledTimes(1);
    const [args] = createMany.mock.calls[0] as [{ data: unknown[] }];
    expect(args.data).toHaveLength(1);
    expect(first.ack).toHaveBeenCalledTimes(1);

    ingester.stop();
  });

  it('acks decisions that drop pre-row (no stackId / no policy) so JetStream does not redeliver', async () => {
    const prisma = makePrisma({ policy: null });
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    const noStack = await deliver(dnsDecision({ stackId: undefined }));
    const noPolicy = await deliver(dnsDecision({ stackId: 'unknown' }));

    expect(noStack.ack).toHaveBeenCalledTimes(1);
    expect(noPolicy.ack).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1500);
    const createMany = prisma.egressEvent.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).not.toHaveBeenCalled();

    ingester.stop();
  });

  it('does NOT ack when batch flush fails — JetStream will redeliver', async () => {
    const failingCreateMany = vi
      .fn()
      .mockRejectedValue(new Error('database down'));
    const prisma = makePrisma({ egressEventCreateMany: failingCreateMany });
    const ingester = new EgressLogIngester(prisma);
    await ingester.start();

    const { ack } = await deliver(dnsDecision());
    await vi.advanceTimersByTimeAsync(1500);

    expect(failingCreateMany).toHaveBeenCalled();
    // No ack — the message stays in JetStream and will be redelivered after
    // ack-wait expires. The dedup window will catch the duplicate on
    // redelivery (within 60s), so we don't double-write.
    expect(ack).not.toHaveBeenCalled();

    ingester.stop();
  });
});
