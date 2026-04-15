import { getLogger } from "../../lib/logger-factory";
import { runWithContext } from "../../lib/logging-context";
import type { PrismaClient } from "../../generated/prisma/client";
import { DockerExecutorService } from "../docker-executor";
import { PostgresDatabaseManager } from "../postgres";
import { AzureStorageService } from "../azure-storage-service";
import { BackupValidator } from "./backup-validator";
import { RollbackManager } from "./rollback-manager";
import { DbOperations } from "./db-operations";
import { extractBlobNameFromUrl, extractContainerFromUrl } from "./utils";
import { resolveDatabaseNetworkName } from "../backup/database-network-resolver";

// Timeout for restore operations (3 hours)
export const RESTORE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

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
  private prisma: PrismaClient;

  constructor(
    dockerExecutor: DockerExecutorService,
    databaseConfigService: PostgresDatabaseManager,
    azureConfigService: AzureStorageService,
    backupValidator: BackupValidator,
    rollbackManager: RollbackManager,
    dbOps: DbOperations,
    prisma: PrismaClient,
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
    return runWithContext({ operationId, userId }, () =>
      this.executeRestoreInner(
        operationId,
        databaseId,
        backupUrl,
        userId,
        targetDatabaseName,
      ),
    );
  }

  private async executeRestoreInner(
    operationId: string,
    databaseId: string,
    backupUrl: string,
    userId: string,
    targetDatabaseName?: string,
  ): Promise<void> {
    let rollbackInitiated = false;
    const executionStartTime = Date.now();

    try {
      getLogger("backup", "restore-runner").info(
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
      getLogger("backup", "restore-runner").debug(
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

      getLogger("backup", "restore-runner").info(
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
      getLogger("backup", "restore-runner").info(
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
        getLogger("backup", "restore-runner").error(
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

      getLogger("backup", "restore-runner").info(
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
      getLogger("backup", "restore-runner").debug(
        {
          operationId,
        },
        "Retrieving Docker image configuration",
      );

      const dockerImage = await this.dbOps.getRestoreDockerImage();

      getLogger("backup", "restore-runner").debug(
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
      getLogger("backup", "restore-runner").info(
        {
          operationId,
          dockerImage,
        },
        "Pulling Docker image for restore with auto-auth",
      );

      const pullStartTime = Date.now();
      await this.dockerExecutor.pullImageWithAutoAuth(dockerImage);

      getLogger("backup", "restore-runner").info(
        {
          operationId,
          dockerImage,
          pullTimeMs: Date.now() - pullStartTime,
        },
        "Docker image pulled successfully",
      );

      // Verify Azure is configured
      getLogger("backup", "restore-runner").debug(
        {
          operationId,
        },
        "Verifying Azure Storage configuration",
      );

      const azureConnectionString =
        await this.azureConfigService.getConnectionString();
      if (!azureConnectionString) {
        getLogger("backup", "restore-runner").error(
          {
            operationId,
          },
          "Azure connection string not configured",
        );
        throw new Error(
          "Azure Storage connection string is not configured. Please configure Azure settings before attempting restore.",
        );
      }

      getLogger("backup", "restore-runner").debug(
        {
          operationId,
        },
        "Azure Storage configuration verified",
      );

      // Get database connection details
      getLogger("backup", "restore-runner").debug(
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

      getLogger("backup", "restore-runner").info(
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

      // Resolve the database management network for backup/restore containers
      const databaseNetworkName = await resolveDatabaseNetworkName(this.prisma);

      await this.dbOps.updateRestoreProgress(operationId, {
        status: "running",
        progress: 35,
        message: "Starting pre-restore backup for rollback",
      });

      // Create a pre-restore backup for rollback purposes
      getLogger("backup", "restore-runner").info(
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
          databaseNetworkName,
        );

      getLogger("backup", "restore-runner").info(
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

      // Extract blob name from backup URL and generate a read SAS URL for restore
      const blobName = extractBlobNameFromUrl(backupUrl);
      const containerName = extractContainerFromUrl(backupUrl);
      const sasExpiryMinutes = Math.ceil(RESTORE_TIMEOUT_MS / 60000) + 15;
      const azureSasUrl = await this.azureConfigService.generateBlobSasUrl(
        containerName,
        blobName,
        sasExpiryMinutes,
        "read",
      );

      getLogger("backup", "restore-runner").info(
        {
          operationId,
          backupUrl,
          containerName,
          blobName,
          sasExpiryMinutes,
        },
        "Generated read SAS URL for restore",
      );

      // Execute restore using Docker
      const containerEnv = {
        POSTGRES_HOST: connectionConfig.host,
        POSTGRES_PORT: connectionConfig.port.toString(),
        POSTGRES_USER: connectionConfig.username,
        POSTGRES_PASSWORD: "[REDACTED]",
        POSTGRES_DATABASE: connectionConfig.database,
        AZURE_SAS_URL: "[REDACTED]",
        RESTORE: "yes",
        DROP_PUBLIC: "yes",
      };

      getLogger("backup", "restore-runner").info(
        {
          operationId,
          dockerImage,
          environment: containerEnv,
          timeoutMs: RESTORE_TIMEOUT_MS,
        },
        "Starting restore container execution",
      );

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
              AZURE_SAS_URL: azureSasUrl,
              RESTORE: "yes",
              DROP_PUBLIC: "yes",
            },
            timeout: RESTORE_TIMEOUT_MS,
            networkMode: databaseNetworkName,
          },
          (progress) => {
            // Update progress based on container status
            let progressValue = 50;
            let message = "Executing restore";

            getLogger("backup", "restore-runner").debug(
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
                getLogger("backup", "restore-runner").info(
                  {
                    operationId,
                  },
                  "Restore container is starting",
                );
                break;
              case "running":
                progressValue = 70;
                message = "Restoring database";
                getLogger("backup", "restore-runner").info(
                  {
                    operationId,
                  },
                  "Restore container is running - database restore in progress",
                );
                break;
              case "completed":
                progressValue = 85;
                message = "Restore completed, verifying database";
                getLogger("backup", "restore-runner").info(
                  {
                    operationId,
                  },
                  "Restore container completed execution",
                );
                break;
              case "failed":
                getLogger("backup", "restore-runner").error(
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

            pendingProgressUpdate = this.dbOps.updateRestoreProgress(operationId, {
              status: "running",
              progress: progressValue,
              message,
            });
          },
        );

      // Ensure callback's DB write completes before we continue to avoid
      // it racing with subsequent writes and overwriting the final status.
      if (pendingProgressUpdate) {
        await pendingProgressUpdate;
      }

      getLogger("backup", "restore-runner").info(
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
        getLogger("backup", "restore-runner").debug(
          {
            operationId,
            stdout: containerResult.stdout.substring(0, 1000), // First 1000 chars
          },
          "Restore container stdout output (truncated)",
        );
      }

      if (containerResult.stderr) {
        getLogger("backup", "restore-runner").debug(
          {
            operationId,
            stderr: containerResult.stderr.substring(0, 1000), // First 1000 chars
          },
          "Restore container stderr output (truncated)",
        );
      }

      if (containerResult.exitCode !== 0) {
        rollbackInitiated = true;

        getLogger("backup", "restore-runner").error(
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
          databaseNetworkName,
        );

        getLogger("backup", "restore-runner").info(
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
      getLogger("backup", "restore-runner").info(
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

      getLogger("backup", "restore-runner").info(
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

        getLogger("backup", "restore-runner").error(
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
          databaseNetworkName,
        );

        getLogger("backup", "restore-runner").info(
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
      getLogger("backup", "restore-runner").info(
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

      getLogger("backup", "restore-runner").info(
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

      getLogger("backup", "restore-runner").error(
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
