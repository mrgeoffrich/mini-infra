/**
 * NATS subject constants for system-internal app-to-app messaging.
 *
 * Every system-internal subject lives under `mini-infra.>`. Application stacks
 * use the per-stack default `app.<stack-id>.>` or an admin-allowlisted prefix
 * — those are out of scope for this file.
 *
 * Naming rules (see docs/planning/not-shipped/internal-nats-messaging-plan.md
 * §4 for the rationale):
 *
 *   mini-infra.<subsystem>.<aggregate>.<verb-or-event>[.<id>]
 *
 *   - Commands: imperative verb, used with request/reply.
 *       e.g. `mini-infra.egress.fw.rules.apply`
 *   - Events: past-participle verb, fan-out publish.
 *       e.g. `mini-infra.egress.fw.rules.applied`
 *   - Heartbeats: noun only, periodic publish of current state.
 *       e.g. `mini-infra.egress.fw.health`
 *
 * Tokens are kebab-case and lowercase. No wildcards in published subjects.
 *
 * **This file is the contract.** No raw subject strings are allowed in
 * `server/src` — always import from here. There is a Go mirror at
 * `egress-shared/natsbus/subjects.go`; the two are kept in sync by
 * `scripts/check-nats-subject-drift.mjs` in CI.
 */

/**
 * The single system prefix. Every subject below begins with this token. Adding
 * `mini-infra` to the prefix allowlist (so app-authored templates can claim
 * it) is deferred to Phase 2 — Phase 1 is server-only and the server's bus
 * credential carries explicit pub/sub permission on `mini-infra.>` directly.
 */
export const NATS_SYSTEM_PREFIX = "mini-infra" as const;

/**
 * Default per-stack NATS subject prefix *template* (rendered with `{{stack.id}}`
 * substituted at apply time → `app.<stack-id>`). A template that declares any
 * other prefix must be on the admin subject-prefix allowlist. This is the single
 * source of truth for "what counts as the default"; the apply orchestrator and
 * the template export/import codec both compare against it.
 */
export const DEFAULT_NATS_SUBJECT_PREFIX_TEMPLATE = "app.{{stack.id}}" as const;

/** Phase 1: smoke-ping subjects used by the bus health-check loopback. */
export const SystemSubject = {
  /**
   * Request/reply liveness probe. The server subscribes to this on its own
   * bus connection (see `server/src/services/nats/nats-bus-ping.ts`) and
   * replies with `SystemPingReply`. Phase 1 only. Phase 2+ may add
   * subsystem-specific responders.
   */
  ping: "mini-infra.system.ping",
} as const;

/** Phase 2: egress firewall agent subjects. Reserved here so the constants
 *  exist when the migration begins; the agent is not yet on the bus. */
export const EgressFwSubject = {
  /** Command (req/reply): server pushes a new ruleset to the agent. */
  rulesApply: "mini-infra.egress.fw.rules.apply",
  /** Event: ruleset successfully applied; durable on JetStream. */
  rulesApplied: "mini-infra.egress.fw.rules.applied",
  /** Event stream: NFLOG events; durable on JetStream. */
  events: "mini-infra.egress.fw.events",
  /** Heartbeat: current health snapshot, published every few seconds. */
  health: "mini-infra.egress.fw.health",
} as const;

/**
 * Phase 3: egress gateway subjects.
 *
 * The gateway is environment-scoped — there's one container per env. To route
 * commands to a specific gateway, the server appends an `<envId>` token at
 * runtime (e.g. `mini-infra.egress.gw.rules.apply.<envId>`). The constants
 * here are the BASE prefixes; never publish on the bare constant for
 * `rulesApply` / `rulesApplied` / `containerMapApply` / `containerMapApplied`
 * / `health` — there's nothing listening.
 *
 * `decisions` is the exception: a single shared stream across every env, with
 * `environmentId` carried in the payload. One server-side consumer drains the
 * full firehose.
 */
export const EgressGwSubject = {
  /** Command (req/reply, per-env): `<rulesApply>.<envId>` — server pushes a new ruleset. */
  rulesApply: "mini-infra.egress.gw.rules.apply",
  /** Event (per-env): `<rulesApplied>.<envId>` — gateway acknowledges an apply. */
  rulesApplied: "mini-infra.egress.gw.rules.applied",
  /**
   * Command (req/reply, per-env): `<containerMapApply>.<envId>` — server
   * pushes the container-IP-to-stack map. Replaces `POST /admin/container-map`
   * on the legacy admin port.
   */
  containerMapApply: "mini-infra.egress.gw.container-map.apply",
  /** Event (per-env): `<containerMapApplied>.<envId>` — gateway acknowledges a container-map apply. */
  containerMapApplied: "mini-infra.egress.gw.container-map.applied",
  /**
   * Event stream (shared, JetStream `EgressGwDecisions`): every proxy
   * decision from every env. `environmentId` lives in the payload so the
   * server consumer can attribute. Work-queue retention; survives gateway
   * restart — that's the headline win over the old log-tail.
   */
  decisions: "mini-infra.egress.gw.decisions",
  /**
   * Heartbeat (KV bucket `egress-gw-health`, key = envId): periodic snapshot
   * of the gateway's current state. Latest-only via KV; no JetStream stream.
   */
  health: "mini-infra.egress.gw.health",
} as const;

