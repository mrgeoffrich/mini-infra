import prisma from "../lib/prisma";
import Bull from "bull";
import { servicesLogger } from "../lib/logger-factory";
import { DockerExecutorService } from "./docker-executor";
import { BackupConfigService } from "./backup-config";
import { DatabaseConfigService } from "./postgres-config";
import { AzureConfigService } from "./azure-config";
import { BlobServiceClient } from "@azure/storage-blob";
import {
  BackupOperationInfo,
  BackupOperationType,
  BackupOperationStatus,
} from "@mini-infra/types";
import type { BackupOperation } from "../generated/prisma";

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
  private prisma: PrismaClient;
  private dockerExecutor: DockerExecutorService;
  private backupConfigService: BackupConfigService;
  private databaseConfigService: DatabaseConfigService;
  private azureConfigService: AzureConfigService;
  private backupQueue: Bull.Queue<BackupJobData>;
  private isInitialized = false;

  // Timeout for backup operations (2 hours)
  private static readonly BACKUP_TIMEOUT_MS = 2 * 60 * 60 * 1000;

  // Retry configuration
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAY_MS = 30000; // 30 seconds

  constructor(prisma: typeof prisma) {
    this.prisma = prisma;
    this.dockerExecutor = new DockerExecutorService();
    this.backupConfigService = new BackupConfigService(prisma);
    this.databaseConfigService = new DatabaseConfigService(prisma);
    this.azureConfigService = new AzureConfigService(prisma);

    // Initialize Bull queue (using in-memory for development, Redis for production)
    this.backupQueue = new Bull("postgres-backup", {
      redis: process.env.REDIS_URL || undefined,
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
      return;
    }

    try {
      // Initialize Docker executor
      await this.dockerExecutor.initialize();

      servicesLogger().info("BackupExecutorService initialized successfully");
      this.isInitialized = true;
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
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
      await this.initialize();
    }

    try {
      // Create backup operation record
      const backupOperation = await this.prisma.backupOperation.create({
        data: {
          databaseId,
          operationType,
          status: "pending",
          progress: 0,
        },
      });

      servicesLogger().info(
        {
          operationId: backupOperation.id,
          databaseId,
          operationType,
          userId,
        },
        "Backup operation created and queued",
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

      return this.mapBackupOperationToInfo(backupOperation);
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          databaseId,
          operationType,
          userId,
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
      servicesLogger().error(
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
      const jobs = await this.backupQueue.getJobs(["waiting", "active"]);
      const job = jobs.find((j) => j.data.backupOperationId === operationId);

      if (job) {
        await job.remove();
        servicesLogger().info({ operationId, jobId: job.id }, "Backup job cancelled");
      }

      return true;
    } catch (error) {
      servicesLogger().error(
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
    this.backupQueue.process("execute-backup", async (job) => {
      const { backupOperationId, databaseId, userId } = job.data;

      servicesLogger().info(
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
        servicesLogger().error(
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
    this.backupQueue.on("completed", (job, result) => {
      servicesLogger().info(
        {
          jobId: job.id,
          operationId: job.data.backupOperationId,
          result,
        },
        "Backup job completed",
      );
    });

    this.backupQueue.on("failed", (job, error) => {
      servicesLogger().error(
        {
          jobId: job.id,
          operationId: job.data.backupOperationId,
          error: error.message,
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
    try {
      // Update status to running
      await this.updateBackupProgress(operationId, {
        status: "running",
        progress: 10,
        message: "Preparing backup operation",
      });

      // Get database configuration
      const database = await this.databaseConfigService.getDatabaseById(
        databaseId,
        userId,
      );
      if (!database) {
        throw new Error("Database not found or access denied");
      }

      // Get backup configuration
      const backupConfig =
        await this.backupConfigService.getBackupConfigByDatabaseId(
          databaseId,
          userId,
        );
      if (!backupConfig) {
        throw new Error("Backup configuration not found");
      }

      await this.updateBackupProgress(operationId, {
        status: "running",
        progress: 20,
        message: "Getting system settings",
      });

      // Get system settings for Docker image
      const dockerImage = await this.getBackupDockerImage();

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

      await this.updateBackupProgress(operationId, {
        status: "running",
        progress: 30,
        message: "Starting backup container",
      });

      // Generate blob name with database ID as path and backup ID + timestamp as filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const blobName = `${databaseId}/${operationId}_${timestamp}.dump`;

      // Execute backup using Docker
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
              AZURE_STORAGE_ACCOUNT_CONNECTION_STRING: azureConnectionString,
              AZURE_CONTAINER_NAME: backupConfig.azureContainerName,
              AZURE_BLOB_NAME: blobName,
              BACKUP_FORMAT: backupConfig.backupFormat,
              COMPRESSION_LEVEL: backupConfig.compressionLevel.toString(),
            },
            timeout: BackupExecutorService.BACKUP_TIMEOUT_MS,
          },
          (progress) => {
            // Update progress based on container status
            let progressValue = 40;
            let message = "Executing backup";

            switch (progress.status) {
              case "starting":
                progressValue = 40;
                message = "Starting backup container";
                break;
              case "running":
                progressValue = 60;
                message = "Creating backup";
                break;
              case "completed":
                progressValue = 80;
                message = "Backup completed, uploading to Azure";
                break;
              case "failed":
                throw new Error(
                  progress.errorMessage || "Container execution failed",
                );
            }

            this.updateBackupProgress(operationId, {
              status: "running",
              progress: progressValue,
              message,
            });
          },
        );

      if (containerResult.exitCode !== 0) {
        throw new Error(
          `Backup failed: ${containerResult.stderr || containerResult.stdout}`,
        );
      }

      await this.updateBackupProgress(operationId, {
        status: "running",
        progress: 85,
        message: "Verifying backup in Azure Storage",
      });

      // Verify backup files in Azure Storage
      const backupVerification = await this.verifyBackupInAzure(
        backupConfig.azureContainerName,
        blobName,
      );

      if (!backupVerification.success) {
        throw new Error(
          backupVerification.error || "Backup verification failed",
        );
      }

      // Update backup operation with success status
      await this.updateBackupProgress(operationId, {
        status: "completed",
        progress: 100,
        message: "Backup completed successfully",
      });

      // Update backup operation with file details
      await this.prisma.backupOperation.update({
        where: { id: operationId },
        data: {
          sizeBytes: backupVerification.sizeBytes,
          azureBlobUrl: backupVerification.blobUrl,
          completedAt: new Date(),
        },
      });

      // Update backup configuration with last backup time
      await this.backupConfigService.updateLastBackupTime(backupConfig.id);

      servicesLogger().info(
        {
          operationId,
          databaseId,
          sizeBytes: backupVerification.sizeBytes,
          blobUrl: backupVerification.blobUrl,
        },
        "Backup operation completed successfully",
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        {
          operationId,
          databaseId,
          error: errorMessage,
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
   * Get backup Docker image from system settings
   */
  private async getBackupDockerImage(): Promise<string> {
    try {
      // Try to get from system settings first
      const setting = await this.prisma.systemSettings.findFirst({
        where: {
          category: "postgres",
          key: "backup_docker_image",
        },
      });

      if (setting?.value) {
        return setting.value;
      }

      // Default fallback
      return "postgres:15-alpine";
    } catch (error) {
      servicesLogger().warn(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get backup Docker image from settings, using default",
      );
      return "postgres:15-alpine";
    }
  }

  /**
   * Verify backup files exist in Azure Storage
   */
  private async verifyBackupInAzure(
    containerName: string,
    blobName: string,
  ): Promise<{
    success: boolean;
    error?: string;
    sizeBytes?: bigint;
    blobUrl?: string;
  }> {
    try {
      const azureConnectionString =
        await this.azureConfigService.get("connection_string");
      if (!azureConnectionString) {
        return {
          success: false,
          error: "Azure connection string not configured",
        };
      }

      const blobServiceClient = BlobServiceClient.fromConnectionString(
        azureConnectionString,
      );
      const containerClient =
        blobServiceClient.getContainerClient(containerName);

      // Check if the specific blob exists
      const blobClient = containerClient.getBlobClient(blobName);
      
      try {
        const properties = await blobClient.getProperties();
        const blobUrl = blobClient.url;
        const sizeBytes = BigInt(properties.contentLength || 0);

        servicesLogger().info(
          {
            containerName,
            blobName,
            sizeBytes: sizeBytes.toString(),
            blobUrl,
          },
          "Backup file verified in Azure Storage",
        );

        return {
          success: true,
          sizeBytes,
          blobUrl,
        };
      } catch (blobError) {
        return {
          success: false,
          error: `Backup file not found: ${blobName}`,
        };
      }
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          containerName,
          blobName,
        },
        "Failed to verify backup in Azure Storage",
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

      servicesLogger().debug(
        {
          operationId,
          status: progressData.status,
          progress: progressData.progress,
          message: progressData.message,
        },
        "Backup progress updated",
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          operationId,
          progressData,
        },
        "Failed to update backup progress",
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
      azureBlobUrl: operation.azureBlobUrl,
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
      servicesLogger().info("BackupExecutorService shut down successfully");
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Error during BackupExecutorService shutdown",
      );
    }
  }
}
