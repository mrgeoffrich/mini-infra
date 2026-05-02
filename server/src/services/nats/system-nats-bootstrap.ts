/**
 * Boot-time seed for system NATS resources owned by Mini Infra itself.
 *
 * The control plane primitives (`NatsAccount`, `NatsStream`, `NatsConsumer`,
 * `NatsPrefixAllowlist`) are normally driven by user-facing API calls and
 * stack-apply orchestration. A handful of rows belong to the *system* — they
 * exist so the server's own subsystems (egress gateway, eventually fw-agent
 * and backup) can publish to and consume from JetStream. Those rows are
 * idempotently seeded here.
 *
 * Why not in `applyConfig()`? `applyConfig()` is about credentials and the
 * rendered `nats.conf`. JetStream streams and consumers belong on the
 * control-plane side and are usually applied per stack. Bundling system-
 * stream seeds into `applyConfig()` would couple two unrelated concerns;
 * keeping them in their own helper makes it obvious where the
 * `EgressGwDecisions` stream comes from.
 *
 * Why not in the templates folder? The egress-gateway *template* doesn't
 * own this stream — multiple gateway instances (one per env) all publish
 * into a single shared stream. The stream is host-scoped, not env-scoped.
 *
 * Idempotency: every operation is upsert. Re-running on every boot is safe
 * and the no-change case is a single SELECT per resource.
 */

import type { PrismaClient } from "../../generated/prisma/client";
import { getLogger } from "../../lib/logger-factory";
import {
  BackupSubject,
  EgressGwSubject,
  NATS_SYSTEM_PREFIX,
  NatsConsumer as NatsConsumerName,
  NatsKvBucket,
  NatsStream as NatsStreamName,
} from "@mini-infra/types";
import { getNatsControlPlaneService } from "./nats-control-plane-service";

const log = getLogger("integrations", "system-nats-bootstrap");

const SYSTEM_USER = "system";
const PREFIX_ALLOWLIST_CATEGORY = "nats-prefix-allowlist";
const DEFAULT_ACCOUNT_NAME = "mini-infra-account";

/**
 * Subsystem prefix → templateNames. The seeder resolves names → templateIds.
 * Prefixes are derived from the subject constants (`<system>.<subsystem>.<aggregate>`)
 * so a rename of `EgressGwSubject` flows through here without a manual edit.
 */
const SYSTEM_PREFIX_BINDINGS: Array<{ prefix: string; templateNames: string[] }> = [
  // Phase 3: egress gateway claims the `mini-infra.egress.gw.>` subject tree.
  { prefix: subjectPrefixOf(EgressGwSubject.decisions, 3), templateNames: ["egress-gateway"] },
  // Phase 2 will add the equivalent for `mini-infra.egress.fw` here.
];

/**
 * Slice the first `depth` dotted tokens from a fully-qualified subject. Used
 * to derive a prefix-allowlist entry from a subject constant — the entry
 * gates `<system>.<subsystem>.<aggregate>` (3 tokens) and below.
 */
function subjectPrefixOf(subject: string, depth: number): string {
  const tokens = subject.split(".");
  if (tokens.length < depth || tokens[0] !== NATS_SYSTEM_PREFIX) {
    throw new Error(
      `bootstrap: unexpected subject shape '${subject}' — expected at least ${depth} dotted tokens beginning with '${NATS_SYSTEM_PREFIX}'`,
    );
  }
  return tokens.slice(0, depth).join(".");
}

/** System-owned JetStream streams (and their consumers). */
interface SystemStreamSpec {
  name: string;
  /** Subjects to capture. Wildcards expected. */
  subjects: string[];
  retention: "limits" | "interest" | "workqueue";
  maxBytes: number;
  maxAgeSeconds: number;
  description: string;
  consumers: Array<{
    name: string;
    durableName: string;
    description: string;
    ackWaitSeconds?: number;
    maxDeliver?: number;
  }>;
}

