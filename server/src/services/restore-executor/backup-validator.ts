import { getLogger } from "../../lib/logger-factory";
import type { StorageBackend } from "@mini-infra/types";
import { parseBackupUrl } from "./utils";
import type { BackupValidationResult } from "./types";

/**
 * BackupValidator validates backup files in the active StorageBackend
 * before restore operations are executed.
 */
export class BackupValidator {
  private backend: StorageBackend;

  constructor(backend: StorageBackend) {
    this.backend = backend;
  }

  /**
   * Validate backup file before restore.
   *
   * Performs cheap pre-flight checks: existence, plausible size, optional
   * databaseId match (legacy backups encode it as the path's first segment),
   * and a non-fatal age warning.
   */
  async validateBackupFile(
    backupUrl: string,
    databaseId?: string,
  ): Promise<BackupValidationResult> {
    try {
      const { containerName, blobName } = parseBackupUrl(backupUrl);
      getLogger("backup", "backup-validator").debug(
        { backupUrl, containerName, blobName, databaseId },
        "Starting backup file validation",
      );

      const head = await this.backend.head({ id: containerName }, blobName);
      if (!head) {
        return {
          isValid: false,
          error: `Backup file not found in storage: ${blobName}`,
        };
      }

      const sizeBytes = head.size ?? 0;
      if (sizeBytes < 100) {
        return {
          isValid: false,
          error: `Backup file appears to be too small (${sizeBytes} bytes) or corrupted`,
        };
      }

      const maxSizeBytes = 50 * 1024 * 1024 * 1024; // 50GB
      if (sizeBytes > maxSizeBytes) {
        getLogger("backup", "backup-validator").warn(
          { backupUrl, sizeBytes, maxSizeBytes },
          "Warning: Backup file is extremely large",
        );
      }

      if (databaseId) {
        const pathParts = blobName.split("/");
        const backupDatabaseId = pathParts[0];
        if (backupDatabaseId !== databaseId) {
          getLogger("backup", "backup-validator").warn(
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

      const maxAgeInDays = 365;
      const lastModified = head.lastModified ?? new Date();
      const ageInMs = Date.now() - lastModified.getTime();
      const ageInDays = ageInMs / (1000 * 60 * 60 * 24);
      if (ageInDays > maxAgeInDays) {
        getLogger("backup", "backup-validator").warn(
          { backupUrl, ageInDays: Math.round(ageInDays), maxAgeInDays },
          "Warning: Backup file is quite old",
        );
      }

      const expectedContentTypes = [
        "application/octet-stream",
        "application/sql",
        "text/plain",
        undefined,
      ];
      if (
        head.contentType &&
        !expectedContentTypes.includes(head.contentType)
      ) {
        getLogger("backup", "backup-validator").warn(
          { backupUrl, contentType: head.contentType, expectedContentTypes },
          "Warning: Unexpected backup file content type",
        );
      }

      getLogger("backup", "backup-validator").info(
        {
          backupUrl,
          containerName,
          blobName,
          sizeBytes,
          sizeMB: Math.round(sizeBytes / (1024 * 1024)),
          lastModified: lastModified.toISOString(),
          contentType: head.contentType,
          ageInDays: Math.round(ageInDays),
        },
        "Backup file validated successfully",
      );

      return {
        isValid: true,
        sizeBytes,
        lastModified,
        metadata: {
          contentType: head.contentType,
          etag: head.etag,
          containerName,
          blobName,
          ageInDays: Math.round(ageInDays),
        },
      };
    } catch (error) {
      getLogger("backup", "backup-validator").error(
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
}
