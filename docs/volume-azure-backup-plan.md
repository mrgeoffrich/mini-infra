# Docker volume backups to Azure Blob (deferred)

A standalone feature, separate from SecretsVault. Mini-infra already has the PostgreSQL + Azure backup pattern; this generalises it to arbitrary Docker volumes.

## Goal

Operators can pick any Docker volume managed by mini-infra, schedule recurring encrypted backups to Azure Blob, and restore from a previous snapshot on demand.

## Shape

- New resource: `VolumeBackupPolicy` — `{ volumeName, schedule (cron), retention, enabled, encryption }`.
- Reuse `AzureStorageService` (already wired for PG backups).
- Reuse the backup executor pattern (`server/src/services/backup/` + `restore-executor/`) — probably a new `VolumeBackupExecutor` that follows the same shape as `PostgresBackupExecutor`.

## Implementation sketch

1. **Backup**: spin a transient container (e.g. `alpine:3`) that mounts the target volume read-only, tars + compresses contents, streams to stdout. Pipe into `AzureStorageService.uploadStream()` with server-side encryption enabled. Chunked upload for large volumes.
2. **Restore**: reverse flow — download blob, stream into a transient container that mounts the target volume RW and extracts. Warn if the volume is currently attached to a running container (require explicit override / stop first).
3. **Scheduling**: reuse the existing cron scheduler used by PG backups.
4. **Progress tracking**: new `VOLUME_BACKUP_*` Socket.IO events + task type registry entry, same pattern as existing long-running ops.

## Considerations

- **Volume-in-use safety**: for stateful services, a live tar is racy. Option to quiesce — stop container → snapshot → restart. Note this in the UI.
- **Size limits**: some volumes will be large. Stream to blob rather than staging on disk; monitor free space.
- **Encryption at rest**: Azure blob server-side encryption by default; add optional client-side encryption with a key derived from the operator passphrase (same passphrase pattern as SecretsVault unseal).
- **Retention**: mirror `PostgresBackup` retention policy — keep N most recent or T days.
- **Restore target**: restoring into a different volume name (clone) is useful for debugging — worth supporting from day one.

## UI

- New "Backups" tab on the volume detail page, showing policy + recent backups.
- List view on the Volumes page: status badge for "backed up" / "no policy".
- Restore dialog with blast-radius warning when the volume is attached.

## Dependencies

- Azure storage already configured (existing `ConfigurationServiceFactory` support).
- No dependency on SecretsVault.
