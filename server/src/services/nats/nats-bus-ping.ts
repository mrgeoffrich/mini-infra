/**
 * Smoke ping for the NatsBus.
 *
 * Phase 1 closes the bus loop by having the server reply to its own
 * `mini-infra.system.ping` requests. Until Phase 2 wires the first real
 * peer (egress-fw-agent), this is the only honest health-check the bus
 * has — but it does prove a non-trivial set of guarantees end to end:
 *
 *   - the bus is connected to NATS
 *   - server-bus credentials grant pub + sub on `mini-infra.>`
 *   - JSON encode/decode and Zod validation are wired correctly
 *   - request/reply round-trip latency is measurable
 *
 * `registerPingResponder()` runs once at boot. `pingSelf()` is the active
 * probe — call it for a synthetic request/reply cycle that returns the
 * round-trip latency. A future ConnectivityScheduler integration can poll
 * `pingSelf()` on a timer; that's deliberately out of scope for Phase 1.
 */

import { randomUUID } from "node:crypto";
import { SystemSubject } from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import { NatsBus } from "./nats-bus";
import type {
  SystemPingReply,
  SystemPingRequest,
} from "./payload-schemas";

const log = getLogger("integrations", "nats-bus-ping");

const RESPONDER_ID = "server";

let cancel: (() => void) | null = null;

/**
 * Subscribe the server's bus connection to `mini-infra.system.ping` and reply
 * with a typed `SystemPingReply`. Idempotent — calling twice is a no-op. The
 * subscription is durable across bus reconnects (NatsBus re-attaches it).
 */
export function registerPingResponder(): void {
  if (cancel) return;
  const bus = NatsBus.getInstance();
  cancel = bus.respond<SystemPingRequest, SystemPingReply>(
    SystemSubject.ping,
    (req) => ({
      nonce: req.nonce,
      receivedAtMs: Date.now(),
      responder: RESPONDER_ID,
    }),
  );
  log.info({ subject: SystemSubject.ping }, "ping responder registered");
}

/** Tear down the responder. For tests; production never unregisters. */
export function unregisterPingResponderForTests(): void {
  if (cancel) {
    cancel();
    cancel = null;
  }
}

export interface PingResult {
  latencyMs: number;
  reply: SystemPingReply;
}

/**
 * Issue a `mini-infra.system.ping` request against the bus and return the
 * round-trip latency. Throws if the bus is not connected or the reply fails
 * validation.
 */
export async function pingSelf(timeoutMs = 2_000): Promise<PingResult> {
  const bus = NatsBus.getInstance();
  const sentAtMs = Date.now();
  const nonce = randomUUID();
  const reply = await bus.request<SystemPingRequest, SystemPingReply>(
    SystemSubject.ping,
    { nonce, sentAtMs },
    { timeoutMs },
  );
  const latencyMs = Date.now() - sentAtMs;
  if (reply.nonce !== nonce) {
    throw new Error(
      `ping reply nonce mismatch (expected ${nonce}, got ${reply.nonce})`,
    );
  }
  return { latencyMs, reply };
}
