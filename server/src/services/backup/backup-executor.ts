import prisma, { PrismaClient } from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";
import { runWithContext } from "../../lib/logging-context";
import { DockerExecutorService } from "../docker-executor";
import { BackupConfigurationManager } from "./backup-configuration-manager";
import { PostgresDatabaseManager, getPgBackupImage } from "../postgres";
import { StorageService } from "../storage/storage-service";
import type { StorageBackend } from "@mini-infra/types";
import { resolveDatabaseNetworkName } from "./database-network-resolver";
import { buildSidecarUploadEnv, redactSidecarEnv } from "./sidecar-env";
import {
  BackupOperationInfo,
  BackupOperationType,
  BackupOperationStatus,
  BackupSubject,
} from "@mini-infra/types";
import type { BackupOperation } from "../../generated/prisma/client";
import { NatsBus } from "../nats/nats-bus";
import type {
  BackupRunRequest,
  BackupRunReply,
  BackupCompleted,
  BackupFailed,
} from "../nats/payload-schemas";

export interface BackupJobData {
  backupOperationId: string;
  databaseId: string;
  operationType: BackupOperationType;
  userId: string;
}

export interface BackupProgressData {
  status: BackupOperationStatus;
  progress: number;
  message?: string;
  errorMessage?: string;
}

/**
 * BackupExecutorService orchestrates backup operations using Docker containers.
 *
 * Phase 4 (ALT-29): the in-memory job queue is replaced by a NATS request
 * flight. `queueBackup()` fires `bus.request(backup.run, ...)` and the
 * executor's own `bus.respond()` handler enforces the concurrency cap (2),
 * creates the DB record, and starts the async Docker execution. Progress
 * events are published to `mini-infra.backup.progress.<runId>` so the
 * backup-nats-bridge can fan them out to Socket.IO. Completed/failed events
 * land on JetStream `BackupHistory` for durable replay.
 */
