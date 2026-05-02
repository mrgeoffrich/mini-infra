# Unified Backups — Strategy-based backup and restore framework

**Status:** planned, not implemented. Phased rollout — each phase is a separate Linear issue.
**Builds on:** the existing `BackupConfiguration` / `BackupOperation` schema and [`BackupExecutorService`](../../../server/src/services/backup/backup-executor.ts) / [`BackupSchedulerService`](../../../server/src/services/backup/backup-scheduler.ts), the [pg-az-backup container pattern](../../../pg-az-backup/backup.sh), `DockerExecutorService.executeContainer()` for transient runners, and `AzureStorageService.generateBlobSasUrl()` ([server/src/services/azure-storage-service.ts](../../../server/src/services/azure-storage-service.ts)).
**Pairs with:** [service-addons-plan.md](service-addons-plan.md) and [job-pool-service-type-plan.md](job-pool-service-type-plan.md) — Phase 5 swaps the runner-container dispatcher from local transient-container to JobPool-dispatched once those features ship.
**Supersedes:** the deferred `volume-azure-backup-plan.md` and `volume-azure-backup-implementation.md`. Volume backup is now one strategy in this framework, not a feature in its own right.

---

## 1. Background

Mini Infra has a single backup feature today — encrypted PostgreSQL backups to Azure Blob, scheduled via cron, restored manually. It works, but it's hard-coded to one resource type, one storage backend, and one runner shape (a sidecar container per database stack). Operators have asked for backups of arbitrary Docker volumes, of internal services like OpenBao Vault, and most pressingly for "restore Mini Infra itself from a backup" during disaster recovery. Solving each separately means three or four parallel features that all do roughly the same thing — schedule, run a runner, encrypt, upload, retain, restore — with bespoke UIs.

This plan delivers **disaster-recovery bootstrap for Mini Infra itself** as the first phase: a fresh install can be pointed at a previous instance's storage target during onboarding and rehydrate from the most recent control-plane backup. The underlying machinery — a strategy registry, a storage-target abstraction, system-scoped backup configs, and a shared `@mini-infra/backups` TypeScript library that holds the strategy and target implementations — is built in service of that goal, then generalises across subsequent phases to add OpenBao Vault snapshots so credentials survive a restore, support arbitrary Docker volume backups via a `backups:` block on stack templates, and finally subsume the existing PostgreSQL-only feature so the `pg-az-backup` sidecar pattern goes away. The shared library is consumed both by the Mini Infra server (in-process, during bootstrap restore — before NATS or any steady-state runtime is up) and by a thin `mini-infra/backup-runner` container (for scheduled and manual operations in steady state). Per-config UI exposes only the operator-tunable knobs; strategy and strategy-config remain template-controlled.

## 2. Goals

1. **A disaster-recovery bootstrap flow.** A first-time-boot wizard configures a storage target, lists candidate `postgres` and (later) `openbao-vault` system backups, and rehydrates Mini Infra from them before normal startup — running in-process, with no dependency on NATS, JobPool, or any other steady-state runtime.
2. **System-scoped backups for Mini Infra's own state.** `postgres` and `openbao-vault` strategies are wired against the control-plane DB and the `vault-nats` stack so the platform's own state is part of the same framework.
3. **A shared backup library and a thin runner image.** Strategy and target implementations live in `@mini-infra/backups`, callable both in-process (during bootstrap restore) and from inside a `mini-infra/backup-runner` container (for scheduled and manual operations). Strategies must not couple to NATS or JobPool — only to what they declare they need.
4. **A storage-target abstraction.** Strategies stream to a `BackupTarget` API; targets implement signed-write-URL, signed-read-URL, list, and delete. Azure Blob is the v1 target; S3-compatible follows.
5. **A strategy registry.** New strategies are dropped into `libs/backups/strategies/<id>/` with a manifest (config schema, scope, applicability, restore-UI metadata), a backup implementation, and a paired restore implementation. Adding `redis-rdb` or `mysql` later is dropping a directory.
6. **A `backups:` block on stack templates.** Each entry declares a stable id, a strategy, and a strategy-specific config blob. Operators never write commands, paths, or quiesce modes.
7. **Per-strategy restore UIs.** Each strategy provides a `RestoreUIMetadata` block; the unified Backups page renders a strategy-typed restore form (target DB name + over-existing-vs-clone for postgres, stop-attached-containers vs clone for volumes, full-instance-only with passphrase for vault).