/**
 * PostgreSQL backup subjects.
 *
 * Note: `mini-infra.backup.completed` / `.failed` were retired in Phase 4 of
 * the job-pool-service-type migration — backup terminal-state events now
 * flow through the per-pool JobPool history stream
 * (`mini-infra.job-pool.<stackId>.pg-az-backup.completed/.failed`) so any
 * future JobPool template gets the same observability for free. The
 * `BackupHistory` JetStream stream + consumer were torn down at the same
 * time; see `system-nats-bootstrap.ts` for the retirement marker.
 */
export const BackupSubject = {
  /** Command: scheduler invokes a backup run. */
  run: "mini-infra.backup.run",
  /** Event prefix: per-run progress (`...progress.<runId>`). Plain pub/sub. */
  progressPrefix: "mini-infra.backup.progress",
} as const;

/**
 * JobPool run-lifecycle subjects (Phase 2 of job-pool-service-type).
 *
 * Subjects are parameterised by `<stackId>` and `<serviceName>` — the
 * declaring stack + service. The history stream that captures the durable
 * `completed`/`failed` events is per-pool (`JobHistory-<stackId>-<service>`);
 * `run-skipped` is plain pub/sub for observability of cap-hit scheduled runs.
 *
 * Use the builder functions rather than concatenating strings manually so
 * the depth check in the operator-path prefix bootstrap stays correct.
 */
export const JobPoolSubject = {
  /** Static base — every per-pool subject starts with this token. */
  base: "mini-infra.job-pool",
  /** Event (JetStream): a run finished with exit code 0. */
  completed: (stackId: string, serviceName: string): string =>
    `mini-infra.job-pool.${stackId}.${serviceName}.completed`,
  /** Event (JetStream): a run finished with a non-zero exit code (or was killed). */
  failed: (stackId: string, serviceName: string): string =>
    `mini-infra.job-pool.${stackId}.${serviceName}.failed`,
  /** Event (plain pub/sub): a trigger fired but the cap was hit, so no run was started. */
  runSkipped: (stackId: string, serviceName: string): string =>
    `mini-infra.job-pool.${stackId}.${serviceName}.run-skipped`,
  /** Wildcard parent used by stream/consumer subscription filters. */
  wildcardForPool: (stackId: string, serviceName: string): string =>
    `mini-infra.job-pool.${stackId}.${serviceName}.>`,
} as const;

/**
 * Maximum length of a JetStream stream name. NATS itself permits up to 256
 * characters, but the SDK validation and most operational tooling assume
 * shorter names; we keep our per-pool names within 32 chars to match the
 * length of all other Mini Infra stream constants. Names that would exceed
 * this collapse the variable portion (`<stackId>-<service>`) onto an 8-char
 * blake-2b-ish hex digest so two different (stackId, service) pairs always
 * produce two different stream names.
 */
const JOB_HISTORY_STREAM_NAME_MAX = 32;

/** Stable, dependency-free 32-bit FNV-1a hash → 8-char hex suffix. */
function shortHashHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Name prefix identifying a JetStream stream as JobPool history.
 *
 * This is load-bearing as an *ownership* marker, not just a naming nicety.
 * `NatsStream` rows carry a `stackId` but no "who manages this" discriminator,
 * and two independent reconcilers write stack-owned stream rows: the NATS apply
 * orchestrator (role-derived streams) and the JobPool stream reconciler (these).
 * Each prunes rows it considers orphaned, so each must be able to recognise the
 * other's rows and leave them alone — keyed off this prefix.
 */
export const JOB_HISTORY_STREAM_PREFIX = "JobHistory-";

/**
 * Derive the JetStream stream name for a JobPool's history stream. Stable for
 * a given (stackId, serviceName) pair — both the operator-path stream creator
 * and any future client-side history reader must call this so the two sides
 * never drift on which stream to address.
 *
 * Format: `JobHistory-<stackId-suffix>-<serviceName>`. When the obvious join
 * would exceed `JOB_HISTORY_STREAM_NAME_MAX`, the variable portion is replaced
 * by a deterministic short hash so the name stays under the limit.
 */
