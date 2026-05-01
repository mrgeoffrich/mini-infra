import prisma, { PrismaClient } from "../../lib/prisma";
import { InMemoryQueue, Job as QueueJob } from "../../lib/in-memory-queue";
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
  Channel,
  ServerEvent,
} from "@mini-infra/types";
import { emitToChannel } from "../../lib/socket";
import type { BackupOperation } from "../../generated/prisma/client";

/**
 * Job data structure for backup operations
 */
export interface BackupJobData {
  backupOperationId: string;
  databaseId: string;
  operationType: BackupOperationType;
  userId: string;
}

/**
 * Progress update data for backup operations
 */
export interface BackupProgressData {
  status: BackupOperationStatus;
  progress: number;
  message?: string;
  errorMessage?: string;
}

/**
 * BackupExecutorService orchestrates backup operations using Docker containers
 */
export class BackupExecutorService {
  private prisma: typeof prisma;
  private dockerExecutor: DockerExecutorService;
  private backupConfigService: BackupConfigurationManager;
  private databaseConfigService: PostgresDatabaseManager;
  // Backend resolved lazily on each call so a config rotation between calls is
  // honoured without restarting the executor.
  private async getStorageBackend(): Promise<StorageBackend> {
    return await StorageService.getInstance(this.prisma).getActiveBackend();
  }
  private backupQueue: InMemoryQueue;
  private isInitialized = false;

  // Timeout for backup operations (2 hours)
  private static readonly BACKUP_TIMEOUT_MS = 2 * 60 * 60 * 1000;

  // Retry configuration
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAY_MS = 30000; // 30 seconds

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.dockerExecutor = new DockerExecutorService();
    this.backupConfigService = new BackupConfigurationManager(prisma);
    this.databaseConfigService = new PostgresDatabaseManager(prisma);

    // Initialize in-memory queue
    this.backupQueue = new InMemoryQueue("postgres-backup", {
      concurrency: 2, // Allow 2 concurrent backups
      defaultJobOptions: {
        attempts: BackupExecutorService.MAX_RETRIES,
        backoff: {
          type: "exponential",
          delay: BackupExecutorService.RETRY_DELAY_MS,
        },
        removeOnComplete: 10, // Keep last 10 completed jobs
        removeOnFail: 50, // Keep last 50 failed jobs
      },
    });

