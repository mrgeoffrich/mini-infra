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

/** Phase 3: egress gateway subjects. Reserved. */
export const EgressGwSubject = {
  rulesApply: "mini-infra.egress.gw.rules.apply",
  rulesApplied: "mini-infra.egress.gw.rules.applied",
  /** Event stream: per-decision proxy verdicts; JetStream durable. */
  decisions: "mini-infra.egress.gw.decisions",
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
