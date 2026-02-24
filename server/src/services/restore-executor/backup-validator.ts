import { BlobServiceClient } from "@azure/storage-blob";
import { servicesLogger } from "../../lib/logger-factory";
import { AzureConfigService } from "../azure-config";
import { parseBackupUrl } from "./utils";
import type { BackupValidationResult } from "./types";

/**
 * BackupValidator handles validation of backup files in Azure Storage
 * before restore operations are executed.
 */
export class BackupValidator {
  private azureConfigService: AzureConfigService;

  constructor(azureConfigService: AzureConfigService) {
    this.azureConfigService = azureConfigService;
  }

  /**
   * Validate backup file before restore
   */
  async validateBackupFile(
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
      const { containerName, blobName } = parseBackupUrl(backupUrl);
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
}
