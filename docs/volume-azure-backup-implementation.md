# Docker volume backups to Azure Blob — implementation plan

Companion to [volume-azure-backup-plan.md](volume-azure-backup-plan.md). That document covers the design rationale — why consistency is the central axis and what the UX looks like. This document is the concrete build spec: schema, events, routes, executor, UI, and phasing.

## MVP scope

**In scope for v1:**

- `VolumeBackupPolicy` resource (schedule, retention, quiesce mode) per Docker volume.
- Backup executor supporting `none`, `stop-restart`, and `app-aware` quiesce modes.
- Restore executor with mandatory stop-attached-containers before restore.
- Task-tracker integration for both backup and restore.
- Retention cleanup (by count, by age, or both).
- Encrypted at rest via Azure server-side encryption (no client-side encryption in v1).

**Deferred:**

- **`fsfreeze` mode.** Works in theory but is non-trivial on Docker: `fsfreeze` operates on a mount point, and for a Docker named volume the underlying filesystem is typically the host root filesystem — freezing it would freeze the entire host. Viable only with a dedicated filesystem per volume (not the default). Ship the three viable modes first and revisit fsfreeze once operators ask for it.
- **Client-side encryption.** Mentioned in the design doc as a passphrase-derived key. Out of MVP to keep scope tight.
- **Restore to a different volume name (clone).** Design doc calls this useful for debugging — agreed, but punt to v2. Implementation is straightforward once restore works.
- **Retrofitting PG backup onto the task tracker.** Worth doing eventually for UX consistency; not in this feature's scope.

## Data model

Two new Prisma models in [server/prisma/schema.prisma](server/prisma/schema.prisma), following existing backup-model conventions (cuid ids, camelCase fields, `@@map` to snake_case table names, cascade deletes on relations).

```prisma
model VolumeBackupPolicy {
  id                 String             @id @default(cuid())
  volumeName         String             @unique
  schedule           String             // cron expression
  timezone           String             @default("UTC")
  azureContainerName String
  azurePathPrefix    String
  retentionCount     Int?               // keep N most recent
  retentionDays      Int?               // keep T days (at least one of count/days required at the app layer)
  isEnabled          Boolean            @default(true)
  quiesceMode        VolumeQuiesceMode
  preBackupCommand   String?            // app-aware only
  postBackupCommand  String?            // app-aware only
  appAwareContainer  String?            // container name for exec, app-aware only
  lastBackupAt       DateTime?
  nextScheduledAt    DateTime?
  createdAt          DateTime           @default(now())
  updatedAt          DateTime           @updatedAt

  backups            VolumeBackupOperation[]

  @@index([volumeName])
  @@map("volume_backup_policies")
}

model VolumeBackupOperation {
  id             String             @id @default(cuid())
  policyId       String
  policy         VolumeBackupPolicy @relation(fields: [policyId], references: [id], onDelete: Cascade)
  operationType  String             // 'manual' | 'scheduled' | 'restore'
  status         String             // 'pending' | 'running' | 'completed' | 'failed'
  quiesceMode    VolumeQuiesceMode  // captured at run time — policy may change later
  startedAt      DateTime           @default(now())
  completedAt    DateTime?
  sizeBytes      BigInt?
  azureBlobUrl   String?
  errorMessage   String?
  progress       Int                @default(0)
  triggeredBy    String?            // userId for manual, null for scheduled
  metadata       String?            // JSON — e.g. container IDs stopped during stop-restart

  @@index([policyId, status])
  @@index([startedAt])
  @@map("volume_backup_operations")
}

enum VolumeQuiesceMode {
  NONE
  STOP_RESTART
  APP_AWARE
  // FSFREEZE deferred
}
```

**Notes:**

- Use a native Prisma enum for `quiesceMode` even though `BackupOperation.status` uses `String` — for a small fixed set with safety implications, the type safety is worth the minor inconsistency.
- `quiesceMode` is denormalised onto each operation so historical runs retain their mode even if the policy is later edited.
- `metadata` is a JSON string (following existing `BackupOperation.metadata` pattern). Used by `stop-restart` mode to record which containers were stopped, for resumable rollback on executor crash.

Migration: `npx -w server prisma migrate dev --name add_volume_backups`.

## Socket.IO events

Additions to [lib/types/socket-events.ts](lib/types/socket-events.ts). Event name format matches the existing `cert:issuance:*` convention (colon-delimited, past-tense for lifecycle events).

