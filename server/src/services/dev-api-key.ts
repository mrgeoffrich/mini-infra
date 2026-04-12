import prisma from "../lib/prisma";
import { createApiKey } from "../lib/api-key-service";
import { appLogger } from "../lib/logger-factory";
import appConfig from "../lib/config-new";

const logger = appLogger();

/**
 * Development API Key Service
 * Automatically creates a default user and API key for Claude to use in development mode
 */

const DEV_USER_EMAIL =
  process.env.CLAUDE_DEV_USER_EMAIL || "claude@development.local";
const DEV_USER_NAME = "Claude Development";
const DEV_API_KEY_NAME = "Claude Development Key";

export interface DevApiKeyResult {
  userId: string;
  apiKey: string;
  keyId: string;
  isNewKey: boolean;
}

/**
 * Initialize development API key if in development mode
 * Creates or retrieves a default user and API key for Claude
 */
export async function initializeDevApiKey(): Promise<DevApiKeyResult | null> {
  // Only run in development mode
  if (appConfig.server.nodeEnv !== "development") {
    logger.debug(
      "Not in development mode, skipping dev API key initialization",
    );
    return null;
  }

  try {
    logger.info("Initializing development API key for Claude");

    // Find or create the development user
    let devUser = await prisma.user.findUnique({
      where: { email: DEV_USER_EMAIL },
      include: {
        apiKeys: {
          where: {
            name: DEV_API_KEY_NAME,
            active: true,
          },
        },
      },
    });

    let isNewKey = false;

    // Create user if it doesn't exist
    if (!devUser) {
      logger.info(`Creating development user: ${DEV_USER_EMAIL}`);
      devUser = await prisma.user.create({
        data: {
          email: DEV_USER_EMAIL,
          name: DEV_USER_NAME,
        },
        include: {
          apiKeys: true,
        },
      });
      logger.info(`Development user created with ID: ${devUser.id}`);
    }

    // Check if we have an active API key
    const activeApiKey = devUser.apiKeys.find(
      (key) => key.name === DEV_API_KEY_NAME && key.active,
    );

    // Create API key if none exists
    if (!activeApiKey) {
      logger.info("Creating development API key for Claude");
      const apiKeyResponse = await createApiKey(devUser.id, {
        name: DEV_API_KEY_NAME,
      });

      isNewKey = true;

      logger.info(`Development API key created with ID: ${apiKeyResponse.id}`);

      return {
        userId: devUser.id,
        apiKey: apiKeyResponse.key,
        keyId: apiKeyResponse.id,
        isNewKey,
      };
    } else {
      logger.info("Development API key already exists, using existing key");

      // We can't retrieve the raw key from the database since it's hashed
      // For development, we'll show a message that the key exists
      return {
        userId: devUser.id,
        apiKey: "[EXISTING_KEY_HIDDEN]",
        keyId: activeApiKey.id,
        isNewKey: false,
      };
    }
  } catch (error) {
    logger.error({ error }, "Failed to initialize development API key");
    throw new Error("Failed to initialize development API key", {
      cause: error,
    });
  }
}

/**
 * Get the current development API key information
 * Used by scripts to display the key information
 */
export async function getDevApiKeyInfo(): Promise<{
  userId: string;
  keyId: string;
  keyName: string;
  userEmail: string;
  userName: string;
  createdAt: string;
  lastUsedAt: string | null;
} | null> {
  // Only run in development mode
  if (appConfig.server.nodeEnv !== "development") {
    return null;
  }

  try {
    const devUser = await prisma.user.findUnique({
      where: { email: DEV_USER_EMAIL },
      include: {
        apiKeys: {
          where: {
            name: DEV_API_KEY_NAME,
            active: true,
          },
        },
      },
    });

    if (!devUser || devUser.apiKeys.length === 0) {
      return null;
    }

    const apiKey = devUser.apiKeys[0];

    return {
      userId: devUser.id,
      keyId: apiKey.id,
      keyName: apiKey.name,
      userEmail: devUser.email,
      userName: devUser.name || DEV_USER_NAME,
      createdAt: apiKey.createdAt.toISOString(),
      lastUsedAt: apiKey.lastUsedAt?.toISOString() || null,
    };
  } catch (error) {
    logger.error({ error }, "Failed to get development API key info");
    return null;
  }
}

/**
 * Recreate the development API key (for testing or if key is lost)
 */
export async function recreateDevApiKey(): Promise<DevApiKeyResult | null> {
  // Only run in development mode
  if (appConfig.server.nodeEnv !== "development") {
    logger.warn("Cannot recreate dev API key - not in development mode");
    return null;
  }

  try {
    logger.info("Recreating development API key");

    // Find the development user
    const devUser = await prisma.user.findUnique({
      where: { email: DEV_USER_EMAIL },
      include: {
        apiKeys: {
          where: { name: DEV_API_KEY_NAME },
        },
      },
    });

    if (!devUser) {
      logger.error("Development user not found, cannot recreate API key");
      throw new Error("Development user not found");
    }

    // Revoke existing keys with the same name
    if (devUser.apiKeys.length > 0) {
      logger.info(
        `Revoking ${devUser.apiKeys.length} existing development API key(s)`,
      );
      await prisma.apiKey.updateMany({
        where: {
          userId: devUser.id,
          name: DEV_API_KEY_NAME,
        },
        data: { active: false },
      });
    }

    // Create new API key
    const apiKeyResponse = await createApiKey(devUser.id, {
      name: DEV_API_KEY_NAME,
    });

    logger.info(
      `New development API key created with ID: ${apiKeyResponse.id}`,
    );

    return {
      userId: devUser.id,
      apiKey: apiKeyResponse.key,
      keyId: apiKeyResponse.id,
      isNewKey: true,
    };
  } catch (error) {
    logger.error({ error }, "Failed to recreate development API key");
    throw error;
  }
}
