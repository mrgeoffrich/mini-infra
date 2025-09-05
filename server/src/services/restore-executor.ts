import { PrismaClient } from "../generated/prisma";
import Bull from "bull";
import { servicesLogger } from "../lib/logger-factory";
import { DockerExecutorService } from "./docker-executor";
import { DatabaseConfigService } from "./postgres-config";
import { AzureConfigService } from "./azure-config";
import { BlobServiceClient } from "@azure/storage-blob";
import {
  RestoreOperationInfo,
  RestoreOperationStatus,
} from "@mini-infra/types";
import type { RestoreOperation } from "../generated/prisma";

/**
 * Job data structure for restore operations
 */
export interface RestoreJobData {
  restoreOperationId: string;
  databaseId: string;
  backupUrl: string;
  userId: string;
}

/**
 * Progress update data for restore operations
 */
export interface RestoreProgressData {
  status: RestoreOperationStatus;
  progress: number;
  message?: string;
  errorMessage?: string;
}

/**
 * Backup file validation result
 */
export interface BackupValidationResult {
  isValid: boolean;
  error?: string;
  sizeBytes?: number;
  lastModified?: Date;
  metadata?: Record<string, any>;
}

/**
 * RestoreExecutorService handles database restore operations from Azure backups
 */
export class RestoreExecutorService {
  private prisma: PrismaClient;
  private dockerExecutor: DockerExecutorService;
  private databaseConfigService: DatabaseConfigService;
  private azureConfigService: AzureConfigService;
  private restoreQueue: Bull.Queue<RestoreJobData>;
  private isInitialized = false;

  // Timeout for restore operations (3 hours)
  private static readonly RESTORE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

  // Retry configuration
  private static readonly MAX_RETRIES = 2;
  private static readonly RETRY_DELAY_MS = 60000; // 60 seconds

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.dockerExecutor = new DockerExecutorService();
    this.databaseConfigService = new DatabaseConfigService(prisma);
    this.azureConfigService = new AzureConfigService(prisma);