export function jobHistoryStreamName(stackId: string, serviceName: string): string {
  // Sanitize to the character set NATS allows in stream names (no `.`, no
  // `*`, no `>`, no spaces). The stack ID is a cuid/ULID-ish opaque token in
  // practice but a sanitisation pass keeps a forward-compat door open if the
  // ID scheme ever changes.
  const safeStack = stackId.replace(/[^A-Za-z0-9_-]/g, "");
  const safeService = serviceName.replace(/[^A-Za-z0-9_-]/g, "");
  const candidate = `${JOB_HISTORY_STREAM_PREFIX}${safeStack}-${safeService}`;
  if (candidate.length <= JOB_HISTORY_STREAM_NAME_MAX) return candidate;
  // Hash the unsanitised inputs together so collisions are vanishingly
  // unlikely even on stack-IDs that share a sanitised prefix.
  const hash = shortHashHex(`${stackId}|${serviceName}`);
  // Keep a short readable service prefix so operators can still spot which
  // pool a stream belongs to from `nats stream ls`.
  const readable = safeService.slice(0, 12);
  return `${JOB_HISTORY_STREAM_PREFIX}${hash}-${readable}`.slice(0, JOB_HISTORY_STREAM_NAME_MAX);
}

/** Phase 5 (optional): self-update sidecar subjects. Reserved. */
export const UpdateSubject = {
  run: "mini-infra.update.run",
  progressPrefix: "mini-infra.update.progress",
  completed: "mini-infra.update.completed",
  failed: "mini-infra.update.failed",
  healthCheckPassed: "mini-infra.update.health-check-passed",
} as const;

/**
 * Wildcard subjects used for stream/consumer subscriptions. Defined alongside
 * the subjects they capture so the relationship is obvious at the call site.
 */
export const NatsWildcard = {
  egressFwAll: "mini-infra.egress.fw.>",
  egressGwAll: "mini-infra.egress.gw.>",
  backupAll: "mini-infra.backup.>",
  backupProgressAll: "mini-infra.backup.progress.>",
  updateAll: "mini-infra.update.>",
  updateProgressAll: "mini-infra.update.progress.>",
  /** Every JobPool run-lifecycle subject across every pool. */
  jobPoolAll: "mini-infra.job-pool.>",
} as const;

/**
 * JetStream stream names. Names live in their own NATS namespace so they do
 * not carry the `mini-infra.` prefix; PascalCase per NATS convention.
 */
export const NatsStream = {
  egressFwEvents: "EgressFwEvents",
  egressGwDecisions: "EgressGwDecisions",
  backupHistory: "BackupHistory",
  updateHistory: "UpdateHistory",
} as const;

/**
 * Durable JetStream consumer names, named `<stream>-<subscriber>` per the
 * convention in `internal-nats-messaging-plan.md` §4.4. Same constant lives
 * on both the seeder (server) and the ingester (server consumer) so a
 * rename only needs touching one place.
 */
export const NatsConsumer = {
  egressGwDecisionsServer: "EgressGwDecisions-server",
  egressFwEventsServer: "EgressFwEvents-server",
  backupHistoryServer: "BackupHistory-server",
} as const;

/**
 * JetStream KV bucket names. Used for last-known-state heartbeats where
 * subscribers latch the most recent value (see plan doc §4.3).
 */
export const NatsKvBucket = {
  egressGwHealth: "egress-gw-health",
  egressFwHealth: "egress-fw-health",
} as const;

/**
 * Flat array of every concrete subject this file declares. Used by the
 * TS↔Go drift check to compare against the Go mirror without having to know
 * the grouping shape.
 */
export const ALL_NATS_SUBJECTS: readonly string[] = [
  SystemSubject.ping,
  EgressFwSubject.rulesApply,
  EgressFwSubject.rulesApplied,
  EgressFwSubject.events,
  EgressFwSubject.health,
  EgressGwSubject.rulesApply,
  EgressGwSubject.rulesApplied,
  EgressGwSubject.containerMapApply,
  EgressGwSubject.containerMapApplied,
  EgressGwSubject.decisions,
  EgressGwSubject.health,
  BackupSubject.run,
  BackupSubject.progressPrefix,
  UpdateSubject.run,
  UpdateSubject.progressPrefix,
  UpdateSubject.completed,
  UpdateSubject.failed,
  UpdateSubject.healthCheckPassed,
  // JobPool (Phase 2): subjects are parameterised per (stackId, serviceName).
  // The static base lives in the registry as a parent so the
  // KnownNatsSubject type stays exhaustive; concrete per-pool subjects use
  // `unchecked: true` at publish/subscribe sites and validate inline against
  // the same Zod schemas exported from payload-schemas.ts.
  JobPoolSubject.base,
] as const;
