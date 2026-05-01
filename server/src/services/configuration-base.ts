import crypto from "crypto";
import { PrismaClient } from "../lib/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  IConfigurationService,
  SettingsCategory,
  ConnectivityService,
  ConnectivityStatusType,
} from "@mini-infra/types";
import { getLogger } from "../lib/logger-factory";
import {
  encryptString,
  decryptString,
  CryptoError,
  zeroise,
} from "../lib/crypto";
import { getAuthSecret } from "../lib/security-config";

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
   * @param settings - Optional settings to validate with (overrides stored settings)
   */
  abstract validate(settings?: Record<string, string>): Promise<ValidationResult>;

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

      getLogger("platform", "configuration-base").info(
        {
          category: this.category,
          key: key,
          userId: userId,
        },
        "Setting updated",
      );
    } catch (error) {
      getLogger("platform", "configuration-base").error(
        {
          category: this.category,
          key: key,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to set configuration value",
      );
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
      getLogger("platform", "configuration-base").error(
        {
          category: this.category,
          key: key,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get configuration value",
      );
      throw error;
    }
  }

  /**
   * Store a setting value encrypted at rest. The value is wrapped in
   * AES-256-GCM using a domain-separated key derived from the application's
   * internal auth secret (HMAC-SHA256 over a category-scoped label) and stored
   * base64-encoded with `isEncrypted: true`.
   *
   * Use this for any setting whose plaintext should never live in the
   * `system_settings` table — e.g. cloud provider connection strings, OAuth
   * refresh tokens, or other long-lived credentials. Round-trip via
   * {@link getSecure}.
   *
   * @param key - Setting key
   * @param value - Plaintext value to encrypt and store
   * @param userId - User ID who is setting the value (audit trail)
   */
  async setSecure(key: string, value: string, userId: string): Promise<void> {
    const wrappingKey = this.deriveWrappingKey();
    let cipherBuf: Buffer;
    try {
      cipherBuf = encryptString(wrappingKey, value);
    } finally {
      zeroise(wrappingKey);
    }
    const ciphertext = cipherBuf.toString("base64");

    try {
      await this.prisma.systemSettings.upsert({
        where: {
          category_key: {
            category: this.category,
            key: key,
          },
        },
        update: {
          value: ciphertext,
          isEncrypted: true,
          updatedBy: userId,
          updatedAt: new Date(),
        },
        create: {
          category: this.category,
          key: key,
          value: ciphertext,
          createdBy: userId,
          updatedBy: userId,
          isEncrypted: true,
          isActive: true,
        },
      });

      getLogger("platform", "configuration-base").info(
        {
          category: this.category,
          key: key,
          userId: userId,
        },
        "Encrypted setting updated",
      );
    } catch (error) {
      getLogger("platform", "configuration-base").error(
        {
          category: this.category,
          key: key,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to set encrypted configuration value",
      );
      throw error;
    }
  }

  /**
   * Retrieve a setting value previously stored with {@link setSecure}.
   * Returns `null` when the key is missing. Throws {@link CryptoError} if the
   * row exists but the ciphertext is corrupt, tampered, or wrapped under a
   * different secret.
   *
   * Rows that exist but have `isEncrypted: false` are returned as-is — this is
   * defensive only; callers should treat any non-encrypted hit as a misuse and
   * re-write via {@link setSecure} on next mutation.
   */
  async getSecure(key: string): Promise<string | null> {
    let setting;
    try {
      setting = await this.prisma.systemSettings.findUnique({
        where: {
          category_key: {
            category: this.category,
            key: key,
          },
        },
      });
    } catch (error) {
      getLogger("platform", "configuration-base").error(
        {
          category: this.category,
          key: key,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to load encrypted configuration row",
      );
      throw error;
    }

    if (!setting || setting.value === null || setting.value === undefined) {
      return null;
    }
    if (!setting.isEncrypted) {
      // Defensive: not how we should be hitting this path, but the caller
      // asked for a secure read and the row holds plaintext. Return it.
      return setting.value;
    }

    const wrappingKey = this.deriveWrappingKey();
    try {
      return decryptString(wrappingKey, Buffer.from(setting.value, "base64"));
    } catch (error) {
      getLogger("platform", "configuration-base").error(
        {
          category: this.category,
          key: key,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to decrypt configuration value",
      );
      throw error instanceof CryptoError
        ? error
        : new CryptoError(
            `Failed to decrypt setting ${this.category}/${key}: ${
              error instanceof Error ? error.message : "unknown"
            }`,
          );
    } finally {
      zeroise(wrappingKey);
    }
  }

  /**
   * Derive a 32-byte AES key for wrapping settings in this category. The label
   * embeds the category so a leak of one category's plaintext doesn't allow
   * forging ciphertexts for another category, even though both share the same
   * underlying auth secret.
   */
  private deriveWrappingKey(): Buffer {
    const secret = getAuthSecret();
    return Buffer.from(
      crypto
        .createHmac("sha256", secret)
        .update(`configuration-base/v1/${this.category}`)
        .digest(),
    );
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

      getLogger("platform", "configuration-base").info(
        {
          category: this.category,
          key: key,
          userId: userId,
        },
        "Setting deleted",
      );
    } catch (error) {
      getLogger("platform", "configuration-base").error(
        {
          category: this.category,
          key: key,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to delete configuration value",
      );
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
    metadata?: Record<string, unknown>,
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
      getLogger("platform", "configuration-base").error(
        {
          service: this.category,
          status: status,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to record connectivity status",
      );
    }
  }

  /**
   * Get the most recent connectivity status for this service
   * @returns Latest connectivity status or null if none exists
   */
  protected async getLatestConnectivityStatus(): Promise<ConnectivityStatusRow | null> {
    try {
      const record = await this.prisma.connectivityStatus.findFirst({
        where: {
          service: this.category as ConnectivityService,
        },
        orderBy: {
          checkedAt: "desc",
        },
      });
      if (!record) return null;
      return {
        status: record.status,
        checkedAt: record.checkedAt,
        lastSuccessfulAt: record.lastSuccessfulAt ?? undefined,
        responseTimeMs:
          record.responseTimeMs != null
            ? Number(record.responseTimeMs)
            : undefined,
        errorMessage: record.errorMessage ?? undefined,
        errorCode: record.errorCode ?? undefined,
        metadata: record.metadata ?? undefined,
      };
    } catch (error) {
      getLogger("platform", "configuration-base").error(
        {
          service: this.category,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get latest connectivity status",
      );
      return null;
    }
  }
}

/**
 * Narrow DTO returned by {@link ConfigurationService.getLatestConnectivityStatus}.
 *
 * Prisma stores `responseTimeMs` as `BigInt` and optional fields as `null`.
 * This type converts both to the JS-friendly forms callers expect:
 *  - `BigInt | null` → `number | undefined`
 *  - `T | null`     → `T | undefined`
 */
export interface ConnectivityStatusRow {
  status: string;
  checkedAt: Date;
  lastSuccessfulAt: Date | undefined;
  responseTimeMs: number | undefined;
  errorMessage: string | undefined;
  errorCode: string | undefined;
  metadata: string | undefined;
}
