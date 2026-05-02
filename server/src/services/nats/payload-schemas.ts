/**
 * Zod schemas + inferred TypeScript types for every NATS subject in
 * `lib/types/nats-subjects.ts`.
 *
 * Subjects are the contract (and live in `lib` so the client can see them);
 * the runtime validators live here in the server because `@mini-infra/types`
 * is a runtime-dependency-free types-only package (see lib/CLAUDE.md).
 *
 * Every subject in `ALL_NATS_SUBJECTS` SHOULD have a request schema and (for
 * req/reply subjects) a reply schema registered in `payloadSchemas` below.
 * The `NatsBus` validates outgoing publish/request bodies and incoming
 * subscribe/reply bodies against this registry. A schema mismatch is a
 * thrown error — never a silently-truncated message.
 */

import { z } from "zod";
import {
  ALL_NATS_SUBJECTS,
  BackupSubject,
  EgressFwSubject,
  EgressGwSubject,
  SystemSubject,
  UpdateSubject,
} from "@mini-infra/types";

// ====================================================================
// pg-az-backup (Phase 4, ALT-29)
// ====================================================================

/** Command payload: scheduler asks the executor to start a backup run. */
export const backupRunRequestSchema = z.object({
  databaseId: z.string().min(1).max(64),
  userId: z.string().min(1).max(64),
  operationType: z.enum(["manual", "scheduled"]),
});
export type BackupRunRequest = z.infer<typeof backupRunRequestSchema>;

/** Reply: executor accepts or rejects the run (capacity check). */
export const backupRunReplySchema = z.object({
  operationId: z.string().max(64),
  accepted: z.boolean(),
  /** Number of operations currently executing (0–2). */
  queueDepth: z.number().int().nonnegative(),
  /** Human-readable rejection reason — only set when `accepted` is false. */
  reason: z.string().max(256).optional(),
});
export type BackupRunReply = z.infer<typeof backupRunReplySchema>;

/**
 * Progress event published by the server during container execution.
 * Subject is `mini-infra.backup.progress.<operationId>` — the `operationId`
 * is also in the body so subscribers on the wildcard don't need to parse the
 * subject token separately.
 */
export const backupProgressSchema = z.object({
  operationId: z.string().min(1).max(64),
  status: z.enum(["pending", "running"]),
  progress: z.number().int().min(0).max(100),
  message: z.string().max(512).optional(),
});
export type BackupProgress = z.infer<typeof backupProgressSchema>;

/**
 * Completion event published to JetStream `BackupHistory` stream.
 * Durable — replayed on server restart to populate the events list on cold
 * load and to repair DB records missed during a server outage.
 */
export const backupCompletedSchema = z.object({
  operationId: z.string().min(1).max(64),
  databaseId: z.string().min(1).max(64),
  sizeBytes: z.number().int().nonnegative().optional(),
  storageObjectUrl: z.string().max(2048).optional(),
  storageProvider: z.string().max(64).optional(),
  completedAtMs: z.number().int().nonnegative(),
});
export type BackupCompleted = z.infer<typeof backupCompletedSchema>;

/**
 * Failure event published to JetStream `BackupHistory` stream.
 * Published on both application-level failures (non-zero exit) and the
 * hard-crash fallback path in the container watcher.
 */
export const backupFailedSchema = z.object({
  operationId: z.string().min(1).max(64),
  databaseId: z.string().min(1).max(64),
  errorMessage: z.string().max(1024),
  failedAtMs: z.number().int().nonnegative(),
});
export type BackupFailed = z.infer<typeof backupFailedSchema>;

// ====================================================================
// Egress gateway (Phase 3) — real schemas, replacing the Phase 1 stubs.
// ====================================================================

/**
 * Rules snapshot pushed from server to gateway. Mirrors the legacy admin
 * `RulesSnapshotRequest` (egress-gateway-client.ts) so the server-side
 * pusher can switch transports without re-shaping the payload.
 *
 * `version` is monotonic per environment — the gateway uses it to skip
 * stale snapshots if reordering ever happens. `stackPolicies` is keyed by
 * stackId; an empty object means "no rules" (defaultAction governs).
 */
