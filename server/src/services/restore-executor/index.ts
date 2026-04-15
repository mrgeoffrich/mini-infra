import { PrismaClient } from "../../lib/prisma";
import { InMemoryQueue, Job as QueueJob } from "../../lib/in-memory-queue";
import { getLogger } from "../../lib/logger-factory";
import { DockerExecutorService } from "../docker-executor";
import { PostgresDatabaseManager } from "../postgres";
import { AzureStorageService } from "../azure-storage-service";
import { RestoreOperationInfo, DatabaseConnectionConfig } from "@mini-infra/types";
import type { RestoreOperation } from "../../generated/prisma/client";

import { BackupValidator } from "./backup-validator";
import { RollbackManager } from "./rollback-manager";
import { RestoreRunner, RESTORE_TIMEOUT_MS } from "./restore-runner";
import { resolveDatabaseNetworkName } from "../backup/database-network-resolver";
import { DbOperations } from "./db-operations";
import {
  parseBackupUrl,
  extractContainerFromUrl,
  extractBlobNameFromUrl,
  getStorageAccountFromConnectionString,
} from "./utils";

import type {
  RestoreJobData,
  RestoreProgressData,
  BackupValidationResult,
} from "./types";

// Re-export all types for consumers
export type { RestoreJobData, RestoreProgressData, BackupValidationResult };

// Re-export sub-modules for advanced usage
export { BackupValidator } from "./backup-validator";
export { RollbackManager } from "./rollback-manager";
export { RestoreRunner } from "./restore-runner";
export { DbOperations } from "./db-operations";

/**
 * RestoreExecutorService - Facade that preserves the original public API
 *
 * Delegates to focused sub-modules for each responsibility area.
 * All consumer import paths continue to work unchanged.
 *
 * Uses getter/setter on dependency fields so that sub-modules are rebuilt
 * whenever a dependency is replaced (including by tests that set it directly).
 */
export class RestoreExecutorService {
  private prisma: PrismaClient;
  private isInitialized = false;

  // Backing fields for getter/setter pattern
  private _dockerExecutor: DockerExecutorService;
  private _databaseConfigService: PostgresDatabaseManager;
  private _azureConfigService: AzureStorageService;
  private _restoreQueue: InMemoryQueue;

  // Sub-modules
  private backupValidator!: BackupValidator;
  private rollbackManager!: RollbackManager;
  private restoreRunner!: RestoreRunner;
  private dbOps!: DbOperations;

  // Retry configuration
  private static readonly MAX_RETRIES = 2;
  private static readonly RETRY_DELAY_MS = 60000; // 60 seconds

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this._dockerExecutor = new DockerExecutorService();
    this._databaseConfigService = new PostgresDatabaseManager(prisma);
    this._azureConfigService = new AzureStorageService(prisma);

    // Initialize in-memory queue
    this._restoreQueue = new InMemoryQueue("postgres-restore", {
      concurrency: 1, // Safer to restore one at a time
      defaultJobOptions: {
        attempts: RestoreExecutorService.MAX_RETRIES,
        backoff: {
          type: "exponential",
          delay: RestoreExecutorService.RETRY_DELAY_MS,
        },
        removeOnComplete: 10, // Keep last 10 completed jobs
        removeOnFail: 25, // Keep last 25 failed jobs
      },
    });

