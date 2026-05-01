import { PrismaClient } from "../../lib/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
  AcmeProvider,
} from "@mini-infra/types";
import { ConfigurationService } from "../configuration-base";
import { getLogger } from "../../lib/logger-factory";
import { StorageService } from "../storage/storage-service";

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
 * TlsConfigService handles TLS-related configuration management. The
 * "container" name is now interpreted as a generic storage location id —
 * Azure container today, Drive folder in Phase 3 — but the setting key is
 * kept for greenfield-stable schema reasons.
 */
export class TlsConfigService extends ConfigurationService {
  private static readonly DEFAULT_RENEWAL_CRON = "0 2 * * *"; // Daily at 2 AM
  private static readonly DEFAULT_RENEWAL_DAYS = 30;
  private static readonly DEFAULT_ACME_PROVIDER: AcmeProvider = "letsencrypt";

  constructor(prisma: PrismaClient) {
    super(prisma, "tls");
  }

  /**
   * Validate that the certificate storage location is reachable through the
   * active StorageBackend.
   */
  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    const startTime = Date.now();
    const logger = getLogger("tls", "tls-config");

    try {
      const containerName =
        settings?.[TLS_SETTINGS_KEYS.CERTIFICATE_BLOB_CONTAINER] ||
        (await this.get(TLS_SETTINGS_KEYS.CERTIFICATE_BLOB_CONTAINER));

      if (!containerName) {
        return {
          isValid: false,
          message: "Certificate storage location not configured",
          errorCode: "CONTAINER_NOT_CONFIGURED",
        };
      }

      let backend;
      try {
        backend = await StorageService.getInstance(this.prisma).getActiveBackend();
      } catch {
        return {
          isValid: false,
          message:
            "Storage provider is not configured. Configure a storage provider before validating TLS settings.",
          errorCode: "STORAGE_NOT_CONFIGURED",
        };
      }

      const access = await backend.testLocationAccess({ id: containerName });
      const responseTime = Date.now() - startTime;

      if (!access.accessible) {
        const errMeta = (access.metadata ?? {}) as {
          error?: string;
          errorCode?: string;
        };
        await this.recordConnectivityStatus(
          "failed",
          responseTime,
          errMeta.error ?? `Storage location '${containerName}' not accessible`,
          errMeta.errorCode ?? "LOCATION_INACCESSIBLE",
        );
        return {
          isValid: false,
          message: `Storage location '${containerName}' is not accessible: ${
            errMeta.error ?? "permission denied"
          }`,
          errorCode: errMeta.errorCode ?? "LOCATION_INACCESSIBLE",
          responseTimeMs: responseTime,
        };
      }

      await this.recordConnectivityStatus(
        "connected",
        responseTime,
        undefined,
        undefined,
        { containerName },
      );

      logger.info(
        { containerName, responseTime },
        "Certificate storage location validation successful",
      );

      return {
        isValid: true,
        message: `Certificate storage location '${containerName}' is accessible`,
        responseTimeMs: responseTime,
        metadata: { containerName, providerId: backend.providerId },
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage =
        (error instanceof Error ? error.message : String(error)) ||
        "Unknown error";
      let errorCode = "UNKNOWN_ERROR";
      let connectivityStatus: ConnectivityStatusType = "failed";

      if (errorMessage.includes("timeout")) {
        errorCode = "TIMEOUT";
        connectivityStatus = "timeout";
      } else if (
        errorMessage.includes("AuthenticationFailed") ||
        errorMessage.includes("InvalidAccountKey")
      ) {
        errorCode = "INVALID_CREDENTIALS";
      } else if (
        errorMessage.includes("Forbidden") ||
        errorMessage.includes("403")
      ) {
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

      await this.recordConnectivityStatus(
        connectivityStatus,
        responseTime,
        errorMessage,
        errorCode,
      );
      logger.error(
        { error: errorMessage, errorCode, responseTime },
        "Certificate storage validation failed",
      );

      return {
        isValid: false,
        message: `TLS storage validation failed: ${errorMessage}`,
        errorCode,
        responseTimeMs: responseTime,
      };
    }
  }

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
      metadata: latestStatus.metadata
        ? JSON.parse(latestStatus.metadata)
        : undefined,
    };
  }

  /**
   * Get certificate storage location id (Azure container name; Drive folder ID).
   */
  async getCertificateContainerName(): Promise<string> {
    const containerName = await this.get(
      TLS_SETTINGS_KEYS.CERTIFICATE_BLOB_CONTAINER,
    );
    if (!containerName) {
      throw new Error("Certificate storage location not configured");
    }
    return containerName;
  }

  /**
   * Same but returning null instead of throwing — used by services that
   * tolerate missing TLS configuration (e.g. stack reconciler).
   */
  async getCertificateContainerNameOrNull(): Promise<string | null> {
    return this.get(TLS_SETTINGS_KEYS.CERTIFICATE_BLOB_CONTAINER);
  }

  async getAcmeAccountConfig(): Promise<AcmeAccountConfig> {
    const email = await this.get(TLS_SETTINGS_KEYS.DEFAULT_ACME_EMAIL);
    const providerStr = await this.get(TLS_SETTINGS_KEYS.DEFAULT_ACME_PROVIDER);

    if (!email) {
      throw new Error("ACME email not configured");
    }

    const provider =
      (providerStr as AcmeProvider) || TlsConfigService.DEFAULT_ACME_PROVIDER;

    return {
      email,
      provider,
    };
  }

  async getRenewalCheckCron(): Promise<string> {
    const cron = await this.get(TLS_SETTINGS_KEYS.RENEWAL_CHECK_CRON);
    return cron || TlsConfigService.DEFAULT_RENEWAL_CRON;
  }

  async getRenewalDaysBeforeExpiry(): Promise<number> {
    const days = await this.get(TLS_SETTINGS_KEYS.RENEWAL_DAYS_BEFORE_EXPIRY);
    return days ? parseInt(days, 10) : TlsConfigService.DEFAULT_RENEWAL_DAYS;
  }

  async setCertificateContainer(
    containerName: string,
    userId: string,
  ): Promise<void> {
    await this.set(
      TLS_SETTINGS_KEYS.CERTIFICATE_BLOB_CONTAINER,
      containerName,
      userId,
    );
  }

  async setAcmeConfig(
    email: string,
    provider: AcmeProvider,
    userId: string,
  ): Promise<void> {
    await this.set(TLS_SETTINGS_KEYS.DEFAULT_ACME_EMAIL, email, userId);
    await this.set(
      TLS_SETTINGS_KEYS.DEFAULT_ACME_PROVIDER,
      provider,
      userId,
    );
  }

  async setRenewalConfig(
    cronSchedule: string,
    daysBeforeExpiry: number,
    userId: string,
  ): Promise<void> {
    await this.set(
      TLS_SETTINGS_KEYS.RENEWAL_CHECK_CRON,
      cronSchedule,
      userId,
    );
    await this.set(
      TLS_SETTINGS_KEYS.RENEWAL_DAYS_BEFORE_EXPIRY,
      daysBeforeExpiry.toString(),
      userId,
    );
  }
}