export const egressGwRuleEntrySchema = z.object({
  id: z.string().min(1).max(64),
  pattern: z.string().min(1).max(512),
  action: z.enum(["allow", "block"]),
  /** Service names within the stack this rule applies to; [] = all services. */
  targets: z.array(z.string()).default([]),
});

export const egressGwStackPolicySchema = z.object({
  mode: z.enum(["detect", "enforce"]),
  defaultAction: z.enum(["allow", "block"]),
  rules: z.array(egressGwRuleEntrySchema),
});

export const egressGwRulesApplyRequestSchema = z.object({
  /** Environment id this snapshot is targeting. The subject also carries it
   *  as a suffix; we keep it in the payload so a malformed broker
   *  routing doesn't silently apply someone else's rules. */
  environmentId: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  /** Map of stackId -> policy. */
  stackPolicies: z.record(z.string(), egressGwStackPolicySchema),
});
export type EgressGwRulesApplyRequest = z.infer<typeof egressGwRulesApplyRequestSchema>;

export const egressGwRulesApplyReplySchema = z.object({
  environmentId: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  accepted: z.boolean(),
  ruleCount: z.number().int().nonnegative(),
  stackCount: z.number().int().nonnegative(),
  /** Reason on rejection, free text. */
  reason: z.string().max(512).optional(),
});
export type EgressGwRulesApplyReply = z.infer<typeof egressGwRulesApplyReplySchema>;

/** Fan-out event published by the gateway after a successful apply. */
export const egressGwRulesAppliedSchema = egressGwRulesApplyReplySchema.extend({
  /** Wall-clock time the gateway swapped the ACL, ms since epoch. */
  appliedAtMs: z.number().int().nonnegative(),
});

/**
 * Container-map snapshot. Same shape as the legacy
 * `ContainerMapRequest`/`Response` so the pusher can swap transports cleanly.
 */
export const egressGwContainerMapEntrySchema = z.object({
  ip: z.string().min(1).max(45), // IPv4 or IPv6
  stackId: z.string().min(1).max(64),
  serviceName: z.string().min(1).max(100),
  containerId: z.string().max(64).optional(),
});

export const egressGwContainerMapApplyRequestSchema = z.object({
  environmentId: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  entries: z.array(egressGwContainerMapEntrySchema),
});
export type EgressGwContainerMapApplyRequest = z.infer<
  typeof egressGwContainerMapApplyRequestSchema
>;

export const egressGwContainerMapApplyReplySchema = z.object({
  environmentId: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  accepted: z.boolean(),
  entryCount: z.number().int().nonnegative(),
  reason: z.string().max(512).optional(),
});
export type EgressGwContainerMapApplyReply = z.infer<
  typeof egressGwContainerMapApplyReplySchema
>;

export const egressGwContainerMapAppliedSchema = egressGwContainerMapApplyReplySchema.extend({
  appliedAtMs: z.number().int().nonnegative(),
});

/**
 * Per-decision payload published to the JetStream `EgressGwDecisions` stream.
 * Discriminated union over `evt`.
 *
 * Phase 3 only emits `dns.query` and `tcp` — those are produced by the
 * egress-gateway. `fw_drop` belongs to the fw-agent (Phase 2 / ALT-27), which
 * publishes to a separate `EgressFwEvents` stream, NOT this one. A
 * `fw_drop` payload showing up here would currently fail Zod validation and
 * the consumer would log + leave the message unacked (intentional — it
 * signals a misrouted publisher rather than silently muddling streams).
 * When Phase 2 lands, that case stops being theoretical: it stays a hard
 * reject because the fw_drop stream is genuinely separate.
 */
const egressActionSchema = z.enum(["allowed", "blocked", "observed"]);

const egressGwDecisionDnsSchema = z.object({
  evt: z.literal("dns.query"),
  ts: z.string().min(1).max(64),
  environmentId: z.string().min(1).max(64),
  srcIp: z.string().min(1).max(45),
  qname: z.string().min(1).max(255),
  qtype: z.string().min(1).max(16),
  action: egressActionSchema,
  matchedPattern: z.string().max(512).optional(),
  wouldHaveBeen: z.enum(["allowed", "blocked"]).optional(),
  stackId: z.string().max(64).optional(),
  serviceName: z.string().max(100).optional(),
  reason: z.string().max(512).optional(),
  mergedHits: z.number().int().nonnegative(),
});