## 3. Non-goals

- **Backing up arbitrary user-managed Docker volumes outside a stack.** Every backup attaches to a stack template (system stacks included). Standalone volumes that aren't owned by a stack are not addressable by the framework. The `custom-command` escape-hatch strategy in Phase 6 covers genuine one-offs.
- **Per-app data backup for stacks the operator authors freehand.** A user template gets backups by declaring the strategy it needs — same surface as system templates, no implicit "we'll back up your volumes anyway" behaviour.
- **Cross-region or cross-account replication.** Storage-target redundancy is the target's problem (Azure GRS, S3 cross-region replication). The framework writes to one target per backup config.
- **Backup of running container memory state.** Strategies reach the same consistency floor as the existing pg-dump pattern — application-level dumps where possible, filesystem-level snapshots otherwise. Live-memory snapshotting is out.
- **Cross-Mini-Infra-version restore guarantees.** Restoring a backup taken on version N onto version N+k requires running the schema migration chain in between. We document the supported envelope; we don't promise infinite back-compat.
- **Encryption-key escrow.** Operators hold passphrases for client-side encryption. Mini Infra does not escrow them; losing the passphrase means losing the backup.
- **The JobPool runtime itself.** This plan consumes JobPool when it lands ([job-pool-service-type-plan.md](job-pool-service-type-plan.md)); it does not specify how JobPool dispatches workloads.

## 4. Architecture

### 4.1 Concepts

- **Strategy.** A backup type (`postgres`, `docker-volume-stop-restart`, `openbao-vault`). Owns a config schema, a backup implementation, a restore implementation, and restore-UI metadata.
- **Strategy registry.** Server-side singleton populated at boot from `@mini-infra/backups`. Stack templates and system seeds resolve strategy ids through it; unknown ids fail validation.
- **Storage target.** A configured destination (`AzureBlobTarget` referencing the existing connected Azure account, future `S3Target`). Strategies don't know targets — they consume a `BackupTargetClient`.
- **Backup config.** The runtime row that pairs (stack instance × template-declared backup id) or (system × system backup id) with a target, schedule, retention policy, and encryption settings. Strategy config is template-controlled and not editable here.
- **Backup operation.** A single run. Captures the strategy and strategy-config snapshot, the target blob URL, the size, the result, and the audit fields.
- **System backup.** A backup config not owned by any user stack. The framework ships two: `control-plane-db` (Mini Infra's own postgres, Phase 1) and `control-plane-vault` (the `vault-nats` stack's OpenBao, Phase 2). Admin-only, undeletable, schema-locked.
- **Execution mode.** *In-process* (server imports `@mini-infra/backups` and runs strategy code directly — used during bootstrap restore) or *runner-container* (server dispatches a job descriptor to a `mini-infra/backup-runner` container — used for scheduled and steady-state operations). See §4.6.

### 4.2 Strategy contract

