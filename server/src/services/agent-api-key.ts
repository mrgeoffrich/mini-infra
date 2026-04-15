import prisma from "../lib/prisma";
import { createApiKey } from "../lib/api-key-service";
import { getLogger } from "../lib/logger-factory";

const logger = getLogger("agent", "agent-api-key");

const AGENT_API_KEY_NAME = "Agent Service Key";
const SETTINGS_CATEGORY = "agent";
const SETTINGS_KEY = "agent_api_key";

// Legacy: prior versions attached the agent key to a fake service-account
// user. New installs create a user-less (system) ApiKey row — see
// api-key-service.createApiKey. Cleanup of the old service-account user is
// handled by migration 20260415000000_agent_key_no_user.
const LEGACY_AGENT_USER_EMAIL = "agent@mini-infra.internal";

let cachedApiKey: string | null = null;

/**
 * Initialize the agent's dedicated API key.
 *
 * The key is a **system credential** — the ApiKey row has `userId = null` so
 * there is no synthetic "agent" user polluting the setup wizard / users list.
 *
 * Stores the raw key in SystemSettings so it survives restarts.
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
      // Reuse the existing key only if the matching ApiKey row is a clean
      // system credential (no user attached). Legacy keys tied to the old
      // service-account user get regenerated so we can delete that user.
      const existingApiKey = await prisma.apiKey.findFirst({
        where: {
          name: AGENT_API_KEY_NAME,
          active: true,
        },
      });

      if (existingApiKey && existingApiKey.userId === null) {
        logger.info("Agent API key loaded from SystemSettings");
        cachedApiKey = existingKeySetting.value;
        return cachedApiKey;
      }

      logger.info(
        "Agent API key record missing, inactive, or user-bound (legacy) — regenerating as system key",
      );
    }

    // Revoke any previously-active agent keys (user-bound or system).
    await prisma.apiKey.updateMany({
      where: { name: AGENT_API_KEY_NAME },
      data: { active: false },
    });

    // Remove the legacy service-account user if it still exists. Its
    // cascade-deleted ApiKeys are fine — we just deactivated them above and
    // are about to mint a fresh system key below. Without this cleanup the
    // setup wizard's `hasUsers` check continues to report true on a fresh
    // install that was upgraded from a pre-system-key build.
    const legacyCleanup = await prisma.user.deleteMany({
      where: { email: LEGACY_AGENT_USER_EMAIL },
    });
    if (legacyCleanup.count > 0) {
      logger.info(
        { removed: legacyCleanup.count },
        "Removed legacy agent service-account user",
      );
    }

    // Create a new system-scoped API key (no user attached).
    const apiKeyResponse = await createApiKey(null, {
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