    // Initialize Bull queue (using in-memory for development, Redis for production)
    this.restoreQueue = new Bull("postgres-restore", {
      redis: process.env.REDIS_URL || undefined,
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

    this.setupQueueProcessors();
  }

  /**
   * Initialize the restore executor service
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Initialize Docker executor
      await this.dockerExecutor.initialize();

      servicesLogger().info("RestoreExecutorService initialized successfully");
      this.isInitialized = true;
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
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
  ): Promise<RestoreOperationInfo> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
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
        },
        "Restore operation created and queued",
      );

      // Add job to queue
      await this.restoreQueue.add(
        "execute-restore",
        {
          restoreOperationId: restoreOperation.id,
          databaseId,
          backupUrl,
          userId,
        },
        {
          delay: 0, // Execute immediately
        },
      );

      return this.mapRestoreOperationToInfo(restoreOperation);
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          databaseId,
          backupUrl,
          userId,
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
      const jobs = await this.restoreQueue.getJobs(["waiting", "active"]);
      const job = jobs.find((j) => j.data.restoreOperationId === operationId);

      if (job) {
        await job.remove();
        servicesLogger().info({ operationId, jobId: job.id }, "Restore job cancelled");
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
   * Setup queue processors
   */
  private setupQueueProcessors(): void {
    // Process restore jobs
    this.restoreQueue.process("execute-restore", async (job) => {
      const { restoreOperationId, databaseId, backupUrl, userId } = job.data;

      servicesLogger().info(
        {
          jobId: job.id,
          operationId: restoreOperationId,
          databaseId,
          backupUrl,
        },
        "Starting restore job processing",
      );

      try {
        await this.executeRestore(
          restoreOperationId,
          databaseId,
          backupUrl,
          userId,
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
    });

    // Handle job events
    this.restoreQueue.on("completed", (job, result) => {
      servicesLogger().info(
        {
          jobId: job.id,
          operationId: job.data.restoreOperationId,
          result,
        },
        "Restore job completed",
      );
    });

    this.restoreQueue.on("failed", (job, error) => {
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

  /**
   * Execute restore operation
   */
  private async executeRestore(
    operationId: string,
    databaseId: string,
    backupUrl: string,
    userId: string,
  ): Promise<void> {
    let rollbackInitiated = false;

    try {
      // Update status to running
      await this.updateRestoreProgress(operationId, {
        status: "running",
        progress: 5,
        message: "Preparing restore operation",
      });

      // Get database configuration
      const database = await this.databaseConfigService.getDatabaseById(
        databaseId,
        userId,
      );
      if (!database) {
        throw new Error("Database not found or access denied");
      }

      await this.updateRestoreProgress(operationId, {
        status: "running",
        progress: 10,
        message: "Validating backup file",
      });

      // Validate backup file before restore
      const validationResult = await this.validateBackupFile(backupUrl);
      if (!validationResult.isValid) {
        throw new Error(`Backup validation failed: ${validationResult.error}`);
      }

      await this.updateRestoreProgress(operationId, {
        status: "running",
        progress: 20,
        message: "Getting system settings",
      });

      // Get system settings for Docker image
      const dockerImage = await this.getRestoreDockerImage();

      // Get Azure connection string
      const azureConnectionString =
        await this.azureConfigService.get("connection_string");
      if (!azureConnectionString) {
        throw new Error("Azure connection string not configured");
      }

      // Get database connection details
      const connectionConfig =
        await this.databaseConfigService.getConnectionConfig(
          databaseId,
          userId,
        );

      await this.updateRestoreProgress(operationId, {
        status: "running",
        progress: 30,
        message: "Starting pre-restore backup for rollback",
      });

      // Create a pre-restore backup for rollback purposes
      const rollbackBackupUrl = await this.createRollbackBackup(
        connectionConfig,
        azureConnectionString,
        dockerImage,
        database.database,
      );

      await this.updateRestoreProgress(operationId, {
        status: "running",
        progress: 40,
        message: "Starting restore container",
      });

      // Execute restore using Docker
      const containerResult =
        await this.dockerExecutor.executeContainerWithProgress(
          {
            image: dockerImage,
            env: {
              POSTGRES_HOST: connectionConfig.host,
              POSTGRES_USER: connectionConfig.username,
              POSTGRES_PASSWORD: connectionConfig.password,
              POSTGRES_DATABASE: connectionConfig.database,
              AZURE_STORAGE_ACCOUNT_CONNECTION_STRING: azureConnectionString,
              AZURE_CONTAINER_NAME: this.extractContainerFromUrl(backupUrl),
              RESTORE: "yes",
              DROP_PUBLIC: "yes",
              BACKUP_FILE_URL: backupUrl,
            },
            timeout: RestoreExecutorService.RESTORE_TIMEOUT_MS,
          },
          (progress) => {
            // Update progress based on container status
            let progressValue = 50;
            let message = "Executing restore";

            switch (progress.status) {
              case "starting":
                progressValue = 50;
                message = "Starting restore container";
                break;
              case "running":
                progressValue = 70;
                message = "Restoring database";
                break;
              case "completed":
                progressValue = 85;
                message = "Restore completed, verifying database";
                break;
              case "failed":
                throw new Error(
                  progress.errorMessage || "Container execution failed",
                );
            }

            this.updateRestoreProgress(operationId, {
              status: "running",
              progress: progressValue,
              message,
            });
          },
        );

      if (containerResult.exitCode !== 0) {
        rollbackInitiated = true;
        await this.updateRestoreProgress(operationId, {
          status: "running",
          progress: 85,
          message: "Restore failed, initiating rollback",
        });

        // Execute rollback
        await this.executeRollback(
          connectionConfig,
          rollbackBackupUrl,
          azureConnectionString,
          dockerImage,
        );

        throw new Error(
          `Restore failed and rollback completed: ${containerResult.stderr || containerResult.stdout}`,
        );
      }

      await this.updateRestoreProgress(operationId, {
        status: "running",
        progress: 90,
        message: "Verifying restored database",
      });

      // Verify the restored database
      const verificationResult =
        await this.verifyRestoredDatabase(connectionConfig);
      if (!verificationResult.isValid) {
        rollbackInitiated = true;
        await this.updateRestoreProgress(operationId, {
          status: "running",
          progress: 90,
          message: "Database verification failed, initiating rollback",
        });

        // Execute rollback
        await this.executeRollback(
          connectionConfig,
          rollbackBackupUrl,
          azureConnectionString,
          dockerImage,
        );

        throw new Error(
          `Database verification failed and rollback completed: ${verificationResult.error}`,
        );
      }

      // Clean up rollback backup on success
      await this.cleanupRollbackBackup(rollbackBackupUrl);

      // Update restore operation with success status
      await this.updateRestoreProgress(operationId, {
        status: "completed",
        progress: 100,
        message: rollbackInitiated
          ? "Restore failed but rollback completed successfully"
          : "Restore completed successfully",
      });

      // Update completion timestamp
      await this.prisma.restoreOperation.update({
        where: { id: operationId },
        data: {
          completedAt: new Date(),
        },
      });

      servicesLogger().info(
        {
          operationId,
          databaseId,
          backupUrl,
          rollbackInitiated,
        },
        "Restore operation completed",
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        {
          operationId,
          databaseId,
          backupUrl,
          error: errorMessage,
          rollbackInitiated,
        },
        "Restore operation failed",
      );

      await this.updateRestoreProgress(operationId, {
        status: "failed",
        progress: rollbackInitiated ? 100 : 0,
        errorMessage,
      });

      throw error;
    }
  }

  /**
   * Validate backup file before restore
   */
  private async validateBackupFile(
    backupUrl: string,
  ): Promise<BackupValidationResult> {
    try {
      const azureConnectionString =
        await this.azureConfigService.get("connection_string");
      if (!azureConnectionString) {
        return {
          isValid: false,
          error: "Azure connection string not configured",
        };
      }

      const blobServiceClient = BlobServiceClient.fromConnectionString(
        azureConnectionString,
      );

      // Parse backup URL to get container and blob name
      const { containerName, blobName } = this.parseBackupUrl(backupUrl);
      const blobClient = blobServiceClient
        .getContainerClient(containerName)
        .getBlobClient(blobName);

      // Check if blob exists and get properties
      const exists = await blobClient.exists();
      if (!exists) {
        return {
          isValid: false,
          error: "Backup file not found in Azure Storage",
        };
      }

      const properties = await blobClient.getProperties();

      // Basic validation - check file size and last modified
      const sizeBytes = properties.contentLength || 0;
      if (sizeBytes < 100) {
        // Backup files should be at least 100 bytes
        return {
          isValid: false,
          error: "Backup file appears to be too small or corrupted",
        };
      }

      // Check if file is not too old (configurable threshold)
      const maxAgeInDays = 365; // 1 year
      const lastModified = properties.lastModified || new Date();
      const ageInMs = Date.now() - lastModified.getTime();
      const ageInDays = ageInMs / (1000 * 60 * 60 * 24);

      if (ageInDays > maxAgeInDays) {
        servicesLogger().warn(
          {
            backupUrl,
            ageInDays: Math.round(ageInDays),
            maxAgeInDays,
          },
          "Warning: Backup file is quite old",
        );
      }

      servicesLogger().info(
        {
          backupUrl,
          sizeBytes,
          lastModified: lastModified.toISOString(),
          contentType: properties.contentType,
        },
        "Backup file validated successfully",
      );

      return {
        isValid: true,
        sizeBytes,
        lastModified,
        metadata: {
          contentType: properties.contentType,
          etag: properties.etag,
          contentEncoding: properties.contentEncoding,
        },
      };
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          backupUrl,
        },
        "Failed to validate backup file",
      );

      return {
        isValid: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Create a rollback backup before restore
   */
  private async createRollbackBackup(
    connectionConfig: any,
    azureConnectionString: string,
    dockerImage: string,
    databaseName: string,
  ): Promise<string> {
    try {
      servicesLogger().info(
        { databaseName },
        "Creating pre-restore backup for rollback purposes",
      );

      // Generate unique container name and path for rollback backup
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rollbackContainerName = "rollback-backups";
      const rollbackPathPrefix = `${databaseName}/rollback-${timestamp}`;

      // Execute backup for rollback purposes
      const containerResult = await this.dockerExecutor.executeContainer({
        image: dockerImage,
        env: {
          POSTGRES_HOST: connectionConfig.host,
          POSTGRES_USER: connectionConfig.username,
          POSTGRES_PASSWORD: connectionConfig.password,
          POSTGRES_DATABASE: connectionConfig.database,
          AZURE_STORAGE_ACCOUNT_CONNECTION_STRING: azureConnectionString,
          AZURE_CONTAINER_NAME: rollbackContainerName,
          BACKUP_PATH_PREFIX: rollbackPathPrefix,
        },
        timeout: 30 * 60 * 1000, // 30 minutes for rollback backup
      });

      if (containerResult.exitCode !== 0) {
        throw new Error(
          `Failed to create rollback backup: ${containerResult.stderr}`,
        );
      }

      const rollbackBackupUrl = `https://${this.getStorageAccountFromConnectionString(azureConnectionString)}.blob.core.windows.net/${rollbackContainerName}/${rollbackPathPrefix}`;

      servicesLogger().info(
        { rollbackBackupUrl, databaseName },
        "Rollback backup created successfully",
      );

      return rollbackBackupUrl;
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          databaseName,
        },
        "Failed to create rollback backup",
      );
      throw error;
    }
  }

  /**
   * Execute rollback using the pre-restore backup
   */
  private async executeRollback(
    connectionConfig: any,
    rollbackBackupUrl: string,
    azureConnectionString: string,
    dockerImage: string,
  ): Promise<void> {
    try {
      servicesLogger().info(
        { rollbackBackupUrl },
        "Executing rollback to pre-restore state",
      );

      const { containerName } = this.parseBackupUrl(rollbackBackupUrl);

      const containerResult = await this.dockerExecutor.executeContainer({
        image: dockerImage,
        env: {
          POSTGRES_HOST: connectionConfig.host,
          POSTGRES_USER: connectionConfig.username,
          POSTGRES_PASSWORD: connectionConfig.password,
          POSTGRES_DATABASE: connectionConfig.database,
          AZURE_STORAGE_ACCOUNT_CONNECTION_STRING: azureConnectionString,
          AZURE_CONTAINER_NAME: containerName,
          RESTORE: "yes",
          DROP_PUBLIC: "yes",
          BACKUP_FILE_URL: rollbackBackupUrl,
        },
        timeout: 60 * 60 * 1000, // 1 hour for rollback
      });

      if (containerResult.exitCode !== 0) {
        throw new Error(`Rollback execution failed: ${containerResult.stderr}`);
      }

      servicesLogger().info({ rollbackBackupUrl }, "Rollback executed successfully");
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          rollbackBackupUrl,
        },
        "Failed to execute rollback",
      );
      throw error;
    }
  }

  /**
   * Verify restored database integrity
   */
  private async verifyRestoredDatabase(connectionConfig: any): Promise<{
    isValid: boolean;
    error?: string;
  }> {
    try {
      // Basic connection and query test
      const validationResult =
        await this.databaseConfigService.testConnection(connectionConfig);

      if (!validationResult.isValid) {
        return {
          isValid: false,
          error: `Database connection failed: ${validationResult.message}`,
        };
      }

      servicesLogger().info(
        { database: connectionConfig.database },
        "Restored database verified successfully",
      );

      return { isValid: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        {
          error: errorMessage,
          database: connectionConfig.database,
        },
        "Failed to verify restored database",
      );

      return {
        isValid: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Clean up rollback backup after successful restore
   */
  private async cleanupRollbackBackup(
    rollbackBackupUrl: string,
  ): Promise<void> {
    try {
      const azureConnectionString =
        await this.azureConfigService.get("connection_string");
      if (!azureConnectionString) {
        servicesLogger().warn("Azure connection string not available for cleanup");
        return;
      }

      const blobServiceClient = BlobServiceClient.fromConnectionString(
        azureConnectionString,
      );

      const { containerName, blobName } =
        this.parseBackupUrl(rollbackBackupUrl);
      const blobClient = blobServiceClient
        .getContainerClient(containerName)
        .getBlobClient(blobName);

      await blobClient.deleteIfExists();

      servicesLogger().info(
        { rollbackBackupUrl },
        "Rollback backup cleaned up successfully",
      );
    } catch (error) {
      // Log but don't throw - cleanup failure shouldn't fail the restore
      servicesLogger().warn(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          rollbackBackupUrl,
        },
        "Failed to clean up rollback backup",
      );
    }
  }

  /**
   * Get restore Docker image from system settings
   */
  private async getRestoreDockerImage(): Promise<string> {
    try {
      // Try to get from system settings first
      const setting = await this.prisma.systemSettings.findFirst({
        where: {
          category: "postgres",
          key: "restore_docker_image",
        },
      });

      if (setting?.value) {
        return setting.value;
      }

      // Fallback to backup image setting
      const backupSetting = await this.prisma.systemSettings.findFirst({
        where: {
          category: "postgres",
          key: "backup_docker_image",
        },
      });

      if (backupSetting?.value) {
        return backupSetting.value;
      }

      // Default fallback
      return "postgres:15-alpine";
    } catch (error) {
      servicesLogger().warn(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get restore Docker image from settings, using default",
      );
      return "postgres:15-alpine";
    }
  }

  /**
   * Parse backup URL to extract container name and blob name
   */
  private parseBackupUrl(backupUrl: string): {
    containerName: string;
    blobName: string;
  } {
    try {
      const url = new URL(backupUrl);
      const pathParts = url.pathname.substring(1).split("/"); // Remove leading slash
      const containerName = pathParts[0];
      const blobName = pathParts.slice(1).join("/");

      return { containerName, blobName };
    } catch (error) {
      throw new Error(`Invalid backup URL format: ${backupUrl}`);
    }
  }

  /**
   * Extract container name from backup URL
   */
  private extractContainerFromUrl(backupUrl: string): string {
    const { containerName } = this.parseBackupUrl(backupUrl);
    return containerName;
  }

  /**
   * Extract storage account name from connection string
   */
  private getStorageAccountFromConnectionString(
    connectionString: string,
  ): string {
    try {
      const accountNameMatch = connectionString.match(/AccountName=([^;]+)/);
      if (accountNameMatch) {
        return accountNameMatch[1];
      }
      throw new Error("AccountName not found in connection string");
    } catch (error) {
      throw new Error("Failed to parse Azure storage account name");
    }
  }

  /**
   * Update restore operation progress
   */
  private async updateRestoreProgress(
    operationId: string,
    progressData: RestoreProgressData,
  ): Promise<void> {
    try {
      await this.prisma.restoreOperation.update({
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

      servicesLogger().debug(
        {
          operationId,
          status: progressData.status,
          progress: progressData.progress,
          message: progressData.message,
        },
        "Restore progress updated",
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          operationId,
          progressData,
        },
        "Failed to update restore progress",
      );
    }
  }

  /**
   * Map Prisma RestoreOperation to RestoreOperationInfo
   */
  private mapRestoreOperationToInfo(
    operation: RestoreOperation,
  ): RestoreOperationInfo {
    return {
      id: operation.id,
      databaseId: operation.databaseId,
      backupUrl: operation.backupUrl,
      status: operation.status as RestoreOperationStatus,
      startedAt: operation.startedAt.toISOString(),
      completedAt: operation.completedAt?.toISOString() || null,
      errorMessage: operation.errorMessage,
      progress: operation.progress,
    };
  }

  /**
   * Clean up resources
   */
  public async shutdown(): Promise<void> {
    try {
      await this.restoreQueue.close();
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
}