```ts
export interface BackupStrategyManifest {
  id: string;                              // "postgres", "docker-volume-stop-restart", "openbao-vault"
  description: string;
  scope: "stack" | "system" | "both";      // where this strategy may be declared
  appliesTo?: {
    serviceTypes?: StackServiceType[];     // strategy targets a service of these types
    requiresVolume?: boolean;              // strategy targets a stack volume
  };
  configSchema: z.ZodTypeAny;              // strategy-specific config blob (template-declared)
  blobMimeType: string;                    // "application/postgres-custom", "application/x-tar+gzip", "application/openbao-snapshot"
  restoreUI: RestoreUIMetadata;            // describes the restore form fields
  encryptionRequired?: boolean;            // openbao-vault forces client-side encryption
}

export interface BackupContext {
  configId: string;
  strategyConfig: unknown;                 // already validated against configSchema
  target: BackupTargetClient;
  encryption?: EncryptionEnvelope;
  emit: (event: BackupProgressEvent) => void;
}

export interface RestoreContext {
  operationId: string;                     // the BackupOperation being restored
  strategyConfig: unknown;
  restoreOptions: unknown;                 // strategy-specific, validated against restoreUI.optionsSchema
  target: BackupTargetClient;
  encryption?: EncryptionEnvelope;
  emit: (event: BackupProgressEvent) => void;
}

export interface BackupStrategy {
  manifest: BackupStrategyManifest;
  backup(ctx: BackupContext): Promise<{ blobKey: string; sizeBytes: number; metadata?: Record<string, unknown> }>;
  restore(ctx: RestoreContext): Promise<void>;
}
```

The strategy implementation lives in `@mini-infra/backups` and is callable in either execution mode (see §4.6). The server resolves the strategy by id, materialises a job descriptor, and either invokes it in-process (bootstrap) or dispatches it to a runner container (steady state). The runner-container dispatch interface is the seam Phase 5 swaps from `DockerExecutorService.executeContainer()` to JobPool. Strategies must not assume NATS, JobPool, or other steady-state infrastructure are reachable — only the resources they declare in `BackupContext` / `RestoreContext`.

### 4.3 Storage target contract

```ts
export interface BackupTargetClient {
  beginWrite(key: string, opts: { ttlMinutes: number }): Promise<{ uploadUrl: string; headers?: Record<string, string> }>;
  beginRead(key: string, opts: { ttlMinutes: number }): Promise<{ downloadUrl: string }>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<Array<{ key: string; sizeBytes: number; createdAt: Date }>>;
}
```

`AzureBlobTarget` wraps the existing `AzureStorageService` (block-blob SAS URL, same shape as `pg-az-backup/backup.sh`). The same target client is used by in-process strategy execution and by the runner CLI — `curl -T` against a signed URL in the runner container, fetch-stream against the same signed URL in-process.

### 4.4 Stack template extension

A new top-level `backups:` array on the stack template (introduced in Phase 3, parallel to `services[]` and `volumes[]`):

```yaml
backups:
  - id: pg-main
    strategy: postgres
    description: "Logical dump of the application database"
    config:
      service: postgres                  # references services[].name
      databases: ["app"]                 # optional, default: all

  - id: redis-data
    strategy: docker-volume-stop-restart
    description: "Redis persistence volume"
    config:
      volume: redis-data                 # references volumes[].name
      stopServices: [redis]
```

The `id` is stable across template versions. Stack instances reference it to track per-backup config state. Edits to a template's `backups:` block flow through the existing plan/apply pipeline; renaming an `id` is a remove + add (operator-visible in the diff).

### 4.5 Per-instance backup config

A new `BackupConfig` table stores the operator-tunable knobs:

```ts
BackupConfig {
  id: string;
  ownerType: "stack" | "system";
  ownerId: string;                        // stackId, or system stable id
  templateBackupId: string;               // matches the template's backups[].id (or the system seed's id)
  strategy: string;                       // denormalised for query convenience
  isEnabled: boolean;
  schedule: string;                       // cron
  timezone: string;
  retentionCount?: number;
  retentionDays?: number;
  targetId: string;                       // FK to BackupTarget
  encryption?: { mode: "passphrase"; passphraseHandle: string };  // Vault-stored
  lastBackupAt?: Date;
  nextScheduledAt?: Date;
}
```

Phase 1 only writes rows with `ownerType: "system"`; Phase 3 introduces `"stack"`. The strategy config from the template (or the system seed) is not duplicated here — it's resolved at run time from the current template snapshot. This avoids drift between template edits and the next scheduled run.

### 4.6 Shared library and execution modes

