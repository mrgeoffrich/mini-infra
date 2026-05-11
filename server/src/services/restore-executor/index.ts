/**
 * Restore-executor module — Phase 5 (MINI-54) remainder.
 *
 * Pre-Phase-5 this directory hosted a bespoke `RestoreExecutorService` with
 * an in-memory queue, a `RestoreRunner` doing the full Docker spawn flow,
 * a `RollbackManager` for pre-restore backups, and per-restore retry
 * configuration. All of that is gone — the JobPool framework
 * (`server/src/services/stacks/job-pool-*.ts`) owns the spawn lifecycle now,
 * driven by the `restore-executor` system template's manual HTTP trigger.
 *
 * What's left:
 *   - `BackupValidator` — server-side pre-flight check that the requested
 *     backup file exists, has plausible size, and (optionally) matches the
 *     target database id. Run from the route handler before spawning so
 *     bad requests return 400 with no container.
 *   - `parseBackupUrl` / `extractContainerFromUrl` / `extractBlobNameFromUrl`
 *     — small URL parsers shared between the validator, the materialiser,
 *     and the route's request schema.
 *   - `installRestoreRuntimeEnvResolver` — registers the apply-time runtime
 *     env resolver that mints per-run env (`POSTGRES_*`, sidecar download
 *     env, `RESTORE=yes`) and creates the `RestoreOperation` row before
 *     spawn. Mirrors `installPgBackupRuntimeEnvResolver` from Phase 4.
 *
 * The rollback-before-restore safety net the pre-Phase-5 runner provided is
 * NOT reimplemented here. Operators wanting that should take a manual
 * backup via the Backups page before triggering a restore — same workflow
 * the JobPool framework supports for any one-shot job.
 */

export { BackupValidator } from "./backup-validator";
export {
  parseBackupUrl,
  extractContainerFromUrl,
  extractBlobNameFromUrl,
} from "./utils";
export {
  installRestoreRuntimeEnvResolver,
  RESTORE_EXECUTOR_SERVICE_NAME,
  RESTORE_EXECUTOR_TEMPLATE_NAME,
} from "./restore-job-pool-materialiser";
