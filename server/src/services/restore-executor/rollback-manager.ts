import type { DatabaseConnectionConfig, StorageBackend } from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import { DockerExecutorService } from "../docker-executor";
import {
  parseBackupUrl,
  extractContainerFromUrl,
} from "./utils";
import {
  buildSidecarUploadEnv,
  buildSidecarDownloadEnv,
  redactSidecarEnv,
} from "../backup/sidecar-env";

/**
 * RollbackManager handles creating, executing, and cleaning up rollback
 * backups for restore operations. Provider-agnostic — every storage call goes
 * through `StorageBackend`.
 */
export class RollbackManager {
  private dockerExecutor: DockerExecutorService;
  private storageBackend: StorageBackend;

  constructor(
    dockerExecutor: DockerExecutorService,
    storageBackend: StorageBackend,
  ) {
    this.dockerExecutor = dockerExecutor;
    this.storageBackend = storageBackend;
  }

  /**
   * Create a rollback backup before restore.
   *
   * Returns the public-ish URL of the new rollback object so it can later be
   * passed to `executeRollback()`. Azure backends populate this from the
   * upload result; Drive will populate it from a `getDownloadHandle()` call.
   */
  async createRollbackBackup(
    connectionConfig: DatabaseConnectionConfig,
    dockerImage: string,
    databaseName: string,
    backupUrl: string,
    networkMode?: string,
  ): Promise<string> {
    const startTime = Date.now();
    try {
      getLogger("backup", "rollback-manager").info(
        {
          databaseName,
          host: connectionConfig.host,
          port: connectionConfig.port,
          database: connectionConfig.database,
        },
        "Creating pre-restore backup for rollback purposes",
      );

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rollbackContainerName = extractContainerFromUrl(backupUrl);
      const rollbackBlobName = `${databaseName}/rollback-${timestamp}.dump`;

      // Mint a write upload handle for the rollback backup; the sidecar uses
      // the provider-discriminated payload to upload directly.
      const rollbackTimeoutMs = 30 * 60 * 1000;
      const ttlMinutes = Math.ceil(rollbackTimeoutMs / 60000) + 15;
      const handle = await this.storageBackend.mintUploadHandle(
        { id: rollbackContainerName },
        rollbackBlobName,
        ttlMinutes,
      );

      const sidecarEnv = buildSidecarUploadEnv(handle);

      getLogger("backup", "rollback-manager").info(
        {
          rollbackContainerName,
          rollbackBlobName,
          timestamp,
          backupUrl,
          ttlMinutes,
          providerId: this.storageBackend.providerId,
          handleKind: handle.kind,
        },
        "Generated rollback backup path and write upload handle",
      );

      const containerEnv = {
        POSTGRES_HOST: connectionConfig.host,
        POSTGRES_PORT: connectionConfig.port.toString(),
        POSTGRES_USER: connectionConfig.username,
        POSTGRES_PASSWORD: "[REDACTED]",
        POSTGRES_DATABASE: connectionConfig.database,
        ...redactSidecarEnv(sidecarEnv),
      };

      getLogger("backup", "rollback-manager").info(
        {
          dockerImage,
          environment: containerEnv,
          timeoutMs: rollbackTimeoutMs,
        },
        "Starting rollback backup container",
      );

      const containerResult = await this.dockerExecutor.executeContainer({
        image: dockerImage,
        env: {
          POSTGRES_HOST: connectionConfig.host,
          POSTGRES_PORT: connectionConfig.port.toString(),
          POSTGRES_USER: connectionConfig.username,
          POSTGRES_PASSWORD: connectionConfig.password,
          POSTGRES_DATABASE: connectionConfig.database,
          ...sidecarEnv,
        },
        timeout: rollbackTimeoutMs,
        ...(networkMode && { networkMode }),
      });

      getLogger("backup", "rollback-manager").info(
        {
          exitCode: containerResult.exitCode,
          stdoutLength: containerResult.stdout?.length || 0,
          stderrLength: containerResult.stderr?.length || 0,
          executionTimeMs: Date.now() - startTime,
        },
        "Rollback backup container execution completed",
      );

      if (containerResult.stdout) {
        getLogger("backup", "rollback-manager").debug(
          { stdout: containerResult.stdout.substring(0, 500) },
          "Rollback backup container stdout (truncated)",
        );
      }
      if (containerResult.stderr) {
        getLogger("backup", "rollback-manager").debug(
          { stderr: containerResult.stderr.substring(0, 500) },
          "Rollback backup container stderr (truncated)",
        );
      }

      if (containerResult.exitCode !== 0) {
        getLogger("backup", "rollback-manager").error(
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

      // Always stash the path-shaped locator so executeRollback() can
      // re-resolve via the active backend. Azure could mint a fresh SAS at
      // restore-time anyway; Drive needs the locator + a freshly-minted token.
      const rollbackBackupUrl = `${rollbackContainerName}/${rollbackBlobName}`;

      getLogger("backup", "rollback-manager").info(
        {
          rollbackBackupUrl,
          databaseName,
          creationTimeMs: Date.now() - startTime,
        },
        "Rollback backup created successfully",
      );

      return rollbackBackupUrl;
    } catch (error) {
      getLogger("backup", "rollback-manager").error(
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
   * Execute rollback using the pre-restore backup.
   */
  async executeRollback(
    connectionConfig: DatabaseConnectionConfig,
    rollbackBackupUrl: string,
    dockerImage: string,
    networkMode?: string,
  ): Promise<void> {
    const startTime = Date.now();
    try {
      getLogger("backup", "rollback-manager").info(
        {
          rollbackBackupUrl,
          databaseHost: connectionConfig.host,
          databaseName: connectionConfig.database,
        },
        "Executing rollback to pre-restore state",
      );

      const { containerName, blobName } = parseBackupUrl(rollbackBackupUrl);

      const rollbackTimeoutMs = 60 * 60 * 1000;
      const ttlMinutes = Math.ceil(rollbackTimeoutMs / 60000) + 15;

      const sidecarEnv = await buildSidecarDownloadEnv(
        this.storageBackend,
        { id: containerName },
        blobName,
        ttlMinutes,
      );
      if (!sidecarEnv) {
        throw new Error(
          `Rollback restore could not get a download handle from provider '${this.storageBackend.providerId}'`,
        );
      }

      getLogger("backup", "rollback-manager").debug(
        {
          rollbackBackupUrl,
          containerName,
          blobName,
          ttlMinutes,
          provider: sidecarEnv.STORAGE_PROVIDER,
        },
        "Generated download handle for rollback restore",
      );

      const containerEnv = {
        POSTGRES_HOST: connectionConfig.host,
        POSTGRES_PORT: connectionConfig.port.toString(),
        POSTGRES_USER: connectionConfig.username,
        POSTGRES_PASSWORD: "[REDACTED]",
        POSTGRES_DATABASE: connectionConfig.database,
        ...redactSidecarEnv(sidecarEnv),
        RESTORE: "yes",
        DROP_PUBLIC: "yes",
      };

      getLogger("backup", "rollback-manager").info(
        { dockerImage, environment: containerEnv, timeoutMs: rollbackTimeoutMs },
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
          ...sidecarEnv,
          RESTORE: "yes",
          DROP_PUBLIC: "yes",
        },
        timeout: rollbackTimeoutMs,
        ...(networkMode && { networkMode }),
      });

      getLogger("backup", "rollback-manager").info(
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
        getLogger("backup", "rollback-manager").debug(
          { stdout: containerResult.stdout.substring(0, 500) },
          "Rollback container stdout (truncated)",
        );
      }
      if (containerResult.stderr) {
        getLogger("backup", "rollback-manager").debug(
          { stderr: containerResult.stderr.substring(0, 500) },
          "Rollback container stderr (truncated)",
        );
      }

      if (containerResult.exitCode !== 0) {
        getLogger("backup", "rollback-manager").error(
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

      getLogger("backup", "rollback-manager").info(
        { rollbackBackupUrl, executionTimeMs: Date.now() - startTime },
        "Rollback executed successfully",
      );
    } catch (error) {
      getLogger("backup", "rollback-manager").error(
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
   * Clean up the rollback backup object after a successful restore.
   * Always best-effort: cleanup failure must not fail the parent restore.
   */
  async cleanupRollbackBackup(rollbackBackupUrl: string): Promise<void> {
    const startTime = Date.now();
    try {
      getLogger("backup", "rollback-manager").debug(
        { rollbackBackupUrl },
        "Starting rollback backup cleanup",
      );

      const { containerName, blobName } = parseBackupUrl(rollbackBackupUrl);
      await this.storageBackend.delete({ id: containerName }, blobName);

      getLogger("backup", "rollback-manager").info(
        { rollbackBackupUrl, cleanupTimeMs: Date.now() - startTime },
        "Rollback backup deleted successfully",
      );
    } catch (error) {
      getLogger("backup", "rollback-manager").warn(
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
