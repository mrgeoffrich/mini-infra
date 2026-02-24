import { servicesLogger, dockerExecutorLogger } from "../../lib/logger-factory";
import { DockerExecutorService } from "../docker-executor";
import { PostgresDatabaseManager } from "../postgres";
import { AzureStorageService } from "../azure-storage-service";
import { BackupValidator } from "./backup-validator";
import { RollbackManager } from "./rollback-manager";
import { DbOperations } from "./db-operations";
import { extractBlobNameFromUrl, extractContainerFromUrl } from "./utils";

// Timeout for restore operations (3 hours)
export const RESTORE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

// Docker network for restore operations (shared with backup)
export const RESTORE_NETWORK_NAME = "mini-infra-postgres-backup";

/**
 * RestoreRunner orchestrates the full restore execution flow:
 * validation, rollback backup, container execution, verification.
 */
export class RestoreRunner {
  private dockerExecutor: DockerExecutorService;
  private databaseConfigService: PostgresDatabaseManager;
  private azureConfigService: AzureStorageService;
  private backupValidator: BackupValidator;
  private rollbackManager: RollbackManager;
  private dbOps: DbOperations;
  private prisma: any;

  constructor(
    dockerExecutor: DockerExecutorService,
    databaseConfigService: PostgresDatabaseManager,
    azureConfigService: AzureStorageService,
    backupValidator: BackupValidator,
    rollbackManager: RollbackManager,
    dbOps: DbOperations,
    prisma: any,
  ) {
    this.dockerExecutor = dockerExecutor;
    this.databaseConfigService = databaseConfigService;
    this.azureConfigService = azureConfigService;
    this.backupValidator = backupValidator;
    this.rollbackManager = rollbackManager;
    this.dbOps = dbOps;
    this.prisma = prisma;
  }

  /**
   * Execute restore operation
   */
  async executeRestore(
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
      await this.dbOps.updateRestoreProgress(operationId, {
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

      await this.dbOps.updateRestoreProgress(operationId, {
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

      const validationResult = await this.backupValidator.validateBackupFile(
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
          `Failed to validate backup file '${extractBlobNameFromUrl(backupUrl)}': ${validationResult.error}`,
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

      await this.dbOps.updateRestoreProgress(operationId, {
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

      const dockerImage = await this.dbOps.getRestoreDockerImage();

      servicesLogger().debug(
        {
          operationId,
        },
        "Retrieving registry credentials configuration",
      );

      await this.dbOps.updateRestoreProgress(operationId, {
        status: "running",
        progress: 25,
        message: "Pulling Docker image",
      });

      // Pull Docker image with automatic authentication
      dockerExecutorLogger().info(
        {
          operationId,
          dockerImage,
        },
        "Pulling Docker image for restore with auto-auth",
      );

      const pullStartTime = Date.now();
      await this.dockerExecutor.pullImageWithAutoAuth(dockerImage);

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
        await this.databaseConfigService.getConnectionConfig(databaseId);

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

      await this.dbOps.updateRestoreProgress(operationId, {
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
      const rollbackBackupUrl =
        await this.rollbackManager.createRollbackBackup(
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

      await this.dbOps.updateRestoreProgress(operationId, {
        status: "running",
        progress: 40,
        message: "Starting restore container",
      });

      // Extract blob name from backup URL for restore
      const blobName = extractBlobNameFromUrl(backupUrl);
      const containerName = extractContainerFromUrl(backupUrl);

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
          timeoutMs: RESTORE_TIMEOUT_MS,
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
            timeout: RESTORE_TIMEOUT_MS,
            networkMode: RESTORE_NETWORK_NAME,
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

            this.dbOps.updateRestoreProgress(operationId, {
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

        await this.dbOps.updateRestoreProgress(operationId, {
          status: "running",
          progress: 85,
          message: "Restore failed, initiating rollback",
        });

        // Execute rollback
        const rollbackExecutionStartTime = Date.now();
        await this.rollbackManager.executeRollback(
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

      await this.dbOps.updateRestoreProgress(operationId, {
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
        await this.dbOps.verifyRestoredDatabase(connectionConfig);

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

        await this.dbOps.updateRestoreProgress(operationId, {
          status: "running",
          progress: 90,
          message: "Database verification failed, initiating rollback",
        });

        // Execute rollback
        const rollbackExecutionStartTime = Date.now();
        await this.rollbackManager.executeRollback(
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
      await this.dbOps.updateRestoreProgress(operationId, {
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

      await this.dbOps.updateRestoreProgress(operationId, {
        status: "failed",
        progress: rollbackInitiated ? 100 : 0,
        errorMessage,
      });

      throw error;
    }
  }
}
