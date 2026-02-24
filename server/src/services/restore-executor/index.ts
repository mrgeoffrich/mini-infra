import prisma, { PrismaClient } from "../../lib/prisma";
import {
  InMemoryQueue,
  Job as QueueJob,
  QueueOptions,
} from "../../lib/in-memory-queue";
import { servicesLogger, dockerExecutorLogger } from "../../lib/logger-factory";
import { DockerExecutorService } from "../docker-executor";
import { PostgresDatabaseManager } from "../postgres";
import { PostgresSettingsConfigService } from "../postgres";
import { AzureStorageService } from "../azure-storage-service";
import {
  RestoreOperationInfo,
  RestoreOperationStatus,
} from "@mini-infra/types";
import type { RestoreOperation } from "@prisma/client";

import { BackupValidator } from "./backup-validator";
import { RollbackManager } from "./rollback-manager";
import { RestoreRunner, RESTORE_TIMEOUT_MS, RESTORE_NETWORK_NAME } from "./restore-runner";
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
  private prisma: typeof prisma;
  private postgresSettingsConfigService: PostgresSettingsConfigService;
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
    this.postgresSettingsConfigService = new PostgresSettingsConfigService(
      prisma,
    );
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
      this.postgresSettingsConfigService,
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
      servicesLogger().debug(
        "RestoreExecutorService already initialized, skipping",
      );
      return;
    }

    const startTime = Date.now();
    try {
      servicesLogger().info("Initializing RestoreExecutorService...");

      // Initialize Docker executor
      servicesLogger().debug(
        "Initializing Docker executor for restore operations",
      );
      try {
        await this._dockerExecutor.initialize();
        servicesLogger().debug("Docker executor initialized successfully");

        // Create dedicated restore network (shared with backup)
        servicesLogger().debug(
          `Ensuring restore network exists: ${RESTORE_NETWORK_NAME}`,
        );
        await this._dockerExecutor.createNetwork(
          RESTORE_NETWORK_NAME,
          undefined,
          {
            driver: "bridge",
            labels: {
              "mini-infra.purpose": "postgres-backup",
            },
          },
        );
        servicesLogger().debug("Restore network ready");
      } catch (dockerError) {
        servicesLogger().warn(
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

      servicesLogger().info(
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
      servicesLogger().error(
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
      servicesLogger().debug(
        "RestoreExecutorService not initialized, initializing now",
      );
      await this.initialize();
    }

    const startTime = Date.now();
    try {
      servicesLogger().info(
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

      servicesLogger().info(
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

      servicesLogger().debug(
        {
          operationId: restoreOperation.id,
          queuePosition: this._restoreQueue.getStats().total,
        },
        "Job added to restore queue",
      );

      return this.mapRestoreOperationToInfo(restoreOperation);
    } catch (error) {
      servicesLogger().error(
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
      servicesLogger().error(
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
      const jobs = await this._restoreQueue.getJobs(["pending", "active"]);
      const job = jobs.find(
        (j) => j.data.restoreOperationId === operationId,
      );

      if (job) {
        await this._restoreQueue.remove(job.id);
        servicesLogger().info(
          { operationId, jobId: job.id },
          "Restore job cancelled",
        );
      }

      return true;
    } catch (error) {
      servicesLogger().error(
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
      servicesLogger().info("RestoreExecutorService shut down successfully");
    } catch (error) {
      servicesLogger().error(
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
    this._restoreQueue.process(
      "execute-restore",
      async (job: QueueJob) => {
        const {
          restoreOperationId,
          databaseId,
          backupUrl,
          userId,
          targetDatabaseName,
        } = job.data;

        servicesLogger().info(
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
          servicesLogger().error(
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
    this._restoreQueue.on("completed", (job: QueueJob, result: any) => {
      servicesLogger().info(
        {
          jobId: job.id,
          operationId: job.data.restoreOperationId,
          result,
        },
        "Restore job completed",
      );
    });

    this._restoreQueue.on("failed", (job: QueueJob, error: Error) => {
      servicesLogger().error(
        {
          jobId: job.id,
          operationId: job.data.restoreOperationId,
          error: error.message,
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
    connectionConfig: any,
    azureConnectionString: string,
    dockerImage: string,
    databaseName: string,
    backupUrl: string,
  ): Promise<string> {
    return this.rollbackManager.createRollbackBackup(
      connectionConfig,
      azureConnectionString,
      dockerImage,
      databaseName,
      backupUrl,
    );
  }

  private async executeRollback(
    connectionConfig: any,
    rollbackBackupUrl: string,
    azureConnectionString: string,
    dockerImage: string,
  ): Promise<void> {
    return this.rollbackManager.executeRollback(
      connectionConfig,
      rollbackBackupUrl,
      azureConnectionString,
      dockerImage,
    );
  }

  private async verifyRestoredDatabase(connectionConfig: any): Promise<{
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
