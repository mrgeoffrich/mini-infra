import { PrismaClient } from "../../lib/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
  AcmeProvider,
} from "@mini-infra/types";
import { ConfigurationService } from "../configuration-base";
import { getLogger } from "../../lib/logger-factory";
import { BlobServiceClient } from "@azure/storage-blob";
import { AzureStorageService } from "../azure-storage-service";

/**
 * TLS Configuration Service Settings Keys
 */
const TLS_SETTINGS_KEYS = {
  CERTIFICATE_BLOB_CONTAINER: "certificate_blob_container",
  DEFAULT_ACME_PROVIDER: "default_acme_provider",
  DEFAULT_ACME_EMAIL: "default_acme_email",
  RENEWAL_CHECK_CRON: "renewal_check_cron",
  RENEWAL_DAYS_BEFORE_EXPIRY: "renewal_days_before_expiry",
} as const;

/**
 * ACME Account Configuration
 */
export interface AcmeAccountConfig {
  email: string;
  provider: AcmeProvider;
}

/**
 * TlsConfigService handles TLS-related configuration management
 * Extends the base ConfigurationService to provide TLS-specific functionality
 */
export class TlsConfigService extends ConfigurationService {
  private static readonly DEFAULT_RENEWAL_CRON = "0 2 * * *"; // Daily at 2 AM
  private static readonly DEFAULT_RENEWAL_DAYS = 30;
  private static readonly DEFAULT_ACME_PROVIDER: AcmeProvider = "letsencrypt";
  private static readonly TIMEOUT_MS = 15000; // 15 seconds

  private azureConfigService: AzureStorageService;

  constructor(prisma: PrismaClient) {
    super(prisma, "tls");
    this.azureConfigService = new AzureStorageService(prisma);
  }

  /**
   * Validate Azure Storage container access for certificate storage
   * @param settings - Optional settings to validate with (overrides stored settings)
   * @returns Validation result with connectivity status
   */
  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    const startTime = Date.now();
    const logger = getLogger("tls", "tls-config");

    try {
      // Get container name (from provided settings or database)
      const containerName = settings?.[TLS_SETTINGS_KEYS.CERTIFICATE_BLOB_CONTAINER]
        || (await this.get(TLS_SETTINGS_KEYS.CERTIFICATE_BLOB_CONTAINER));

      if (!containerName) {
        return {
          isValid: false,
          message: "Azure Storage container for certificates not configured",
          errorCode: "CONTAINER_NOT_CONFIGURED",
        };
      }

      // Validate container name format (Azure Storage requirements)
      if (!containerName.match(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/)) {
        return {
          isValid: false,
          message: "Invalid Azure Storage container name format",
          errorCode: "INVALID_CONTAINER_NAME",
        };
      }

      // Get Azure Storage connection string from Azure config
      const connectionString = await this.azureConfigService.getConnectionString();

      if (!connectionString) {
        return {
          isValid: false,
          message: "Azure Storage connection not configured. Please configure Azure Storage first.",
          errorCode: "AZURE_STORAGE_NOT_CONFIGURED",
        };
      }

      // Test container access
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(containerName);

      // Check if container exists
      const exists = await containerClient.exists();

      if (!exists) {
        return {
          isValid: false,
          message: `Azure Storage container '${containerName}' does not exist`,
          errorCode: "CONTAINER_NOT_FOUND",
        };
      }

      // Test read access by listing blobs (lightweight operation)
      const blobIterator = containerClient.listBlobsFlat({ prefix: "cert_" }).byPage({ maxPageSize: 1 });
      await blobIterator.next();

      const responseTime = Date.now() - startTime;

      // Record successful connectivity
      await this.recordConnectivityStatus(
        "connected",
        responseTime,
        undefined,
        undefined,
        { containerName }
      );

      logger.info(
        {
          containerName,
          responseTime,
        },
        "Azure Storage container validation successful"
      );

      return {
        isValid: true,
        message: `Azure Storage container '${containerName}' is accessible`,
        responseTimeMs: responseTime,
        metadata: {
          containerName,
        },
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage = (error instanceof Error ? error.message : String(error)) || "Unknown error";
      let errorCode = "UNKNOWN_ERROR";
      let connectivityStatus: ConnectivityStatusType = "failed";

      // Parse specific Azure Storage errors
      if (errorMessage.includes("timeout")) {
        errorCode = "TIMEOUT";
        connectivityStatus = "timeout";
      } else if (
        errorMessage.includes("AuthenticationFailed") ||
        errorMessage.includes("InvalidAccountKey")
      ) {
        errorCode = "INVALID_CREDENTIALS";
      } else if (errorMessage.includes("Forbidden") || errorMessage.includes("403")) {
        errorCode = "INSUFFICIENT_PERMISSIONS";
      } else if (
        errorMessage.includes("ENOTFOUND") ||
        errorMessage.includes("ECONNREFUSED")
      ) {
        errorCode = "NETWORK_ERROR";
        connectivityStatus = "unreachable";
      } else if (errorMessage.includes("ContainerNotFound")) {
        errorCode = "CONTAINER_NOT_FOUND";
      }

      // Record failed connectivity
      await this.recordConnectivityStatus(
        connectivityStatus,
        responseTime,
        errorMessage,
        errorCode
      );

      logger.error(
        {
          error: errorMessage,
          errorCode,
          responseTime,
        },
        "Azure Storage container validation failed"
      );

      return {
        isValid: false,
        message: `Azure Storage validation failed: ${errorMessage}`,
        errorCode,
        responseTimeMs: responseTime,
      };
    }
  }