const SYSTEM_STREAMS: SystemStreamSpec[] = [
  {
    name: NatsStreamName.egressGwDecisions, // "EgressGwDecisions"
    subjects: [EgressGwSubject.decisions],
    // Work-queue retention so each decision is delivered to the server-side
    // consumer once and removed. Plan §6 Phase 3 specifies this explicitly:
    // it makes the stream a buffer for in-flight decisions across gateway
    // restart, not a long-term archive (the server's own EgressEvent rows
    // are the long-term store).
    retention: "workqueue",
    maxBytes: 1024 * 1024 * 1024, // 1 GiB
    maxAgeSeconds: 30 * 24 * 3600, // 30 d
    description: "Egress gateway proxy decisions (one per CONNECT/HTTP/DNS verdict).",
    consumers: [
      {
        name: NatsConsumerName.egressGwDecisionsServer,
        durableName: NatsConsumerName.egressGwDecisionsServer,
        description:
          "Mini Infra server consumer: persists decisions to EgressEvent rows.",
        // 30 s ack-wait gives the batch flusher a wide margin (it normally
        // flushes every 1 s, batch-of-100). On a stuck DB the message
        // redelivers; the dedup window catches the duplicate.
        ackWaitSeconds: 30,
        // Cap redelivery so a poison message can't loop forever. After 5
        // attempts the consumer NAKs to the dead-letter side (which we
        // currently just log — a follow-up adds a real DLQ).
        maxDeliver: 5,
      },
    ],
  },
  {
    name: NatsStreamName.backupHistory, // "BackupHistory"
    subjects: [BackupSubject.completed, BackupSubject.failed],
    // Limits retention: history stream for replay on cold load and recovery
    // from missed events during server restarts. Each backup run produces at
    // most one message; 1 GiB / 30 d is conservative but consistent with
    // plan §7 estimates.
    retention: "limits",
    maxBytes: 1024 * 1024 * 1024, // 1 GiB
    maxAgeSeconds: 30 * 24 * 3600, // 30 d
    description: "Phase 4 (ALT-29): backup run completed/failed events for durable replay.",
    consumers: [
      {
        name: NatsConsumerName.backupHistoryServer,
        durableName: NatsConsumerName.backupHistoryServer,
        description:
          "Mini Infra server consumer: emits Socket.IO events and repairs stale DB records on cold-boot replay.",
        ackWaitSeconds: 30,
        maxDeliver: 5,
      },
    ],
  },
];

/**
 * System-internal JetStream KV buckets. These can't be created by app-level
 * NATS roles (bucket creation requires admin permission on the account), so
 * the control plane pre-seeds them. App roles only get put/get permission
 * on the bucket's subject namespace once the bucket exists.
 */
const SYSTEM_KV_BUCKETS = [
  {
    name: NatsKvBucket.egressGwHealth,
    // Heartbeats are 5 s; keep the latest 10 minutes worth of revisions so a
    // back-from-the-dead consumer can read the freshest value without an
    // unbounded stream.
    maxAgeSeconds: 10 * 60,
    description: "Egress gateway last-known-state heartbeats (key = environmentId).",
  },
];

/**
 * Seed system NATS rows. Pass the templateByName map from
 * `syncBuiltinStacks` so the prefix allowlist entries can resolve their
 * template ids without re-querying.
 *
 * Idempotent end-to-end: every step is upsert. Re-running on every boot is
 * cheap. Also called from `runStackNatsApplyPhase` for the egress-gateway
 * template so a failed initial seed self-heals on the first stack apply
 * without requiring a server restart.
 */
export async function seedSystemNatsResources(
  prisma: PrismaClient,
  templateByName: Map<string, { id: string }>,
): Promise<void> {
  await seedPrefixAllowlist(prisma, templateByName);
  await seedSystemStreams(prisma);
  // KV buckets ride on the live NATS connection; if NATS isn't reachable
  // yet (cold worktree boot) the call returns and the next applyJetStream
  // run will retry. The control plane logs a warn rather than throwing.
  try {
    await getNatsControlPlaneService(prisma).ensureSystemKvBuckets(SYSTEM_KV_BUCKETS);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "ensureSystemKvBuckets failed (will retry on next boot or apply)",
    );
  }
}

/**
 * Re-seed the egress-gateway-related rows ahead of a stack apply for that
 * template. Used by the stack apply orchestrator so a server-boot seed
 * failure doesn't permanently block egress-gateway from coming up — the
 * first apply self-heals.
 *
 * Returns silently when the egress-gateway template isn't in the byName
 * map (the seed will get the next chance on a later apply / boot).
 */
export async function ensureEgressGatewaySeeded(
  prisma: PrismaClient,
  templateByName: Map<string, { id: string }>,
): Promise<void> {
  if (!templateByName.has("egress-gateway")) return;
  await seedSystemNatsResources(prisma, templateByName);
}