const egressGwDecisionTcpSchema = z.object({
  evt: z.literal("tcp"),
  ts: z.string().min(1).max(64),
  environmentId: z.string().min(1).max(64),
  protocol: z.enum(["connect", "http"]),
  srcIp: z.string().min(1).max(45),
  target: z.string().min(1).max(512),
  action: egressActionSchema,
  reason: z.string().max(512).optional(),
  matchedPattern: z.string().max(512).optional(),
  stackId: z.string().max(64).optional(),
  serviceName: z.string().max(100).optional(),
  bytesUp: z.number().int().nonnegative().optional(),
  bytesDown: z.number().int().nonnegative().optional(),
  method: z.string().max(16).optional(),
  path: z.string().max(2048).optional(),
  status: z.number().int().min(100).max(599).optional(),
  mergedHits: z.number().int().nonnegative(),
});

export const egressGwDecisionSchema = z.discriminatedUnion("evt", [
  egressGwDecisionDnsSchema,
  egressGwDecisionTcpSchema,
]);
export type EgressGwDecision = z.infer<typeof egressGwDecisionSchema>;

/**
 * Heartbeat payload stored in the `egress-gw-health` KV bucket. One entry
 * per environment; the value is fully replaced on each publish (latest-wins
 * semantics). Survives gateway container restart because KV is JetStream-
 * backed.
 */
export const egressGwHealthSchema = z.object({
  environmentId: z.string().min(1).max(64),
  /** Wall-clock time the gateway emitted this heartbeat, ms since epoch. */
  reportedAtMs: z.number().int().nonnegative(),
  /** Gateway uptime in seconds since process start. */
  uptimeSeconds: z.number().nonnegative(),
  /** Last successfully applied rules.version (0 = none). */
  rulesVersion: z.number().int().nonnegative(),
  /** Last successfully applied container-map.version (0 = none). */
  containerMapVersion: z.number().int().nonnegative(),
  /** Listeners status — `proxy` is the L7 forward proxy. */
  listeners: z.object({
    proxy: z.boolean(),
  }),
});
export type EgressGwHealth = z.infer<typeof egressGwHealthSchema>;

// ====================================================================
// System / smoke ping (Phase 1)
// ====================================================================

export const systemPingRequestSchema = z.object({
  /** Free-form correlation token echoed back in the reply. */
  nonce: z.string().min(1).max(128),
  /** Caller's wall-clock time, ms since epoch. */
  sentAtMs: z.number().int().nonnegative(),
});
export type SystemPingRequest = z.infer<typeof systemPingRequestSchema>;

export const systemPingReplySchema = z.object({
  /** Echoed `nonce` from the request. */
  nonce: z.string().min(1).max(128),
  /** Responder's wall-clock time, ms since epoch. */
  receivedAtMs: z.number().int().nonnegative(),
  /** Stable identifier of the responder (e.g. "server"). */
  responder: z.string().min(1).max(64),
});
export type SystemPingReply = z.infer<typeof systemPingReplySchema>;

// ====================================================================
// Egress fw-agent (Phase 2)
//
// The four legacy Unix-socket admin endpoints (POST /v1/env, DELETE /v1/env/
// :env, POST /v1/ipset/:env/managed/{add|del|sync}) collapse into a single
// `rules.apply` request. The body is a discriminated union keyed on `op` —
// keeps existing env-firewall-manager.ts call sites 1:1 with the legacy
// transport (one bus.request per former HTTP call) while honouring the plan
// doc's single-command-subject convention.
//
// The `rules.applied` event is fan-out, fact-tense, and lands on JetStream;
// it carries the `op` so subscribers can filter without parsing reasons.
// ====================================================================