  /**
   * Get health status of Azure Storage container connectivity
   * @returns Service health status
   */
  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latestStatus = await this.getLatestConnectivityStatus();

    if (!latestStatus) {
      return {
        service: "tls",
        status: "unreachable",
        lastChecked: new Date(),
        errorMessage: "No connectivity checks performed yet",
      };
    }

    return {
      service: "tls",
      status: latestStatus.status as ConnectivityStatusType,
      lastChecked: latestStatus.checkedAt,
      lastSuccessful: latestStatus.lastSuccessfulAt,
      responseTime: latestStatus.responseTimeMs || undefined,
      errorMessage: latestStatus.errorMessage || undefined,
      errorCode: latestStatus.errorCode || undefined,
      metadata: latestStatus.metadata ? JSON.parse(latestStatus.metadata) : undefined,
    };
  }

  /**
   * Get certificate storage container name
   * @returns Container name for certificate storage
   */
  async getCertificateContainerName(): Promise<string> {
    const containerName = await this.get(TLS_SETTINGS_KEYS.CERTIFICATE_BLOB_CONTAINER);

    if (!containerName) {
      throw new Error("Certificate storage container not configured");
    }

    return containerName;
  }

  /**
   * Get ACME account configuration
   * @returns ACME account configuration
   */
  async getAcmeAccountConfig(): Promise<AcmeAccountConfig> {
    const email = await this.get(TLS_SETTINGS_KEYS.DEFAULT_ACME_EMAIL);
    const providerStr = await this.get(TLS_SETTINGS_KEYS.DEFAULT_ACME_PROVIDER);

    if (!email) {
      throw new Error("ACME email not configured");
    }

    const provider = (providerStr as AcmeProvider) || TlsConfigService.DEFAULT_ACME_PROVIDER;

    return {
      email,
      provider,
    };
  }

  /**
   * Get renewal check cron schedule
   * @returns Cron expression
   */
  async getRenewalCheckCron(): Promise<string> {
    const cron = await this.get(TLS_SETTINGS_KEYS.RENEWAL_CHECK_CRON);
    return cron || TlsConfigService.DEFAULT_RENEWAL_CRON;
  }

  /**
   * Get renewal days before expiry
   * @returns Number of days before expiry to renew
   */
  async getRenewalDaysBeforeExpiry(): Promise<number> {
    const days = await this.get(TLS_SETTINGS_KEYS.RENEWAL_DAYS_BEFORE_EXPIRY);
    return days ? parseInt(days, 10) : TlsConfigService.DEFAULT_RENEWAL_DAYS;
  }

  /**
   * Helper method to set certificate storage container
   */
  async setCertificateContainer(containerName: string, userId: string): Promise<void> {
    await this.set(TLS_SETTINGS_KEYS.CERTIFICATE_BLOB_CONTAINER, containerName, userId);
  }

  /**
   * Helper method to set ACME configuration
   */
  async setAcmeConfig(
    email: string,
    provider: AcmeProvider,
    userId: string
  ): Promise<void> {
    await this.set(TLS_SETTINGS_KEYS.DEFAULT_ACME_EMAIL, email, userId);
    await this.set(TLS_SETTINGS_KEYS.DEFAULT_ACME_PROVIDER, provider, userId);
  }

  /**
   * Helper method to set renewal configuration
   */
  async setRenewalConfig(
    cronSchedule: string,
    daysBeforeExpiry: number,
    userId: string
  ): Promise<void> {
    await this.set(TLS_SETTINGS_KEYS.RENEWAL_CHECK_CRON, cronSchedule, userId);
    await this.set(TLS_SETTINGS_KEYS.RENEWAL_DAYS_BEFORE_EXPIRY, daysBeforeExpiry.toString(), userId);
  }

  /**
   * Get Azure Storage connection string from Azure config service
   * @returns Connection string
   */
  async getConnectionString(): Promise<string> {
    const connectionString = await this.azureConfigService.getConnectionString();
    if (!connectionString) {
      throw new Error("Azure Storage not configured");
    }
    return connectionString;
  }
}