export class BackupExecutorService {
  private prisma: typeof prisma;
  private dockerExecutor: DockerExecutorService;
  private backupConfigService: BackupConfigurationManager;
  private databaseConfigService: PostgresDatabaseManager;
  private async getStorageBackend(): Promise<StorageBackend> {
    return await StorageService.getInstance(this.prisma).getActiveBackend();
  }
  private isInitialized = false;
  /** Number of backup containers currently executing. Enforces the cap of 2. */
  private activeOperationCount = 0;
  private static readonly MAX_CONCURRENT = 2;
  private static readonly BACKUP_TIMEOUT_MS = 2 * 60 * 60 * 1000;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.dockerExecutor = new DockerExecutorService();
    this.backupConfigService = new BackupConfigurationManager(prisma);
    this.databaseConfigService = new PostgresDatabaseManager(prisma);
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      getLogger("backup", "backup-executor").debug(
        "BackupExecutorService already initialized, skipping",
      );
      return;
    }

    const startTime = Date.now();
    try {
      getLogger("backup", "backup-executor").info("Initializing BackupExecutorService...");

      try {
        await this.dockerExecutor.initialize();
        getLogger("backup", "backup-executor").debug("Docker executor initialized successfully");

        const networkName = await resolveDatabaseNetworkName(this.prisma);
        getLogger("backup", "backup-executor").debug(
          `Ensuring backup network exists: ${networkName}`,
        );
        await this.dockerExecutor.createNetwork(networkName, undefined, {
          driver: "bridge",
          labels: { "mini-infra.purpose": "postgres-backup" },
        });
        getLogger("backup", "backup-executor").debug("Backup network ready");
      } catch (dockerError) {
        getLogger("backup", "backup-executor").warn(
          { error: dockerError instanceof Error ? dockerError.message : "Unknown error" },
          "Failed to initialize Docker executor - backup operations will be unavailable until Docker is configured",
        );
      }

      // Register the durable NATS responder. bus.respond() records the
      // registration and re-attaches it on every reconnect, so calling this
      // before the bus reaches `connected` is intentional.
      this.registerNatsResponder();

      getLogger("backup", "backup-executor").info(
        {
          initializationTimeMs: Date.now() - startTime,
          maxConcurrent: BackupExecutorService.MAX_CONCURRENT,
          timeoutMs: BackupExecutorService.BACKUP_TIMEOUT_MS,
        },
        "BackupExecutorService initialized successfully",
      );
      this.isInitialized = true;
    } catch (error) {
      getLogger("backup", "backup-executor").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          initializationTimeMs: Date.now() - startTime,
        },
        "Failed to initialize BackupExecutorService",
      );
      throw error;
    }
  }

  /**
   * Register the durable NATS responder on `mini-infra.backup.run`. This
   * replaces the old InMemoryQueue processor — all callers (scheduler, HTTP
   * route) funnel through bus.request(backup.run) so the concurrency cap is
   * enforced in a single place.
   */
  private registerNatsResponder(): void {
    const bus = NatsBus.getInstance();
    bus.respond<BackupRunRequest, BackupRunReply>(
      BackupSubject.run,
      async (req) => {
        if (this.activeOperationCount >= BackupExecutorService.MAX_CONCURRENT) {
          getLogger("backup", "backup-executor").info(
            { databaseId: req.databaseId, activeOperationCount: this.activeOperationCount },
            "Backup request rejected — at max concurrency",
          );
          return {
            operationId: "",
            accepted: false,
            queueDepth: this.activeOperationCount,
            reason: `max concurrent backups (${BackupExecutorService.MAX_CONCURRENT}) already running`,
          };
        }

        const backupOperation = await this.prisma.backupOperation.create({
          data: {
            databaseId: req.databaseId,
            operationType: req.operationType,
            status: "pending",
            progress: 0,
          },
        });

        const operationId = backupOperation.id;
        this.activeOperationCount++;

        getLogger("backup", "backup-executor").info(
          {
            operationId,
            databaseId: req.databaseId,
            operationType: req.operationType,
            userId: req.userId,
            activeOperationCount: this.activeOperationCount,
          },
          "NATS backup.run: operation accepted, starting execution",
        );

        // Fire and forget — decrement counter when done (success or failure).
        // Catch errors here so the unhandled-rejection is suppressed: errors
        // are already logged and the DB is already updated inside executeBackup.
        void this.executeBackup(operationId, req.databaseId, req.userId)
          .catch((err) => {
            getLogger("backup", "backup-executor").debug(
              { operationId, err: err instanceof Error ? err.message : String(err) },
              "Backup execution threw after internal handling (expected)",
            );
          })
          .finally(() => {
            this.activeOperationCount--;
            getLogger("backup", "backup-executor").debug(
              { operationId, activeOperationCount: this.activeOperationCount },
              "Backup operation slot released",
            );
          });

        return { operationId, accepted: true, queueDepth: this.activeOperationCount };
      },
    );

    getLogger("backup", "backup-executor").info(
      { subject: BackupSubject.run },
      "NATS backup.run responder registered",
    );
  }

  /**
   * Request a backup run via the NATS bus. Both the HTTP route and the
   * scheduler funnel through here — the NATS request is the only execution
   * path.
   */
  public async queueBackup(
    databaseId: string,
    operationType: BackupOperationType,
    userId: string,
  ): Promise<BackupOperationInfo> {
    if (!this.isInitialized) {
      getLogger("backup", "backup-executor").debug(
        "BackupExecutorService not initialized, initializing now",
      );
      await this.initialize();
    }

    const bus = NatsBus.getInstance();
    const reply = await bus.request<BackupRunRequest, BackupRunReply>(
      BackupSubject.run,
      { databaseId, userId, operationType },
      { timeoutMs: 10_000 },
    );

    if (!reply.accepted) {
      throw new Error(reply.reason ?? "Backup request rejected by executor");
    }

    // The DB record was created inside the respond handler before the reply
    // was sent, so it exists here.
    const operation = await this.prisma.backupOperation.findUnique({
      where: { id: reply.operationId },
    });
    if (!operation) {
      throw new Error(`Backup operation record not found: ${reply.operationId}`);
    }
    return this.mapBackupOperationToInfo(operation);
  }

  public async getBackupStatus(
    operationId: string,
  ): Promise<BackupOperationInfo | null> {
    try {
      const operation = await this.prisma.backupOperation.findUnique({
        where: { id: operationId },
      });
      if (!operation) return null;
      return this.mapBackupOperationToInfo(operation);
    } catch (error) {
      getLogger("backup", "backup-executor").error(
        { error: error instanceof Error ? error.message : "Unknown error", operationId },
        "Failed to get backup status",
      );
      throw error;
    }
  }

  public async cancelBackup(operationId: string): Promise<boolean> {
    try {
      const operation = await this.prisma.backupOperation.findUnique({
        where: { id: operationId },
      });
      if (!operation || operation.status === "completed") return false;

      await this.updateBackupProgress(operationId, operation.databaseId, {
        status: "failed",
        progress: operation.progress,
        errorMessage: "Operation cancelled by user",
      });
      return true;
    } catch (error) {
      getLogger("backup", "backup-executor").error(
        { error: error instanceof Error ? error.message : "Unknown error", operationId },
        "Failed to cancel backup operation",
      );
      return false;
    }
  }

  private async executeBackup(
    operationId: string,
    databaseId: string,
    userId: string,
  ): Promise<void> {
    return runWithContext({ operationId, userId }, () =>
      this.executeBackupInner(operationId, databaseId, userId),
    );
  }

  private async executeBackupInner(
    operationId: string,
    databaseId: string,
    userId: string,
  ): Promise<void> {
    const executionStartTime = Date.now();
    try {
      getLogger("backup", "backup-executor").info(
        { operationId, databaseId, userId },
        "Starting backup execution",
      );

      await this.updateBackupProgress(operationId, databaseId, {
        status: "running",
        progress: 10,
        message: "Preparing backup operation",
      });

      const database = await this.databaseConfigService.getDatabaseById(databaseId);
      if (!database) throw new Error("Database not found or access denied");

      const backupConfig = await this.backupConfigService.getBackupConfigByDatabaseId(databaseId);
      if (!backupConfig) {
        getLogger("backup", "backup-executor").error(
          { operationId, databaseId },
          "Backup configuration not found",
        );
        throw new Error("Backup configuration not found");
      }

      await this.updateBackupProgress(operationId, databaseId, {
        status: "running",
        progress: 20,
        message: "Getting system settings",
      });

      const dockerImage = this.getBackupDockerImage();

      await this.updateBackupProgress(operationId, databaseId, {
        status: "running",
        progress: 25,
        message: "Pulling Docker image",
      });

      const pullStartTime = Date.now();
      try {
        await this.dockerExecutor.pullImageWithAutoAuth(dockerImage);
        getLogger("backup", "backup-executor").info(
          { operationId, dockerImage, pullTimeMs: Date.now() - pullStartTime },
          "Docker image pulled successfully",
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        throw new Error(`Failed to pull Docker image: ${errorMessage}`, { cause: error });
      }

      let storageBackend: StorageBackend;
      try {
        storageBackend = await this.getStorageBackend();
      } catch (err) {
        throw new Error(
          `No storage provider configured: ${err instanceof Error ? err.message : "unknown"}`,
          { cause: err },
        );
      }

      const connectionConfig = await this.databaseConfigService.getConnectionConfig(databaseId);

      await this.updateBackupProgress(operationId, databaseId, {
        status: "running",
        progress: 35,
        message: "Starting backup container",
      });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const blobName = `${databaseId}/${operationId}_${timestamp}.dump`;
      const ttlMinutes = Math.ceil(BackupExecutorService.BACKUP_TIMEOUT_MS / 60000) + 15;
      const uploadHandle = await storageBackend.mintUploadHandle(
        { id: backupConfig.storageLocationId },
        blobName,
        ttlMinutes,
      );
      const sidecarEnv = buildSidecarUploadEnv(uploadHandle);

      getLogger("backup", "backup-executor").info(
        {
          operationId,
          storageLocationId: backupConfig.storageLocationId,
          blobName,
          backupFormat: backupConfig.backupFormat,
          compressionLevel: backupConfig.compressionLevel,
          ttlMinutes,
          providerId: storageBackend.providerId,
          handleKind: uploadHandle.kind,
        },
        "Minted upload handle for backup sidecar",
      );

      // Log the env we're sending (with secrets redacted).
      const containerEnvRedacted = {
        POSTGRES_HOST: connectionConfig.host,
        POSTGRES_PORT: connectionConfig.port.toString(),
        POSTGRES_USER: connectionConfig.username,
        POSTGRES_PASSWORD: "[REDACTED]",
        POSTGRES_DATABASE: connectionConfig.database,
        ...redactSidecarEnv(sidecarEnv),
        BACKUP_FORMAT: backupConfig.backupFormat,
        COMPRESSION_LEVEL: backupConfig.compressionLevel.toString(),
      };
      getLogger("backup", "backup-executor").info(
        { operationId, dockerImage, environment: containerEnvRedacted, timeoutMs: BackupExecutorService.BACKUP_TIMEOUT_MS },
        "Starting backup container execution",
      );

      const backupNetworkName = await resolveDatabaseNetworkName(this.prisma);
      const containerStartTime = Date.now();
      let pendingProgressUpdate: Promise<void> | undefined;

      const containerResult = await this.dockerExecutor.executeContainerWithProgress(
        {
          image: dockerImage,
          env: {
            POSTGRES_HOST: connectionConfig.host,
            POSTGRES_PORT: connectionConfig.port.toString(),
            POSTGRES_USER: connectionConfig.username,
            POSTGRES_PASSWORD: connectionConfig.password,
            POSTGRES_DATABASE: connectionConfig.database,
            ...sidecarEnv,
            BACKUP_FORMAT: backupConfig.backupFormat,
            COMPRESSION_LEVEL: backupConfig.compressionLevel.toString(),
          },
          timeout: BackupExecutorService.BACKUP_TIMEOUT_MS,
          networkMode: backupNetworkName,
        },
        (progress) => {
          let progressValue = 40;
          let message = "Executing backup";

          getLogger("backup", "backup-executor").debug(
            { operationId, containerStatus: progress.status, errorMessage: progress.errorMessage },
            "Container progress update received",
          );

          switch (progress.status) {
            case "starting":
              progressValue = 40;
              message = "Starting backup container";
              getLogger("backup", "backup-executor").info({ operationId }, "Backup container is starting");
              break;
            case "running":
              progressValue = 60;
              message = "Creating backup";
              getLogger("backup", "backup-executor").info({ operationId }, "Backup container is running - database backup in progress");
              break;
            case "completed":
              progressValue = 80;
              message = "Backup completed, uploading to storage";
              getLogger("backup", "backup-executor").info({ operationId }, "Backup container completed execution");
              break;
            case "failed":
              getLogger("backup", "backup-executor").error(
                { operationId, errorMessage: progress.errorMessage },
                "Backup container execution failed",
              );
              throw new Error(progress.errorMessage || "Container execution failed");
          }

          pendingProgressUpdate = this.updateBackupProgress(operationId, databaseId, {
            status: "running",
            progress: progressValue,
            message,
          });
        },
      );

      if (pendingProgressUpdate) await pendingProgressUpdate;

      getLogger("backup", "backup-executor").info(
        {
          operationId,
          exitCode: containerResult.exitCode,
          containerExecutionTimeMs: Date.now() - containerStartTime,
          stdoutLength: containerResult.stdout?.length || 0,
          stderrLength: containerResult.stderr?.length || 0,
        },
        "Backup container execution completed",
      );

      if (containerResult.exitCode !== 0) {
        getLogger("backup", "backup-executor").error(
          { operationId, exitCode: containerResult.exitCode, stderr: containerResult.stderr },
          "Backup container failed",
        );
        throw new Error(
          `Backup failed: ${containerResult.stderr || containerResult.stdout}`,
        );
      }

      await this.updateBackupProgress(operationId, databaseId, {
        status: "running",
        progress: 85,
        message: "Verifying backup in storage",
      });

      const backupVerification = await this.verifyBackupInStorage(
        storageBackend,
        backupConfig.storageLocationId,
        blobName,
      );

      if (!backupVerification.success) {
        throw new Error(backupVerification.error || "Backup verification failed");
      }

      // Atomic DB update with the final completion state.
      await this.prisma.backupOperation.update({
        where: { id: operationId },
        data: {
          status: "completed",
          progress: 100,
          sizeBytes: backupVerification.sizeBytes,
          storageObjectUrl: backupVerification.objectUrl,
          storageProviderAtCreation: storageBackend.providerId,
          completedAt: new Date(),
        },
      });

      await this.backupConfigService.updateLastBackupTime(backupConfig.id);

      // Publish to JetStream BackupHistory after DB is updated. The bridge
      // consumer re-emits the Socket.IO event from this message, and on a
      // cold-boot replay it can detect any DB record still in "running"
      // state and repair it.
      const completedPayload: BackupCompleted = {
        operationId,
        databaseId,
        sizeBytes: backupVerification.sizeBytes ? Number(backupVerification.sizeBytes) : undefined,
        storageObjectUrl: backupVerification.objectUrl,
        storageProvider: storageBackend.providerId,
        completedAtMs: Date.now(),
      };
      try {
        await NatsBus.getInstance().jetstream.publish(BackupSubject.completed, completedPayload);
      } catch (natsErr) {
        getLogger("backup", "backup-executor").warn(
          { operationId, err: natsErr instanceof Error ? natsErr.message : String(natsErr) },
          "Failed to publish backup.completed to JetStream (non-fatal — DB already updated)",
        );
      }

      getLogger("backup", "backup-executor").info(
        {
          operationId,
          databaseId,
          sizeBytes: backupVerification.sizeBytes?.toString(),
          objectUrl: backupVerification.objectUrl,
          totalExecutionTimeMs: Date.now() - executionStartTime,
        },
        "Backup operation completed successfully",
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const stack = error instanceof Error ? error.stack : undefined;

      getLogger("backup", "backup-executor").error(
        {
          operationId,
          databaseId,
          error: errorMessage,
          stack,
          executionTimeMs: Date.now() - executionStartTime,
        },
        "Backup operation failed",
      );

      await this.updateBackupProgress(operationId, databaseId, {
        status: "failed",
        progress: 0,
        errorMessage,
      });

      // Hard-crash fallback: publish to JetStream so the bridge emits the
      // Socket.IO COMPLETED (failed=true) event and future replay has the
      // failure on record.
      const failedPayload: BackupFailed = {
        operationId,
        databaseId,
        errorMessage,
        failedAtMs: Date.now(),
      };
      try {
        await NatsBus.getInstance().jetstream.publish(BackupSubject.failed, failedPayload);
      } catch (natsErr) {
        getLogger("backup", "backup-executor").warn(
          { operationId, err: natsErr instanceof Error ? natsErr.message : String(natsErr) },
          "Failed to publish backup.failed to JetStream (non-fatal — DB already updated)",
        );
      }

      throw error;
    }
  }

  private getBackupDockerImage(): string {
    const dockerImage = getPgBackupImage();
    getLogger("backup", "backup-executor").info({ dockerImage }, "Resolved backup Docker image");
    return dockerImage;
  }

  private async verifyBackupInStorage(
    backend: StorageBackend,
    storageLocationId: string,
    objectName: string,
  ): Promise<{ success: boolean; error?: string; sizeBytes?: bigint; objectUrl?: string }> {
    try {
      const head = await backend.head({ id: storageLocationId }, objectName);
      if (!head) {
        return { success: false, error: `Backup object not found: ${objectName}` };
      }
      const sizeBytes = BigInt(head.size ?? 0);
      let objectUrl: string | undefined;
      if (backend.getDownloadHandle) {
        try {
          const handle = await backend.getDownloadHandle({ id: storageLocationId }, objectName, 60);
          objectUrl = handle.redirectUrl;
        } catch {
          // fall through to path-shape fallback
        }
      }
      if (!objectUrl) objectUrl = `${storageLocationId}/${objectName}`;
      getLogger("backup", "backup-executor").info(
        { storageLocationId, objectName, sizeBytes: sizeBytes.toString(), providerId: backend.providerId },
        "Backup object verified in storage backend",
      );
      return { success: true, sizeBytes, objectUrl };
    } catch (error) {
      getLogger("backup", "backup-executor").error(
        { error: error instanceof Error ? error.message : "Unknown error", storageLocationId, objectName },
        "Failed to verify backup in storage backend",
      );
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  /**
   * Update the backup operation's DB record and publish a NATS progress event
   * so the backup-nats-bridge can fan it out to Socket.IO. Only running/pending
   * status publishes to the progress subject; completed/failed use JetStream
   * (handled by the caller).
   */
  private async updateBackupProgress(
    operationId: string,
    databaseId: string,
    progressData: BackupProgressData,
  ): Promise<void> {
    try {
      await this.prisma.backupOperation.update({
        where: { id: operationId },
        data: {
          status: progressData.status,
          progress: progressData.progress,
          errorMessage: progressData.errorMessage,
          ...(progressData.status === "completed" && { completedAt: new Date() }),
        },
      });

      getLogger("backup", "backup-executor").debug(
        { operationId, status: progressData.status, progress: progressData.progress, message: progressData.message },
        "Backup progress updated",
      );

      if (progressData.status === "running" || progressData.status === "pending") {
        try {
          const subject = `${BackupSubject.progressPrefix}.${operationId}`;
          await NatsBus.getInstance().publish(
            subject,
            {
              operationId,
              status: progressData.status,
              progress: progressData.progress,
              message: progressData.message,
            },
            { unchecked: true },
          );
        } catch (natsErr) {
          getLogger("backup", "backup-executor").debug(
            { operationId, err: natsErr instanceof Error ? natsErr.message : String(natsErr) },
            "Failed to publish progress to NATS (non-fatal — DB already updated)",
          );
        }
      }
    } catch (error) {
      getLogger("backup", "backup-executor").warn(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          operationId,
          progressData,
        },
        "Failed to update backup progress — this may leave the operation in a stale state",
      );
    }
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

  public async shutdown(): Promise<void> {
    try {
      // The NATS respond handler is durable and managed by NatsBus.shutdown().
      // Active operations run to completion or fail through the bus drain path.
      getLogger("backup", "backup-executor").info(
        { activeOperationCount: this.activeOperationCount },
        "BackupExecutorService shut down successfully",
      );
    } catch (error) {
      getLogger("backup", "backup-executor").error(
        { error: error instanceof Error ? error.message : "Unknown error" },
        "Error during BackupExecutorService shutdown",
      );
    }
  }

  public getActiveOperationCount(): number {
    return this.activeOperationCount;
  }
}
