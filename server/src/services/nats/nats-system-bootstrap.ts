/**
 * Bootstrap the JetStream streams + KV buckets that system-internal
 * subjects rely on. Idempotent — safe to run on every boot. Called once
 * the NatsBus reaches `connected`; the bus's ensure helpers are no-ops
 * after the first successful run.
 *
 * Each phase of the messaging migration adds its own entry here:
 *
 *   - Phase 2 (ALT-27): EgressFwEvents stream + egress-fw-health KV
 *   - Phase 3 (ALT-28): EgressGwDecisions stream + egress-gw-health KV
 *   - Phase 4 (ALT-29): BackupHistory stream
 *   - Phase 5 (ALT-30, optional): UpdateHistory stream
 *
 * Adding a stream/bucket here whose corresponding template/consumer hasn't
 * landed yet is harmless — JetStream just keeps an empty stream around.
 */

import { EgressFwSubject, NatsStream } from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import { NatsBus } from "./nats-bus";

const log = getLogger("integrations", "nats-system-bootstrap");

/**
 * KV bucket name for the egress-fw-agent's 5 s heartbeat. Pinned here so
 * the bootstrap call site, the role declaration in the template, and the
 * server-side health reader (Stage D10) all reference one constant.
 */
export const EGRESS_FW_HEALTH_BUCKET = "egress-fw-health";

/**
 * 30 s per-key TTL: a heartbeat sent every 5 s stays "fresh" for ~6
 * intervals before disappearing. The freshness gate the UI applies (≤10 s
 * per the ALT-27 acceptance criteria) is comparing wall-clock against the
 * latest `reportedAtMs`, not relying on TTL — but a TTL avoids the bucket
 * accumulating stale heartbeats from long-dead agent containers.
 */
const EGRESS_FW_HEALTH_TTL_MS = 30_000;

/**
 * Stream byte/age limits. The plan doc §7 calls out explicit limits as a
 * non-optional design choice. Defaults match the recommendation there
 * (1 GiB / 30 d) — re-tune once we have real volume data.
 */
const EGRESS_FW_EVENTS_MAX_BYTES = 1024 * 1024 * 1024;
const EGRESS_FW_EVENTS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function bootstrapNatsSystemResources(): Promise<void> {
  const bus = NatsBus.getInstance();

  // Wait briefly for the bus — caller already kicked it off, but a fresh-
  // worktree boot can have NATS still coming up. The bus's reconnect loop
  // continues in the background regardless; if we time out here we just
  // surface the error and rely on the next boot to retry.
  try {
    await bus.ready({ timeoutMs: 10_000 });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "nats system bootstrap: bus not ready in 10s — skipping (will retry on next boot)",
    );
    return;
  }

  // EgressFwEvents stream — captures the past-tense apply event and the
  // NFLOG event stream. NOT the apply request (fire-and-forget core req/
  // reply) and NOT the heartbeat (lives in KV). Keeping the subjects
  // filter narrow prevents the stream from accumulating apply-request
  // bodies it would never replay.
  try {
    await bus.jetstream.ensureStream({
      name: NatsStream.egressFwEvents,
      subjects: [EgressFwSubject.rulesApplied, EgressFwSubject.events],
      description: "Phase 2 (ALT-27): egress-fw-agent past-tense events + NFLOG drops",
      maxBytes: EGRESS_FW_EVENTS_MAX_BYTES,
      maxAgeMs: EGRESS_FW_EVENTS_MAX_AGE_MS,
    });
    log.info(
      { stream: NatsStream.egressFwEvents },
      "nats system bootstrap: EgressFwEvents stream ensured",
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "nats system bootstrap: EgressFwEvents stream ensure failed",
    );
  }

  // egress-fw-health KV bucket — 5 s heartbeat from the agent, read by
  // the server-side health-status reader (Stage D10).
  try {
    await bus.jetstream.ensureKv({
      bucket: EGRESS_FW_HEALTH_BUCKET,
      ttlMs: EGRESS_FW_HEALTH_TTL_MS,
      description: "Phase 2 (ALT-27): egress-fw-agent 5s heartbeat",
    });
    log.info(
      { bucket: EGRESS_FW_HEALTH_BUCKET },
      "nats system bootstrap: egress-fw-health KV bucket ensured",
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "nats system bootstrap: egress-fw-health KV ensure failed",
    );
  }
}
