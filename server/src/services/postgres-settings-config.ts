import { ConfigurationService } from "./configuration-base";
import {
  ValidationResult,
  ServiceHealthStatus,
  SettingsCategory,
  ConnectivityService,
  ConnectivityStatusType,
} from "@mini-infra/types";
import prisma, { PrismaClient } from "../lib/prisma";
import { servicesLogger } from "../lib/logger-factory";

/**
 * PostgreSQL Settings Configuration Service
 * Manages Docker image settings for PostgreSQL backup and restore operations
 */
export class PostgresSettingsConfigService extends ConfigurationService {
  // Default Docker images for PostgreSQL operations
  private static readonly DEFAULT_BACKUP_IMAGE = "postgres:15-alpine";
  private static readonly DEFAULT_RESTORE_IMAGE = "postgres:15-alpine";

  constructor(prisma: PrismaClient) {
    super(prisma, "system" as SettingsCategory);
  }

  /**
   * Initialize default settings in the database if they don't exist
   * This ensures that the default values are persisted and visible in the UI
   */
  async initializeDefaults(userId: string): Promise<void> {
    try {
      // Check if settings already exist
      const existingBackupSetting = await this.get("backup_docker_image");
      const existingRestoreSetting = await this.get("restore_docker_image");

      // Create default settings if they don't exist
      if (!existingBackupSetting) {
        await this.set(
          "backup_docker_image",
          PostgresSettingsConfigService.DEFAULT_BACKUP_IMAGE,
          userId,
        );
      }

      if (!existingRestoreSetting) {
        await this.set(
          "restore_docker_image",
          PostgresSettingsConfigService.DEFAULT_RESTORE_IMAGE,
          userId,
        );
      }

      servicesLogger().info(
        {
          userId,
          backupImageSet: !existingBackupSetting,
          restoreImageSet: !existingRestoreSetting,
        },
        "PostgreSQL Docker image defaults initialized",
      );
    } catch (error) {
      servicesLogger().error(
        {
          userId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to initialize PostgreSQL Docker image defaults",
      );
      throw error;
    }
  }

  /**
   * Validate PostgreSQL settings configuration
   * Validates that the Docker images are in valid format and accessible
   * @param settings - Optional settings to validate with (overrides stored settings)
   */
  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    const startTime = Date.now();

    try {
      // Get configured Docker images from settings (use provided settings or fallback to stored)
      const backupImage = settings?.backup_docker_image || await this.get("backup_docker_image");
      const restoreImage = settings?.restore_docker_image || await this.get("restore_docker_image");

      // Use defaults if not configured
      const effectiveBackupImage =
        backupImage || PostgresSettingsConfigService.DEFAULT_BACKUP_IMAGE;
      const effectiveRestoreImage =
        restoreImage || PostgresSettingsConfigService.DEFAULT_RESTORE_IMAGE;

      servicesLogger().info(
        {
          backupImage: effectiveBackupImage,
          restoreImage: effectiveRestoreImage,
        },
        "Validating PostgreSQL settings configuration",
      );

      // Validate Docker image format
      const backupImageValid =
        this.validateDockerImageFormat(effectiveBackupImage);
      const restoreImageValid = this.validateDockerImageFormat(
        effectiveRestoreImage,
      );

      if (!backupImageValid.isValid) {
        const errorMessage = `Invalid backup Docker image format: ${backupImageValid.message}`;

        await this.recordConnectivityStatus(
          "failed",
          Date.now() - startTime,
          errorMessage,
          "INVALID_BACKUP_IMAGE",
        );

        return {
          isValid: false,
          message: errorMessage,
          errorCode: "INVALID_BACKUP_IMAGE",
          responseTimeMs: Date.now() - startTime,
        };
      }

      if (!restoreImageValid.isValid) {
        const errorMessage = `Invalid restore Docker image format: ${restoreImageValid.message}`;

        await this.recordConnectivityStatus(
          "failed",
          Date.now() - startTime,
          errorMessage,
          "INVALID_RESTORE_IMAGE",
        );

        return {
          isValid: false,
          message: errorMessage,
          errorCode: "INVALID_RESTORE_IMAGE",
          responseTimeMs: Date.now() - startTime,
        };
      }

      const responseTimeMs = Date.now() - startTime;

      const metadata = {
        backupDockerImage: effectiveBackupImage,
        restoreDockerImage: effectiveRestoreImage,
        configSource: {
          backup: backupImage ? "settings" : "default",
          restore: restoreImage ? "settings" : "default",
        },
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
        {
          responseTimeMs,
          backupImage: effectiveBackupImage,
          restoreImage: effectiveRestoreImage,
        },
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
        {
          error: errorMessage,
          responseTimeMs,
        },
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
   * Get backup Docker image setting
   */
  async getBackupDockerImage(): Promise<string> {
    const configuredImage = await this.get("backup_docker_image");
    if (!configuredImage) {
      throw new Error("Backup Docker image not configured in system settings. Please configure it at /settings/system");
    }
    return configuredImage;
  }

  /**
   * Get restore Docker image setting
   */
  async getRestoreDockerImage(): Promise<string> {
    const configuredImage = await this.get("restore_docker_image");
    if (!configuredImage) {
      throw new Error("Restore Docker image not configured in system settings. Please configure it at /settings/system");
    }
    return configuredImage;
  }

  /**
   * Set backup Docker image setting
   */
  async setBackupDockerImage(image: string, userId: string): Promise<void> {
    const validation = this.validateDockerImageFormat(image);
    if (!validation.isValid) {
      throw new Error(`Invalid Docker image format: ${validation.message}`);
    }

    await this.set("backup_docker_image", image, userId);

    servicesLogger().info(
      {
        image,
        userId,
      },
      "PostgreSQL backup Docker image updated",
    );
  }

  /**
   * Set restore Docker image setting
   */
  async setRestoreDockerImage(image: string, userId: string): Promise<void> {
    const validation = this.validateDockerImageFormat(image);
    if (!validation.isValid) {
      throw new Error(`Invalid Docker image format: ${validation.message}`);
    }

    await this.set("restore_docker_image", image, userId);

    servicesLogger().info(
      {
        image,
        userId,
      },
      "PostgreSQL restore Docker image updated",
    );
  }

  /**
   * Get all PostgreSQL Docker image settings
   */
  async getAllDockerImages(): Promise<{
    backup: string;
    restore: string;
  }> {
    const [backup, restore] = await Promise.all([
      this.getBackupDockerImage(),
      this.getRestoreDockerImage(),
    ]);

    return {
      backup,
      restore,
    };
  }

  /**
   * Reset all Docker image settings to defaults
   */
  async resetToDefaults(userId: string): Promise<void> {
    await Promise.all([
      this.delete("backup_docker_image", userId),
      this.delete("restore_docker_image", userId),
    ]);

    servicesLogger().info(
      {
        userId,
        defaultBackupImage: PostgresSettingsConfigService.DEFAULT_BACKUP_IMAGE,
        defaultRestoreImage:
          PostgresSettingsConfigService.DEFAULT_RESTORE_IMAGE,
      },
      "PostgreSQL Docker image settings reset to defaults",
    );
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
   * Get default Docker image configurations
   */
  static getDefaults(): {
    backupDockerImage: string;
    restoreDockerImage: string;
  } {
    return {
      backupDockerImage: PostgresSettingsConfigService.DEFAULT_BACKUP_IMAGE,
      restoreDockerImage: PostgresSettingsConfigService.DEFAULT_RESTORE_IMAGE,
    };
  }
}
