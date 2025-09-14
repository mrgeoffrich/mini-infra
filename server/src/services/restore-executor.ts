import prisma, { PrismaClient } from "../lib/prisma";
import {
  InMemoryQueue,
  Job as QueueJob,
  QueueOptions,
} from "../lib/in-memory-queue";
import { servicesLogger, dockerExecutorLogger } from "../lib/logger-factory";
import { DockerExecutorService } from "./docker-executor";
import { DatabaseConfigService } from "./postgres-config";
import { PostgresSettingsConfigService } from "./postgres-settings-config";
import { AzureConfigService } from "./azure-config";
import { BlobServiceClient } from "@azure/storage-blob";
import {
  RestoreOperationInfo,
  RestoreOperationStatus,
} from "@mini-infra/types";
import type { RestoreOperation } from "@prisma/client";

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
  private prisma: typeof prisma;
  private dockerExecutor: DockerExecutorService;
  private databaseConfigService: DatabaseConfigService;
  private postgresSettingsConfigService: PostgresSettingsConfigService;
  private azureConfigService: AzureConfigService;
  private restoreQueue: InMemoryQueue;
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
    this.postgresSettingsConfigService = new PostgresSettingsConfigService(
      prisma,
    );
    this.azureConfigService = new AzureConfigService(prisma);

    // Initialize in-memory queue
    this.restoreQueue = new InMemoryQueue("postgres-restore", {
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

    this.setupQueueProcessors();
  }

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
      await this.dockerExecutor.initialize();
      servicesLogger().debug("Docker executor initialized successfully");

      servicesLogger().info(
        {
          initializationTimeMs: Date.now() - startTime,
          queueConcurrency: 1,
          maxRetries: RestoreExecutorService.MAX_RETRIES,
          timeoutMs: RestoreExecutorService.RESTORE_TIMEOUT_MS,
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
      await this.restoreQueue.add(
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
          queuePosition: this.restoreQueue.getStats().total,
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
      const jobs = await this.restoreQueue.getJobs(["pending", "active"]);
      const job = jobs.find((j) => j.data.restoreOperationId === operationId);

      if (job) {
        await this.restoreQueue.remove(job.id);
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
   * Setup queue processors
   */
  private setupQueueProcessors(): void {
    // Process restore jobs
    this.restoreQueue.process("execute-restore", async (job: QueueJob) => {
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
    });

    // Handle job events
    this.restoreQueue.on("completed", (job: QueueJob, result: any) => {
      servicesLogger().info(
        {
          jobId: job.id,
          operationId: job.data.restoreOperationId,
          result,
        },
        "Restore job completed",
      );
    });

    this.restoreQueue.on("failed", (job: QueueJob, error: Error) => {
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
    targetDatabaseName?: string,
  ): Promise<void> {
    let rollbackInitiated = false;
    const executionStartTime = Date.now();

    try {
      servicesLogger().info(
        {
          operationId,
          databaseId,
          backupUrl,
          userId,
        },
        "Starting restore execution",
      );

      // Update status to running
      await this.updateRestoreProgress(operationId, {
        status: "running",
        progress: 5,
        message: "Preparing restore operation",
      });

      // Get database configuration
      servicesLogger().debug(
        {
          operationId,
          databaseId,
          userId,
        },
        "Retrieving database configuration",
      );

      const database = await this.databaseConfigService.getDatabaseById(
        databaseId,
        userId,
      );
      if (!database) {
        throw new Error(
          `Database '${databaseId}' not found or access denied. Please verify the database exists and you have permission to restore it.`,
        );
      }

      servicesLogger().info(
        {
          operationId,
          databaseId: database.id,
          databaseName: database.database,
          host: database.host,
          port: database.port,
        },
        "Database configuration retrieved successfully",
      );

      await this.updateRestoreProgress(operationId, {
        status: "running",
        progress: 10,
        message: "Validating backup file",
      });

      // Validate backup file before restore
      servicesLogger().info(
        {
          operationId,
          backupUrl,
        },
        "Starting backup file validation",
      );

      const validationResult = await this.validateBackupFile(
        backupUrl,
        databaseId,
      );
      if (!validationResult.isValid) {
        servicesLogger().error(
          {
            operationId,
            backupUrl,
            validationError: validationResult.error,
          },
          "Backup file validation failed",
        );
        throw new Error(
          `Failed to validate backup file '${this.extractBlobNameFromUrl(backupUrl)}': ${validationResult.error}`,
        );
      }

      servicesLogger().info(
        {
          operationId,
          backupUrl,
          sizeBytes: validationResult.sizeBytes,
          lastModified: validationResult.lastModified,
        },
        "Backup file validation completed successfully",
      );

      await this.updateRestoreProgress(operationId, {
        status: "running",
        progress: 20,
        message: "Getting system settings",
      });

      // Get system settings for Docker image
      servicesLogger().debug(
        {
          operationId,
        },
        "Retrieving Docker image configuration",
      );

      const dockerImage = await this.getRestoreDockerImage();

      servicesLogger().debug(
        {
          operationId,
        },
        "Retrieving registry credentials configuration",
      );

      // Get registry credentials for Docker image
      const registryCredentials = await this.getRestoreRegistryCredentials();

      await this.updateRestoreProgress(operationId, {
        status: "running",
        progress: 25,
        message: "Pulling Docker image",
      });

      // Pull Docker image with authentication if credentials are provided
      dockerExecutorLogger().info(
        {
          operationId,
          dockerImage,
          hasRegistryAuth: !!(
            registryCredentials.username && registryCredentials.password
          ),
        },
        "Starting Docker image pull",
      );

      const pullStartTime = Date.now();
      await this.dockerExecutor.pullImageWithAuth(
        dockerImage,
        registryCredentials.username,
        registryCredentials.password,
      );

      dockerExecutorLogger().info(
        {
          operationId,
          dockerImage,
          pullTimeMs: Date.now() - pullStartTime,
        },
        "Docker image pulled successfully",
      );

      // Get Azure connection string
      servicesLogger().debug(
        {
          operationId,
        },
        "Retrieving Azure connection string",
      );

      const azureConnectionString =
        await this.azureConfigService.get("connection_string");
      if (!azureConnectionString) {
        servicesLogger().error(
          {
            operationId,
          },
          "Azure connection string not configured",
        );
        throw new Error(
          "Azure Storage connection string is not configured. Please configure Azure settings before attempting restore.",
        );
      }

      servicesLogger().debug(
        {
          operationId,
          hasAzureConnection: !!azureConnectionString,
        },
        "Azure connection string retrieved successfully",
      );

      // Get database connection details
      servicesLogger().debug(
        {
          operationId,
          databaseId,
        },
        "Retrieving database connection configuration",
      );

      const baseConnectionConfig =
        await this.databaseConfigService.getConnectionConfig(
          databaseId,
          userId,
        );

      // Use target database name if provided, otherwise use the original database name
      const connectionConfig = {
        ...baseConnectionConfig,
        database: targetDatabaseName || baseConnectionConfig.database,
      };

      servicesLogger().info(
        {
          operationId,
          databaseHost: connectionConfig.host,
          databasePort: connectionConfig.port,
          originalDatabaseName: baseConnectionConfig.database,
          targetDatabaseName: connectionConfig.database,
          databaseUser: connectionConfig.username,
          isCustomDatabaseName: !!targetDatabaseName,
        },
        "Database connection configuration retrieved and prepared for restore",
      );

      await this.updateRestoreProgress(operationId, {
        status: "running",
        progress: 35,
        message: "Starting pre-restore backup for rollback",
      });

      // Create a pre-restore backup for rollback purposes
      servicesLogger().info(
        {
          operationId,
          databaseName: database.database,
        },
        "Creating pre-restore rollback backup",
      );

      const rollbackStartTime = Date.now();
      const rollbackBackupUrl = await this.createRollbackBackup(
        baseConnectionConfig,
        azureConnectionString,
        dockerImage,
        database.database,
        backupUrl,
      );

      servicesLogger().info(
        {
          operationId,
          rollbackBackupUrl,
          rollbackCreationTimeMs: Date.now() - rollbackStartTime,
        },
        "Pre-restore rollback backup created successfully",
      );

      await this.updateRestoreProgress(operationId, {
        status: "running",
        progress: 40,
        message: "Starting restore container",
      });

      // Extract blob name from backup URL for restore
      const blobName = this.extractBlobNameFromUrl(backupUrl);
      const containerName = this.extractContainerFromUrl(backupUrl);

      servicesLogger().info(
        {
          operationId,
          backupUrl,
          containerName,
          blobName,
        },
        "Parsed backup URL components for restore",
      );

      // Execute restore using Docker
      const containerEnv = {
        POSTGRES_HOST: connectionConfig.host,
        POSTGRES_PORT: connectionConfig.port.toString(),
        POSTGRES_USER: connectionConfig.username,
        POSTGRES_PASSWORD: "[REDACTED]",
        POSTGRES_DATABASE: connectionConfig.database,
        AZURE_STORAGE_ACCOUNT_CONNECTION_STRING: "[REDACTED]",
        AZURE_CONTAINER_NAME: containerName,
        RESTORE: "yes",
        DROP_PUBLIC: "yes",
        AZURE_BLOB_NAME: blobName,
      };

      dockerExecutorLogger().info(
        {
          operationId,
          dockerImage,
          environment: containerEnv,
          timeoutMs: RestoreExecutorService.RESTORE_TIMEOUT_MS,
        },
        "Starting restore container execution",
      );

      const containerStartTime = Date.now();
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
              AZURE_CONTAINER_NAME: containerName,
              RESTORE: "yes",
              DROP_PUBLIC: "yes",
              AZURE_BLOB_NAME: blobName,
            },
            timeout: RestoreExecutorService.RESTORE_TIMEOUT_MS,
          },
          (progress) => {
            // Update progress based on container status
            let progressValue = 50;
            let message = "Executing restore";

            servicesLogger().debug(
              {
                operationId,
                containerStatus: progress.status,
                errorMessage: progress.errorMessage,
              },
              "Container progress update received",
            );

            switch (progress.status) {
              case "starting":
                progressValue = 50;
                message = "Starting restore container";
                servicesLogger().info(
                  {
                    operationId,
                  },
                  "Restore container is starting",
                );
                break;
              case "running":
                progressValue = 70;
                message = "Restoring database";
                servicesLogger().info(
                  {
                    operationId,
                  },
                  "Restore container is running - database restore in progress",
                );
                break;
              case "completed":
                progressValue = 85;
                message = "Restore completed, verifying database";
                servicesLogger().info(
                  {
                    operationId,
                  },
                  "Restore container completed execution",
                );
                break;
              case "failed":
                servicesLogger().error(
                  {
                    operationId,
                    errorMessage: progress.errorMessage,
                  },
                  "Restore container execution failed",
                );
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

      dockerExecutorLogger().info(
        {
          operationId,
          exitCode: containerResult.exitCode,
          containerExecutionTimeMs: Date.now() - containerStartTime,
          stdoutLength: containerResult.stdout?.length || 0,
          stderrLength: containerResult.stderr?.length || 0,
        },
        "Restore container execution completed",
      );

      if (containerResult.stdout) {
        dockerExecutorLogger().debug(
          {
            operationId,
            stdout: containerResult.stdout.substring(0, 1000), // First 1000 chars
          },
          "Restore container stdout output (truncated)",
        );
      }

      if (containerResult.stderr) {
        dockerExecutorLogger().debug(
          {
            operationId,
            stderr: containerResult.stderr.substring(0, 1000), // First 1000 chars
          },
          "Restore container stderr output (truncated)",
        );
      }

      if (containerResult.exitCode !== 0) {
        rollbackInitiated = true;

        servicesLogger().error(
          {
            operationId,
            exitCode: containerResult.exitCode,
            stderr: containerResult.stderr,
            stdout: containerResult.stdout,
          },
          "Restore container failed, initiating rollback",
        );

        await this.updateRestoreProgress(operationId, {
          status: "running",
          progress: 85,
          message: "Restore failed, initiating rollback",
        });

        // Execute rollback
        const rollbackExecutionStartTime = Date.now();
        await this.executeRollback(
          connectionConfig,
          rollbackBackupUrl,
          azureConnectionString,
          dockerImage,
        );

        servicesLogger().info(
          {
            operationId,
            rollbackExecutionTimeMs: Date.now() - rollbackExecutionStartTime,
          },
          "Rollback execution completed",
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
      servicesLogger().info(
        {
          operationId,
          databaseHost: connectionConfig.host,
          databaseName: connectionConfig.database,
        },
        "Starting database verification after restore",
      );

      const verificationStartTime = Date.now();
      const verificationResult =
        await this.verifyRestoredDatabase(connectionConfig);

      servicesLogger().info(
        {
          operationId,
          isValid: verificationResult.isValid,
          verificationTimeMs: Date.now() - verificationStartTime,
          error: verificationResult.error,
        },
        "Database verification completed",
      );

      if (!verificationResult.isValid) {
        rollbackInitiated = true;

        servicesLogger().error(
          {
            operationId,
            verificationError: verificationResult.error,
          },
          "Database verification failed, initiating rollback",
        );

        await this.updateRestoreProgress(operationId, {
          status: "running",
          progress: 90,
          message: "Database verification failed, initiating rollback",
        });

        // Execute rollback
        const rollbackExecutionStartTime = Date.now();
        await this.executeRollback(
          connectionConfig,
          rollbackBackupUrl,
          azureConnectionString,
          dockerImage,
        );

        servicesLogger().info(
          {
            operationId,
            rollbackExecutionTimeMs: Date.now() - rollbackExecutionStartTime,
          },
          "Rollback execution completed after verification failure",
        );

        throw new Error(
          `Database verification failed and rollback completed: ${verificationResult.error}`,
        );
      }

      // Keep rollback backup for future reference - do not delete
      servicesLogger().info(
        {
          operationId,
          rollbackBackupUrl,
        },
        "Rollback backup preserved for future reference (not deleted)",
      );

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
          totalExecutionTimeMs: Date.now() - executionStartTime,
        },
        "Restore operation completed successfully",
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      const stack = error instanceof Error ? error.stack : undefined;

      servicesLogger().error(
        {
          operationId,
          databaseId,
          backupUrl,
          error: errorMessage,
          stack: stack,
          rollbackInitiated,
          executionTimeMs: Date.now() - executionStartTime,
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
    databaseId?: string,
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

      servicesLogger().debug(
        {
          backupUrl,
          containerName,
          blobName,
          databaseId,
        },
        "Starting backup file validation",
      );

      // Check if blob exists and get properties
      const exists = await blobClient.exists();
      if (!exists) {
        servicesLogger().warn(
          {
            backupUrl,
            containerName,
            blobName,
          },
          "Backup file not found in Azure Storage",
        );
        return {
          isValid: false,
          error: `Backup file not found in Azure Storage: ${blobName}`,
        };
      }

      const properties = await blobClient.getProperties();

      // Enhanced validation - check file size
      const sizeBytes = properties.contentLength || 0;
      if (sizeBytes < 100) {
        // Backup files should be at least 100 bytes
        return {
          isValid: false,
          error: `Backup file appears to be too small (${sizeBytes} bytes) or corrupted`,
        };
      }

      // Check for reasonable maximum file size (e.g., 50GB)
      const maxSizeBytes = 50 * 1024 * 1024 * 1024; // 50GB
      if (sizeBytes > maxSizeBytes) {
        servicesLogger().warn(
          {
            backupUrl,
            sizeBytes,
            maxSizeBytes,
          },
          "Warning: Backup file is extremely large",
        );
      }

      // Validate backup file belongs to the correct database if databaseId is provided
      if (databaseId) {
        const pathParts = blobName.split("/");
        const backupDatabaseId = pathParts[0]; // Expected format: databaseId/backup_file.dump

        if (backupDatabaseId !== databaseId) {
          servicesLogger().warn(
            {
              backupUrl,
              expectedDatabaseId: databaseId,
              actualDatabaseId: backupDatabaseId,
              blobName,
            },
            "Backup file database ID mismatch",
          );
          return {
            isValid: false,
            error: `Backup file belongs to database '${backupDatabaseId}' but expected '${databaseId}'`,
          };
        }
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

      // Validate content type if available
      const expectedContentTypes = [
        "application/octet-stream",
        "application/sql",
        "text/plain",
        undefined, // Some backups may not have content type set
      ];

      if (
        properties.contentType &&
        !expectedContentTypes.includes(properties.contentType)
      ) {
        servicesLogger().warn(
          {
            backupUrl,
            contentType: properties.contentType,
            expectedContentTypes,
          },
          "Warning: Unexpected backup file content type",
        );
      }

      servicesLogger().info(
        {
          backupUrl,
          containerName,
          blobName,
          sizeBytes,
          sizeMB: Math.round(sizeBytes / (1024 * 1024)),
          lastModified: lastModified.toISOString(),
          contentType: properties.contentType,
          ageInDays: Math.round(ageInDays),
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
          containerName,
          blobName,
          ageInDays: Math.round(ageInDays),
        },
      };
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          backupUrl,
          databaseId,
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
    backupUrl: string,
  ): Promise<string> {
    const startTime = Date.now();
    try {
      servicesLogger().info(
        {
          databaseName,
          host: connectionConfig.host,
          port: connectionConfig.port,
          database: connectionConfig.database,
        },
        "Creating pre-restore backup for rollback purposes",
      );

      // Extract container name from backup URL and generate unique path for rollback backup
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rollbackContainerName = this.extractContainerFromUrl(backupUrl);
      const rollbackBlobName = `${databaseName}/rollback-${timestamp}.dump`;

      servicesLogger().info(
        {
          rollbackContainerName,
          rollbackBlobName,
          timestamp,
          backupUrl,
        },
        "Generated rollback backup path and container from backup URL",
      );

      const containerEnv = {
        POSTGRES_HOST: connectionConfig.host,
        POSTGRES_PORT: connectionConfig.port.toString(),
        POSTGRES_USER: connectionConfig.username,
        POSTGRES_PASSWORD: "[REDACTED]",
        POSTGRES_DATABASE: connectionConfig.database,
        AZURE_STORAGE_ACCOUNT_CONNECTION_STRING: "[REDACTED]",
        AZURE_CONTAINER_NAME: rollbackContainerName,
        AZURE_BLOB_NAME: rollbackBlobName,
      };

      dockerExecutorLogger().info(
        {
          dockerImage,
          environment: containerEnv,
          timeoutMs: 30 * 60 * 1000,
        },
        "Starting rollback backup container",
      );

      // Execute backup for rollback purposes
      const containerResult = await this.dockerExecutor.executeContainer({
        image: dockerImage,
        env: {
          POSTGRES_HOST: connectionConfig.host,
          POSTGRES_PORT: connectionConfig.port.toString(),
          POSTGRES_USER: connectionConfig.username,
          POSTGRES_PASSWORD: connectionConfig.password,
          POSTGRES_DATABASE: connectionConfig.database,
          AZURE_STORAGE_ACCOUNT_CONNECTION_STRING: azureConnectionString,
          AZURE_CONTAINER_NAME: rollbackContainerName,
          AZURE_BLOB_NAME: rollbackBlobName,
        },
        timeout: 30 * 60 * 1000, // 30 minutes for rollback backup
      });

      dockerExecutorLogger().info(
        {
          exitCode: containerResult.exitCode,
          stdoutLength: containerResult.stdout?.length || 0,
          stderrLength: containerResult.stderr?.length || 0,
          executionTimeMs: Date.now() - startTime,
        },
        "Rollback backup container execution completed",
      );

      if (containerResult.stdout) {
        dockerExecutorLogger().debug(
          {
            stdout: containerResult.stdout.substring(0, 500),
          },
          "Rollback backup container stdout (truncated)",
        );
      }

      if (containerResult.stderr) {
        dockerExecutorLogger().debug(
          {
            stderr: containerResult.stderr.substring(0, 500),
          },
          "Rollback backup container stderr (truncated)",
        );
      }

      if (containerResult.exitCode !== 0) {
        servicesLogger().error(
          {
            exitCode: containerResult.exitCode,
            stderr: containerResult.stderr,
            stdout: containerResult.stdout,
          },
          "Rollback backup container failed",
        );
        throw new Error(
          `Failed to create rollback backup: ${containerResult.stderr}`,
        );
      }

      const rollbackBackupUrl = `https://${this.getStorageAccountFromConnectionString(azureConnectionString)}.blob.core.windows.net/${rollbackContainerName}/${rollbackBlobName}`;

      servicesLogger().info(
        {
          rollbackBackupUrl,
          databaseName,
          creationTimeMs: Date.now() - startTime,
        },
        "Rollback backup created successfully",
      );

      return rollbackBackupUrl;
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          databaseName,
          creationTimeMs: Date.now() - startTime,
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
    const startTime = Date.now();
    try {
      servicesLogger().info(
        {
          rollbackBackupUrl,
          databaseHost: connectionConfig.host,
          databaseName: connectionConfig.database,
        },
        "Executing rollback to pre-restore state",
      );

      const { containerName, blobName } =
        this.parseBackupUrl(rollbackBackupUrl);

      servicesLogger().debug(
        {
          rollbackBackupUrl,
          containerName,
          blobName,
        },
        "Parsed rollback backup URL components",
      );

      const containerEnv = {
        POSTGRES_HOST: connectionConfig.host,
        POSTGRES_PORT: connectionConfig.port.toString(),
        POSTGRES_USER: connectionConfig.username,
        POSTGRES_PASSWORD: "[REDACTED]",
        POSTGRES_DATABASE: connectionConfig.database,
        AZURE_STORAGE_ACCOUNT_CONNECTION_STRING: "[REDACTED]",
        AZURE_CONTAINER_NAME: containerName,
        RESTORE: "yes",
        DROP_PUBLIC: "yes",
        BACKUP_FILE_URL: rollbackBackupUrl,
      };

      dockerExecutorLogger().info(
        {
          dockerImage,
          environment: containerEnv,
          timeoutMs: 60 * 60 * 1000,
        },
        "Starting rollback container execution",
      );

      const containerResult = await this.dockerExecutor.executeContainer({
        image: dockerImage,
        env: {
          POSTGRES_HOST: connectionConfig.host,
          POSTGRES_PORT: connectionConfig.port.toString(),
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

      dockerExecutorLogger().info(
        {
          rollbackBackupUrl,
          exitCode: containerResult.exitCode,
          stdoutLength: containerResult.stdout?.length || 0,
          stderrLength: containerResult.stderr?.length || 0,
          executionTimeMs: Date.now() - startTime,
        },
        "Rollback container execution completed",
      );

      if (containerResult.stdout) {
        dockerExecutorLogger().debug(
          {
            stdout: containerResult.stdout.substring(0, 500),
          },
          "Rollback container stdout (truncated)",
        );
      }

      if (containerResult.stderr) {
        dockerExecutorLogger().debug(
          {
            stderr: containerResult.stderr.substring(0, 500),
          },
          "Rollback container stderr (truncated)",
        );
      }

      if (containerResult.exitCode !== 0) {
        servicesLogger().error(
          {
            rollbackBackupUrl,
            exitCode: containerResult.exitCode,
            stderr: containerResult.stderr,
            stdout: containerResult.stdout,
          },
          "Rollback container execution failed",
        );
        throw new Error(`Rollback execution failed: ${containerResult.stderr}`);
      }

      servicesLogger().info(
        {
          rollbackBackupUrl,
          executionTimeMs: Date.now() - startTime,
        },
        "Rollback executed successfully",
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          rollbackBackupUrl,
          executionTimeMs: Date.now() - startTime,
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
    const startTime = Date.now();
    try {
      servicesLogger().debug(
        {
          rollbackBackupUrl,
        },
        "Starting rollback backup cleanup",
      );

      const azureConnectionString =
        await this.azureConfigService.get("connection_string");
      if (!azureConnectionString) {
        servicesLogger().warn(
          {
            rollbackBackupUrl,
          },
          "Azure connection string not available for cleanup",
        );
        return;
      }

      const blobServiceClient = BlobServiceClient.fromConnectionString(
        azureConnectionString,
      );

      const { containerName, blobName } =
        this.parseBackupUrl(rollbackBackupUrl);

      servicesLogger().debug(
        {
          rollbackBackupUrl,
          containerName,
          blobName,
        },
        "Parsed rollback backup URL for cleanup",
      );

      const blobClient = blobServiceClient
        .getContainerClient(containerName)
        .getBlobClient(blobName);

      // Check if blob exists before trying to delete
      const exists = await blobClient.exists();

      servicesLogger().debug(
        {
          rollbackBackupUrl,
          exists,
        },
        "Checked rollback backup existence",
      );

      if (exists) {
        await blobClient.deleteIfExists();

        servicesLogger().info(
          {
            rollbackBackupUrl,
            cleanupTimeMs: Date.now() - startTime,
          },
          "Rollback backup deleted successfully",
        );
      } else {
        servicesLogger().info(
          {
            rollbackBackupUrl,
          },
          "Rollback backup does not exist, no cleanup needed",
        );
      }
    } catch (error) {
      // Log but don't throw - cleanup failure shouldn't fail the restore
      servicesLogger().warn(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          rollbackBackupUrl,
          cleanupTimeMs: Date.now() - startTime,
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
      // Try to get restore image from system settings first (category: "system" as used by frontend)
      const setting = await this.prisma.systemSettings.findFirst({
        where: {
          category: "system",
          key: "restore_docker_image",
        },
      });

      if (setting?.value) {
        servicesLogger().info(
          {
            dockerImage: setting.value,
          },
          "Using restore Docker image from system settings",
        );
        return setting.value;
      }

      // Fallback to backup image setting
      const backupSetting = await this.prisma.systemSettings.findFirst({
        where: {
          category: "system",
          key: "backup_docker_image",
        },
      });

      if (backupSetting?.value) {
        servicesLogger().info(
          {
            dockerImage: backupSetting.value,
          },
          "Using backup Docker image from system settings for restore",
        );
        return backupSetting.value;
      }

      // Default fallback
      servicesLogger().info(
        {
          dockerImage: "postgres:15-alpine",
        },
        "Using default restore Docker image",
      );
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
   * Get restore registry credentials from system settings
   */
  private async getRestoreRegistryCredentials(): Promise<{
    username?: string;
    password?: string;
  }> {
    try {
      const [usernameSetting, passwordSetting] = await Promise.all([
        this.prisma.systemSettings.findFirst({
          where: {
            category: "system",
            key: "restore_registry_username",
          },
        }),
        this.prisma.systemSettings.findFirst({
          where: {
            category: "system",
            key: "restore_registry_password",
          },
        }),
      ]);

      const credentials = {
        username: usernameSetting?.value || undefined,
        password: passwordSetting?.value || undefined,
      };

      servicesLogger().info(
        {
          hasUsername: !!credentials.username,
          hasPassword: !!credentials.password,
        },
        "Retrieved restore registry credentials from system settings",
      );

      return credentials;
    } catch (error) {
      servicesLogger().warn(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get restore registry credentials from system settings",
      );
      return {
        username: undefined,
        password: undefined,
      };
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
   * Extract blob name from backup URL
   */
  private extractBlobNameFromUrl(backupUrl: string): string {
    const { blobName } = this.parseBackupUrl(backupUrl);
    return blobName;
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
