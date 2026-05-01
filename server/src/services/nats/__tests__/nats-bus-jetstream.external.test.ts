/**
 * Integration test for the JetStream + KV wrappers added in ALT-27 Phase 2.
 *
 * Mirrors the Phase 1 smoke shape (`nats-bus.external.test.ts`): boots a
 * real `nats:2.12.8-alpine` with `-js` enabled, exercises ensureStream /
 * ensureConsumer / consume / kv.put + kv.get end-to-end. The dispatch and
 * reconnect machinery are unit-tested elsewhere; this suite proves the
 * JetStream codepath wires up cleanly against a real server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { NatsBus } from "../nats-bus";

const NATS_IMAGE = "nats:2.12.8-alpine";
const TEST_STREAM = "EgressFwEventsTest";
const TEST_SUBJECT = "mini-infra.egress.fw.events";
const TEST_DURABLE = "EgressFwEventsTest-server";
const TEST_KV_BUCKET = "egress-fw-health-test";

let container: StartedTestContainer;
let bus: NatsBus;
let url: string;

describe("NatsBus JetStream + KV (external)", () => {
  beforeAll(async () => {
    container = await new GenericContainer(NATS_IMAGE)
      .withCommand(["-js", "-m", "8222"])
      .withExposedPorts(4222, 8222)
      .withWaitStrategy(Wait.forHttp("/healthz", 8222).forStatusCode(200))
      .withStartupTimeout(20_000)
      .start();
    url = `nats://${container.getHost()}:${container.getMappedPort(4222)}`;
    NatsBus.resetInstanceForTests();
    bus = NatsBus.getInstance({ testOverride: { url } });
    bus.start();
    await bus.ready({ timeoutMs: 10_000 });
  }, 30_000);

  afterAll(async () => {
    if (bus) await bus.shutdown();
    NatsBus.resetInstanceForTests();
    if (container) {
      try {
        await container.stop({ timeout: 5_000 });
      } catch {
        // best-effort
      }
    }
  });

  it("ensureStream + jetstream.publish + ensureConsumer + consume round-trips a typed message", async () => {
    await bus.jetstream.ensureStream({
      name: TEST_STREAM,
      subjects: [TEST_SUBJECT],
      maxBytes: 100 * 1024 * 1024,
      maxAgeMs: 60 * 60 * 1000,
    });
    await bus.jetstream.ensureConsumer({
      stream: TEST_STREAM,
      durable: TEST_DURABLE,
      filterSubject: TEST_SUBJECT,
    });

    type EgressFwEvent = {
      occurredAtMs: number;
      protocol: "tcp" | "udp" | "icmp";
      srcIp: string;
      destIp: string;
      destPort?: number;
      mergedHits: number;
    };

    const received: EgressFwEvent[] = [];
    const cancel = bus.jetstream.consume<EgressFwEvent>(
      {
        stream: TEST_STREAM,
        durable: TEST_DURABLE,
        filterSubject: TEST_SUBJECT,
      },
      async (msg) => {
        received.push(msg);
      },
      { unchecked: true /* test stream not in payload-schemas */, ack: "auto" },
    );

    try {
      const evt: EgressFwEvent = {
        occurredAtMs: Date.now(),
        protocol: "tcp",
        srcIp: "172.30.0.10",
        destIp: "1.1.1.1",
        destPort: 443,
        mergedHits: 1,
      };
      const ack = await bus.jetstream.publish<EgressFwEvent>(TEST_SUBJECT, evt, {
        unchecked: true,
      });
      expect(ack.stream).toBe(TEST_STREAM);
      expect(ack.seq).toBeGreaterThan(0);

      // Wait briefly for delivery — NATS server typically acks within 10ms
      // but testcontainers add some jitter on first delivery.
      const deadline = Date.now() + 3_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(received).toHaveLength(1);
      expect(received[0].srcIp).toBe("172.30.0.10");
      expect(received[0].destPort).toBe(443);
    } finally {
      cancel();
    }
  });

  it("kv put + get round-trips a JSON value with revision tracking", async () => {
    await bus.jetstream.ensureKv({
      bucket: TEST_KV_BUCKET,
      ttlMs: 60_000,
    });
    const kv = bus.jetstream.kv(TEST_KV_BUCKET);

    type Heartbeat = { ok: boolean; reportedAtMs: number; lastApplyId?: string };

    const writeRev = await kv.put<Heartbeat>("current", {
      ok: true,
      reportedAtMs: 1_700_000_000_000,
      lastApplyId: "apply-001",
    });
    expect(writeRev).toBeGreaterThan(0);

    const got = await kv.get<Heartbeat>("current");
    expect(got).not.toBeNull();
    expect(got!.value.ok).toBe(true);
    expect(got!.value.reportedAtMs).toBe(1_700_000_000_000);
    expect(got!.value.lastApplyId).toBe("apply-001");
    expect(got!.revision).toBe(writeRev);
  });

  it("kv.get returns null for a missing key", async () => {
    await bus.jetstream.ensureKv({ bucket: TEST_KV_BUCKET, ttlMs: 60_000 });
    const kv = bus.jetstream.kv(TEST_KV_BUCKET);
    const got = await kv.get("never-written");
    expect(got).toBeNull();
  });
});
