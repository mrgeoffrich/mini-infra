/**
 * Apply-time materialiser for the `restore-executor` JobPool template.
 *
 * Phase 5 (MINI-54) converts restore-executor from a bespoke executor + queue
 * + rollback-manager into a JobPool service. Unlike pg-az-backup (Phase 4)
 * which has both cron + nats-request triggers driven by `BackupConfiguration`
 * rows, restore is **manual-only** — each restore is initiated by a UI click
 * with one-shot parameters that don't make sense to mint-once-at-apply.
 *
 * The template declares an empty `triggers[]`; the manual HTTP route is
 * always available regardless. So there's no equivalent of
 * `buildTriggersFromBackupConfigurations` here — only the runtime env
 * resolver. The materialiser still exists as a module to mirror the Phase 4
 * shape and to centralise the resolver-install entry point.
 *
 * On each manual trigger, the resolver:
 *   1. Reads `JOB_PAYLOAD` (the body POSTed to the manual HTTP route),
 *      validates it has `databaseId` + `backupUrl`.
 *   2. Creates the `RestoreOperation` DB row up-front so the legacy listing
 *      UIs keep working. The row's `id` becomes the JobPool `runId`.
 *   3. Looks up the target database, mints a per-run download SAS handle,
 *      assembles `POSTGRES_*` + `STORAGE_PROVIDER`-specific env + `RESTORE=yes`,
 *      and hands it back to the spawner.
 *
 * Pre-flight validation (file exists, plausible size, optional db-id match)
 * runs **server-side at the HTTP route** via `BackupValidator.validateBackupFile()`
 * — failures there return 400 with no container spawn. The resolver itself
 * stays focused on per-run env assembly and DB-row bookkeeping.
 */

import { getLogger } from "../../lib/logger-factory";
import { PostgresDatabaseManager } from "../postgres";
import { StorageService } from "../storage/storage-service";
import { buildSidecarDownloadEnv } from "../backup/sidecar-env";
import {
  jobPoolRuntimeEnvResolvers,
  type JobPoolRuntimeEnvResolver,
} from "../stacks/job-pool-runtime-env-resolver";
import { extractBlobNameFromUrl, extractContainerFromUrl } from "./utils";

const log = getLogger("backup", "restore-job-pool-materialiser");

/** Service name the restore-executor template uses for its single JobPool service. */
export const RESTORE_EXECUTOR_SERVICE_NAME = "restore-executor";
/** Template name on disk (`server/templates/restore-executor`). */
export const RESTORE_EXECUTOR_TEMPLATE_NAME = "restore-executor";

/**
 * Build the per-run runtime env resolver for the restore-executor JobPool.
 *
 * Behaviour:
 *   - Only invoked for `manual` triggers (the template declares no other
 *     trigger kinds). If a future cron / nats-request trigger appears, the
 *     resolver still works as long as the trigger payload carries
 *     `databaseId` + `backupUrl`.
 *   - Creates the `RestoreOperation` row before spawn so the existing UI list
 *     query keeps showing pending → running → completed.
 *   - Mints a per-run download handle (SAS URL for Azure, OAuth token bundle
 *     for Drive) via the active StorageBackend. TTL matches
 *     `killAfterSeconds` (10800s = 3h) plus 15 min margin.
 */
