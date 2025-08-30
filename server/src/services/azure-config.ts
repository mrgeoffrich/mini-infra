import { PrismaClient } from "../generated/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
} from "@mini-infra/types";
import { ConfigurationService } from "./configuration-base";
import logger from "../lib/logger";
import config from "../lib/config";
import { BlobServiceClient } from "@azure/storage-blob";

/**
 * AzureConfigService handles Azure Storage configuration management
 * Extends the base ConfigurationService to provide Azure-specific functionality
 */
export class AzureConfigService extends ConfigurationService {
  private static readonly CONNECTION_STRING_KEY = "connection_string";
  private static readonly STORAGE_ACCOUNT_KEY = "storage_account_name";

  private get timeoutMs(): number {
    return config.AZURE_API_TIMEOUT;
  }

  constructor(prisma: PrismaClient) {
    super(prisma, "azure");
  }

  /**
   * Validate Azure Storage configuration by testing connection
   * @returns ValidationResult with connectivity status and details
   */
  async validate(): Promise<ValidationResult> {
    const startTime = Date.now();

    try {
      const connectionString = await this.get(
        AzureConfigService.CONNECTION_STRING_KEY,
      );

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
        logger.warn(
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

      const metadata: Record<string, any> = {
        accountName,
        skuName: accountInfo.skuName,
        accountKind: accountInfo.accountKind,
        containerCount: containers.length,
        containers: containers.slice(0, 5), // Include first 5 container names
      };

      // Store account name for future reference
      if (accountName !== "Unknown") {
        await this.set(
          AzureConfigService.STORAGE_ACCOUNT_KEY,
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

      logger.error(
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
      AzureConfigService.CONNECTION_STRING_KEY,
      connectionString,
      userId,
    );
  }

  /**
   * Get connection string
   * @returns Connection string or null if not set
   */
  async getConnectionString(): Promise<string | null> {
    return await this.get(AzureConfigService.CONNECTION_STRING_KEY);
  }

  /**
   * Get storage account name
   * @returns Storage account name or null if not set
   */
  async getStorageAccountName(): Promise<string | null> {
    return await this.get(AzureConfigService.STORAGE_ACCOUNT_KEY);
  }

  /**
   * Test blob container access and retrieve container information
   * @returns Array of container information or empty array if no containers or connection fails
   */
  async getContainerInfo(): Promise<any[]> {
    try {
      const connectionString = await this.getConnectionString();

      if (!connectionString) {
        logger.warn(
          "Cannot retrieve container info: Connection string not configured",
        );
        return [];
      }

      const blobServiceClient =
        BlobServiceClient.fromConnectionString(connectionString);

      // Fetch containers with timeout
      const containersPromise = (async () => {
        const containers: any[] = [];
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

      logger.info(
        {
          containerCount: containers.length,
        },
        "Successfully retrieved Azure Storage container information",
      );

      return containers;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error(
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
   * @returns boolean indicating if container is accessible
   */
  async testContainerAccess(containerName: string): Promise<boolean> {
    try {
      const connectionString = await this.getConnectionString();

      if (!connectionString) {
        return false;
      }

      const blobServiceClient =
        BlobServiceClient.fromConnectionString(connectionString);
      const containerClient =
        blobServiceClient.getContainerClient(containerName);

      // Try to list first blob with timeout
      const listPromise = (async () => {
        const iterator = containerClient.listBlobsFlat();
        const page = await iterator.next();
        return page.done !== undefined;
      })();

      const timeoutPromise = new Promise<boolean>((_, reject) =>
        setTimeout(
          () => reject(new Error("Container access test timeout")),
          5000, // Shorter timeout for container access test
        ),
      );

      await Promise.race([listPromise, timeoutPromise]);

      logger.info({ containerName }, "Container access test successful");

      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.warn(
        {
          containerName,
          error: errorMessage,
        },
        "Container access test failed",
      );

      return false;
    }
  }

  /**
   * Remove connection string and storage account name
   * @param userId - User ID who is removing the configuration
   */
  async removeConfiguration(userId: string): Promise<void> {
    try {
      await this.delete(AzureConfigService.CONNECTION_STRING_KEY, userId);
    } catch (error) {
      // Connection string might not exist, continue
    }

    try {
      const oldAccountName = await this.get(
        AzureConfigService.STORAGE_ACCOUNT_KEY,
      );
      await this.delete(AzureConfigService.STORAGE_ACCOUNT_KEY, userId);
    } catch (error) {
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
}