    this.rebuildSubModules();
    this.setupQueueProcessors();
  }

  // --- Getter/Setter pattern for test compatibility ---
  // Tests set `(service as any).dockerExecutor = mock` — the setter intercepts this.

  private get dockerExecutor(): DockerExecutorService {
    return this._dockerExecutor;
  }

  private set dockerExecutor(value: DockerExecutorService) {
    this._dockerExecutor = value;
    this.rebuildSubModules();
  }

  private get databaseConfigService(): PostgresDatabaseManager {
    return this._databaseConfigService;
  }

  private set databaseConfigService(value: PostgresDatabaseManager) {
    this._databaseConfigService = value;
    this.rebuildSubModules();
  }

  private get azureConfigService(): AzureStorageService {
    return this._azureConfigService;
  }

  private set azureConfigService(value: AzureStorageService) {
    this._azureConfigService = value;
    this.rebuildSubModules();
  }

  private get restoreQueue(): InMemoryQueue {
    return this._restoreQueue;
  }

  private set restoreQueue(value: InMemoryQueue) {
    this._restoreQueue = value;
  }

  /**
   * Rebuild all sub-modules with current backing field values.
   * Called whenever a dependency is replaced (e.g. by tests).
   */
  private rebuildSubModules(): void {
    this.backupValidator = new BackupValidator(this._azureConfigService);
    this.rollbackManager = new RollbackManager(
      this._dockerExecutor,
      this._azureConfigService,
    );
    this.dbOps = new DbOperations(
      this.prisma,
      this._databaseConfigService,
    );
    this.restoreRunner = new RestoreRunner(
      this._dockerExecutor,
      this._databaseConfigService,
      this._azureConfigService,
      this.backupValidator,
      this.rollbackManager,
      this.dbOps,
      this.prisma,
    );
  }

  // =====================================================================
  // Public API (identical to original)
  // =====================================================================

  /**
   * Initialize the restore executor service
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      getLogger("backup", "restore-executor").debug(
        "RestoreExecutorService already initialized, skipping",
      );
      return;
    }

    const startTime = Date.now();
    try {
      getLogger("backup", "restore-executor").info("Initializing RestoreExecutorService...");

      // Initialize Docker executor
      getLogger("backup", "restore-executor").debug(
        "Initializing Docker executor for restore operations",
      );
      try {
        await this._dockerExecutor.initialize();
        getLogger("backup", "restore-executor").debug("Docker executor initialized successfully");

        // Ensure database network exists (shared with backup)
        const networkName = await resolveDatabaseNetworkName(this.prisma);
        getLogger("backup", "restore-executor").debug(
          `Ensuring restore network exists: ${networkName}`,
        );
        await this._dockerExecutor.createNetwork(
          networkName,
          undefined,
          {
            driver: "bridge",
            labels: {
              "mini-infra.purpose": "postgres-backup",
            },
          },
        );
        getLogger("backup", "restore-executor").debug("Restore network ready");
      } catch (dockerError) {
        getLogger("backup", "restore-executor").warn(
          {
            error:
              dockerError instanceof Error
                ? dockerError.message
                : "Unknown error",
          },
          "Failed to initialize Docker executor - restore operations will be unavailable until Docker is configured",
        );
        // Continue initialization without Docker - restore operations will fail gracefully when attempted
      }

      getLogger("backup", "restore-executor").info(
        {
          initializationTimeMs: Date.now() - startTime,
          queueConcurrency: 1,
          maxRetries: RestoreExecutorService.MAX_RETRIES,
          timeoutMs: RESTORE_TIMEOUT_MS,
        },
        "RestoreExecutorService initialized successfully",
      );
      this.isInitialized = true;
    } catch (error) {
      getLogger("backup", "restore-executor").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          initializationTimeMs: Date.now() - startTime,
        },
        "Failed to initialize RestoreExecutorService",
      );
      throw error;
    }
  }

  /**
   * Queue a restore operation
   */
  public async queueRestore(
    databaseId: string,
    backupUrl: string,
    userId: string,
    targetDatabaseName?: string,
  ): Promise<RestoreOperationInfo> {
    if (!this.isInitialized) {
      getLogger("backup", "restore-executor").debug(
        "RestoreExecutorService not initialized, initializing now",
      );
      await this.initialize();
    }

    const startTime = Date.now();
    try {
      getLogger("backup", "restore-executor").info(
        {
          databaseId,
          backupUrl,
          userId,
        },
        "Queueing new restore operation",
      );

      // Create restore operation record
      const restoreOperation = await this.prisma.restoreOperation.create({
        data: {
          databaseId,
          backupUrl,
          status: "pending",
          progress: 0,
        },
      });

      getLogger("backup", "restore-executor").info(
        {
          operationId: restoreOperation.id,
          databaseId,
          backupUrl,
          userId,
          queueingTimeMs: Date.now() - startTime,
        },
        "Restore operation created and queued successfully",
      );

      // Add job to queue
      await this._restoreQueue.add(
        "execute-restore",
        {
          restoreOperationId: restoreOperation.id,
          databaseId,
          backupUrl,
          userId,
          targetDatabaseName,
        },
        {
          delay: 0, // Execute immediately
        },
      );

      getLogger("backup", "restore-executor").debug(
        {
          operationId: restoreOperation.id,
          queuePosition: this._restoreQueue.getStats().total,
        },
        "Job added to restore queue",
      );

      return this.mapRestoreOperationToInfo(restoreOperation);
    } catch (error) {
      getLogger("backup", "restore-executor").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          databaseId,
          backupUrl,
          userId,
          queueingTimeMs: Date.now() - startTime,
        },
        "Failed to queue restore operation",
      );
      throw error;
    }
  }

  /**
   * Get restore operation status
   */
  public async getRestoreStatus(
    operationId: string,
  ): Promise<RestoreOperationInfo | null> {
    try {
      const operation = await this.prisma.restoreOperation.findUnique({
        where: { id: operationId },
      });

      if (!operation) {
        return null;
      }

      return this.mapRestoreOperationToInfo(operation);
    } catch (error) {
      getLogger("backup", "restore-executor").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          operationId,
        },
        "Failed to get restore status",
      );
      throw error;
    }
  }

  /**
   * Cancel a restore operation
   */
  public async cancelRestore(operationId: string): Promise<boolean> {
    try {
      // Update database status
      const operation = await this.prisma.restoreOperation.findUnique({
        where: { id: operationId },
      });

      if (!operation || operation.status === "completed") {
        return false;
      }

      await this.updateRestoreProgress(operationId, {
        status: "failed",
        progress: operation.progress,
        errorMessage: "Operation cancelled by user",
      });

      // Try to cancel the job in the queue
      const jobs = await this._restoreQueue.getJobs<RestoreJobData>(["pending", "active"]);
      const job = jobs.find(
        (j) => j.data.restoreOperationId === operationId,
      );

      if (job) {
        await this._restoreQueue.remove(job.id);
        getLogger("backup", "restore-executor").info(
          { operationId, jobId: job.id },
          "Restore job cancelled",
        );
      }

      return true;
    } catch (error) {
      getLogger("backup", "restore-executor").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          operationId,
        },
        "Failed to cancel restore operation",
      );
      return false;
    }
  }

  /**
   * Clean up resources
   */
  public async shutdown(): Promise<void> {
    try {
      await this._restoreQueue.close();
      getLogger("backup", "restore-executor").info("RestoreExecutorService shut down successfully");
    } catch (error) {
      getLogger("backup", "restore-executor").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Error during RestoreExecutorService shutdown",
      );
    }
  }

  // =====================================================================
  // Queue processors (stays on facade — arrow callbacks capture `this`)
  // =====================================================================

  private setupQueueProcessors(): void {
    // Process restore jobs
    this._restoreQueue.process<RestoreJobData>(
      "execute-restore",
      async (job) => {
        const {
          restoreOperationId,
          databaseId,
          backupUrl,
          userId,
          targetDatabaseName,
        } = job.data;

        getLogger("backup", "restore-executor").info(
          {
            jobId: job.id,
            operationId: restoreOperationId,
            databaseId,
            backupUrl,
            targetDatabaseName,
          },
          "Starting restore job processing",
        );

        try {
          await this.executeRestore(
            restoreOperationId,
            databaseId,
            backupUrl,
            userId,
            targetDatabaseName,
          );
        } catch (error) {
          getLogger("backup", "restore-executor").error(
            {
              jobId: job.id,
              operationId: restoreOperationId,
              error: error instanceof Error ? error.message : "Unknown error",
            },
            "Restore job failed",
          );

          // Update status to failed
          await this.updateRestoreProgress(restoreOperationId, {
            status: "failed",
            progress: 0,
            errorMessage:
              error instanceof Error ? error.message : "Unknown error",
          });

          throw error;
        }
      },
    );

    // Handle job events
    this._restoreQueue.on("completed", (job: QueueJob<RestoreJobData>,result: unknown) => {
      getLogger("backup", "restore-executor").info(
        {
          jobId: job.id,
          operationId: job.data.restoreOperationId,
          result,
        },
        "Restore job completed",
      );
    });

    this._restoreQueue.on("failed", (job: QueueJob<RestoreJobData>,error: Error) => {
      getLogger("backup", "restore-executor").error(
        {
          jobId: job.id,
          operationId: job.data.restoreOperationId,
          error: (error instanceof Error ? error.message : String(error)),
        },
        "Restore job failed permanently",
      );
    });
  }

  // =====================================================================
  // Private forwarding methods for test compatibility
  // Tests call these via `(service as any).methodName(...)`
  // =====================================================================

  private async executeRestore(
    operationId: string,
    databaseId: string,
    backupUrl: string,
    userId: string,
    targetDatabaseName?: string,
  ): Promise<void> {
    return this.restoreRunner.executeRestore(
      operationId,
      databaseId,
      backupUrl,
      userId,
      targetDatabaseName,
    );
  }

  private async validateBackupFile(
    backupUrl: string,
    databaseId?: string,
  ): Promise<BackupValidationResult> {
    return this.backupValidator.validateBackupFile(backupUrl, databaseId);
  }

  private parseBackupUrl(
    backupUrl: string,
  ): { containerName: string; blobName: string } {
    return parseBackupUrl(backupUrl);
  }

  private extractContainerFromUrl(backupUrl: string): string {
    return extractContainerFromUrl(backupUrl);
  }

  private extractBlobNameFromUrl(backupUrl: string): string {
    return extractBlobNameFromUrl(backupUrl);
  }

  private getStorageAccountFromConnectionString(
    connectionString: string,
  ): string {
    return getStorageAccountFromConnectionString(connectionString);
  }

  private async getRestoreDockerImage(): Promise<string> {
    return this.dbOps.getRestoreDockerImage();
  }

  private async createRollbackBackup(
    connectionConfig: DatabaseConnectionConfig,
    azureConnectionString: string,
    dockerImage: string,
    databaseName: string,
    backupUrl: string,
    networkMode?: string,
  ): Promise<string> {
    return this.rollbackManager.createRollbackBackup(
      connectionConfig,
      azureConnectionString,
      dockerImage,
      databaseName,
      backupUrl,
      networkMode,
    );
  }

  private async executeRollback(
    connectionConfig: DatabaseConnectionConfig,
    rollbackBackupUrl: string,
    azureConnectionString: string,
    dockerImage: string,
    networkMode?: string,
  ): Promise<void> {
    return this.rollbackManager.executeRollback(
      connectionConfig,
      rollbackBackupUrl,
      azureConnectionString,
      dockerImage,
      networkMode,
    );
  }

  private async verifyRestoredDatabase(connectionConfig: DatabaseConnectionConfig): Promise<{
    isValid: boolean;
    error?: string;
  }> {
    return this.dbOps.verifyRestoredDatabase(connectionConfig);
  }

  private async cleanupRollbackBackup(
    rollbackBackupUrl: string,
  ): Promise<void> {
    return this.rollbackManager.cleanupRollbackBackup(rollbackBackupUrl);
  }

  private async updateRestoreProgress(
    operationId: string,
    progressData: RestoreProgressData,
  ): Promise<void> {
    return this.dbOps.updateRestoreProgress(operationId, progressData);
  }

  private mapRestoreOperationToInfo(
    operation: RestoreOperation,
  ): RestoreOperationInfo {
    return this.dbOps.mapRestoreOperationToInfo(operation);
  }
}
