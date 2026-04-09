import { BlobServiceClient } from "@azure/storage-blob";
import { servicesLogger, dockerExecutorLogger } from "../../lib/logger-factory";
import { DockerExecutorService } from "../docker-executor";
import { AzureStorageService } from "../azure-storage-service";
import {
  parseBackupUrl,
  extractContainerFromUrl,
  getStorageAccountFromConnectionString,
} from "./utils";

/**
 * RollbackManager handles creating, executing, and cleaning up
 * rollback backups for restore operations.
 */
export class RollbackManager {
  private dockerExecutor: DockerExecutorService;
  private azureConfigService: AzureStorageService;

  constructor(
    dockerExecutor: DockerExecutorService,
    azureConfigService: AzureStorageService,
  ) {
    this.dockerExecutor = dockerExecutor;
    this.azureConfigService = azureConfigService;
  }

  /**
   * Create a rollback backup before restore
   */
  async createRollbackBackup(
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
      const rollbackContainerName = extractContainerFromUrl(backupUrl);
      const rollbackBlobName = `${databaseName}/rollback-${timestamp}.dump`;

      // Generate a write SAS URL for the rollback backup upload
      const rollbackTimeoutMs = 30 * 60 * 1000;
      const sasExpiryMinutes = Math.ceil(rollbackTimeoutMs / 60000) + 15;
      const azureSasUrl = await this.azureConfigService.generateBlobSasUrl(
        rollbackContainerName,
        rollbackBlobName,
        sasExpiryMinutes,
        "write",
      );

      servicesLogger().info(
        {
          rollbackContainerName,
          rollbackBlobName,
          timestamp,
          backupUrl,
          sasExpiryMinutes,
        },
        "Generated rollback backup path and write SAS URL",
      );

      const containerEnv = {
        POSTGRES_HOST: connectionConfig.host,
        POSTGRES_PORT: connectionConfig.port.toString(),
        POSTGRES_USER: connectionConfig.username,
        POSTGRES_PASSWORD: "[REDACTED]",
        POSTGRES_DATABASE: connectionConfig.database,
        AZURE_SAS_URL: "[REDACTED]",
      };

      dockerExecutorLogger().info(
        {
          dockerImage,
          environment: containerEnv,
          timeoutMs: rollbackTimeoutMs,
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
          AZURE_SAS_URL: azureSasUrl,
        },
        timeout: rollbackTimeoutMs,
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

      const rollbackBackupUrl = `https://${getStorageAccountFromConnectionString(azureConnectionString)}.blob.core.windows.net/${rollbackContainerName}/${rollbackBlobName}`;

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
  async executeRollback(
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

      const { containerName, blobName } = parseBackupUrl(rollbackBackupUrl);

      // Generate a read SAS URL for the rollback backup download
      const rollbackTimeoutMs = 60 * 60 * 1000;
      const sasExpiryMinutes = Math.ceil(rollbackTimeoutMs / 60000) + 15;
      const azureSasUrl = await this.azureConfigService.generateBlobSasUrl(
        containerName,
        blobName,
        sasExpiryMinutes,
        "read",
      );

      servicesLogger().debug(
        {
          rollbackBackupUrl,
          containerName,
          blobName,
          sasExpiryMinutes,
        },
        "Generated read SAS URL for rollback restore",
      );

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

      dockerExecutorLogger().info(
        {
          dockerImage,
          environment: containerEnv,
          timeoutMs: rollbackTimeoutMs,
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
          AZURE_SAS_URL: azureSasUrl,
          RESTORE: "yes",
          DROP_PUBLIC: "yes",
        },
        timeout: rollbackTimeoutMs,
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
        throw new Error(
          `Rollback execution failed: ${containerResult.stderr}`,
        );
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
   * Clean up rollback backup after successful restore
   */
  async cleanupRollbackBackup(rollbackBackupUrl: string): Promise<void> {
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

      const { containerName, blobName } = parseBackupUrl(rollbackBackupUrl);

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
}
