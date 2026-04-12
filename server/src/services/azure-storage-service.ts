import { PrismaClient } from "../lib/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
} from "@mini-infra/types";
import { ConfigurationService } from "./configuration-base";
import { toServiceError } from "../lib/service-error-mapper";
import { servicesLogger } from "../lib/logger-factory";
import { azureConfig } from "../lib/config-new";
import {
  BlobServiceClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import NodeCache from "node-cache";

interface ContainerInfo {
  name: string;
  lastModified?: Date;
  etag?: string;
  leaseStatus?: string;
  leaseState?: string;
  hasImmutabilityPolicy?: boolean;
  hasLegalHold?: boolean;
  metadata?: Record<string, string>;
}

/**
 * Backup file metadata interface
 */
export interface BackupFileMetadata {
  name: string;
  blobUrl: string;
  size: number;
  createdAt: Date;
  lastModified: Date;
  databaseName: string;
  backupType: string;
  pathPrefix: string;
  contentMD5?: string;
  metadata: Record<string, string>;
  etag: string;
}

/**
 * Backup file list result
 */
export interface BackupFileListResult {
  files: BackupFileMetadata[];
  totalCount: number;
  containerName: string;
  pathPrefix?: string;
}

/**
 * Download stream result
 */
export interface BackupDownloadResult {
  stream: NodeJS.ReadableStream;
  contentLength: number;
  contentType: string;
  fileName: string;
}

/**
 * Retention policy enforcement result
 */
export interface RetentionEnforcementResult {
  deletedFiles: string[];
  deletedCount: number;
  totalSizeFreed: number;
  errors: string[];
}

/**
 * AzureStorageService handles Azure Storage configuration management
 * Extends the base ConfigurationService to provide Azure-specific functionality
 */
export class AzureStorageService extends ConfigurationService {
  private static readonly CONNECTION_STRING_KEY = "connection_string";
  private static readonly STORAGE_ACCOUNT_KEY = "storage_account_name";

  // Cache for container access test results (5 minute TTL)
  private static containerAccessCache = new NodeCache({
    stdTTL: 300, // 5 minutes
    checkperiod: 60, // Check for expired keys every minute
    useClones: false,
  });

  private get timeoutMs(): number {
    return azureConfig.apiTimeout;
  }

  constructor(prisma: PrismaClient) {
    super(prisma, "azure");
  }

  /**
   * Retry helper for transient failures
   */
  private async retryOperation<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelayMs: number = 1000,
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        const errorMessage = lastError.message.toLowerCase();

        // Don't retry on authentication or authorization errors
        if (
          errorMessage.includes("authenticationfailed") ||
          errorMessage.includes("forbidden") ||
          errorMessage.includes("invalidaccountkey") ||
          errorMessage.includes("invalidstorage")
        ) {
          throw lastError;
        }

        // Don't retry on final attempt
        if (attempt === maxRetries) {
          break;
        }

        // Exponential backoff with jitter
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
        servicesLogger().warn(
          {
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
            delayMs: Math.round(delay),
            error: errorMessage,
          },
          "Azure operation failed, retrying...",
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }

  /**
   * Validate Azure Storage configuration by testing connection
   * @param settings - Optional settings to validate with (overrides stored settings)
   * @returns ValidationResult with connectivity status and details
   */
  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    const startTime = Date.now();

    try {
      const connectionString = settings?.connectionString || (await this.get(
        AzureStorageService.CONNECTION_STRING_KEY,
      ));

      if (!connectionString) {
        const result: ValidationResult = {
          isValid: false,
          message: "Azure Storage connection string not configured",
          errorCode: "MISSING_CONNECTION_STRING",
          responseTimeMs: Date.now() - startTime,
        };

        await this.recordConnectivityStatus(
          "failed",
          result.responseTimeMs,
          result.message,
          result.errorCode,
        );

        return result;
      }

      // Create BlobServiceClient with timeout
      const blobServiceClient =
        BlobServiceClient.fromConnectionString(connectionString);

      // Test connection by getting account info
      const accountInfoPromise = blobServiceClient.getAccountInfo();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Azure API request timeout")),
          this.timeoutMs,
        ),
      );

      const accountInfo = await Promise.race([
        accountInfoPromise,
        timeoutPromise,
      ]);

      const responseTime = Date.now() - startTime;

      // Extract storage account name from connection string
      const accountNameMatch = connectionString.match(/AccountName=([^;]+)/);
      const accountName = accountNameMatch ? accountNameMatch[1] : "Unknown";

      // List containers to verify access
      const containers: string[] = [];
      try {
        const containerIterator = blobServiceClient.listContainers();
        for await (const container of containerIterator) {
          containers.push(container.name);
          // Limit to first 10 containers for metadata
          if (containers.length >= 10) break;
        }
      } catch (containerError) {
        servicesLogger().warn(
          {
            accountName,
            error:
              containerError instanceof Error
                ? containerError.message
                : "Unknown error",
          },
          "Failed to list containers, but connection is valid",
        );
      }

      const metadata: Record<string, unknown> = {
        accountName,
        skuName: accountInfo.skuName,
        accountKind: accountInfo.accountKind,
        containerCount: containers.length,
        containers: containers.slice(0, 5), // Include first 5 container names
      };

      // Store account name for future reference
      if (accountName !== "Unknown") {
        await this.set(
          AzureStorageService.STORAGE_ACCOUNT_KEY,
          accountName,
          "system",
        );
      }

      const result: ValidationResult = {
        isValid: true,
        message: `Azure Storage connection successful (${accountName})`,
        responseTimeMs: responseTime,
        metadata,
      };

      await this.recordConnectivityStatus(
        "connected",
        result.responseTimeMs,
        undefined,
        undefined,
        metadata,
      );

      return result;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      let errorCode = "AZURE_STORAGE_ERROR";
      let connectivityStatus: ConnectivityStatusType = "failed";

      // Parse specific Azure Storage errors
      if (errorMessage.includes("timeout")) {
        errorCode = "TIMEOUT";
        connectivityStatus = "timeout";
      } else if (
        errorMessage.includes("AuthenticationFailed") ||
        errorMessage.includes("InvalidStorageAccountName") ||
        errorMessage.includes("InvalidAccountKey")
      ) {
        errorCode = "INVALID_CREDENTIALS";
      } else if (errorMessage.includes("Forbidden")) {
        errorCode = "INSUFFICIENT_PERMISSIONS";
      } else if (
        errorMessage.includes("ENOTFOUND") ||
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("getaddrinfo")
      ) {
        errorCode = "NETWORK_ERROR";
        connectivityStatus = "unreachable";
      } else if (errorMessage.includes("Rate exceeded")) {
        errorCode = "RATE_LIMITED";
      } else if (errorMessage.includes("InvalidUri")) {
        errorCode = "INVALID_CONNECTION_STRING";
      }

      const result: ValidationResult = {
        isValid: false,
        message: `Azure Storage validation failed: ${errorMessage}`,
        errorCode,
        responseTimeMs: responseTime,
      };

      await this.recordConnectivityStatus(
        connectivityStatus,
        result.responseTimeMs,
        result.message,
        result.errorCode,
      );

      servicesLogger().error(
        {
          error: errorMessage,
          errorCode,
          responseTime,
        },
        "Azure Storage validation failed",
      );

      return result;
    }
  }

  /**
   * Get current health status of the Azure Storage service
   * @returns ServiceHealthStatus with current connectivity information
   */
  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latestStatus = await this.getLatestConnectivityStatus();

    if (!latestStatus) {
      // No previous status, perform validation
      const validationResult = await this.validate();

      return {
        service: "azure",
        status: validationResult.isValid ? "connected" : "failed",
        lastChecked: new Date(),
        responseTime: validationResult.responseTimeMs,
        errorMessage: validationResult.isValid
          ? undefined
          : validationResult.message,
        errorCode: validationResult.errorCode,
        metadata: validationResult.metadata,
      };
    }

    return {
      service: "azure",
      status: latestStatus.status as ConnectivityStatusType,
      lastChecked: latestStatus.checkedAt,
      lastSuccessful: latestStatus.lastSuccessfulAt,
      responseTime: latestStatus.responseTimeMs || undefined,
      errorMessage: latestStatus.errorMessage || undefined,
      errorCode: latestStatus.errorCode || undefined,
      metadata: latestStatus.metadata
        ? JSON.parse(latestStatus.metadata)
        : undefined,
    };
  }

  /**
   * Set connection string with validation
   * @param connectionString - Azure Storage connection string
   * @param userId - User ID who is setting the connection string
   */
  async setConnectionString(
    connectionString: string,
    userId: string,
  ): Promise<void> {
    if (!connectionString || connectionString.trim().length === 0) {
      throw new Error("Connection string cannot be empty");
    }

    // Validate connection string format
    const requiredKeys = [
      "DefaultEndpointsProtocol",
      "AccountName",
      "AccountKey",
    ];
    const missingKeys = requiredKeys.filter(
      (key) => !connectionString.includes(`${key}=`),
    );

    if (missingKeys.length > 0) {
      throw new Error(
        `Invalid connection string format. Missing: ${missingKeys.join(", ")}`,
      );
    }

    await this.set(
      AzureStorageService.CONNECTION_STRING_KEY,
      connectionString,
      userId,
    );
  }

  /**
   * Get connection string
   * @returns Connection string or null if not set
   */
  async getConnectionString(): Promise<string | null> {
    return await this.get(AzureStorageService.CONNECTION_STRING_KEY);
  }

  /**
   * Get storage account name
   * @returns Storage account name or null if not set
   */
  async getStorageAccountName(): Promise<string | null> {
    return await this.get(AzureStorageService.STORAGE_ACCOUNT_KEY);
  }

  /**
   * Test blob container access and retrieve container information
   * @returns Array of container information or empty array if no containers or connection fails
   */
  async getContainerInfo(): Promise<ContainerInfo[]> {
    try {
      const connectionString = await this.getConnectionString();

      if (!connectionString) {
        servicesLogger().warn(
          "Cannot retrieve container info: Connection string not configured",
        );
        return [];
      }

      const blobServiceClient =
        BlobServiceClient.fromConnectionString(connectionString);

      // Fetch containers with timeout
      const containersPromise = (async () => {
        const containers: ContainerInfo[] = [];
        const containerIterator = blobServiceClient.listContainers({
          includeMetadata: true,
        });

        for await (const container of containerIterator) {
          containers.push({
            name: container.name,
            lastModified: container.properties.lastModified,
            etag: container.properties.etag,
            leaseStatus: container.properties.leaseStatus,
            leaseState: container.properties.leaseState,
            hasImmutabilityPolicy: container.properties.hasImmutabilityPolicy,
            hasLegalHold: container.properties.hasLegalHold,
            metadata: container.metadata,
          });

          // Limit to prevent excessive data
          if (containers.length >= 50) break;
        }

        return containers;
      })();

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Container listing timeout")),
          this.timeoutMs,
        ),
      );

      const containers = await Promise.race([
        containersPromise,
        timeoutPromise,
      ]);

      servicesLogger().info(
        {
          containerCount: containers.length,
        },
        "Successfully retrieved Azure Storage container information",
      );

      return containers;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        {
          error: errorMessage,
        },
        "Failed to retrieve Azure Storage container information",
      );

      return [];
    }
  }

  /**
   * Test container access by attempting to list blobs in a specific container
   * @param containerName - Name of the container to test
   * @returns Object with access result, response time, and error details
   */
  async testContainerAccess(containerName: string): Promise<{
    accessible: boolean;
    responseTimeMs: number;
    error?: string;
    errorCode?: string;
    cached?: boolean;
  }> {
    const cacheKey = `container_access:${containerName}`;

    // Check cache first
    const cached = AzureStorageService.containerAccessCache.get<{
      accessible: boolean;
      responseTimeMs: number;
      error?: string;
      errorCode?: string;
    }>(cacheKey);

    if (cached) {
      servicesLogger().debug(
        { containerName },
        "Container access test result returned from cache",
      );
      return { ...cached, cached: true };
    }

    const startTime = Date.now();

    try {
      const connectionString = await this.getConnectionString();

      if (!connectionString) {
        const result = {
          accessible: false,
          responseTimeMs: Date.now() - startTime,
          error: "No connection string configured",
          errorCode: "MISSING_CONNECTION_STRING",
        };

        // Cache negative result for shorter time (1 minute)
        AzureStorageService.containerAccessCache.set(cacheKey, result, 60);
        return result;
      }

      // Test container access with retry logic
      const accessible = await this.retryOperation(
        async () => {
          const blobServiceClient =
            BlobServiceClient.fromConnectionString(connectionString);
          const containerClient =
            blobServiceClient.getContainerClient(containerName);

          // Try to get container properties (faster than listing blobs)
          const propertiesPromise = containerClient.getProperties();
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Container access test timeout")),
              5000, // Shorter timeout for container access test
            ),
          );

          await Promise.race([propertiesPromise, timeoutPromise]);
          return true;
        },
        2,
        500,
      ); // 2 retries with 500ms base delay

      const result = {
        accessible,
        responseTimeMs: Date.now() - startTime,
      };

      // Cache successful result
      AzureStorageService.containerAccessCache.set(cacheKey, result);

      servicesLogger().info(
        {
          containerName,
          responseTimeMs: result.responseTimeMs,
          cached: false,
        },
        "Container access test successful",
      );

      return result;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      let errorCode = "CONTAINER_ACCESS_ERROR";

      // Parse specific error types
      if (errorMessage.includes("timeout")) {
        errorCode = "TIMEOUT";
      } else if (
        errorMessage.includes("AuthenticationFailed") ||
        errorMessage.includes("InvalidAccountKey")
      ) {
        errorCode = "INVALID_CREDENTIALS";
      } else if (errorMessage.includes("ContainerNotFound")) {
        errorCode = "CONTAINER_NOT_FOUND";
      } else if (errorMessage.includes("Forbidden")) {
        errorCode = "INSUFFICIENT_PERMISSIONS";
      } else if (
        errorMessage.includes("ENOTFOUND") ||
        errorMessage.includes("ECONNREFUSED")
      ) {
        errorCode = "NETWORK_ERROR";
      }

      const result = {
        accessible: false,
        responseTimeMs: responseTime,
        error: errorMessage,
        errorCode,
      };

      // Cache error result for shorter time (2 minutes)
      AzureStorageService.containerAccessCache.set(cacheKey, result, 120);

      servicesLogger().warn(
        {
          containerName,
          error: errorMessage,
          errorCode,
          responseTime,
        },
        "Container access test failed",
      );

      return result;
    }
  }

  /**
   * List backup files in a container with metadata
   * @param containerName - Name of the Azure container
   * @param pathPrefix - Optional path prefix to filter files
   * @param databaseName - Optional database name to filter files
   * @param maxResults - Maximum number of results to return (default: 100)
   * @returns BackupFileListResult with file metadata
   */
  async listBackupFiles(
    containerName: string,
    pathPrefix?: string,
    databaseName?: string,
    maxResults: number = 100,
  ): Promise<BackupFileListResult> {
    try {
      const connectionString = await this.getConnectionString();
      if (!connectionString) {
        throw new Error("Azure connection string not configured");
      }

      const blobServiceClient =
        BlobServiceClient.fromConnectionString(connectionString);
      const containerClient =
        blobServiceClient.getContainerClient(containerName);

      // Build prefix for filtering
      let searchPrefix = pathPrefix || "";
      if (databaseName) {
        searchPrefix = searchPrefix
          ? `${searchPrefix}/${databaseName}`
          : databaseName;
      }

      const files: BackupFileMetadata[] = [];
      let totalCount = 0;

      // List blobs with metadata
      const listOptions = {
        prefix: searchPrefix || undefined,
        includeMetadata: true,
      };

      for await (const blob of containerClient.listBlobsFlat(listOptions)) {
        if (totalCount >= maxResults) {
          break;
        }

        // Parse database name from blob path
        const pathParts = blob.name.split("/");
        let extractedDbName = databaseName;

        if (!extractedDbName) {
          // Try to extract from path structure
          if (pathPrefix && blob.name.startsWith(pathPrefix + "/")) {
            const remainingPath = blob.name.substring(pathPrefix.length + 1);
            extractedDbName = remainingPath.split("/")[0];
          } else {
            extractedDbName = pathParts[0];
          }
        }

        // Determine backup type from file extension
        let backupType = "unknown";
        if (blob.name.endsWith(".sql")) {
          backupType = "sql";
        } else if (
          blob.name.endsWith(".dump") ||
          blob.name.endsWith(".backup")
        ) {
          backupType = "custom";
        } else if (blob.name.endsWith(".tar")) {
          backupType = "tar";
        }

        const fileMetadata: BackupFileMetadata = {
          name: blob.name,
          blobUrl: `https://${blobServiceClient.accountName}.blob.core.windows.net/${containerName}/${blob.name}`,
          size: blob.properties.contentLength || 0,
          createdAt: blob.properties.createdOn || new Date(),
          lastModified: blob.properties.lastModified || new Date(),
          databaseName: extractedDbName || "unknown",
          backupType,
          pathPrefix: pathPrefix || "",
          contentMD5: blob.properties.contentMD5
            ? Buffer.from(blob.properties.contentMD5).toString("hex")
            : undefined,
          metadata: blob.metadata || {},
          etag: blob.properties.etag || "",
        };

        files.push(fileMetadata);
        totalCount++;
      }

      // Sort files by creation date (newest first)
      files.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      servicesLogger().info(
        {
          containerName,
          pathPrefix,
          databaseName,
          fileCount: files.length,
          maxResults,
        },
        "Listed backup files from Azure Storage",
      );

      return {
        files,
        totalCount,
        containerName,
        pathPrefix,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        {
          error: errorMessage,
          containerName,
          pathPrefix,
          databaseName,
          maxResults,
        },
        "Failed to list backup files from Azure Storage",
      );

      throw toServiceError(error, "azure");
    }
  }

  /**
   * Download a backup file from Azure Storage
   * @param containerName - Name of the Azure container
   * @param blobName - Name of the blob to download
   * @returns BackupDownloadResult with download stream
   */
  async downloadBackupFile(
    containerName: string,
    blobName: string,
  ): Promise<BackupDownloadResult> {
    try {
      const connectionString = await this.getConnectionString();
      if (!connectionString) {
        throw new Error("Azure connection string not configured");
      }

      const blobServiceClient =
        BlobServiceClient.fromConnectionString(connectionString);
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);
      const blockBlobClient = blobClient.getBlockBlobClient();

      // Get blob properties first
      const properties = await blockBlobClient.getProperties();

      // Start download
      const downloadResponse = await blockBlobClient.download(0);

      if (!downloadResponse.readableStreamBody) {
        throw new Error("Failed to get download stream");
      }

      const fileName = blobName.split("/").pop() || blobName;

      servicesLogger().info(
        {
          containerName,
          blobName,
          contentLength: properties.contentLength,
          fileName,
        },
        "Started backup file download from Azure Storage",
      );

      return {
        stream: downloadResponse.readableStreamBody,
        contentLength: properties.contentLength || 0,
        contentType: properties.contentType || "application/octet-stream",
        fileName,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        {
          error: errorMessage,
          containerName,
          blobName,
        },
        "Failed to download backup file from Azure Storage",
      );

      throw toServiceError(error, "azure");
    }
  }

  /**
   * Enforce retention policy by deleting old backup files
   * @param containerName - Name of the Azure container
   * @param retentionDays - Number of days to retain backups
   * @param pathPrefix - Optional path prefix to limit deletion scope
   * @param databaseName - Optional database name to limit deletion scope
   * @returns RetentionEnforcementResult with deletion details
   */
  async enforceRetentionPolicy(
    containerName: string,
    retentionDays: number,
    pathPrefix?: string,
    databaseName?: string,
  ): Promise<RetentionEnforcementResult> {
    try {
      const connectionString = await this.getConnectionString();
      if (!connectionString) {
        throw new Error("Azure connection string not configured");
      }

      const blobServiceClient =
        BlobServiceClient.fromConnectionString(connectionString);
      const containerClient =
        blobServiceClient.getContainerClient(containerName);

      // Calculate cutoff date
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      const deletedFiles: string[] = [];
      const errors: string[] = [];
      let totalSizeFreed = 0;

      // Build prefix for filtering
      let searchPrefix = pathPrefix || "";
      if (databaseName) {
        searchPrefix = searchPrefix
          ? `${searchPrefix}/${databaseName}`
          : databaseName;
      }

      // List blobs to find old ones
      const listOptions = {
        prefix: searchPrefix || undefined,
        includeMetadata: true,
      };

      for await (const blob of containerClient.listBlobsFlat(listOptions)) {
        const blobDate =
          blob.properties.createdOn || blob.properties.lastModified;

        if (blobDate && blobDate < cutoffDate) {
          try {
            const blobClient = containerClient.getBlobClient(blob.name);
            await blobClient.delete();

            deletedFiles.push(blob.name);
            totalSizeFreed += blob.properties.contentLength || 0;

            servicesLogger().debug(
              {
                blobName: blob.name,
                blobDate: blobDate.toISOString(),
                sizeBytes: blob.properties.contentLength,
              },
              "Deleted old backup file due to retention policy",
            );
          } catch (deleteError) {
            const deleteErrorMessage =
              deleteError instanceof Error
                ? deleteError.message
                : "Unknown error";
            errors.push(`Failed to delete ${blob.name}: ${deleteErrorMessage}`);

            servicesLogger().warn(
              {
                blobName: blob.name,
                error: deleteErrorMessage,
              },
              "Failed to delete backup file during retention enforcement",
            );
          }
        }
      }

      servicesLogger().info(
        {
          containerName,
          retentionDays,
          pathPrefix,
          databaseName,
          deletedCount: deletedFiles.length,
          totalSizeFreed,
          errorCount: errors.length,
        },
        "Retention policy enforcement completed",
      );

      return {
        deletedFiles,
        deletedCount: deletedFiles.length,
        totalSizeFreed,
        errors,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        {
          error: errorMessage,
          containerName,
          retentionDays,
          pathPrefix,
          databaseName,
        },
        "Failed to enforce retention policy",
      );

      throw toServiceError(error, "azure");
    }
  }

  /**
   * Index backup metadata by creating/updating blob metadata
   * @param containerName - Name of the Azure container
   * @param blobName - Name of the blob to index
   * @param metadata - Metadata to associate with the backup
   * @returns boolean indicating success
   */
  async indexBackupMetadata(
    containerName: string,
    blobName: string,
    metadata: Record<string, string>,
  ): Promise<boolean> {
    try {
      const connectionString = await this.getConnectionString();
      if (!connectionString) {
        throw new Error("Azure connection string not configured");
      }

      const blobServiceClient =
        BlobServiceClient.fromConnectionString(connectionString);
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);

      // Validate metadata keys and values (Azure Storage requirements)
      const validatedMetadata: Record<string, string> = {};

      for (const [key, value] of Object.entries(metadata)) {
        // Azure metadata keys must be valid identifiers and values must be strings
        const validKey = key.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
        const validValue = String(value).substring(0, 8192); // Max 8KB per metadata value

        if (validKey && validValue) {
          validatedMetadata[validKey] = validValue;
        }
      }

      // Add timestamp for indexing
      validatedMetadata.indexed_at = new Date().toISOString();

      await blobClient.setMetadata(validatedMetadata);

      servicesLogger().info(
        {
          containerName,
          blobName,
          metadataKeys: Object.keys(validatedMetadata),
        },
        "Backup metadata indexed successfully",
      );

      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        {
          error: errorMessage,
          containerName,
          blobName,
          metadata,
        },
        "Failed to index backup metadata",
      );

      return false;
    }
  }

  /**
   * Validate backup file integrity after upload
   * @param containerName - Name of the Azure container
   * @param blobName - Name of the blob to validate
   * @param expectedSize - Expected file size in bytes (optional)
   * @param expectedMD5 - Expected MD5 hash (optional)
   * @returns Object with validation results
   */
  async validateBackupFile(
    containerName: string,
    blobName: string,
    expectedSize?: number,
    expectedMD5?: string,
  ): Promise<{
    isValid: boolean;
    actualSize: number;
    actualMD5?: string;
    errors: string[];
  }> {
    const errors: string[] = [];

    try {
      const connectionString = await this.getConnectionString();
      if (!connectionString) {
        throw new Error("Azure connection string not configured");
      }

      const blobServiceClient =
        BlobServiceClient.fromConnectionString(connectionString);
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);

      // Get blob properties
      const properties = await blobClient.getProperties();
      const actualSize = properties.contentLength || 0;

      // Validate size
      if (expectedSize !== undefined && actualSize !== expectedSize) {
        errors.push(
          `Size mismatch: expected ${expectedSize}, got ${actualSize}`,
        );
      }

      // Validate MD5 if available
      let actualMD5: string | undefined;
      if (properties.contentMD5) {
        actualMD5 = Buffer.from(properties.contentMD5).toString("hex");

        if (expectedMD5 && actualMD5 !== expectedMD5) {
          errors.push(
            `MD5 mismatch: expected ${expectedMD5}, got ${actualMD5}`,
          );
        }
      }

      // Basic existence and accessibility check
      if (actualSize === 0) {
        errors.push("Backup file is empty");
      }

      const isValid = errors.length === 0;

      servicesLogger().info(
        {
          containerName,
          blobName,
          actualSize,
          actualMD5,
          expectedSize,
          expectedMD5,
          isValid,
          errorCount: errors.length,
        },
        "Backup file validation completed",
      );

      return {
        isValid,
        actualSize,
        actualMD5,
        errors,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      errors.push(`Validation failed: ${errorMessage}`);

      servicesLogger().error(
        {
          error: errorMessage,
          containerName,
          blobName,
          expectedSize,
          expectedMD5,
        },
        "Failed to validate backup file",
      );

      return {
        isValid: false,
        actualSize: 0,
        errors,
      };
    }
  }

  /**
   * Generate a time-limited SAS URL for blob access
   * @param containerName - Name of the Azure container
   * @param blobName - Name of the blob
   * @param expiryMinutes - Number of minutes until the SAS token expires (default: 15)
   * @param mode - Access mode: "read" for download, "write" for upload (default: "read")
   * @returns Full blob URL with SAS token appended
   */
  async generateBlobSasUrl(
    containerName: string,
    blobName: string,
    expiryMinutes: number = 15,
    mode: "read" | "write" = "read",
  ): Promise<string> {
    try {
      const connectionString = await this.getConnectionString();
      if (!connectionString) {
        throw new Error("Azure connection string not configured");
      }

      // Parse connection string to extract account name and account key
      const accountNameMatch = connectionString.match(/AccountName=([^;]+)/);
      const accountKeyMatch = connectionString.match(/AccountKey=([^;]+)/);

      if (!accountNameMatch || !accountKeyMatch) {
        throw new Error(
          "Invalid connection string: missing AccountName or AccountKey",
        );
      }

      const accountName = accountNameMatch[1];
      const accountKey = accountKeyMatch[1];

      // Create shared key credential
      const sharedKeyCredential = new StorageSharedKeyCredential(
        accountName,
        accountKey,
      );

      // Set SAS token permissions based on mode
      const permissions = new BlobSASPermissions();
      if (mode === "write") {
        permissions.create = true;
        permissions.write = true;
      } else {
        permissions.read = true;
      }

      // Calculate expiry time
      const startsOn = new Date();
      const expiresOn = new Date(startsOn.getTime() + expiryMinutes * 60 * 1000);

      // Generate SAS query parameters
      const sasToken = generateBlobSASQueryParameters(
        {
          containerName,
          blobName,
          permissions,
          startsOn,
          expiresOn,
        },
        sharedKeyCredential,
      ).toString();

      // Construct full URL with SAS token
      const blobUrl = `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`;

      servicesLogger().info(
        {
          containerName,
          blobName,
          expiryMinutes,
          expiresOn: expiresOn.toISOString(),
          mode,
        },
        `Generated SAS URL for blob ${mode}`,
      );

      return blobUrl;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        {
          error: errorMessage,
          containerName,
          blobName,
          expiryMinutes,
          mode,
        },
        "Failed to generate SAS URL",
      );

      throw toServiceError(error, "azure");
    }
  }

  /**
   * Remove connection string and storage account name
   * @param userId - User ID who is removing the configuration
   */
  async removeConfiguration(userId: string): Promise<void> {
    try {
      await this.delete(AzureStorageService.CONNECTION_STRING_KEY, userId);
    } catch {
      // Connection string might not exist, continue
    }

    try {
      await this.delete(AzureStorageService.STORAGE_ACCOUNT_KEY, userId);
    } catch {
      // Account name might not exist, continue
    }

    // Record disconnection status
    await this.recordConnectivityStatus(
      "failed",
      undefined,
      "Configuration removed by user",
      "CONFIG_REMOVED",
      undefined,
      userId,
    );
  }

  /**
   * Static cleanup method for tests to properly close the cache
   * This prevents the NodeCache timer from keeping the process alive
   */
  static cleanupCache(): void {
    if (AzureStorageService.containerAccessCache) {
      AzureStorageService.containerAccessCache.flushAll();
      AzureStorageService.containerAccessCache.close();
    }
  }
}
