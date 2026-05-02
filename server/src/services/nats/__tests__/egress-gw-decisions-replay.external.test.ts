/**
 * Integration test for the headline acceptance criterion of Phase 3 (ALT-28):
 *
 *   "Gateway container restart does not drop in-flight proxy decisions
 *    (today they are lost via log-attach disconnect — this is the headline win)"
 *
 * Equivalently for the consumer side: the server's `EgressGwDecisions-server`
 * consumer can crash mid-stream and the queued decisions wait in JetStream
 * until a fresh consumer attaches. This test boots a real NATS server with
 * JetStream enabled, stands up the stream + durable consumer, publishes a
 * burst of decisions, kills the consumer mid-flight, publishes another
 * burst (which would be lost in the old log-tail world), then reattaches —
 * and asserts every decision is delivered.
 *
 * No auth on this NATS — we exercise the mechanic, not the creds plumbing
 * (covered by `nats-account-claim-update.external.test.ts`).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { EgressGwSubject, NatsStream } from "@mini-infra/types";
import { NatsBus } from "../nats-bus";
import type { EgressGwDecision } from "../payload-schemas";

const NATS_IMAGE = "nats:2.12.8-alpine";

let container: StartedTestContainer;
let url: string;

const STREAM_NAME = NatsStream.egressGwDecisions;
const CONSUMER_NAME = "EgressGwDecisions-server";

function decision(envId: string, n: number): EgressGwDecision {
  return {
    evt: "tcp",
    ts: new Date(Date.now() + n).toISOString(),
    environmentId: envId,
    protocol: "connect",
    srcIp: "10.0.0.1",
    target: `host-${n}.example.com:443`,
    action: "allowed",
    matchedPattern: "*.example.com",
    stackId: "stk-test",
    serviceName: "web",
    bytesUp: 1024,
    bytesDown: 4096,
    mergedHits: 1,
  } as EgressGwDecision;
}

describe("Egress gateway decisions — replay across consumer restart (external)", () => {
  beforeAll(async () => {
    container = await new GenericContainer(NATS_IMAGE)
      .withCommand(["-js", "-m", "8222"])
      .withExposedPorts(4222, 8222)
      .withWaitStrategy(Wait.forHttp("/healthz", 8222).forStatusCode(200))
      .withStartupTimeout(20_000)
      .start();
    url = `nats://${container.getHost()}:${container.getMappedPort(4222)}`;
  }, 30_000);

  afterAll(async () => {
    if (container) {
      try {
        await container.stop({ timeout: 5_000 });
      } catch {
        // best-effort
      }
    }
  });

  beforeEach(() => {
    NatsBus.resetInstanceForTests();
  });

  afterEach(async () => {
    try {
      await NatsBus.getInstance().shutdown();
    } catch {
      // best-effort
    }
    NatsBus.resetInstanceForTests();
  });

  it("delivers every decision across a server-side consumer restart", async () => {
    // Boot the bus and wait for connection.
    const bus = NatsBus.getInstance({ testOverride: { url } });
    bus.start();
    await bus.ready({ timeoutMs: 10_000 });

    // Stand up the stream + durable consumer the way `system-nats-bootstrap`
    // does in production. Work-queue retention so the test asserts the
    // exactly-once-on-ack guarantee that the EgressDecisionsConsumer relies
    // on.
    await bus.jsEnsureStream({
      name: STREAM_NAME,
      subjects: [EgressGwSubject.decisions],
      retention: "workqueue",
      maxBytes: 50 * 1024 * 1024, // 50 MiB — plenty for the test burst
      maxAgeSeconds: 600, // 10 min
      description: "Egress gateway decisions (test)",
    });
    await bus.jsEnsureConsumer(STREAM_NAME, {
      name: CONSUMER_NAME,
      durableName: CONSUMER_NAME,
      ackPolicy: "explicit",
      deliverPolicy: "all",
      ackWaitSeconds: 30,
      maxDeliver: 5,
    });

    const envId = "env-replay-test";
    const TOTAL = 50;
    const FIRST_BATCH = 20;

    // Phase 1 — register a consumer and start draining.
    const received1: string[] = [];
    const cancel1 = bus.jsConsume<EgressGwDecision>(
      STREAM_NAME,
      CONSUMER_NAME,
      async (d, msg) => {
        received1.push(d.target);
        msg.ack();
      },
    );

    // Publish FIRST_BATCH decisions.
    for (let i = 0; i < FIRST_BATCH; i++) {
      await bus.jsPublish(EgressGwSubject.decisions, decision(envId, i));
    }
    await waitFor(() => received1.length === FIRST_BATCH, 5_000);
    expect(received1.length).toBe(FIRST_BATCH);

    // Phase 2 — kill the consumer iterator (simulates server crash).
    cancel1();

    // Publish the remaining decisions while there's no live consumer.
    // These are the messages that the legacy `docker logs` follower would
    // have lost on a server restart.
    for (let i = FIRST_BATCH; i < TOTAL; i++) {
      await bus.jsPublish(EgressGwSubject.decisions, decision(envId, i));
    }

    // Phase 3 — re-attach a fresh consumer iterator. JetStream should have
    // the post-cancel messages still queued under the durable consumer name.
    const received2: string[] = [];
    const cancel2 = bus.jsConsume<EgressGwDecision>(
      STREAM_NAME,
      CONSUMER_NAME,
      async (d, msg) => {
        received2.push(d.target);
        msg.ack();
      },
    );

    await waitFor(() => received2.length >= TOTAL - FIRST_BATCH, 10_000);

    // The fresh consumer should see the post-cancel batch (and only that —
    // the first batch was acked before cancel).
    const allTargets = new Set([...received1, ...received2]);
    expect(allTargets.size).toBe(TOTAL);
    for (let i = 0; i < TOTAL; i++) {
      expect(allTargets.has(`host-${i}.example.com:443`)).toBe(true);
    }

    cancel2();
  }, 60_000);

  it("rejects malformed decision publishes via the bus's Zod gate", async () => {
    const bus = NatsBus.getInstance({ testOverride: { url } });
    bus.start();
    await bus.ready({ timeoutMs: 10_000 });
    await bus.jsEnsureStream({
      name: STREAM_NAME,
      subjects: [EgressGwSubject.decisions],
      retention: "workqueue",
      maxBytes: 50 * 1024 * 1024,
      maxAgeSeconds: 600,
    });
    // Zod requires `evt` to be `dns.query` or `tcp` — anything else fails.
    await expect(
      bus.jsPublish(EgressGwSubject.decisions, { evt: "wat" } as never),
    ).rejects.toThrow(/nats payload validation failed/);
  }, 30_000);
});

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}