Strategy and target implementations live in a new shared TypeScript workspace package at `libs/backups/`, exposed as `@mini-infra/backups`. This establishes a new top-level `libs/` directory for shared workspace packages — sibling to `client/`, `server/`, and the existing `lib/`. Other shared packages may migrate into `libs/` over time, but this plan does not require it.

The package exports:

- Every `BackupStrategy` implementation (postgres, openbao-vault, docker-volume-*, etc.).
- Every `BackupTargetClient` implementation (`AzureBlobTarget`, future `S3Target`).
- The encryption envelope filter (encrypt-on-write, decrypt-on-read).
- The job-descriptor schema that binds strategy id + strategy config + target descriptor + encryption envelope + operation parameters.

Two consumers, two execution modes:

**In-process.** The Mini Infra server imports `@mini-infra/backups` directly and runs strategy code in its own process. Used during the **DR bootstrap restore**, which by definition runs before NATS, JobPool, or any other steady-state runtime is available. The server runs in a dedicated 'bootstrap mode' during this window — serving a separate, minimal bootstrap UI distinct from the main UI (no auth, no Socket.IO, no connected-services dependency); progress is delivered via direct callback to that surface rather than over a wire. Used only for the bootstrap path in Phase 1; Phase 2 extends it to cover the vault leg of bootstrap.

**Runner-container.** A small image, `mini-infra/backup-runner`, packaged like `update-sidecar/` and `agent-sidecar/` and built as a thin CLI wrapper around the shared library:

- `backup-runner --job-descriptor <path>` reads a JSON file mounted by the dispatcher; the descriptor contains everything `@mini-infra/backups` needs to execute the strategy.
- It calls the same strategy code the in-process path does — no logic duplication.
- Progress channel is `stdout` for Phase 1 (the dispatcher pipes it into the operation's task tracker) and a NATS subject for the JobPool integration in Phase 5.
- Used for **all steady-state backup/restore operations**: scheduled backups, manual "run backup now" runs, and non-bootstrap restores.

The two modes share the strategy contract verbatim. A strategy author writes one implementation; the runtime decides whether to execute it in-process or via a runner container based on context, not based on which strategy it is. The constraint this places on strategies is non-trivial: they must run on whatever set of resources is available at the moment they're called, and bootstrap is the lowest-common-denominator (no NATS, no JobPool, the live `vault-nats` stack may not yet exist). Strategies that need *more* than that — e.g. the Phase 2 vault strategy needs a reachable OpenBao endpoint — must declare that requirement in their config and rely on the caller to satisfy it before invocation.

### 4.7 Encryption

Two layers, composable:

- **Server-side encryption** at the storage target. Automatic for Azure Blob, transparent to the strategy. Default for everything in Phase 1.
- **Client-side encryption** in the runner / in-process strategy invocation, before upload. Operator-held passphrase, derived through the same KDF the SecretsVault unseal pattern uses. Introduced in Phase 2 alongside the OpenBao Vault strategy. Required for `openbao-vault` (the vault snapshot is the platform's secrets root — server-side-only encryption defeats the purpose). Optional everywhere else.

The encryption envelope (algorithm, KDF parameters, salt) is recorded on the `BackupOperation` row so restore can re-derive the key from the same passphrase.

### 4.8 Permissions and events

A new `backups` permission domain (replaces the current PG-scoped `backups` domain at the Phase 4 cutover):

- `backups:read` — list configs, list operations, view metadata.
- `backups:write` — edit per-instance config (schedule, retention, target, encryption). Strategy and strategy-config remain template-controlled.
- `backups:trigger` — kick off a manual run.
- `backups:restore` — kick off a restore. Admin-only by default preset.

Socket.IO events on a new `Channel.BACKUPS`:

- `BACKUP_STARTED` / `BACKUP_STEP` / `BACKUP_COMPLETED` for runs.
- `RESTORE_STARTED` / `RESTORE_STEP` / `RESTORE_COMPLETED` for restores.

The new domain and channel land in Phase 1 alongside the new framework. Existing PG-backup events and the legacy `backups`-domain entries are removed at the Phase 4 cutover (no compat shim per the project convention). The bootstrap restore predates Socket.IO — its progress flows via the in-process callback, not events.

## 5. Phased rollout

Phases land in order; each phase blocks the next. Phase 5 also blocks on JobPool landing in the Service Addons project. Phase 6 is independent and may be picked up at any time after Phase 4.

### Phase 1 — Mini Infra control-plane backup and onboarding restore from storage

**Goal:** a fresh Mini Infra install can be pointed at a previous instance's storage target during onboarding and rehydrate from the most recent control-plane Postgres backup before normal startup, in-process, without any steady-state runtime needing to be up.

Deliverables:
- A new shared workspace package at `libs/backups/`, published as `@mini-infra/backups`, establishing a new top-level `libs/` directory for shared packages. Exports strategy implementations, target client implementations, the encryption-envelope filter, and the job-descriptor schema. Phase 1 ships only the `postgres` strategy and the `AzureBlobTarget`; the package shape is framework-ready so later phases drop new strategies and targets in.
- Strategy registry + manifest schema + progress-event protocol under `server/src/services/backups/`. The registry resolves strategy ids supplied by the bootstrap UI, the scheduler, or the runner CLI.
- `BackupTarget` admin model and admin UI; add target → connectivity probe + write/read/delete pre-flight → save.
- `BackupConfig` and `BackupOperation` Prisma models — system-scoped only in this phase (`ownerType: "system"`). Legacy `BackupConfiguration` rows are left alone; the cutover happens in Phase 4.
- A `system_backup_seed` mechanism that registers a `control-plane-db` `BackupConfig` row at boot, admin-only and undeletable.
- `mini-infra/backup-runner` image package — a thin CLI wrapper around `@mini-infra/backups`. Consumes a job-descriptor file mounted by the dispatcher and streams progress to stdout.
- Server-side runner-container dispatcher using `DockerExecutorService.executeContainer()` (transient container per run). The dispatch interface is the seam Phase 5 swaps to JobPool.
- Server-side **in-process invocation path** that imports `@mini-infra/backups` and runs the postgres strategy's `restore()` directly during bootstrap — without NATS, JobPool, or the runner-container path needing to be available.
- A scheduler that runs the seeded `control-plane-db` config on its configured cron via the runner-container path; manual "run backup now" affordance for operators.
- A new `Backups` admin page listing system backup configs, their schedules, and operation history. Per-strategy restore form rendered from `RestoreUIMetadata` (postgres-typed). Per-stack listing is added in Phase 3; pg-az-backup integration in Phase 4.
- A new `backups` permission domain with the four scopes; Reader / Editor / Admin presets updated. The legacy PG-only domain is left alone until Phase 4.
- A separate **bootstrap UI surface**, distinct from the main UI: no auth, no Socket.IO, no connected-services dependency, minimal bundle (its own React entry, its own minimal API surface). Served by Mini Infra in 'bootstrap mode' — activated when a fresh-install signal is detected or a `restore-pending` marker is present, deactivated once normal startup runs. The main UI does not load until bootstrap mode exits.
- The bootstrap surface hosts a "Fresh install" branch and a "Restore from backup" branch. The restore branch flow: configure storage target → list candidate backups at that target → pick one → confirm → write a `restore-pending` marker on a persistent volume → exit container.
- On next boot the platform detects the marker, runs the postgres strategy's `restore()` in-process against the empty control-plane DB, runs `prisma migrate deploy`, clears the marker, then continues normal boot. Progress streams to the bootstrap UI via direct callback.
- A first-boot-after-restore notice in the UI explaining that connected-service credentials need re-entry until vault DR ships in Phase 2.

Done when: worktree A runs Mini Infra with the seeded `control-plane-db` backup configured against an Azure target; worktree B (fresh install) is pointed at the same target via the onboarding wizard, picks the most recent backup, and confirms; after one container restart B comes up with A's stack definitions, environments, users, and audit history. The bootstrap restore path runs entirely in-process — no NATS, no runner container, no other steady-state runtime is required for it to complete. A first-boot-after-restore banner reminds the operator to re-enter Azure / Cloudflare / GitHub credentials.

### Phase 2 — OpenBao Vault strategy and client-side encryption

**Goal:** control-plane DR is complete — a restored Mini Infra has both its postgres and its vault state, eliminating the post-restore credential re-entry from Phase 1.

Deliverables:
- `openbao-vault` strategy in `@mini-infra/backups` with `encryptionRequired: true`: invokes `bao operator raft snapshot save` against the running OpenBao via the OpenBao HTTP API and streams the snapshot to the target. The paired restore implementation consumes the snapshot on a freshly-initialised OpenBao via the same API; the *bootstrap sequencing* that produces such an OpenBao to restore into is the open design question called out below.
- Client-side encryption envelope (algorithm, KDF parameters, salt) and the encrypt-on-write / decrypt-on-read filter in `@mini-infra/backups`. Passphrase handles stored under the same access semantics as the existing SecretsVault unseal material.
- The `vault-nats` system template gains a system-seed `control-plane-vault` backup config; the framework refuses to save the config without a passphrase.
- Onboarding restore branch extension: when a configured target has paired vault + DB system backups (matched by tag or timestamp window), the wizard offers them as a unit and asks for the encryption passphrase.
- The Phase 1 in-process restore path is extended to include the vault leg, sequenced after the postgres restore. The exact bootstrap sequencing — how to stand up a freshly-initialised OpenBao to restore *into*, how to handle the OpenBao image pull credential if it itself lives in vault, and whether NATS / JetStream state needs its own backup leg alongside the vault snapshot — is an open design question to resolve before this phase starts (see Risks). The constraint the phase must respect: every step runs in-process and depends only on what was available at Phase 1 plus what the previous steps in the sequence have produced — no NATS, no JobPool.
- A "test restore" affordance per system backup that rehearses restore against an isolated target volume without touching the live control plane, so operators can verify their backups are usable.

Done when: worktree A backs up both DB and Vault to a target; worktree B is restored from that target through the onboarding wizard; after one container restart B comes up fully — connected-service credentials decryptable, ACME private keys, NATS NKeys, registry creds all intact — without any manual re-entry. The full DR restore path remains in-process.

### Phase 3 — Stack-template `backups:` block and Docker volume strategies

**Goal:** stack templates can declare backups for their own services and volumes, on the same framework as the system backups Phases 1–2 introduced.

Deliverables:
- `backups:` array on `StackTemplate` with per-strategy config validation against the registry. Stack instances materialise per-instance `BackupConfig` rows (`ownerType: "stack"`) for each declaration the operator enables.
- The `postgres` strategy generalises from "control-plane only" to any postgres-typed service in any stack.
- `docker-volume-stop-restart` and `docker-volume-live` strategies in `@mini-infra/backups`. (`docker-volume-fsfreeze` deferred to Phase 6 — non-trivial on Docker named volumes that share the host filesystem, per the prior plan's analysis.)
- `BackupLockService` wired into the stack reconciler so a `stop-restart` window does not race a reconciler-driven restart.
- Restore-UI metadata for volume strategies: stop-attached-containers-and-restore-over-existing vs restore-to-clone-volume.
- Mandatory inconsistency-acknowledgement on the Backups page when an operator enables a `docker-volume-live` config.
- Per-stack listing on the Backups page; the Phase 1 system-only listing grows a per-stack section.
- Documentation page covering when to pick which volume strategy and the consistency trade-offs.

Done when: a user-authored stack template declaring a `docker-volume-stop-restart` backup applies cleanly, the configured backup runs on schedule, restoring into the same volume stops the attached services and restores correctly, and the reconciler does not fight the stop window.

### Phase 4 — pg-az-backup cutover

**Goal:** the existing PostgreSQL-only backup feature is fully replaced by the unified framework, with a one-shot data migration of existing user backup configs.

Deliverables:
- The system Postgres template's `backups:` block declares a `pg-main` backup using the postgres strategy.
- One-shot data migration from the legacy `BackupConfiguration` / `BackupOperation` rows to new `BackupConfig` / `BackupOperation` rows, preserving history and blob references.
- Cutover: postgres stack templates stop spawning a per-stack `pg-az-backup` sidecar; all backups now dispatch through the unified runner.
- Legacy PG-only permission entries removed; legacy PG-specific Socket.IO events removed (the new `BACKUP_*` / `RESTORE_*` events on `Channel.BACKUPS` shipped in Phase 1 take over).
- The legacy "Database Backups" UI page is removed; the unified Backups page is now the only surface.

Done when: zero `pg-az-backup` containers run anywhere on the host, every pre-cutover BackupConfiguration is represented as a new BackupConfig with continuous history, and a manual restore through the new UI completes successfully against a database that was being backed up by the legacy feature pre-cutover.

### Phase 5 — JobPool integration (optional, deferred)

**Goal:** the runner-container dispatcher stops being a transient `DockerExecutorService` invocation and becomes a JobPool-dispatched job, picking up the orchestration improvements (queueing, parallelism limits, retry, NATS-based progress) that the Service Addons / JobPool plan delivers. The bootstrap in-process path is unaffected.

Deliverables:
- A `JobPoolBackupDispatcher` implementing the same dispatch interface defined in Phase 1, replacing the transient-container dispatcher.
- The runner CLI gains a NATS-based progress emitter for use inside JobPool; the stdout emitter remains for local development and tests.
- Backup operation rows reference a `jobId` for cross-linking with JobPool's run history.
- Concurrency policy: per-target write throughput limit configurable on `BackupTarget`, enforced by JobPool queue depth.
- Migration path from the transient runner: feature flag + rollout; existing in-flight runs drain on the old dispatcher.

Done when: a backup run dispatched on a JobPool-enabled instance shows in the JobPool history, progress streams over NATS rather than stdout pipe, and the per-target concurrency cap is enforceable by the operator.

### Phase 6 — Additional strategies and targets (optional, deferred)

**Goal:** the registry covers the long tail of common workloads and at least one non-Azure storage target.

Deliverables:
- `redis-rdb` strategy (BGSAVE + RDB copy) and `mysql` strategy (mysqldump).
- `sqlite` strategy (online backup API via `sqlite3 .backup`).
- `custom-command` strategy with explicit "you own consistency" framing — escape hatch for niche data types; not eligible for system scope.
- `S3Target` storage target; `LocalFsTarget` for on-host backups (e.g. an external disk mount).
- `docker-volume-fsfreeze` strategy if a dedicated-filesystem-per-volume option becomes practical.
- Additional dashboard surfacing on the Backups page: per-strategy success-rate / size-trend / run-duration panels.

Done when: a stack template can declare any of the listed strategies against any of the listed targets, with restore working end-to-end for each.

## 6. Risks & open questions

- **Strategy/runner versioning across DR.** A backup taken on library version N and restored on a later instance with library N+k must remain readable. Both the in-process server and the runner image carry a copy of `@mini-infra/backups`, so the version mismatch surface is the *blob format*, not the library — version the blob format explicitly, record the format version on `BackupOperation`, refuse cross-format restores with a clear error. Lock this in during Phase 1, before any backup blobs exist in the wild.
- **In-process strategy contract.** Strategies must run without NATS, JobPool, or any steady-state runtime — only what they declare in `BackupContext` / `RestoreContext`. The contract enforces this in shape, but a careless implementation can still reach for a global. Confirm during Phase 1 by reviewing the postgres strategy's imports against an allowlist before committing; carry that review forward each time a new strategy lands.
- **Postgres restore against the running control plane.** Phase 1 routes the control-plane DB restore through a container restart so the in-process restore happens before Mini Infra opens its own DB connection. Confirm in production: the container exits cleanly on the marker, the marker is on a volume that survives the restart, the post-restart boot path is reliable, and no concurrent writer races the import.
- **Phase 2 design is an open question — restoring OpenBao and NATS at bootstrap.** Multiple chicken-and-eggs make this a real design problem rather than an implementation detail: the `vault-nats` stack only exists in the database after Phase 1's postgres restore; deploying it via the normal stack reconciler at this point in boot may need a registry credential for the OpenBao image that itself lives in (the not-yet-restored) vault; and JetStream stream contents living in the NATS data volume are not captured by either the postgres or vault snapshots. Resolve before Phase 2 starts — the resolution shapes the deliverables. Candidate directions worth weighing: pinning OpenBao / NATS images to public-registry references so no vault-stored credentials are needed at this point in boot; staging the OpenBao container manually (outside the stack reconciler) for the duration of bootstrap; and either treating JetStream state as transient (recoverable on reconnect — no DR needed) or introducing a separate JetStream-data backup strategy.
- **DR usefulness in Phase 1 without vault.** A Phase-1-only restore brings back stack defs, environments, users, and audit history — but every secret in the DB references something in Vault that the new instance can't decrypt. Connected services (Cloudflare, Azure, GitHub), ACME private keys, NATS NKeys, and registry creds all need re-entry. Surface this prominently in the first-boot-after-restore notice; Phase 2 closes the gap.
- **Vault snapshot on a running OpenBao.** `bao operator raft snapshot save` is online and consistent against Raft, but the snapshot does not include unseal material. The DR flow needs the operator to provide the unseal key separately at restore time — same pattern as today's first-boot vault setup. Document explicitly in Phase 2.
- **Stack reconciler vs backup lock.** Phase 3 introduces `BackupLockService`. Confirm during Phase 3 that the existing reconciler honours the lock — the prior volume-backup-plan flagged this as a high-priority pre-flight.
- **System-backup encryption-key loss.** A lost passphrase for `control-plane-vault` is the platform equivalent of losing the keys to your house. Phase 2 should ship operator-facing guidance and a "rotate passphrase" action that re-encrypts the most recent backup with a new key. Older backups under the previous key are not retrievable.
- **Storage-target migration mid-life.** Operators will eventually want to switch from Azure to S3 (or vice versa). The framework supports this via a per-config `targetId` change, but the existing blobs don't move automatically. Document the migration recipe (re-run a manual backup against the new target, retire the old) rather than implement target-to-target replication.
- **Custom-command strategy and system scope.** Phase 6 disallows `custom-command` at system scope (the manifest's `scope: "stack"` enforces this). If we ever loosen that, we open the platform to "operator typed `rm -rf /` in a backup hook" failures during DR. Keep it locked.
- **Runner image size.** Bundling every strategy into one shared library and one runner image keeps distribution simple but grows both with each strategy added. Re-evaluate at Phase 6 whether per-strategy images or a plugin-fetch model becomes warranted; for v1 the unified library + image is right.
- **Concurrency before JobPool.** Phase 1 dispatches steady-state backups via transient containers with no global concurrency cap. With only the seeded `control-plane-db` config the risk is small, but it grows in Phase 3 once user-stack backups join the schedule. Mitigate with a small in-process semaphore in the dispatcher; revisit properly in Phase 5.

## 7. Linear tracking

Tracked under the [Unified Backups — Strategy-based backup and restore framework](https://linear.app/altitude-devops/project/unified-backups) project on the Altitude Devops team. Phases land in order; each phase blocks the next. Phase 5 also blocks on JobPool landing in the Service Addons project.

- ALT-_TBD_ — Phase 1: Mini Infra control-plane backup and onboarding restore from storage
- ALT-_TBD_ — Phase 2: OpenBao Vault strategy and client-side encryption
- ALT-_TBD_ — Phase 3: Stack-template `backups:` block and Docker volume strategies
- ALT-_TBD_ — Phase 4: pg-az-backup cutover
- ALT-_TBD_ — Phase 5 (deferred): JobPool integration
- ALT-_TBD_ — Phase 6 (deferred): Additional strategies and targets