```ts
// Add to ServerEvent:
VOLUME_BACKUP_STARTED:    "volume-backup:operation:started",
VOLUME_BACKUP_STEP:       "volume-backup:operation:step",
VOLUME_BACKUP_COMPLETED:  "volume-backup:operation:completed",
VOLUME_RESTORE_STARTED:   "volume-restore:operation:started",
VOLUME_RESTORE_STEP:      "volume-restore:operation:step",
VOLUME_RESTORE_COMPLETED: "volume-restore:operation:completed",
```

`Channel.VOLUMES` already exists — reuse it.

Payload shapes mirror `CERT_ISSUANCE_*`:

```ts
type VolumeBackupStartedPayload   = { operationId: string; volumeName: string; totalSteps: number; stepNames: string[]; quiesceMode: VolumeQuiesceMode; };
type VolumeBackupStepPayload      = { operationId: string; volumeName: string; step: { index: number; name: string; status: 'running' | 'done' | 'failed'; detail?: string; } };
type VolumeBackupCompletedPayload = { operationId: string; volumeName: string; success: boolean; steps: StepRecord[]; errors: string[]; sizeBytes?: number; };
```

## Permissions

Add a new `volume-backups` domain in [lib/types/permissions.ts](lib/types/permissions.ts) rather than overloading the existing `backups` (PG-backup-scoped) or `docker` (volume-CRUD-scoped) domains. Backups have meaningfully different write surfaces (trigger, restore) that deserve their own scopes.

```ts
export type PermissionDomain =
  | "containers" | "docker" | "environments" | "haproxy" | "postgres" | "tls"
  | "settings" | "events" | "api-keys" | "user" | "agent" | "backups"
  | "monitoring" | "registry" | "stacks"
  | "volume-backups";   // new

// New scopes
"volume-backups:read"     // list/view policies + operation history
"volume-backups:write"    // create/update/delete policies
"volume-backups:trigger"  // kick off a manual backup
"volume-backups:restore"  // kick off a restore (destructive — separate scope from write)
```

Preset additions:

- **Reader**: `volume-backups:read`
- **Editor**: `volume-backups:read`, `volume-backups:write`, `volume-backups:trigger`
- **Admin**: `*` already covers it

Restore is intentionally admin-only in the default presets because it's destructive and may involve stopping running containers.

## REST API

New route file: [server/src/routes/volume-backups.ts](server/src/routes/volume-backups.ts), mounted under `/api/docker/volumes/:volumeName/backup-*` to keep the URL tree consistent with existing `/api/docker/volumes` routes.

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| GET    | `/api/docker/volumes/:volumeName/backup-policy` | `volume-backups:read` | Get policy, or 404 if none |
| POST   | `/api/docker/volumes/:volumeName/backup-policy` | `volume-backups:write` | Create or replace policy |
| PATCH  | `/api/docker/volumes/:volumeName/backup-policy` | `volume-backups:write` | Partial update |
| DELETE | `/api/docker/volumes/:volumeName/backup-policy` | `volume-backups:write` | Delete policy (cascades to operations) |
| POST   | `/api/docker/volumes/:volumeName/backup-policy/trigger` | `volume-backups:trigger` | Run a backup now |
| GET    | `/api/docker/volumes/:volumeName/backups` | `volume-backups:read` | List backup operations |
| DELETE | `/api/docker/volumes/:volumeName/backups/:operationId` | `volume-backups:write` | Delete a single backup (blob + row) |
| POST   | `/api/docker/volumes/:volumeName/backups/:operationId/restore` | `volume-backups:restore` | Kick off restore |