function buildRestoreRuntimeEnvResolver(): JobPoolRuntimeEnvResolver {
  return async (prisma, _dockerExecutor, ctx) => {
    const payload = (ctx.payload ?? {}) as {
      databaseId?: string;
      backupUrl?: string;
      targetDatabaseName?: string;
      userId?: string;
    };

    if (!payload.databaseId) {
      return {
        env: {},
        error: "restore-executor runtime env resolver: missing databaseId in payload",
      };
    }
    if (!payload.backupUrl) {
      return {
        env: {},
        error: "restore-executor runtime env resolver: missing backupUrl in payload",
      };
    }

    const { databaseId, backupUrl, targetDatabaseName } = payload;

    const databaseConfigService = new PostgresDatabaseManager(prisma);
    const database = await databaseConfigService.getDatabaseById(databaseId);
    if (!database) {
      return {
        env: {},
        error: `restore-executor runtime env resolver: database ${databaseId} not found`,
      };
    }

    const baseConnectionConfig = await databaseConfigService.getConnectionConfig(databaseId);
    const connectionConfig = {
      ...baseConnectionConfig,
      database: targetDatabaseName || baseConnectionConfig.database,
    };

    // Backend resolution mirrors the pre-Phase-5 logic in
    // `RestoreExecutorService.resolveBackendForRestore` — prefer the provider
    // the originating BackupOperation row was created under, fall back to the
    // active backend. The originating row lookup is best-effort; rollback
    // URLs and ad-hoc restores both legitimately have no row.
    const storageService = StorageService.getInstance(prisma);
    let storageBackend = await storageService.getActiveBackend();
    try {
      const ownerRow = await prisma.backupOperation.findFirst({
        where: { storageObjectUrl: backupUrl },
        select: { storageProviderAtCreation: true },
      });
      if (ownerRow?.storageProviderAtCreation) {
        storageBackend = await storageService.getBackendByProviderIdOrThrow(
          ownerRow.storageProviderAtCreation as Parameters<
            typeof storageService.getBackendByProviderIdOrThrow
          >[0],
        );
      }
    } catch (err) {
      log.warn(
        { backupUrl, err: err instanceof Error ? err.message : String(err) },
        "restore-executor: failed to resolve owning backend; falling back to active",
      );
    }

    // Create the RestoreOperation row up front. The runId == operation.id so
    // the JobPool history events and any in-container progress publishes
    // share one identifier with the row the UI is polling.
    const restoreOperation = await prisma.restoreOperation.create({
      data: {
        databaseId,
        backupUrl,
        status: "pending",
        progress: 0,
      },
    });
    const operationId = restoreOperation.id;

    // Mint the download handle for the container. The container reads
    // `STORAGE_PROVIDER` + provider-specific env (AZURE_SAS_URL for azure,
    // GDRIVE_* for drive) and downloads the backup blob itself — same path
    // the pre-Phase-5 server-spawned container used.
    const blobName = extractBlobNameFromUrl(backupUrl);
    const containerName = extractContainerFromUrl(backupUrl);
    const ttlMinutes = Math.ceil(10800 / 60) + 15; // matches killAfterSeconds + 15 min margin

    let sidecarEnv;
    try {
      sidecarEnv = await buildSidecarDownloadEnv(
        storageBackend,
        { id: containerName },
        blobName,
        ttlMinutes,
      );
    } catch (err) {
      await prisma.restoreOperation
        .update({
          where: { id: operationId },
          data: {
            status: "failed",
            errorMessage: `Failed to mint download handle: ${err instanceof Error ? err.message : String(err)}`,
            completedAt: new Date(),
          },
        })
        .catch(() => {
          /* logged downstream */
        });
      return {
        env: {},
        error: `restore-executor runtime env resolver: failed to mint download handle (${err instanceof Error ? err.message : String(err)})`,
        runIdOverride: operationId,
      };
    }

    if (!sidecarEnv) {
      await prisma.restoreOperation
        .update({
          where: { id: operationId },
          data: {
            status: "failed",
            errorMessage: `Restore container could not get a download handle from provider '${storageBackend.providerId}'`,
            completedAt: new Date(),
          },
        })
        .catch(() => {
          /* logged downstream */
        });
      return {
        env: {},
        error: `restore-executor runtime env resolver: provider '${storageBackend.providerId}' did not return a download handle`,
        runIdOverride: operationId,
      };
    }

    const env: Record<string, string> = {
      POSTGRES_HOST: connectionConfig.host,
      POSTGRES_PORT: String(connectionConfig.port),
      POSTGRES_USER: connectionConfig.username,
      POSTGRES_PASSWORD: connectionConfig.password,
      POSTGRES_DATABASE: connectionConfig.database,
      RESTORE: "yes",
      DROP_PUBLIC: "yes",
      RESTORE_OPERATION_ID: operationId,
      RESTORE_DATABASE_ID: databaseId,
    };
    // sidecarEnv has typed optional fields; collapse to plain strings only.
    for (const [key, value] of Object.entries(sidecarEnv)) {
      if (typeof value === "string") env[key] = value;
    }

    log.info(
      {
        databaseId,
        operationId,
        backupUrl,
        targetDatabaseName: targetDatabaseName ?? null,
        triggerKind: ctx.trigger.kind,
        triggerName: ctx.trigger.name,
        containerName,
        blobName,
        providerId: storageBackend.providerId,
      },
      "restore-executor runtime env resolved",
    );

    return {
      env,
      // The runId == RestoreOperation.id so JobPool history events line up
      // with the existing UI list query, and the exit watcher's
      // completed/failed history publish keys against it.
      runIdOverride: operationId,
    };
  };
}

let installed = false;

/**
 * Register the wildcard runtime env resolver against every applied
 * `restore-executor` JobPool service. Called once from server boot.
 * Idempotent.
 */
export function installRestoreRuntimeEnvResolver(): void {
  if (installed) return;
  jobPoolRuntimeEnvResolvers.register("*", RESTORE_EXECUTOR_SERVICE_NAME, buildRestoreRuntimeEnvResolver());
  installed = true;
  log.info("Installed restore-executor runtime env resolver (wildcard)");
}

/** Test-only — drops the global installed flag. Does NOT unregister the resolver. */
export function __resetInstalledForTests(): void {
  installed = false;
}
