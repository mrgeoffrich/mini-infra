# Docker volume backups to Azure Blob (deferred)

A standalone feature, separate from SecretsVault. Mini-infra has a PostgreSQL + Azure backup pattern, but that feature uses `pg_dump` — an application-aware logical dump — which is inherently consistent. Generalising to arbitrary Docker volumes requires solving a problem the PG feature never had: how to get a consistent snapshot of a filesystem that a running container is actively writing to.

## Goal

Operators can pick any Docker volume managed by mini-infra, schedule recurring encrypted backups to Azure Blob, and restore from a previous snapshot on demand — without silently capturing corrupt data.

## Consistency is the primary design axis

A naive live `tar` of a mounted volume captures:

- **Torn reads** — a file mutated mid-tar produces a half-old/half-new blob.
- **Database-like files** (SQLite, LMDB, BoltDB, Redis RDB/AOF, Postgres PGDATA) captured between fsync boundaries — the restored volume looks structurally valid but is corrupt on first open.
- **Multi-file transactions** (rename-over-temp, split WAL + data files) captured mid-step — restore has the rename but not the content, or vice versa.

Read-only mounting the volume in the backup container does **not** help: it only prevents the backup container from writing. The original writer keeps mutating the underlying filesystem.

Therefore the policy model exposes the operator's consistency choice explicitly, and the backup executor branches on it.

## Shape

New resource: `VolumeBackupPolicy`

```
VolumeBackupPolicy {
  volumeName
  schedule           (cron)
  retention
  enabled
  encryption
  quiesceMode:       'none' | 'fsfreeze' | 'stop-restart' | 'app-aware'
  preBackupCommand?:  string   // app-aware only
  postBackupCommand?: string   // app-aware only
}
```

`quiesceMode` has no default. The operator must pick it deliberately when creating the policy; the UI presents the trade-offs alongside each choice.

## Quiesce modes

Listed in increasing safety / cost order:

### `none`

Tar the volume live. Only safe when the operator *knows* the volume is idle or append-only (e.g. a write-once artifact cache, or a volume attached only to a stopped container). UI must show a prominent "inconsistent snapshot risk" warning on selection with a mandatory acknowledgement checkbox.

### `fsfreeze`

Call `fsfreeze -f` on the mount, tar, then `fsfreeze -u`. Brief I/O stall for the attached container, no container downtime. Only works on ext4 / xfs.

**Important caveat:** fsfreeze guarantees a crash-consistent on-disk snapshot, but does not flush in-memory dirty application state. Apps with their own write buffers (Postgres shared buffers, Redis unsaved dataset, application-level write-back caches) still need `app-aware` for a truly consistent snapshot — restoring from an fsfreeze snapshot of such an app is equivalent to recovering from an unclean shutdown.

### `stop-restart`

Stop the attached container(s), tar, restart. Simplest general-purpose safe option. Downtime proportional to tar duration — for large volumes, streaming to Azure during the stop window can be significant. A multi-service stack attached to the same volume requires all attached containers to be stopped, not just one.

### `app-aware`

Run `preBackupCommand` inside the running container (e.g. `pg_dumpall > /backup/dump.sql`, `redis-cli BGSAVE`, `sqlite3 db.sqlite '.backup /backup/db.bak'`), then tar either the whole volume or just the dump output, then run `postBackupCommand`. This is the same category as the existing PG backup pattern in [pg-az-backup/backup.sh](pg-az-backup/backup.sh), which is why PG backups don't suffer the live-tar problem.

This mode requires running a command inside a running container. No helper exists today on [DockerService](server/src/services/docker.ts) for this — it'll need adding (e.g. `DockerService.execInContainer()`), rather than calling dockerode's exec API directly, per the "never use raw dockerode calls" rule in `CLAUDE.md`.

## Implementation sketch

