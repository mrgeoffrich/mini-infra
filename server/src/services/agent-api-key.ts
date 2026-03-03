import prisma from "../lib/prisma";
import { createApiKey } from "../lib/api-key-service";
import { agentLogger } from "../lib/logger-factory";

const logger = agentLogger();

const AGENT_USER_EMAIL = "agent@mini-infra.internal";
const AGENT_USER_NAME = "Mini Infra Agent";
const AGENT_API_KEY_NAME = "Agent Service Key";
const SETTINGS_CATEGORY = "agent";
const SETTINGS_KEY = "agent_api_key";

let cachedApiKey: string | null = null;

/**
 * Initialize the agent's dedicated API key.
 * Creates a service account user and API key if they don't exist,
 * stores the raw key in SystemSettings so it survives restarts.
 */
export async function initializeAgentApiKey(): Promise<string | null> {
  try {
    logger.info("Initializing agent API key");

    // Try to load existing key from SystemSettings
    const existingKeySetting = await prisma.systemSettings.findFirst({
      where: {
        category: SETTINGS_CATEGORY,
        key: SETTINGS_KEY,
        isActive: true,
      },
    });

    if (existingKeySetting?.value) {
      // Verify the matching ApiKey record is still active
      const agentUser = await prisma.user.findUnique({
        where: { email: AGENT_USER_EMAIL },
        include: {
          apiKeys: {
            where: {
              name: AGENT_API_KEY_NAME,
              active: true,
            },
          },
        },
      });

      if (agentUser && agentUser.apiKeys.length > 0) {
        logger.info("Agent API key loaded from SystemSettings");
        cachedApiKey = existingKeySetting.value;
        return cachedApiKey;
      }

      // Key record was revoked/deleted — regenerate
      logger.info(
        "Agent API key record not found or inactive, regenerating",
      );
    }

    // Find or create the agent service account user
    let agentUser = await prisma.user.findUnique({
      where: { email: AGENT_USER_EMAIL },
    });

    if (!agentUser) {
      logger.info(`Creating agent service account: ${AGENT_USER_EMAIL}`);
      agentUser = await prisma.user.create({
        data: {
          email: AGENT_USER_EMAIL,
          name: AGENT_USER_NAME,
        },
      });
      logger.info({ userId: agentUser.id }, "Agent service account created");
    }

    // Revoke any existing agent keys
    await prisma.apiKey.updateMany({
      where: {
        userId: agentUser.id,
        name: AGENT_API_KEY_NAME,
      },
      data: { active: false },
    });

    // Create a new API key
    const apiKeyResponse = await createApiKey(agentUser.id, {
      name: AGENT_API_KEY_NAME,
    });

    // Store the raw key in SystemSettings for retrieval on restart
    await prisma.systemSettings.upsert({
      where: {
        category_key: {
          category: SETTINGS_CATEGORY,
          key: SETTINGS_KEY,
        },
      },
      create: {
        category: SETTINGS_CATEGORY,
        key: SETTINGS_KEY,
        value: apiKeyResponse.key,
        isEncrypted: false,
        isActive: true,
        createdBy: "system",
        updatedBy: "system",
      },
      update: {
        value: apiKeyResponse.key,
        updatedBy: "system",
        updatedAt: new Date(),
      },
    });

    logger.info(
      { keyId: apiKeyResponse.id },
      "Agent API key created and stored in SystemSettings",
    );

    cachedApiKey = apiKeyResponse.key;
    return cachedApiKey;
  } catch (error) {
    logger.error({ error }, "Failed to initialize agent API key");
    return null;
  }
}

/**
 * Get the cached agent API key (available after initialization).
 */
export function getAgentApiKey(): string | null {
  return cachedApiKey;
}