async function seedPrefixAllowlist(
  prisma: PrismaClient,
  templateByName: Map<string, { id: string }>,
): Promise<void> {
  for (const binding of SYSTEM_PREFIX_BINDINGS) {
    const templateIds: string[] = [];
    for (const name of binding.templateNames) {
      const t = templateByName.get(name);
      if (!t) {
        // The corresponding template hasn't been synced yet (e.g. Phase 2
        // running before Phase 3, or a checkout where the template files
        // are missing). Skip rather than insert a broken row.
        log.info(
          { prefix: binding.prefix, templateName: name },
          "system prefix allowlist seed: template not found yet, skipping",
        );
        continue;
      }
      templateIds.push(t.id);
    }
    if (templateIds.length === 0) continue;

    const value = JSON.stringify({ allowedTemplateIds: templateIds });
    // Upsert by (category, key) — the unique compound on SystemSettings.
    // We bypass `NatsPrefixAllowlistService.create()` deliberately:
    //   - it requires a userId (system bootstrap doesn't have one)
    //   - its overlap check would reject re-runs on the same prefix
    //     (the row is its own "overlap"); update-on-conflict is safer.
    await prisma.systemSettings.upsert({
      where: {
        category_key: { category: PREFIX_ALLOWLIST_CATEGORY, key: binding.prefix },
      },
      create: {
        category: PREFIX_ALLOWLIST_CATEGORY,
        key: binding.prefix,
        value,
        isEncrypted: false,
        isActive: true,
        createdBy: SYSTEM_USER,
        updatedBy: SYSTEM_USER,
      },
      update: {
        value,
        isActive: true,
        updatedBy: SYSTEM_USER,
        updatedAt: new Date(),
      },
    });
    log.info(
      { prefix: binding.prefix, templateIds },
      "system prefix allowlist entry seeded",
    );
  }
}

async function seedSystemStreams(prisma: PrismaClient): Promise<void> {
  // Streams are bound to the default `mini-infra-account`. Phase 1's
  // NatsControlPlaneService.ensureDefaultAccount() runs at boot via
  // applyConfig(); if it hasn't yet, we skip and let the next boot retry —
  // we don't want to race the account-creation path here.
  const account = await prisma.natsAccount.findUnique({
    where: { name: DEFAULT_ACCOUNT_NAME },
  });
  if (!account) {
    log.info(
      { account: DEFAULT_ACCOUNT_NAME },
      "system stream seed: default NATS account not yet present, skipping (will retry next boot)",
    );
    return;
  }

  for (const spec of SYSTEM_STREAMS) {
    const stream = await prisma.natsStream.upsert({
      where: { name: spec.name },
      create: {
        name: spec.name,
        accountId: account.id,
        description: spec.description,
        subjects: spec.subjects,
        retention: spec.retention,
        storage: "file",
        maxBytes: spec.maxBytes,
        maxAgeSeconds: spec.maxAgeSeconds,
        createdById: null,
        updatedById: null,
      },
      update: {
        accountId: account.id,
        description: spec.description,
        subjects: spec.subjects,
        retention: spec.retention,
        storage: "file",
        maxBytes: spec.maxBytes,
        maxAgeSeconds: spec.maxAgeSeconds,
      },
    });

    for (const cspec of spec.consumers) {
      await prisma.natsConsumer.upsert({
        where: {
          streamId_name: { streamId: stream.id, name: cspec.name },
        },
        create: {
          streamId: stream.id,
          name: cspec.name,
          durableName: cspec.durableName,
          description: cspec.description,
          deliverPolicy: "all",
          ackPolicy: "explicit",
          ackWaitSeconds: cspec.ackWaitSeconds ?? null,
          maxDeliver: cspec.maxDeliver ?? null,
        },
        update: {
          durableName: cspec.durableName,
          description: cspec.description,
          deliverPolicy: "all",
          ackPolicy: "explicit",
          ackWaitSeconds: cspec.ackWaitSeconds ?? null,
          maxDeliver: cspec.maxDeliver ?? null,
        },
      });
    }

    log.info(
      { stream: spec.name, consumers: spec.consumers.map((c) => c.name) },
      "system NATS stream + consumers seeded",
    );
  }
}
