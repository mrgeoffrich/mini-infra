/**
 * EgressGatewayTransport — NATS-backed control plane to the per-env gateway.
 *
 * Replaces the legacy `EgressGatewayClient` (HTTP to the gateway's `:8054`
 * admin port). Same surface — `pushRules`, `pushContainerMap`, health — but
 * delivered over `NatsBus.request()` on per-env subjects. Phase 3, ALT-28.
 *
 * Subject scheme
 * ─────────────
 * Commands are addressed per-environment by appending the envId token:
 *
 *   mini-infra.egress.gw.rules.apply.<envId>
 *   mini-infra.egress.gw.container-map.apply.<envId>
 *
 * The base prefixes live in `lib/types/nats-subjects.ts` as constants —
 * runtime code appends the envId to route to a specific gateway. Each
 * gateway subscribes only to its own env's subject (its credential profile
 * grants `rules.apply.>` / `container-map.apply.>` so it can pick up its
 * env's variant), which keeps a single shared stream of subjects without
 * any broadcast-and-filter at the consumer.
 *
 * Health is a separate concern: gateways publish heartbeats into the
 * `egress-gw-health` JetStream KV bucket keyed by envId. `readHealth` here
 * exposes that to the rule pusher's UI emitter.
 */

import { EgressGwSubject, NatsKvBucket } from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import { NatsBus } from "../nats/nats-bus";
import {
  egressGwHealthSchema,
  type EgressGwContainerMapApplyReply,
  type EgressGwContainerMapApplyRequest,
  type EgressGwHealth,
  type EgressGwRulesApplyReply,
  type EgressGwRulesApplyRequest,
} from "../nats/payload-schemas";

const log = getLogger("integrations", "egress-gateway-transport");

const KV_HEALTH_BUCKET = NatsKvBucket.egressGwHealth;

const DEFAULT_PUSH_TIMEOUT_MS = 5_000;

export class EgressGatewayTransportError extends Error {
  constructor(
    message: string,
    public readonly status: "rejected" | "timeout" | "transport",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EgressGatewayTransportError";
  }
}

export interface PushRulesResult {
  version: number;
  ruleCount: number;
  stackCount: number;
  accepted: boolean;
}

export interface PushContainerMapResult {
  version: number;
  entryCount: number;
  accepted: boolean;
}

/**
 * Push a rules snapshot to a specific environment's gateway. The reply is
 * Zod-validated by NatsBus on the way back; a non-accepted reply is
 * surfaced as an error so the caller's existing retry loop can react.
 *
 * Returns the gateway's reply once it's been validated. Throws on transport
 * failure (timeout, no responder) — callers retry as before.
 */
export async function pushRulesViaNats(
  environmentId: string,
  request: Omit<EgressGwRulesApplyRequest, "environmentId">,
  opts: { timeoutMs?: number } = {},
): Promise<PushRulesResult> {
  const subject = `${EgressGwSubject.rulesApply}.${environmentId}`;
  const payload: EgressGwRulesApplyRequest = { environmentId, ...request };
  const reply = await sendRequest<EgressGwRulesApplyRequest, EgressGwRulesApplyReply>(
    subject,
    payload,
    opts.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS,
  );
  if (!reply.accepted) {
    throw new EgressGatewayTransportError(
      `egress-gateway rejected rules apply v${reply.version}: ${reply.reason ?? "no reason"}`,
      "rejected",
    );
  }
  return {
    version: reply.version,
    ruleCount: reply.ruleCount,
    stackCount: reply.stackCount,
    accepted: reply.accepted,
  };
}

export async function pushContainerMapViaNats(
  environmentId: string,
  request: Omit<EgressGwContainerMapApplyRequest, "environmentId">,
  opts: { timeoutMs?: number } = {},
): Promise<PushContainerMapResult> {
  const subject = `${EgressGwSubject.containerMapApply}.${environmentId}`;
  const payload: EgressGwContainerMapApplyRequest = { environmentId, ...request };
  const reply = await sendRequest<
    EgressGwContainerMapApplyRequest,
    EgressGwContainerMapApplyReply
  >(subject, payload, opts.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS);
  if (!reply.accepted) {
    throw new EgressGatewayTransportError(
      `egress-gateway rejected container-map v${reply.version}: ${reply.reason ?? "no reason"}`,
      "rejected",
    );
  }
  return {
    version: reply.version,
    entryCount: reply.entryCount,
    accepted: reply.accepted,
  };
}

/**
 * Read the latest heartbeat for an environment's gateway from the
 * `egress-gw-health` KV bucket. Returns `null` when the gateway hasn't
 * published yet (fresh boot, KV bucket not yet created, env without an
 * egress gateway). Validation is intentionally permissive: a malformed
 * heartbeat returns null rather than throwing, so the UI can fall back to
 * "unknown" instead of breaking.
 */
export async function readGatewayHealth(
  environmentId: string,
): Promise<EgressGwHealth | null> {
  try {
    const bus = NatsBus.getInstance();
    // Phase 2's `bus.jetstream.kv` returns a `BusKv` that already JSON-parses
    // the stored value into `T`. Validate the `T` shape with Zod before
    // returning — a truncated or schema-drifted heartbeat surfaces as null
    // (so the UI shows "unknown") rather than slipping through as a
    // `Partial<…>` and causing downstream NaN/undefined bugs.
    const kv = bus.jetstream.kv(KV_HEALTH_BUCKET);
    const entry = await kv.get<unknown>(environmentId);
    if (!entry) return null;
    const result = egressGwHealthSchema.safeParse(entry.value);
    if (!result.success) {
      log.debug(
        {
          environmentId,
          issues: result.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`),
        },
        "readGatewayHealth: heartbeat failed schema validation",
      );
      return null;
    }
    return result.data;
  } catch (err) {
    log.debug(
      {
        environmentId,
        err: err instanceof Error ? err.message : String(err),
      },
      "readGatewayHealth: KV read failed (likely bucket not yet created)",
    );
    return null;
  }
}

async function sendRequest<Req, Res>(
  subject: string,
  payload: Req,
  timeoutMs: number,
): Promise<Res> {
  const bus = NatsBus.getInstance();
  try {
    return await bus.request<Req, Res>(subject, payload, { timeoutMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT") || msg.includes("timed out") || msg.includes("503")) {
      throw new EgressGatewayTransportError(
        `egress-gateway request to ${subject} timed out after ${timeoutMs}ms`,
        "timeout",
        err,
      );
    }
    throw new EgressGatewayTransportError(
      `egress-gateway request to ${subject} failed: ${msg}`,
      "transport",
      err,
    );
  }
}