    this.setupQueueProcessors();
  }

  /**
   * Initialize the backup executor service
   */
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

      // Initialize Docker executor
      getLogger("backup", "backup-executor").debug(
        "Initializing Docker executor for backup operations",
      );
      try {
        await this.dockerExecutor.initialize();
        getLogger("backup", "backup-executor").debug("Docker executor initialized successfully");

        // Ensure backup network exists (resolved dynamically or fallback)
        const networkName = await resolveDatabaseNetworkName(this.prisma);
        getLogger("backup", "backup-executor").debug(
          `Ensuring backup network exists: ${networkName}`,
        );
        await this.dockerExecutor.createNetwork(
          networkName,
          undefined,
          {
            driver: "bridge",
            labels: {
              "mini-infra.purpose": "postgres-backup",
            },
          },
        );
        getLogger("backup", "backup-executor").debug("Backup network ready");
      } catch (dockerError) {
        getLogger("backup", "backup-executor").warn(
          {
            error: dockerError instanceof Error ? dockerError.message : "Unknown error",
          },
          "Failed to initialize Docker executor - backup operations will be unavailable until Docker is configured",
        );
        // Continue initialization without Docker - backup operations will fail gracefully when attempted
      }

      getLogger("backup", "backup-executor").info(
        {
          initializationTimeMs: Date.now() - startTime,
          queueConcurrency: 2,
          maxRetries: BackupExecutorService.MAX_RETRIES,
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
   * Queue a backup operation
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

    const startTime = Date.now();
    try {
      getLogger("backup", "backup-executor").info(
        {
          databaseId,
          operationType,
          userId,
        },
        "Queueing new backup operation",
      );

      // Create backup operation record
      const backupOperation = await this.prisma.backupOperation.create({
        data: {
          databaseId,
          operationType,
          status: "pending",
          progress: 0,
        },
      });

      getLogger("backup", "backup-executor").info(
        {
          operationId: backupOperation.id,
          databaseId,
          operationType,
          userId,
          queueingTimeMs: Date.now() - startTime,
        },
        "Backup operation created and queued successfully",
      );

      // Add job to queue
      await this.backupQueue.add(
        "execute-backup",
        {
          backupOperationId: backupOperation.id,
          databaseId,
          operationType,
          userId,
        },
        {
          delay: 0, // Execute immediately
        },
      );

      getLogger("backup", "backup-executor").debug(
        {
          operationId: backupOperation.id,
          queuePosition: this.backupQueue.getStats().pending,
        },
        "Job added to backup queue",
      );

      return this.mapBackupOperationToInfo(backupOperation);
    } catch (error) {
      getLogger("backup", "backup-executor").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          databaseId,
          operationType,
          userId,
          queueingTimeMs: Date.now() - startTime,
        },
        "Failed to queue backup operation",
      );
      throw error;
    }
  }

  /**
   * Get backup operation status
   */
  public async getBackupStatus(
    operationId: string,
  ): Promise<BackupOperationInfo | null> {
    try {
      const operation = await this.prisma.backupOperation.findUnique({
        where: { id: operationId },
      });

      if (!operation) {
        return null;
      }

      return this.mapBackupOperationToInfo(operation);
    } catch (error) {
      getLogger("backup", "backup-executor").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          operationId,
        },
        "Failed to get backup status",
      );
      throw error;
    }
  }

  /**
   * Cancel a backup operation
   */
  public async cancelBackup(operationId: string): Promise<boolean> {
    try {
      // Update database status
      const operation = await this.prisma.backupOperation.findUnique({
        where: { id: operationId },
      });

      if (!operation || operation.status === "completed") {
        return false;
      }

      await this.updateBackupProgress(operationId, {
        status: "failed",
        progress: operation.progress,
        errorMessage: "Operation cancelled by user",
      });

      // Try to cancel the job in the queue
      const jobs = await this.backupQueue.getJobs<BackupJobData>(["pending", "active"]);
      const job = jobs.find((j) => j.data.backupOperationId === operationId);

      if (job) {
        await this.backupQueue.remove(job.id);
        getLogger("backup", "backup-executor").info(
          { operationId, jobId: job.id },
          "Backup job cancelled",
        );
      }

      return true;
    } catch (error) {
      getLogger("backup", "backup-executor").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          operationId,
        },
        "Failed to cancel backup operation",
      );
      return false;
    }
  }

  /**
   * Setup queue processors
   */
  private setupQueueProcessors(): void {
    // Process backup jobs
    this.backupQueue.process<BackupJobData>("execute-backup", async (job) => {
      const { backupOperationId, databaseId, userId } = job.data;

      getLogger("backup", "backup-executor").info(
        {
          jobId: job.id,
          operationId: backupOperationId,
          databaseId,
        },
        "Starting backup job processing",
      );

      try {
        await this.executeBackup(backupOperationId, databaseId, userId);
      } catch (error) {
        getLogger("backup", "backup-executor").error(
          {
            jobId: job.id,
            operationId: backupOperationId,
            error: error instanceof Error ? error.message : "Unknown error",
          },
          "Backup job failed",
        );

        // Update status to failed
        await this.updateBackupProgress(backupOperationId, {
          status: "failed",
          progress: 0,
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        });

        throw error;
      }
    });

    // Handle job events
    this.backupQueue.on("completed", (job: QueueJob<BackupJobData>, result: unknown) => {
      getLogger("backup", "backup-executor").info(
        {
          jobId: job.id,
          operationId: job.data.backupOperationId,
          result,
        },
        "Backup job completed",
      );
    });

    this.backupQueue.on("failed", (job: QueueJob<BackupJobData>,error: Error) => {
      getLogger("backup", "backup-executor").error(
        {
          jobId: job.id,
          operationId: job.data.backupOperationId,
          error: (error instanceof Error ? error.message : String(error)),
        },
        "Backup job failed permanently",
      );
    });
  }

  /**
   * Execute backup operation
   */
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
        {
          operationId,
          databaseId,
          userId,
        },
        "Starting backup execution",
      );

      // Update status to running
      await this.updateBackupProgress(operationId, {
        status: "running",
        progress: 10,
        message: "Preparing backup operation",
      });

      // Get database configuration
      getLogger("backup", "backup-executor").debug(
        {
          operationId,
          databaseId,
          userId,
        },
        "Retrieving database configuration",
      );

      const database = await this.databaseConfigService.getDatabaseById(
        databaseId,
      );
      if (!database) {
        throw new Error("Database not found or access denied");
      }

      getLogger("backup", "backup-executor").info(
        {
          operationId,
          databaseId: database.id,
          databaseName: database.database,
          host: database.host,
          port: database.port,
        },
        "Database configuration retrieved successfully",
      );

      // Get backup configuration
      getLogger("backup", "backup-executor").debug(
        {
          operationId,
          databaseId,
        },
        "Retrieving backup configuration",
      );

      const backupConfig =
        await this.backupConfigService.getBackupConfigByDatabaseId(
          databaseId,
        );
      if (!backupConfig) {
        getLogger("backup", "backup-executor").error(
          {
            operationId,
            databaseId,
          },
          "Backup configuration not found",
        );
        throw new Error("Backup configuration not found");
      }

      getLogger("backup", "backup-executor").info(
        {
          operationId,
          backupConfigId: backupConfig.id,
          storageLocationId: backupConfig.storageLocationId,
          backupFormat: backupConfig.backupFormat,
          compressionLevel: backupConfig.compressionLevel,
        },
        "Backup configuration retrieved successfully",
      );

      await this.updateBackupProgress(operationId, {
        status: "running",
        progress: 20,
        message: "Getting system settings",
      });

      // Get system settings for Docker image
      getLogger("backup", "backup-executor").debug(
        {
          operationId,
        },
        "Retrieving Docker image configuration",
      );

      const dockerImage = await this.getBackupDockerImage();

      getLogger("backup", "backup-executor").debug(
        {
          operationId,
        },
        "Retrieving registry credentials configuration",
      );

      await this.updateBackupProgress(operationId, {
        status: "running",
        progress: 25,
        message: "Pulling Docker image",
      });

      // Pull Docker image with automatic authentication
      getLogger("backup", "backup-executor").info(
        {
          operationId,
          dockerImage,
        },
        "Pulling Docker image for backup with auto-auth",
      );

      const pullStartTime = Date.now();
      try {
        await this.dockerExecutor.pullImageWithAutoAuth(dockerImage);

        getLogger("backup", "backup-executor").info(
          {
            operationId,
            dockerImage,
            pullTimeMs: Date.now() - pullStartTime,
          },
          "Docker image pulled successfully",
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        getLogger("backup", "backup-executor").error(
          {
            operationId,
            dockerImage,
            error: errorMessage,
            pullTimeMs: Date.now() - pullStartTime,
          },
          "Failed to pull Docker image for backup",
        );
        throw new Error(`Failed to pull Docker image: ${errorMessage}`, {
          cause: error,
        });
      }

      // Resolve the active storage backend (Azure today; Drive in Phase 3).
      getLogger("backup", "backup-executor").debug(
        { operationId },
        "Resolving active storage backend",
      );

      let storageBackend: StorageBackend;
      try {
        storageBackend = await this.getStorageBackend();
      } catch (err) {
        getLogger("backup", "backup-executor").error(
          {
            operationId,
            error: err instanceof Error ? err.message : "Unknown error",
          },
          "No storage provider configured for backup",
        );
        throw new Error(
          `No storage provider configured: ${err instanceof Error ? err.message : "unknown"}`,
          { cause: err },
        );
      }

      getLogger("backup", "backup-executor").debug(
        { operationId, providerId: storageBackend.providerId },
        "Storage backend resolved",
      );

      // Get database connection details
      getLogger("backup", "backup-executor").debug(
        {
          operationId,
          databaseId,
        },
        "Retrieving database connection configuration",
      );

      const connectionConfig =
        await this.databaseConfigService.getConnectionConfig(
          databaseId,
        );

      getLogger("backup", "backup-executor").debug(
        {
          operationId,
          databaseHost: connectionConfig.host,
          databasePort: connectionConfig.port,
          databaseName: connectionConfig.database,
          databaseUser: connectionConfig.username,
        },
        "Database connection configuration retrieved",
      );

      await this.updateBackupProgress(operationId, {
        status: "running",
        progress: 35,
        message: "Starting backup container",
      });

      // Generate blob name with database ID as path and backup ID + timestamp as filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const blobName = `${databaseId}/${operationId}_${timestamp}.dump`;

      // Mint a provider-agnostic upload handle for the backup sidecar to use.
      // Azure backend returns a SAS URL; Drive backend will return a token+folder
      // bundle in Phase 3.
      const ttlMinutes =
        Math.ceil(BackupExecutorService.BACKUP_TIMEOUT_MS / 60000) + 15;
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

      // Execute backup using Docker
      const containerEnv = {
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
        {
          operationId,
          dockerImage,
          environment: containerEnv,
          timeoutMs: BackupExecutorService.BACKUP_TIMEOUT_MS,
        },
        "Starting backup container execution",
      );

      const backupNetworkName = await resolveDatabaseNetworkName(this.prisma);
      const containerStartTime = Date.now();
      // Track the latest pending progress update from the callback to avoid
      // fire-and-forget race conditions where an unawaited DB write completes
      // after subsequent awaited writes, overwriting the final status.
      let pendingProgressUpdate: Promise<void> | undefined;

      const containerResult =
        await this.dockerExecutor.executeContainerWithProgress(
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
            // Update progress based on container status
            let progressValue = 40;
            let message = "Executing backup";

            getLogger("backup", "backup-executor").debug(
              {
                operationId,
                containerStatus: progress.status,
                errorMessage: progress.errorMessage,
              },
              "Container progress update received",
            );

            switch (progress.status) {
              case "starting":
                progressValue = 40;
                message = "Starting backup container";
                getLogger("backup", "backup-executor").info(
                  {
                    operationId,
                  },
                  "Backup container is starting",
                );
                break;
              case "running":
                progressValue = 60;
                message = "Creating backup";
                getLogger("backup", "backup-executor").info(
                  {
                    operationId,
                  },
                  "Backup container is running - database backup in progress",
                );
                break;
              case "completed":
                progressValue = 80;
                message = "Backup completed, uploading to storage";
                getLogger("backup", "backup-executor").info(
                  {
                    operationId,
                  },
                  "Backup container completed execution",
                );
                break;
              case "failed":
                getLogger("backup", "backup-executor").error(
                  {
                    operationId,
                    errorMessage: progress.errorMessage,
                  },
                  "Backup container execution failed",
                );
                throw new Error(
                  progress.errorMessage || "Container execution failed",
                );
            }

            pendingProgressUpdate = this.updateBackupProgress(operationId, {
              status: "running",
              progress: progressValue,
              message,
            });
          },
        );

      // Ensure callback's DB write completes before we continue to avoid
      // it racing with subsequent writes and overwriting the final status
      if (pendingProgressUpdate) {
        await pendingProgressUpdate;
      }

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

      if (containerResult.stdout) {
        getLogger("backup", "backup-executor").debug(
          {
            operationId,
            stdout: containerResult.stdout.substring(0, 1000), // First 1000 chars
          },
          "Backup container stdout output (truncated)",
        );
      }

      if (containerResult.stderr) {
        getLogger("backup", "backup-executor").debug(
          {
            operationId,
            stderr: containerResult.stderr.substring(0, 1000), // First 1000 chars
          },
          "Backup container stderr output (truncated)",
        );
      }

      if (containerResult.exitCode !== 0) {
        getLogger("backup", "backup-executor").error(
          {
            operationId,
            exitCode: containerResult.exitCode,
            stderr: containerResult.stderr,
            stdout: containerResult.stdout,
          },
          "Backup container failed",
        );
        throw new Error(
          `Backup failed: ${containerResult.stderr || containerResult.stdout}`,
        );
      }

      await this.updateBackupProgress(operationId, {
        status: "running",
        progress: 85,
        message: "Verifying backup in storage",
      });

      // Verify backup objects in the active backend
      getLogger("backup", "backup-executor").info(
        {
          operationId,
          storageLocationId: backupConfig.storageLocationId,
          blobName,
        },
        "Starting backup verification in storage backend",
      );

      const verificationStartTime = Date.now();
      const backupVerification = await this.verifyBackupInStorage(
        storageBackend,
        backupConfig.storageLocationId,
        blobName,
      );

      getLogger("backup", "backup-executor").info(
        {
          operationId,
          success: backupVerification.success,
          sizeBytes: backupVerification.sizeBytes?.toString(),
          objectUrl: backupVerification.objectUrl,
          verificationTimeMs: Date.now() - verificationStartTime,
        },
        "Backup verification completed",
      );

      if (!backupVerification.success) {
        getLogger("backup", "backup-executor").error(
          {
            operationId,
            error: backupVerification.error,
          },
          "Backup verification failed",
        );
        throw new Error(
          backupVerification.error || "Backup verification failed",
        );
      }

      // Update backup operation with success status and file details in a
      // single atomic write to prevent race conditions where status/progress
      // and sizeBytes/completedAt end up out of sync.
      getLogger("backup", "backup-executor").debug(
        {
          operationId,
          sizeBytes: backupVerification.sizeBytes?.toString(),
          objectUrl: backupVerification.objectUrl,
        },
        "Updating backup operation with completion status and file details",
      );

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

      // Update backup configuration with last backup time
      getLogger("backup", "backup-executor").debug(
        {
          operationId,
          backupConfigId: backupConfig.id,
        },
        "Updating backup configuration with last backup time",
      );

      await this.backupConfigService.updateLastBackupTime(backupConfig.id);

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
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      const stack = error instanceof Error ? error.stack : undefined;

      getLogger("backup", "backup-executor").error(
        {
          operationId,
          databaseId,
          error: errorMessage,
          stack: stack,
          executionTimeMs: Date.now() - executionStartTime,
        },
        "Backup operation failed",
      );

      await this.updateBackupProgress(operationId, {
        status: "failed",
        progress: 0,
        errorMessage,
      });

      throw error;
    }
  }

  /**
   * Get backup Docker image (resolved from PG_BACKUP_IMAGE_TAG env var)
   */
  private getBackupDockerImage(): string {
    const dockerImage = getPgBackupImage();
    getLogger("backup", "backup-executor").info({ dockerImage }, "Resolved backup Docker image");
    return dockerImage;
  }

  /**
   * Verify the backup object exists in the storage backend.
   */
  private async verifyBackupInStorage(
    backend: StorageBackend,
    storageLocationId: string,
    objectName: string,
  ): Promise<{
    success: boolean;
    error?: string;
    sizeBytes?: bigint;
    objectUrl?: string;
  }> {
    try {
      const head = await backend.head({ id: storageLocationId }, objectName);
      if (!head) {
        return {
          success: false,
          error: `Backup object not found: ${objectName}`,
        };
      }
      const sizeBytes = BigInt(head.size ?? 0);
      // Resolve the canonical objectUrl in two passes:
      //   1. If the backend has `getDownloadHandle` (Azure), use the SAS URL.
      //   2. Otherwise (Drive, or if the SAS mint fails), fall back to the
      //      same path-shape `<storageLocationId>/<objectName>` that the
      //      upload path returns (see google-drive-backend.ts:544 and Azure's
      //      blob-path equivalent). `parseBackupUrl()` accepts both shapes.
      let objectUrl: string | undefined;
      if (backend.getDownloadHandle) {
        try {
          const handle = await backend.getDownloadHandle(
            { id: storageLocationId },
            objectName,
            60,
          );
          objectUrl = handle.redirectUrl;
        } catch {
          // Non-fatal: fall through to the path-shape fallback below.
        }
      }
      if (!objectUrl) {
        objectUrl = `${storageLocationId}/${objectName}`;
      }
      getLogger("backup", "backup-executor").info(
        {
          storageLocationId,
          objectName,
          sizeBytes: sizeBytes.toString(),
          providerId: backend.providerId,
        },
        "Backup object verified in storage backend",
      );
      return { success: true, sizeBytes, objectUrl };
    } catch (error) {
      getLogger("backup", "backup-executor").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          storageLocationId,
          objectName,
        },
        "Failed to verify backup in storage backend",
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Update backup operation progress
   */
  private async updateBackupProgress(
    operationId: string,
    progressData: BackupProgressData,
  ): Promise<void> {
    try {
      await this.prisma.backupOperation.update({
        where: { id: operationId },
        data: {
          status: progressData.status,
          progress: progressData.progress,
          errorMessage: progressData.errorMessage,
          ...(progressData.status === "completed" && {
            completedAt: new Date(),
          }),
        },
      });

      getLogger("backup", "backup-executor").debug(
        {
          operationId,
          status: progressData.status,
          progress: progressData.progress,
          message: progressData.message,
        },
        "Backup progress updated",
      );

      // Emit progress via Socket.IO
      try {
        const eventData = {
          operationId,
          type: "backup" as const,
          status: progressData.status,
          progress: progressData.progress,
          message: progressData.message,
        };
        if (progressData.status === "completed" || progressData.status === "failed") {
          emitToChannel(Channel.POSTGRES, ServerEvent.POSTGRES_OPERATION_COMPLETED, {
            operationId,
            type: "backup",
            success: progressData.status === "completed",
            error: progressData.errorMessage,
          });
        } else {
          emitToChannel(Channel.POSTGRES, ServerEvent.POSTGRES_OPERATION, eventData);
        }
      } catch (emitError) {
        getLogger("backup", "backup-executor").error(
          { operationId, error: emitError instanceof Error ? emitError.message : emitError },
          "Failed to emit backup progress via socket",
        );
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

  /**
   * Map Prisma BackupOperation to BackupOperationInfo
   */
  private mapBackupOperationToInfo(
    operation: BackupOperation,
  ): BackupOperationInfo {
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

  /**
   * Clean up resources
   */
  public async shutdown(): Promise<void> {
    try {
      await this.backupQueue.close();
      getLogger("backup", "backup-executor").info("BackupExecutorService shut down successfully");
    } catch (error) {
      getLogger("backup", "backup-executor").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Error during BackupExecutorService shutdown",
      );
    }
  }
}
