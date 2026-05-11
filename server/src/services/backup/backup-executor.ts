import type { PrismaClient } from "../../generated/prisma/client";
import { getLogger } from "../../lib/logger-factory";
import { DockerExecutorService } from "../docker-executor";
import { runJobPool } from "../stacks/job-pool-spawner";
import { PG_AZ_BACKUP_SERVICE_NAME } from "./backup-job-pool-materialiser";
import {
  BackupOperationInfo,
  BackupOperationType,
  BackupOperationStatus,
} from "@mini-infra/types";
import type { BackupOperation } from "../../generated/prisma/client";

const log = getLogger("backup", "backup-executor");

/**
 * Backup executor — Phase 4 (MINI-53) remainder.
 *
 * Pre-Phase-4 this module owned an in-memory queue + a bespoke
 * `mini-infra.backup.run` NATS responder + a 734-LOC Docker-spawn pipeline.
 * Phase 4 retires all three: the JobPool framework
 * (`server/src/services/stacks/job-pool-*.ts`) owns the spawn lifecycle now,
 * driven by the `pg-az-backup` system template's `triggers[]` (cron +
 * `mini-infra.backup.run` nats-request, both materialised from
 * `BackupConfiguration` rows by `backup-job-pool-materialiser.ts`).
 *
 * What's left:
 *   - `queueBackup()` — single entry point for the HTTP "Run now" route.
 *     Resolves the applied pg-az-backup stack for the requested database
 *     and delegates to `runJobPool` with `trigger.kind = 'manual'`. The
 *     runtime env resolver registered by the materialiser handles the per-
 *     run `POSTGRES_*` / `AZURE_SAS_URL` minting and creates the
 *     `BackupOperation` row whose id becomes the JobPool `runId`.
 *   - `getBackupStatus()` / `cancelBackup()` — DB-only operations preserved
 *     so the existing REST surface keeps working without churn.
 *
 * The class no longer holds any in-memory state (queue, active count,
 * `isInitialized` flag); construction is cheap, no `initialize()` is
 * required, and `shutdown()` is a no-op.
 */
export class BackupExecutorService {
  /**
   * Cached `DockerExecutorService` instance — `new DockerExecutorService()
   * + initialize()` is non-trivial work (wires a fresh Docker client +
   * event handlers + image-pull auth lookup), so allocating one per
   * `queueBackup()` call wasted resources on every "Run now" click
   * (MINI-50 review finding M5). Mirrors the `lazyDockerExecutor`
   * pattern in `job-pool-exit-watcher.ts` / the registries.
   */
  private cachedDockerExecutor: DockerExecutorService | null = null;
  private cachedDockerExecutorPromise: Promise<DockerExecutorService> | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Lazy single-instance accessor. Concurrent callers during the first
   * construction await the same promise so a burst of simultaneous
   * "Run now" clicks doesn't race-allocate multiple executors.
   */
  private async getDockerExecutor(): Promise<DockerExecutorService> {
    if (this.cachedDockerExecutor) return this.cachedDockerExecutor;
    if (!this.cachedDockerExecutorPromise) {
      this.cachedDockerExecutorPromise = (async () => {
        const exec = new DockerExecutorService();
        await exec.initialize();
        this.cachedDockerExecutor = exec;
        return exec;
      })().catch((err) => {
        // Reset so the next call can retry — a transient docker
        // unavailability shouldn't pin the service to a broken state.
        this.cachedDockerExecutorPromise = null;
        throw err;
      });
    }
    return this.cachedDockerExecutorPromise;
  }

  /**
   * Initialise — kept as a no-op for backwards compatibility with the
   * pre-Phase-4 callsites (`server.ts` boot, route construction) that still
   * called `await executor.initialize()`. The JobPool path owns its own
   * boot via `JobPoolCronRegistry.loadAll()` + `JobPoolNatsRegistry.loadAll()`.
   */
  initialize(): Promise<void> {
    log.debug("BackupExecutorService.initialize is a no-op in Phase 4 (JobPool owns lifecycle)");
    return Promise.resolve();
  }

