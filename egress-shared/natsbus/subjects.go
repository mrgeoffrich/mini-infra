// Package natsbus mirrors the NATS subject constants declared in
// `lib/types/nats-subjects.ts`. Both files describe the same contract for
// system-internal app-to-app messaging on the `mini-infra.>` namespace; the
// drift check at `scripts/check-nats-subject-drift.mjs` runs in CI to keep
// them in lock-step.
//
// Phase 1 ships constants only — there is no NATS client wrapper here yet.
// The first real Go consumer (the egress-fw-agent in Phase 2) will add
// publish/subscribe helpers.
//
// Naming rules (kept terse here; see the TS file for the full rationale):
//
//	mini-infra.<subsystem>.<aggregate>.<verb-or-event>[.<id>]
//
//	  Commands: imperative verb, used with request/reply.
//	  Events:   past-participle verb, fan-out publish.
//	  Heartbeat: noun only, periodic publish.
package natsbus

// SystemPrefix is the single namespace under which every system-internal
// subject lives. App stacks use the per-stack default `app.<stack-id>.>`
// or an admin-allowlisted prefix — both are out of scope of this package.
const SystemPrefix = "mini-infra"

// System / smoke ping (Phase 1).
const (
	SubjectSystemPing = "mini-infra.system.ping"
)

// Egress firewall agent subjects (Phase 2).
const (
	SubjectEgressFwRulesApply   = "mini-infra.egress.fw.rules.apply"
	SubjectEgressFwRulesApplied = "mini-infra.egress.fw.rules.applied"
	SubjectEgressFwEvents       = "mini-infra.egress.fw.events"
	SubjectEgressFwHealth       = "mini-infra.egress.fw.health"
)

// Egress gateway subjects (Phase 3).
//
// `RulesApply`, `RulesApplied`, `ContainerMapApply`, `ContainerMapApplied`,
// and `Health` are BASE prefixes — the server appends an `<envId>` token at
// runtime so each environment's gateway gets its own command/event subject.
// `Decisions` is the lone shared subject (one JetStream stream across all
// envs, with environmentId carried in the payload).
const (
	SubjectEgressGwRulesApply           = "mini-infra.egress.gw.rules.apply"
	SubjectEgressGwRulesApplied         = "mini-infra.egress.gw.rules.applied"
	SubjectEgressGwContainerMapApply    = "mini-infra.egress.gw.container-map.apply"
	SubjectEgressGwContainerMapApplied  = "mini-infra.egress.gw.container-map.applied"
	SubjectEgressGwDecisions            = "mini-infra.egress.gw.decisions"
	SubjectEgressGwHealth               = "mini-infra.egress.gw.health"
)

// JetStream / KV resource names used by the gateway. Shared with the server
// side — the server creates them via NatsControlPlaneService, the gateway
// only references them at publish-time.
const (
	StreamEgressGwDecisions = "EgressGwDecisions"
	KvEgressGwHealth        = "egress-gw-health"
)

// PostgreSQL backup subjects (Phase 4).
const (
	SubjectBackupRun             = "mini-infra.backup.run"
	SubjectBackupProgressPrefix  = "mini-infra.backup.progress"
	SubjectBackupCompleted       = "mini-infra.backup.completed"
	SubjectBackupFailed          = "mini-infra.backup.failed"
)

// Self-update sidecar subjects (Phase 5, optional).
const (
	SubjectUpdateRun                = "mini-infra.update.run"
	SubjectUpdateProgressPrefix     = "mini-infra.update.progress"
	SubjectUpdateCompleted          = "mini-infra.update.completed"
	SubjectUpdateFailed             = "mini-infra.update.failed"
	SubjectUpdateHealthCheckPassed  = "mini-infra.update.health-check-passed"
)

// AllSubjects is the flat list used by the TS↔Go drift check. Order matches
// `ALL_NATS_SUBJECTS` in `lib/types/nats-subjects.ts` (subjects-as-set
// equality is what the check enforces, but mirroring the order makes diffs
// readable).
var AllSubjects = []string{
	SubjectSystemPing,
	SubjectEgressFwRulesApply,
	SubjectEgressFwRulesApplied,
	SubjectEgressFwEvents,
	SubjectEgressFwHealth,
	SubjectEgressGwRulesApply,
	SubjectEgressGwRulesApplied,
	SubjectEgressGwContainerMapApply,
	SubjectEgressGwContainerMapApplied,
	SubjectEgressGwDecisions,
	SubjectEgressGwHealth,
	SubjectBackupRun,
	SubjectBackupProgressPrefix,
	SubjectBackupCompleted,
	SubjectBackupFailed,
	SubjectUpdateRun,
	SubjectUpdateProgressPrefix,
	SubjectUpdateCompleted,
	SubjectUpdateFailed,
	SubjectUpdateHealthCheckPassed,
}