Validation via `zod` (the repo's standard pattern — see existing routes that use zod-openapi). Follow [server/src/routes/docker.ts](server/src/routes/docker.ts) for the `requirePermission('<scope>')` middleware pattern.

Key request bodies:

```ts
// POST /backup-policy
{
  schedule: string,                   // cron
  timezone?: string,                  // default "UTC"
  azureContainerName: string,
  azurePathPrefix: string,
  retentionCount?: number,
  retentionDays?: number,             // at least one of count/days required (zod refine)
  isEnabled?: boolean,
  quiesceMode: 'NONE' | 'STOP_RESTART' | 'APP_AWARE',
  preBackupCommand?: string,          // required when quiesceMode === 'APP_AWARE'
  postBackupCommand?: string,
  appAwareContainer?: string,         // required when quiesceMode === 'APP_AWARE'
  ackInconsistentRiskForNone?: boolean, // required when quiesceMode === 'NONE'
}

// POST /backups/:operationId/restore
{
  stopAttachedContainers: boolean,    // must be true if volume is attached, else 409
  confirmOverwrite: boolean,          // must be true (destructive)
}
```

Refuse `quiesceMode: 'NONE'` without `ackInconsistentRiskForNone: true` at the API layer, not just the UI — prevents API-key-based misuse.

## Server executor

New service: [server/src/services/volume-backup/](server/src/services/volume-backup/) with files:

- `index.ts` — `VolumeBackupExecutorService` (public entry)
- `backup-runner.ts` — per-mode backup logic
- `restore-runner.ts` — restore logic
- `socket-emitter.ts` — emits `VOLUME_BACKUP_*` events, mirrors `container-socket-emitter.ts`
- `retention-cleaner.ts` — prunes old operations + blobs
- `__tests__/` — vitest files

### `VolumeBackupExecutorService.runBackup(policyId, trigger)`

```
1. Create VolumeBackupOperation row (status=running, quiesceMode frozen from policy)
2. Emit VOLUME_BACKUP_STARTED with plannedStepNames derived from quiesceMode
3. Resolve attached containers via DockerService.listContainers({ filters: { volume: [volumeName] } })
4. Branch on quiesceMode (see below). Each branch is wrapped in try/finally for cleanup.
5. Update operation row (status=completed|failed, sizeBytes, azureBlobUrl)
6. Emit VOLUME_BACKUP_COMPLETED
7. Enqueue a retention sweep for this policy
```

### Mode: `NONE`

Planned steps: `["Snapshot volume", "Upload to Azure"]`

```
1. Call AzureStorageService.generateBlobSasUrl(container, blob, 60, 'write')
2. DockerExecutorService.executeContainer({
     image: 'alpine:3',
     cmd: ['sh', '-c', 'apk add --no-cache curl tar >/dev/null && cd /volume && tar czf - . | curl -sS -T - -H "x-ms-blob-type: BlockBlob" "$SAS_URL"'],
     env: { SAS_URL: sasUrl },
     binds: [`${volumeName}:/volume:ro`],
     removeContainer: true,
     outputHandler: stream => pipeToTaskLog(stream, operationId),
     timeout: 6 * 60 * 60 * 1000,  // 6h
   })
3. Verify blob exists via AzureStorageService.getBlobProperties; populate sizeBytes
```

SAS expiry 60 min (current PG backup uses 15 min — too short for large volumes). Make this configurable per-policy in a future iteration if needed.

### Mode: `STOP_RESTART`

Planned steps: `["Stop attached containers", "Snapshot volume", "Upload to Azure", "Restart containers"]`

```
try:
  stopped = []
  for c in attachedContainers:
    record c.state (running / paused / exited); append to stopped[]
    emit step ("Stopping container <name>")
    DockerService.stopContainer(c.id, { timeout: 30 })
  persist stopped[] into operation.metadata    # allows manual rollback on crash
  run the NONE flow (tar + upload)
finally:
  for c in reverse(stopped):
    if c was running before:
      emit step ("Restarting container <name>")
      DockerService.startContainer(c.id)
```

**Stack-interaction risk** — if a stack's reconciler runs while containers are stopped for backup it may see drift and try to restart them mid-tar. Before merging, verify either (a) the reconciler schedule is infrequent enough that the stop window is safe, or (b) add a "backup-in-progress" lock checked by [server/src/services/stacks/stack-reconciler.ts](server/src/services/stacks/stack-reconciler.ts). Current expectation: (b) is required. Implement as a simple in-memory `Set<volumeName>` protected by a lock, exposed via a `BackupLockService`.

### Mode: `APP_AWARE`

Planned steps: `["Run pre-backup command", "Snapshot volume", "Upload to Azure", "Run post-backup command"]`

Requires a new helper — see [`DockerService.execInContainer`](#new-dockerserviceexecincontainer-helper) below.

```
1. DockerService.execInContainer(policy.appAwareContainer, ['sh', '-c', policy.preBackupCommand], { timeoutMs: 30 * 60 * 1000 })
   - Fail the whole backup if exit code != 0
2. Run the NONE flow (the pre-command should have written a consistent snapshot to the volume)
3. try: DockerService.execInContainer(policy.appAwareContainer, ['sh', '-c', policy.postBackupCommand])
   except: log but don't fail the backup — post-command is cleanup
```

Enforce in the API: `appAwareContainer` must be currently attached to `volumeName` at policy-creation time. Re-validate at run time — if the container is gone, mark the operation failed with a clear error.

### Restore flow

Planned steps: `["Stop attached containers", "Download from Azure", "Extract to volume", "Restart containers"]`

```
1. Refuse if volume has attached running containers AND stopAttachedContainers=false (return 409)
2. Stop containers (as in STOP_RESTART)
3. Call generateBlobSasUrl(..., mode='read')
4. DockerExecutorService.executeContainer({
     image: 'alpine:3',
     cmd: ['sh', '-c', 'apk add --no-cache curl tar >/dev/null && cd /volume && find . -mindepth 1 -delete && curl -sS "$SAS_URL" | tar xzf -'],
     env: { SAS_URL: sasUrl },
     binds: [`${volumeName}:/volume:rw`],
     removeContainer: true,
     timeout: 6 * 60 * 60 * 1000,
   })
5. Restart containers
```

The `find . -mindepth 1 -delete` before extraction is intentional — a partial-overlay restore would leave stale files from the current volume state mixed with restored files. If the operator wants a merge, do it at the application level.

## Scheduler + retention

Two options:

1. **Extend** [server/src/services/backup/backup-scheduler.ts](server/src/services/backup/backup-scheduler.ts)'s `BackupSchedulerService` to be resource-agnostic.
2. **Add a parallel** `VolumeBackupSchedulerService` in `server/src/services/volume-backup/scheduler.ts`.

**Recommendation: option 2 for v1, with a refactor to extract a shared `CronRegistry` in v2.** Option 1 is DRYer but requires reworking the PG scheduler's tight coupling to `BackupConfiguration` — risky during this feature's rollout. Flag the refactor as follow-up work.

`VolumeBackupSchedulerService` responsibilities:

- On server start, load all enabled policies and register their cron jobs via `node-cron`.
- On policy create / update / delete, refresh the in-memory cron registration.
- On cron fire, call `VolumeBackupExecutorService.runBackup(policyId, 'scheduled')`.

### Retention cleanup

New: `retention-cleaner.ts`.

```
async sweep(policy):
  cutoffByDate  = policy.retentionDays ? now - policy.retentionDays*86400000 : null
  keepByCount   = policy.retentionCount
  ops = query VolumeBackupOperation
    where policyId=policy.id and status='completed'
    order by startedAt desc
  toDelete = []
  if keepByCount: toDelete.push(...ops.slice(keepByCount))
  if cutoffByDate: toDelete.push(...ops.filter(o => o.startedAt < cutoffByDate))
  toDelete = unique(toDelete)
  for op in toDelete:
    AzureStorageService.deleteBlob(op.azureBlobUrl)
    prisma.volumeBackupOperation.delete({ where: { id: op.id } })
```

Run sweep after each successful backup (in-line, same process) rather than on a separate schedule — simplest and sufficient for volumes that back up on a cron. For disabled policies with stale retention, add a one-off endpoint `POST /api/docker/volumes/:volumeName/backup-policy/sweep` for operator triggering.

## Client task-type registry

Additions to [client/src/lib/task-type-registry.ts](client/src/lib/task-type-registry.ts):

```ts
"volume-backup": defineTaskTypeConfig({
  channel: Channel.VOLUMES,
  startedEvent: ServerEvent.VOLUME_BACKUP_STARTED,
  stepEvent: ServerEvent.VOLUME_BACKUP_STEP,
  completedEvent: ServerEvent.VOLUME_BACKUP_COMPLETED,
  getId: (p) => p.operationId,
  normalizeStarted: (p) => ({ totalSteps: p.totalSteps, plannedStepNames: p.stepNames ?? [] }),
  normalizeStep: (p) => p.step,
  normalizeCompleted: (p) => ({ success: p.success, steps: p.steps, errors: p.errors }),
  invalidateKeys: () => [["volumes"], ["volume-backups"]],
}),
"volume-restore": defineTaskTypeConfig({
  channel: Channel.VOLUMES,
  startedEvent: ServerEvent.VOLUME_RESTORE_STARTED,
  stepEvent: ServerEvent.VOLUME_RESTORE_STEP,
  completedEvent: ServerEvent.VOLUME_RESTORE_COMPLETED,
  getId: (p) => p.operationId,
  normalizeStarted: (p) => ({ totalSteps: p.totalSteps, plannedStepNames: p.stepNames ?? [] }),
  normalizeStep: (p) => p.step,
  normalizeCompleted: (p) => ({ success: p.success, steps: p.steps, errors: p.errors }),
  invalidateKeys: () => [["volumes"], ["volume-backups"], ["containers"]],
}),
```

Client hooks (new):

- `client/src/hooks/useVolumeBackupPolicy.ts` — TanStack Query CRUD.
- `client/src/hooks/useVolumeBackups.ts` — list + socket-subscribed invalidation (pattern: `useContainers.ts`).
- `client/src/hooks/useTriggerVolumeBackup.ts` — mutation that calls the task tracker.

## UI

New components under `client/src/components/volume-backups/`:

- `VolumeBackupsTab.tsx` — renders inside the existing volume detail page as a new tab. Shows: current policy summary, "Backups" table, "Create policy" / "Edit policy" button, "Run backup now" button.
- `VolumeBackupPolicyDialog.tsx` — create/edit form. Validates mode-specific required fields via zod.
- `QuiesceModePicker.tsx` — radio-group with an inline trade-off matrix:

  | Mode | Downtime | Consistency | When to use |
  |------|----------|-------------|-------------|
  | None | None | **Risky — can capture corrupt data** | Idle/append-only volumes only |
  | Stop-restart | ~tar duration | Full | Any volume, simplest safe option |
  | App-aware | None (brief I/O) | Full (with correct command) | Databases with dump tooling |

- `VolumeBackupsTable.tsx` — operations history with status, size, duration, "Restore" action.
- `VolumeRestoreDialog.tsx` — shows attached-container list, requires explicit "Stop containers and restore" confirmation.
- `VolumeBackupBadge.tsx` — badge for volumes list: `backed-up` / `no-policy` / `risky-policy` (quiesce=none).

Routes: no new top-level routes. The volume detail page already exists; add a tab.

Data-tour attributes: add `data-tour="volume-backup-policy-button"`, `data-tour="volume-backup-trigger"`, `data-tour="volume-restore-button"` so the agent sidecar can guide operators. Run `npm run generate:ui-manifest` after.

## New `DockerService.execInContainer` helper

Required by `app-aware` mode. Per repo convention ("never use raw dockerode calls"), add to [server/src/services/docker.ts](server/src/services/docker.ts):

```ts
async execInContainer(
  containerId: string,
  cmd: string[],
  options: {
    timeoutMs?: number;
    user?: string;
    workdir?: string;
    env?: Record<string, string>;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // 1. container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, User, WorkingDir, Env })
  // 2. exec.start({ hijack: true, stdin: false }) -> Duplex stream
  // 3. demux via modem.demuxStream -> stdout/stderr buffers
  // 4. enforce timeoutMs (abort + stream.destroy)
  // 5. exec.inspect() -> ExitCode
  // 6. return { exitCode, stdout, stderr }
}
```

Redact stdout/stderr in logs for `app-aware` runs (commands may contain credentials). Write a unit test that round-trips a command against a running container from the test fixture — see existing `DockerService` tests for the pattern.

## Testing

### Server

- `volume-backup-executor.test.ts` — one test per quiesce mode. Use the real dockerode test pattern from `volume-inspector` tests (if available) or mock `DockerExecutorService.executeContainer` and assert the right args/binds/commands.
- `volume-backup-executor.rollback.test.ts` — simulate tar failure during `STOP_RESTART` and assert containers are restarted in the finally block.
- `volume-restore.test.ts` — refuses when attached + `stopAttachedContainers=false`; succeeds with explicit stop; verifies `find -delete` happens before extract.
- `volume-backup-scheduler.test.ts` — cron registration on policy create/update/delete; retention cleanup invoked post-backup.
- `docker-service-exec.test.ts` — new `execInContainer` helper; exit codes, timeout, redaction.
- Route tests: permission gating for each endpoint; the `quiesceMode=NONE` + `ackInconsistentRiskForNone=false` 400 case; restore 409 when attached.

### Client

- `QuiesceModePicker.test.tsx` — mandatory ack checkbox appears only for NONE; disables submit until ticked.
- `VolumeRestoreDialog.test.tsx` — warning + attached-container list render; submit disabled until confirms present.
- `task-type-registry.test.ts` — extend existing if any; confirm the two new entries normalize payloads correctly.

### Manual / dev-loop

After each backend change, `deployment/development/worktree_start.sh` then use the `test-dev` skill to drive the UI. Specifically exercise:

1. Create a policy with each quiesce mode; verify validation messages.
2. Trigger a manual backup; watch the task tracker stream all steps.
3. Kill the server mid-backup during `STOP_RESTART` → restart server → verify containers come back up from `operation.metadata`.
4. Restore into an attached volume without stop → expect 409.
5. Restore with stop → volume populated, containers running again.

## Migration + rollout

- Single Prisma migration (`add_volume_backups`).
- No feature flag. Feature is gated by permission scopes — users without `volume-backups:*` see no UI.
- Azure container — reuse the configured Azure storage account (via `ConfigurationServiceFactory`). No new connected-service setup.
- No data migration needed (net-new tables).

## Files touched (summary)

New:

- `server/prisma/migrations/<timestamp>_add_volume_backups/migration.sql`
- `server/src/services/volume-backup/index.ts`
- `server/src/services/volume-backup/backup-runner.ts`
- `server/src/services/volume-backup/restore-runner.ts`
- `server/src/services/volume-backup/scheduler.ts`
- `server/src/services/volume-backup/retention-cleaner.ts`
- `server/src/services/volume-backup/socket-emitter.ts`
- `server/src/services/volume-backup/__tests__/*.test.ts`
- `server/src/services/backup-lock-service.ts` (shared with reconciler)
- `server/src/routes/volume-backups.ts`
- `client/src/hooks/useVolumeBackupPolicy.ts`
- `client/src/hooks/useVolumeBackups.ts`
- `client/src/hooks/useTriggerVolumeBackup.ts`
- `client/src/components/volume-backups/*.tsx`

Modified:

- `server/prisma/schema.prisma` — two new models + enum
- `lib/types/socket-events.ts` — six new `ServerEvent` entries + payload types
- `lib/types/permissions.ts` — new domain + four scopes + preset additions
- `server/src/services/docker.ts` — new `execInContainer` helper
- `server/src/services/stacks/stack-reconciler.ts` — consult `BackupLockService` before reconciling a volume's attached containers
- `server/src/index.ts` (or wherever schedulers boot) — start `VolumeBackupSchedulerService`
- `client/src/lib/task-type-registry.ts` — two new entries
- `client/src/components/volumes/VolumeDetail.tsx` (or equivalent) — add Backups tab
- `client/src/user-docs/ui-elements/manifest.json` — regenerated

## Open questions

1. **Stack reconciler interaction (high priority).** Confirm before implementation starts: does the reconciler actually try to restart containers that were deliberately stopped? If yes, `BackupLockService` is required and the scope needs adjusting. Mitigation is easy; surprise mid-implementation is not.
2. **SAS URL expiry.** 60 min is a guess. For a 500 GB volume at 50 MB/s upload that's 2.8 hours — expiry would blow. Consider renewable SAS or a longer default (6h?) with an operator override.
3. **App-aware on multi-container attached volumes.** Current design makes the operator pick one container via `appAwareContainer`. Is that always right? Stack-managed volumes might imply the "primary" service; worth a policy-creation hint that reads the stack.
4. **Audit trail.** `BackupOperation.triggeredBy` captures userId for manual runs. Should we also emit `events` (the audit log resource) for backup/restore? Feels yes, but confirm with existing conventions.

## Phased delivery

Rough cut if the work needs splitting across PRs:

1. **PR 1 — Schema + basic executor + `NONE` mode.** Ship end-to-end for the trivial case; no scheduler, manual trigger only via API. Validates the plumbing.
2. **PR 2 — `STOP_RESTART` + `BackupLockService` + reconciler integration.** The first interesting mode.
3. **PR 3 — `APP_AWARE` + `DockerService.execInContainer`.**
4. **PR 4 — Scheduler + retention.** Moves from manual-trigger to autonomous.
5. **PR 5 — Restore executor.**
6. **PR 6 — UI.** Done last so each backend piece can be dogfooded via API/curl as it lands.

Each PR is independently mergeable and each adds a discrete user-visible capability from PR 2 onward.
