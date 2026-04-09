import { ConfigurationService } from "../configuration-base";
import {
  ValidationResult,
  ServiceHealthStatus,
  SettingsCategory,
  ConnectivityService,
  ConnectivityStatusType,
} from "@mini-infra/types";
import prisma, { PrismaClient } from "../../lib/prisma";
import { servicesLogger } from "../../lib/logger-factory";

/**
 * PostgreSQL Settings Configuration Service
 * Manages Docker image settings for PostgreSQL backup and restore operations
 */
export class PostgresSettingsConfigService extends ConfigurationService {
  // Default Docker image for PostgreSQL backup/restore operations
  private static readonly DEFAULT_BACKUP_IMAGE = "ghcr.io/mrgeoffrich/mini-infra-pg-backup:dev";

  constructor(prisma: PrismaClient) {
    super(prisma, "system" as SettingsCategory);
  }

  /**
   * Get the effective Docker image for backup/restore operations.
   * Priority: PG_BACKUP_IMAGE_TAG env var (baked in at Docker build time) -> hardcoded default
   */
  private getEffectiveImage(): string {
    return process.env.PG_BACKUP_IMAGE_TAG || PostgresSettingsConfigService.DEFAULT_BACKUP_IMAGE;
  }

  /**
   * Validate PostgreSQL settings configuration
   * Validates that the Docker image is in valid format
   */
  async validate(): Promise<ValidationResult> {
    const startTime = Date.now();

    try {
      const effectiveImage = this.getEffectiveImage();

      servicesLogger().info(
        { image: effectiveImage },
        "Validating PostgreSQL settings configuration",
      );

      // Validate Docker image format
      const imageValid = this.validateDockerImageFormat(effectiveImage);

      if (!imageValid.isValid) {
        const errorMessage = `Invalid Docker image format: ${imageValid.message}`;

        await this.recordConnectivityStatus(
          "failed",
          Date.now() - startTime,
          errorMessage,
          "INVALID_IMAGE",
        );

        return {
          isValid: false,
          message: errorMessage,
          errorCode: "INVALID_IMAGE",
          responseTimeMs: Date.now() - startTime,
        };
      }

      const responseTimeMs = Date.now() - startTime;

      const metadata = {
        dockerImage: effectiveImage,
      };

      // Record successful validation
      await this.recordConnectivityStatus(
        "connected",
        responseTimeMs,
        undefined,
        undefined,
        metadata,
      );

      servicesLogger().info(
        { responseTimeMs, image: effectiveImage },
        "PostgreSQL settings validation successful",
      );

      return {
        isValid: true,
        message: "PostgreSQL settings configuration is valid",
        responseTimeMs,
        metadata,
      };
    } catch (error) {
      const responseTimeMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        { error: errorMessage, responseTimeMs },
        "PostgreSQL settings validation failed",
      );

      // Record failed validation
      await this.recordConnectivityStatus(
        "failed",
        responseTimeMs,
        errorMessage,
        "VALIDATION_ERROR",
      );

      return {
        isValid: false,
        message: `PostgreSQL settings validation failed: ${errorMessage}`,
        errorCode: "VALIDATION_ERROR",
        responseTimeMs,
      };
    }
  }

  /**
   * Get current health status of PostgreSQL settings service
   */
  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latestStatus = await this.getLatestConnectivityStatus();

    if (!latestStatus) {
      return {
        service: "postgres" as ConnectivityService,
        status: "unreachable" as ConnectivityStatusType,
        lastChecked: new Date(),
        errorMessage: "No connectivity data available",
      };
    }

    return {
      service: "postgres" as ConnectivityService,
      status: latestStatus.status as ConnectivityStatusType,
      lastChecked: latestStatus.checkedAt,
      lastSuccessful: latestStatus.lastSuccessfulAt || undefined,
      responseTime: latestStatus.responseTimeMs || undefined,
      errorMessage: latestStatus.errorMessage || undefined,
      errorCode: latestStatus.errorCode || undefined,
      metadata: latestStatus.metadata
        ? JSON.parse(latestStatus.metadata)
        : undefined,
    };
  }

  /**
   * Get backup Docker image
   */
  async getBackupDockerImage(): Promise<string> {
    return this.getEffectiveImage();
  }

  /**
   * Get restore Docker image
   */
  async getRestoreDockerImage(): Promise<string> {
    return this.getEffectiveImage();
  }

  /**
   * Validate Docker image format
   * Supports: registry/name:tag, name:tag, name (defaults to latest)
   */
  private validateDockerImageFormat(image: string): {
    isValid: boolean;
    message?: string;
  } {
    if (!image || typeof image !== "string") {
      return {
        isValid: false,
        message: "Image name cannot be empty",
      };
    }

    // Trim whitespace
    image = image.trim();

    if (image.length === 0) {
      return {
        isValid: false,
        message: "Image name cannot be empty",
      };
    }

    // Basic Docker image name validation
    // Format: [registry/]namespace/repository[:tag][@digest]
    const dockerImageRegex =
      /^(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::[0-9]+)?\/))?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?(?:@sha256:[a-fA-F0-9]{64})?$/;

    if (!dockerImageRegex.test(image)) {
      return {
        isValid: false,
        message:
          "Invalid Docker image format. Expected format: [registry/]name[:tag]",
      };
    }

    // Additional checks
    if (image.length > 255) {
      return {
        isValid: false,
        message: "Docker image name is too long (maximum 255 characters)",
      };
    }

    // Check for dangerous characters
    if (image.includes("..") || image.includes("//")) {
      return {
        isValid: false,
        message: "Docker image name contains invalid character sequences",
      };
    }

    return {
      isValid: true,
    };
  }

  /**
   * Get the Docker image used for backup/restore operations
   */
  static getDockerImage(): string {
    return process.env.PG_BACKUP_IMAGE_TAG || PostgresSettingsConfigService.DEFAULT_BACKUP_IMAGE;
  }
}