1. **Backup executor** — follow the shape of `BackupExecutorService` at [server/src/services/backup/backup-executor.ts](server/src/services/backup/backup-executor.ts) and the transient-container pattern at [server/src/services/volume/volume-inspector.ts](server/src/services/volume/volume-inspector.ts) (`performInspection`, ~lines 111–176): use `DockerExecutorService.executeContainer()` ([server/src/services/docker-executor/index.ts](server/src/services/docker-executor/index.ts)) with a small image (`alpine:3` or similar), `removeContainer: true`, and a volume bind.
   - Branch on `quiesceMode` at the top of the run: `fsfreeze` and `stop-restart` wrap the tar step; `app-aware` shells into the running container before and after; `none` goes straight to tar.
   - Stream the tar output to Azure via a SAS URL rather than `uploadStream`: call `AzureStorageService.generateBlobSasUrl(container, blob, expiryMinutes, 'write')` ([server/src/services/azure-storage-service.ts](server/src/services/azure-storage-service.ts)) and pass the signed URL into the transient container, which does `tar | curl -T <sas>` — same approach as [pg-az-backup/backup.sh:67](pg-az-backup/backup.sh:67). There is no `AzureStorageService.uploadStream()`.

2. **Restore** — reverse flow. Download blob, stream into a transient container that mounts the target volume RW and extracts. Restoring into a volume that's currently attached to a running container **refuses by default** — the operator must explicitly stop attached containers first (the UI can automate this as a one-click action with an explicit confirm). Add an "override" escape hatch for expert recoveries, but make it loud.
   - Restoring into a different volume name (clone) is useful for debugging — support from day one.

3. **Scheduling** — the existing PG backup scheduler lives in [server/src/services/backup/backup-scheduler.ts](server/src/services/backup/backup-scheduler.ts) (`BackupSchedulerService.registerSchedule`, node-cron). Decide at implementation time whether to generalise that scheduler to accept `VolumeBackupPolicy` too, or to stand up a sibling scheduler — generalising is DRYer but may bloat a currently-focused service. Not worth pre-deciding in the doc.

4. **Progress tracking** — add new `volume-backup` + `volume-restore` entries to the client task-type registry at [client/src/lib/task-type-registry.ts](client/src/lib/task-type-registry.ts), following the `cert-issuance` shape. Corresponding `VOLUME_BACKUP_*` / `VOLUME_RESTORE_*` Socket.IO events go in `lib/types/socket-events.ts`. Note: backup tasks (including PG backup) are **not** currently wired through the task tracker — volume backup will be the first. Worth considering retrofitting PG backup at the same time so the backup UX is consistent.

## Considerations

- **Size limits**: some volumes will be large. Stream tar output straight to blob via the SAS URL rather than staging on disk; monitor free space in the transient container. Chunked upload is handled by Azure-side block blob semantics — `curl -T` with a SAS URL for a block blob supports multi-block uploads up to the service limits.
- **Encryption at rest**: Azure blob server-side encryption is a storage-account setting, not a per-upload flag — it applies automatically. For operator-held encryption, add optional client-side encryption with a key derived from the operator passphrase (same passphrase pattern as SecretsVault unseal).
- **Retention**: mirror `PostgresBackup` retention policy — keep N most recent, or T days, or both.

## UI

- **Policy-creation form**: mode picker showing a consistency × downtime matrix inline, so operators see the trade-off when they choose.
- **`quiesceMode: 'none'` selection**: mandatory confirmation checkbox acknowledging inconsistent-snapshot risk.
- **`quiesceMode: 'stop-restart'` selection**: show estimated downtime range based on volume size and recent observed tar throughput.
- **Volume detail page**: a "Backups" tab showing policy + recent backups. If an active policy uses `quiesceMode: 'none'`, show a persistent warning badge.
- **Volumes list**: status badge for "backed up" / "no policy".
- **Restore dialog**: blast-radius warning, refuses by default when the volume is attached, explicit stop-attached-containers action to proceed.

## Dependencies

- Azure storage already configured (existing `ConfigurationServiceFactory` support).
- New `DockerService.execInContainer()` helper required for `app-aware` quiesce mode.
- No dependency on SecretsVault.
