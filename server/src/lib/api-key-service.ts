import { randomBytes, createHmac } from "crypto";
import prisma from "./prisma";
import logger from "./logger";
import type {
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  ApiKeyInfo,
  ApiKeyValidationResult,
  JWTUser,
} from "@mini-infra/types";

/**
 * Generate a secure API key using cryptographically secure random bytes
 * Format: mk_<32 random bytes in hex>
 */
export function generateApiKey(): string {
  const prefix = "mk"; // "mini-infra key"
  const randomPart = randomBytes(32).toString("hex");
  return `${prefix}_${randomPart}`;
}

/**
 * Generate a secure hash of the API key for storage
 * Uses HMAC-SHA256 with a secret from environment
 */
export function hashApiKey(key: string): string {
  const secret =
    process.env.API_KEY_SECRET || "default-secret-change-in-production";
  return createHmac("sha256", secret).update(key).digest("hex");
}

/**
 * Create a new API key for a user
 */
export async function createApiKey(
  userId: string,
  request: CreateApiKeyRequest,
): Promise<CreateApiKeyResponse> {
  logger.info({ userId, name: request.name }, "Creating new API key");

  try {
    // Generate the raw key and its hash
    const rawKey = generateApiKey();
    const hashedKey = hashApiKey(rawKey);

    // Store the hashed key in the database
    const apiKey = await prisma.apiKey.create({
      data: {
        name: request.name,
        key: hashedKey,
        userId,
        active: true,
      },
      include: {
        user: true,
      },
    });

    logger.info(
      { userId, keyId: apiKey.id, name: apiKey.name },
      "API key created successfully",
    );

    // Return the response with the raw key (only time we expose it)
    return {
      id: apiKey.id,
      name: apiKey.name,
      key: rawKey, // Only exposed during creation
      active: apiKey.active,
      lastUsedAt: apiKey.lastUsedAt?.toISOString() || null,
      createdAt: apiKey.createdAt.toISOString(),
      updatedAt: apiKey.updatedAt.toISOString(),
    };
  } catch (error) {
    logger.error(
      { error, userId, name: request.name },
      "Failed to create API key",
    );
    throw new Error("Failed to create API key");
  }
}

/**
 * Validate an API key and return user information
 */
export async function validateApiKey(
  key: string,
): Promise<ApiKeyValidationResult> {
  if (!key) {
    return { valid: false };
  }

  try {
    // Hash the provided key
    const hashedKey = hashApiKey(key);

    // Look up the API key in the database
    const apiKey = await prisma.apiKey.findUnique({
      where: {
        key: hashedKey,
      },
      include: {
        user: true,
      },
    });

    if (!apiKey) {
      logger.debug("API key validation failed: key not found");
      return { valid: false };
    }

    if (!apiKey.active) {
      logger.warn(
        { keyId: apiKey.id, userId: apiKey.userId },
        "API key validation failed: key is inactive",
      );
      return { valid: false };
    }

    // Update last used timestamp
    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    });

    logger.debug(
      { keyId: apiKey.id, userId: apiKey.userId },
      "API key validated successfully",
    );

    const sessionUser: JWTUser = {
      id: apiKey.user.id,
      email: apiKey.user.email,
      name: apiKey.user.name || undefined,
      image: apiKey.user.image || undefined,
      createdAt: apiKey.user.createdAt,
    };

    return {
      valid: true,
      userId: apiKey.userId,
      keyId: apiKey.id,
      user: sessionUser,
    };
  } catch (error) {
    logger.error({ error }, "Error validating API key");
    return { valid: false };
  }
}

/**
 * Get all API keys for a user (without the actual key values)
 */
export async function getUserApiKeys(
  userId: string,
): Promise<ApiKeyInfo[]> {
  try {
    const apiKeys = await prisma.apiKey.findMany({
      where: {
        userId,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return apiKeys.map((apiKey) => ({
      id: apiKey.id,
      name: apiKey.name,
      active: apiKey.active,
      lastUsedAt: apiKey.lastUsedAt?.toISOString() || null,
      createdAt: apiKey.createdAt.toISOString(),
      updatedAt: apiKey.updatedAt.toISOString(),
    }));
  } catch (error) {
    logger.error({ error, userId }, "Failed to get user API keys");
    throw new Error("Failed to retrieve API keys");
  }
}

/**
 * Deactivate an API key (soft delete)
 */
export async function revokeApiKey(
  userId: string,
  keyId: string,
): Promise<void> {
  try {
    const apiKey = await prisma.apiKey.findFirst({
      where: {
        id: keyId,
        userId, // Ensure user can only revoke their own keys
      },
    });

    if (!apiKey) {
      throw new Error("API key not found or not owned by user");
    }

    await prisma.apiKey.update({
      where: { id: keyId },
      data: { active: false },
    });

    logger.info(
      { userId, keyId, name: apiKey.name },
      "API key revoked successfully",
    );
  } catch (error) {
    logger.error({ error, userId, keyId }, "Failed to revoke API key");
    throw error;
  }
}

/**
 * Rotate an API key by creating a new one and deactivating the old one
 */
export async function rotateApiKey(
  userId: string,
  keyId: string,
): Promise<CreateApiKeyResponse> {
  try {
    // Get the existing key
    const existingKey = await prisma.apiKey.findFirst({
      where: {
        id: keyId,
        userId, // Ensure user can only rotate their own keys
      },
    });

    if (!existingKey) {
      throw new Error("API key not found or not owned by user");
    }

    // Create a new key with the same name
    const newKey = await createApiKey(userId, { name: existingKey.name });

    // Deactivate the old key
    await prisma.apiKey.update({
      where: { id: keyId },
      data: { active: false },
    });

    logger.info(
      { userId, oldKeyId: keyId, newKeyId: newKey.id },
      "API key rotated successfully",
    );

    return newKey;
  } catch (error) {
    logger.error({ error, userId, keyId }, "Failed to rotate API key");
    throw error;
  }
}

/**
 * Permanently delete an API key from the database
 */
export async function deleteApiKey(
  userId: string,
  keyId: string,
): Promise<void> {
  try {
    const apiKey = await prisma.apiKey.findFirst({
      where: {
        id: keyId,
        userId, // Ensure user can only delete their own keys
      },
    });

    if (!apiKey) {
      throw new Error("API key not found or not owned by user");
    }

    await prisma.apiKey.delete({
      where: { id: keyId },
    });

    logger.info(
      { userId, keyId, name: apiKey.name },
      "API key deleted permanently",
    );
  } catch (error) {
    logger.error({ error, userId, keyId }, "Failed to delete API key");
    throw error;
  }
}

/**
 * Get API key statistics for a user
 */
export async function getApiKeyStats(userId: string): Promise<{
  total: number;
  active: number;
  inactive: number;
}> {
  try {
    const [total, active] = await Promise.all([
      prisma.apiKey.count({
        where: { userId },
      }),
      prisma.apiKey.count({
        where: { userId, active: true },
      }),
    ]);

    return {
      total,
      active,
      inactive: total - active,
    };
  } catch (error) {
    logger.error({ error, userId }, "Failed to get API key statistics");
    throw new Error("Failed to retrieve API key statistics");
  }
}
