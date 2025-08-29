import { PrismaClient } from "../generated/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  IConfigurationService,
  SettingsCategory,
  ConnectivityService,
  ConnectivityStatusType,
} from "@mini-infra/types";
import { logger } from "../lib/logger";

export abstract class ConfigurationService implements IConfigurationService {
  protected prisma: PrismaClient;
  protected category: SettingsCategory;

  constructor(prisma: PrismaClient, category: SettingsCategory) {
    this.prisma = prisma;
    this.category = category;
  }

  /**
   * Abstract method to validate the service configuration
   * Must be implemented by concrete service classes
   */
  abstract validate(): Promise<ValidationResult>;

  /**
   * Abstract method to get health status of the service
   * Must be implemented by concrete service classes
   */
  abstract getHealthStatus(): Promise<ServiceHealthStatus>;

  /**
   * Store a setting value in the database
   * @param key - Setting key
   * @param value - Setting value
   * @param userId - User ID who is setting the value
   */
  async set(key: string, value: string, userId: string): Promise<void> {
    try {
      await this.prisma.systemSettings.upsert({
        where: {
          category_key: {
            category: this.category,
            key: key,
          },
        },
        update: {
          value: value,
          updatedBy: userId,
          updatedAt: new Date(),
        },
        create: {
          category: this.category,
          key: key,
          value: value,
          createdBy: userId,
          updatedBy: userId,
          isEncrypted: false,
          isActive: true,
        },
      });

      logger.info("Setting updated", {
        category: this.category,
        key: key,
        userId: userId,
      });
    } catch (error) {
      logger.error("Failed to set configuration value", {
        category: this.category,
        key: key,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  /**
   * Retrieve a setting value from the database
   * @param key - Setting key
   * @returns Setting value or null if not found
   */
  async get(key: string): Promise<string | null> {
    try {
      const setting = await this.prisma.systemSettings.findUnique({
        where: {
          category_key: {
            category: this.category,
            key: key,
          },
        },
      });

      return setting?.value || null;
    } catch (error) {
      logger.error("Failed to get configuration value", {
        category: this.category,
        key: key,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  /**
   * Delete a setting from the database
   * @param key - Setting key
   * @param userId - User ID who is deleting the setting
   */
  async delete(key: string, userId: string): Promise<void> {
    try {
      await this.prisma.systemSettings.delete({
        where: {
          category_key: {
            category: this.category,
            key: key,
          },
        },
      });

      logger.info("Setting deleted", {
        category: this.category,
        key: key,
        userId: userId,
      });
    } catch (error) {
      logger.error("Failed to delete configuration value", {
        category: this.category,
        key: key,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  /**
   * Record connectivity status in the database
   * @param status - Connectivity status information
   * @param userId - Optional user ID who initiated the check
   */
  protected async recordConnectivityStatus(
    status: ConnectivityStatusType,
    responseTimeMs?: number,
    errorMessage?: string,
    errorCode?: string,
    metadata?: Record<string, any>,
    userId?: string,
  ): Promise<void> {
    try {
      await this.prisma.connectivityStatus.create({
        data: {
          service: this.category as ConnectivityService,
          status: status,
          responseTimeMs: responseTimeMs || null,
          errorMessage: errorMessage || null,
          errorCode: errorCode || null,
          metadata: metadata ? JSON.stringify(metadata) : null,
          checkInitiatedBy: userId || null,
          checkedAt: new Date(),
          lastSuccessfulAt: status === "connected" ? new Date() : null,
        },
      });
    } catch (error) {
      logger.error("Failed to record connectivity status", {
        service: this.category,
        status: status,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Get the most recent connectivity status for this service
   * @returns Latest connectivity status or null if none exists
   */
  protected async getLatestConnectivityStatus(): Promise<any | null> {
    try {
      return await this.prisma.connectivityStatus.findFirst({
        where: {
          service: this.category as ConnectivityService,
        },
        orderBy: {
          checkedAt: "desc",
        },
      });
    } catch (error) {
      logger.error("Failed to get latest connectivity status", {
        service: this.category,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }
  }

  /**
   * Create audit log entry for configuration changes
   * @param action - Action performed
   * @param key - Setting key
   * @param oldValue - Previous value (optional)
   * @param newValue - New value (optional)
   * @param userId - User ID who performed the action
   * @param ipAddress - IP address of the request
   * @param userAgent - User agent string
   * @param success - Whether the action was successful
   * @param errorMessage - Error message if action failed
   */
  protected async createAuditLog(
    action: "create" | "update" | "delete" | "validate",
    key: string,
    oldValue: string | null,
    newValue: string | null,
    userId: string,
    ipAddress?: string,
    userAgent?: string,
    success: boolean = true,
    errorMessage?: string,
  ): Promise<void> {
    try {
      await this.prisma.settingsAudit.create({
        data: {
          category: this.category,
          key: key,
          action: action,
          oldValue: oldValue,
          newValue: newValue,
          userId: userId,
          ipAddress: ipAddress || null,
          userAgent: userAgent || null,
          success: success,
          errorMessage: errorMessage || null,
          createdAt: new Date(),
        },
      });
    } catch (error) {
      logger.error("Failed to create audit log", {
        category: this.category,
        key: key,
        action: action,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}
