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

/** Phase 4: PostgreSQL backup subjects. Reserved. */
export const BackupSubject = {
  /** Command: scheduler invokes a backup run. */
  run: "mini-infra.backup.run",
  /** Event prefix: per-run progress (`...progress.<runId>`). Plain pub/sub. */
  progressPrefix: "mini-infra.backup.progress",
  /** Event: backup finished successfully; JetStream durable. */
  completed: "mini-infra.backup.completed",
  /** Event: backup failed; JetStream durable. */
  failed: "mini-infra.backup.failed",
} as const;

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
  BackupSubject.completed,
  BackupSubject.failed,
  UpdateSubject.run,
  UpdateSubject.progressPrefix,
  UpdateSubject.completed,
  UpdateSubject.failed,
  UpdateSubject.healthCheckPassed,
] as const;