  /**
   * Fire a manual backup run for `databaseId`. Locates the applied
   * pg-az-backup JobPool stack and routes the request through
   * `runJobPool` — the runtime env resolver creates the `BackupOperation`
   * row whose id becomes the JobPool `runId`, mints the SAS URL, and feeds
   * everything into `callerEnv`.
   *
   * Returns a `BackupOperationInfo` shaped like the legacy
   * `queueBackup()` return type so the HTTP route doesn't have to change
   * shape. Throws on missing stack / unknown database / cap-hit.
   */
  async queueBackup(
    databaseId: string,
    operationType: BackupOperationType,
    userId: string,
  ): Promise<BackupOperationInfo> {
    const stack = await this.findPgBackupStackForDatabase(databaseId);
    if (!stack) {
      throw new Error(
        "No pg-az-backup stack is currently applied. Deploy the pg-az-backup template from the template catalog before triggering a manual backup.",
      );
    }

    const dockerExecutor = await this.getDockerExecutor();

    const result = await runJobPool(this.prisma, dockerExecutor, {
      stackId: stack.id,
      serviceName: PG_AZ_BACKUP_SERVICE_NAME,
      trigger: { kind: "manual", name: "manual-http" },
      payload: { databaseId, operationType, userId },
    });

    if (!result.ok) {
      if (result.reason === "concurrency_cap") {
        throw new Error(
          `Backup request rejected — max concurrent backups (${result.maxConcurrent}) already running`,
        );
      }
      throw new Error(
        "message" in result && result.message
          ? `${result.reason}: ${result.message}`
          : `pg-az-backup JobPool spawn failed (${result.reason})`,
      );
    }

    // The runtime env resolver created the BackupOperation row whose id ==
    // result.runId. Surface it back so the HTTP response matches the legacy
    // shape.
    const operation = await this.prisma.backupOperation.findUnique({
      where: { id: result.runId },
    });
    if (!operation) {
      throw new Error(
        `pg-az-backup JobPool spawn produced runId ${result.runId} but no BackupOperation row exists`,
      );
    }
    return this.mapBackupOperationToInfo(operation);
  }

  async getBackupStatus(operationId: string): Promise<BackupOperationInfo | null> {
    try {
      const operation = await this.prisma.backupOperation.findUnique({
        where: { id: operationId },
      });
      if (!operation) return null;
      return this.mapBackupOperationToInfo(operation);
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : "Unknown error", operationId },
        "Failed to get backup status",
      );
      throw error;
    }
  }

  /**
   * Mark a backup operation cancelled. The JobPool exit watcher will
   * subsequently transition the underlying `PoolInstance` row to `failed`
   * when its container dies (e.g. from the kill-after-seconds reaper or
   * external `docker kill`). For Phase 4 we don't stop the container
   * proactively — operators wanting an immediate stop can `docker kill`
   * the container directly; this method only updates the DB row.
   */
  async cancelBackup(operationId: string): Promise<boolean> {
    try {
      const operation = await this.prisma.backupOperation.findUnique({
        where: { id: operationId },
      });
      if (!operation || operation.status === "completed") return false;

      await this.prisma.backupOperation.update({
        where: { id: operationId },
        data: {
          status: "failed",
          errorMessage: "Operation cancelled by user",
          completedAt: new Date(),
        },
      });
      return true;
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : "Unknown error", operationId },
        "Failed to cancel backup operation",
      );
      return false;
    }
  }

  /**
   * Find the applied pg-az-backup JobPool stack that owns this database's
   * backup. For Phase 4 the constraint is "at most one applied pg-az-backup
   * stack across the host" (documented in pg-az-backup/CLAUDE.md), so we
   * grab the first one we find.
   */
  private async findPgBackupStackForDatabase(_databaseId: string): Promise<{ id: string } | null> {
    const service = await this.prisma.stackService.findFirst({
      where: { serviceName: PG_AZ_BACKUP_SERVICE_NAME, serviceType: "JobPool" },
      select: { stackId: true },
    });
    if (!service) return null;
    return { id: service.stackId };
  }

  private mapBackupOperationToInfo(operation: BackupOperation): BackupOperationInfo {
    return {
      id: operation.id,
      databaseId: operation.databaseId,
      operationType: operation.operationType as BackupOperationType,
      status: operation.status as BackupOperationStatus,
      startedAt: operation.startedAt.toISOString(),
      completedAt: operation.completedAt?.toISOString() || null,
      sizeBytes: operation.sizeBytes ? Number(operation.sizeBytes) : null,
      storageObjectUrl: operation.storageObjectUrl,
      storageProviderAtCreation: operation.storageProviderAtCreation,
      errorMessage: operation.errorMessage,
      progress: operation.progress,
      metadata: operation.metadata ? JSON.parse(operation.metadata) : null,
    };
  }

  shutdown(): Promise<void> {
    log.debug("BackupExecutorService.shutdown is a no-op in Phase 4");
    return Promise.resolve();
  }

  /**
   * Pre-Phase-4 returned the in-memory active operation count. Kept as a
   * 0-returning stub so any leftover diagnostics calls don't break; the
   * real per-pool count lives in `PoolInstance` rows now (status in
   * `starting` or `running` for the pg-az-backup pool).
   */
  getActiveOperationCount(): number {
    return 0;
  }
}
