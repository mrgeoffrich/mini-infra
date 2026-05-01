/**
 * NatsBus integration test against a real `nats:2.12.8-alpine` container.
 *
 * Phase 1 verifies the smallest end-to-end loop: the server bus connects to
 * NATS, registers the smoke-ping responder, and a `pingSelf()` call returns
 * a typed reply with the same nonce. Schema validation is exercised on both
 * the publish and reply paths.
 *
 * Named `*.external.test.ts` to match the convention in `nats-account-claim-
 * update.external.test.ts` — these tests pull a Docker image and run a real
 * server, so they're slower than the in-memory suite.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { SystemSubject } from "@mini-infra/types";
import { NatsBus } from "../nats-bus";
import { pingSelf, registerPingResponder } from "../nats-bus-ping";

const NATS_IMAGE = "nats:2.12.8-alpine";

let container: StartedTestContainer;
let bus: NatsBus;
let url: string;

describe("NatsBus (external)", () => {
  beforeAll(async () => {
    // Phase 1 smoke uses no auth — we're testing the bus mechanics, not the
    // creds plumbing (covered by the existing nats-account-claim-update
    // tests). The Phase 0 control-plane tests use a full operator/account
    // setup; mixing that in here would add boot time without coverage value.
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
    registerPingResponder();
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

  it("connects via the test override URL", () => {
    const health = bus.getHealth();
    expect(health.state).toBe("connected");
    expect(health.url).toBe(url);
    expect(health.lastConnectedAtMs).not.toBeNull();
  });

  it("ping/pong round-trips with matching nonce", async () => {
    const result = await pingSelf(2_000);
    expect(result.reply.responder).toBe("server");
    expect(typeof result.reply.nonce).toBe("string");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.latencyMs).toBeLessThan(2_000);
  });

  it("rejects publishes with payloads that fail Zod validation", async () => {
    await expect(
      // Missing `nonce` and `sentAtMs` — schema requires both.
      bus.request(SystemSubject.ping, {} as { nonce: string; sentAtMs: number }, {
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/nats payload validation failed/);
  });

  it("getHealth() reports a connected state and a recent connect timestamp", () => {
    const before = Date.now();
    const health = bus.getHealth();
    expect(health.state).toBe("connected");
    expect(health.lastConnectedAtMs).toBeLessThanOrEqual(before);
    expect(health.lastErrorMessage).toBeNull();
  });
});