const ipv4 = z.string().regex(/^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/, {
  message: "must be a dotted-quad IPv4 address",
});
const ipv4Cidr = z.string().regex(/^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\/(?:3[0-2]|[12]?\d)$/, {
  message: "must be an IPv4 CIDR (e.g. 172.30.5.0/24)",
});
// Env names mirror EnvironmentManager's invariant (lowercase, dotted/dashed
// segments, ≤63 chars). Tightened from a free string so a typo can't end up
// as a stray ipset on the host.
const envName = z.string().min(1).max(63).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
  message: "must be kebab-case [a-z0-9-]",
});
// `applyId` is set by the server. Width chosen to fit a UUID v4 with room
// for a short prefix if we ever want to namespace it.
const applyId = z.string().min(1).max(64);
const fwMode = z.enum(["observe", "enforce"]);

const envUpsertOp = z.object({
  op: z.literal("env-upsert"),
  applyId,
  envName,
  bridgeCidr: ipv4Cidr,
  mode: fwMode,
});
const envRemoveOp = z.object({
  op: z.literal("env-remove"),
  applyId,
  envName,
});
const ipsetAddOp = z.object({
  op: z.literal("ipset-add"),
  applyId,
  envName,
  ip: ipv4,
});
const ipsetDelOp = z.object({
  op: z.literal("ipset-del"),
  applyId,
  envName,
  ip: ipv4,
});
const ipsetSyncOp = z.object({
  op: z.literal("ipset-sync"),
  applyId,
  envName,
  ips: z.array(ipv4).max(10_000),
});

export const egressFwRulesApplyRequestSchema = z.discriminatedUnion("op", [
  envUpsertOp,
  envRemoveOp,
  ipsetAddOp,
  ipsetDelOp,
  ipsetSyncOp,
]);
export type EgressFwRulesApplyRequest = z.infer<typeof egressFwRulesApplyRequestSchema>;
export type EgressFwApplyOp = EgressFwRulesApplyRequest["op"];

export const egressFwRulesApplyReplySchema = z.object({
  applyId,
  status: z.enum(["applied", "rejected"]),
  /** Reason on rejection, free text. Always set when status="rejected". */
  reason: z.string().max(500).optional(),
});
export type EgressFwRulesApplyReply = z.infer<typeof egressFwRulesApplyReplySchema>;

/**
 * Past-tense fan-out event published by the agent after a successful apply.
 * Carries `op` so durable consumers (audit, metrics) can filter without
 * cracking the reply payload, and `durationMs` so apply-latency histograms
 * are derivable from the event stream alone.
 */
export const egressFwRulesAppliedSchema = z.object({
  applyId,
  op: z.enum(["env-upsert", "env-remove", "ipset-add", "ipset-del", "ipset-sync"]),
  envName,
  appliedAtMs: z.number().int().nonnegative(),
  /** Wall-clock duration on the agent — apply RPC service time, not RTT. */
  durationMs: z.number().int().nonnegative(),
});
export type EgressFwRulesApplied = z.infer<typeof egressFwRulesAppliedSchema>;

/**
 * NFLOG-derived drop event. Replaces the bespoke `fw_drop` JSON line shape
 * (see `server/src/services/egress/egress-log-ingester.ts` for the legacy
 * shape this is a re-typing of).
 *
 * `evt`/`ts` from the legacy shape are gone — the subject is the
 * discriminator and `occurredAtMs` is a JSON-friendly number. Fields are
 * named alongside the existing `EgressEvent` Prisma columns so the ingester
 * can map straight through.
 */
export const egressFwEventSchema = z.object({
  occurredAtMs: z.number().int().nonnegative(),
  protocol: z.enum(["tcp", "udp", "icmp"]),
  srcIp: ipv4,
  destIp: ipv4,
  /** Optional — ICMP and some malformed packets have no port. */
  destPort: z.number().int().min(0).max(65_535).optional(),
  /** Source stack ID from container labels; missing for stray traffic. */
  stackId: z.string().min(1).max(64).optional(),
  /** Source service name within the stack; missing if unattributed. */
  serviceName: z.string().min(1).max(128).optional(),
  /** Free-form rule reason (e.g. "default-deny", "out-of-bridge"). */
  reason: z.string().max(200).optional(),
  /**
   * Pre-aggregation count from the agent's NFLOG batcher. ≥1; an unbatched
   * event is `mergedHits: 1`. The ingester sums these into Prisma-side
   * dedup buckets identically to the legacy log path.
   */
  mergedHits: z.number().int().positive(),
});
export type EgressFwEvent = z.infer<typeof egressFwEventSchema>;

/**
 * Heartbeat published every 5 s into the `egress-fw-health` KV bucket. The
 * server reads the latest value to compute freshness for the health UI; per
 * the plan, freshness ≤10 s under normal load is the SLA.
 */
export const egressFwHealthSchema = z.object({
  ok: z.boolean(),
  reportedAtMs: z.number().int().nonnegative(),
  /**
   * Number of NFLOG events buffered in the agent's in-memory queue waiting
   * to be JetStream-published. >0 is a yellow flag; sustained growth means
   * the agent can't keep up.
   */
  queueDepth: z.number().int().nonnegative().optional(),
  /** Last `applyId` the agent processed, if any. Useful for verifying that
   *  a server-side apply has propagated end to end. */
  lastApplyId: z.string().min(1).max(64).optional(),
});
export type EgressFwHealth = z.infer<typeof egressFwHealthSchema>;

// ====================================================================
// Schema registry — used by NatsBus for validation lookups.
// ====================================================================

export interface SubjectSchemaEntry {
  /** Schema for the published / request body on this subject. */
  request: z.ZodType<unknown>;
  /** Schema for the reply (only set for request/reply subjects). */
  reply?: z.ZodType<unknown>;
}

/**
 * The set of subjects this registry knows about. Tied to `ALL_NATS_SUBJECTS`
 * in `lib/types/nats-subjects.ts` so adding a new subject there forces an
 * entry here at compile time — a typo in a key fails to type-check, and a
 * forgotten schema surfaces as a missing-key compile error rather than a
 * silent runtime skip.
 */
export type KnownNatsSubject = (typeof ALL_NATS_SUBJECTS)[number];

/**
 * Concrete subjects only — wildcards and per-id subjects (e.g. `progress.<id>`)
 * are validated by the closest static parent subject's schema if present, or
 * skipped if the bus call is marked `unchecked: true`.
 */
export const payloadSchemas: Record<KnownNatsSubject, SubjectSchemaEntry> = {
  [SystemSubject.ping]: {
    request: systemPingRequestSchema,
    reply: systemPingReplySchema,
  },
  [EgressFwSubject.rulesApply]: {
    request: egressFwRulesApplyRequestSchema,
    reply: egressFwRulesApplyReplySchema,
  },
  [EgressFwSubject.rulesApplied]: {
    request: egressFwRulesAppliedSchema,
  },
  [EgressFwSubject.events]: {
    request: egressFwEventSchema,
  },
  [EgressFwSubject.health]: {
    request: egressFwHealthSchema,
  },
  [EgressGwSubject.rulesApply]: {
    request: egressGwRulesApplyRequestSchema,
    reply: egressGwRulesApplyReplySchema,
  },
  [EgressGwSubject.rulesApplied]: { request: egressGwRulesAppliedSchema },
  [EgressGwSubject.containerMapApply]: {
    request: egressGwContainerMapApplyRequestSchema,
    reply: egressGwContainerMapApplyReplySchema,
  },
  [EgressGwSubject.containerMapApplied]: { request: egressGwContainerMapAppliedSchema },
  [EgressGwSubject.decisions]: { request: egressGwDecisionSchema },
  [EgressGwSubject.health]: { request: egressGwHealthSchema },
  [BackupSubject.run]: {
    request: backupRunRequestSchema,
    reply: backupRunReplySchema,
  },
  // progressPrefix is a wildcard parent — callers use unchecked:true and validate inline
  [BackupSubject.progressPrefix]: { request: backupProgressSchema },
  [BackupSubject.completed]: { request: backupCompletedSchema },
  [BackupSubject.failed]: { request: backupFailedSchema },
  [UpdateSubject.run]: { request: z.unknown() },
  [UpdateSubject.progressPrefix]: { request: z.unknown() },
  [UpdateSubject.completed]: { request: z.unknown() },
  [UpdateSubject.failed]: { request: z.unknown() },
  [UpdateSubject.healthCheckPassed]: { request: z.unknown() },
};
