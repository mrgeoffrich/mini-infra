import fs from "fs";
import prisma from "../lib/prisma";
import { agentLogger } from "../lib/logger-factory";
import { agentConfig } from "../lib/config-new";
import { githubAppService } from "./github-app";
import {
  AgentProxyService,
  setAgentService,
  getAgentService,
} from "./agent-service";
import { initializeAgentApiKey } from "./agent-api-key";
import type {
  AgentSettingsResponse,
  AgentConfigSource,
  AgentApiKeyValidationResponse,
} from "@mini-infra/types";

const logger = agentLogger();

const SETTINGS_CATEGORY = "agent";
const API_KEY_KEY = "anthropic_api_key";
const MODEL_KEY = "agent_model";

// Snapshot whether the env vars were genuinely set at startup,
// before we potentially copy DB values into process.env for subprocesses.
const ENV_HAD_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const ENV_HAD_MODEL = !!process.env.AGENT_MODEL;

const AVAILABLE_MODELS = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

const DEFAULT_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getDbSetting(key: string): Promise<string | null> {
  const setting = await prisma.systemSettings.findFirst({
    where: { category: SETTINGS_CATEGORY, key, isActive: true },
  });
  return setting?.value ?? null;
}

async function setDbSetting(key: string, value: string): Promise<void> {
  await prisma.systemSettings.upsert({
    where: { category_key: { category: SETTINGS_CATEGORY, key } },
    create: {
      category: SETTINGS_CATEGORY,
      key,
      value,
      isEncrypted: false,
      isActive: true,
      createdBy: "system",
      updatedBy: "system",
    },
    update: {
      value,
      isActive: true,
      updatedBy: "system",
      updatedAt: new Date(),
    },
  });
}

async function deleteDbSetting(key: string): Promise<void> {
  await prisma.systemSettings.updateMany({
    where: { category: SETTINGS_CATEGORY, key },
    data: { isActive: false, updatedBy: "system", updatedAt: new Date() },
  });
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 7) + "..." + key.slice(-4);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getEffectiveApiKey(): Promise<string | null> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return getDbSetting(API_KEY_KEY);
}

export async function getEffectiveModel(): Promise<string> {
  if (process.env.AGENT_MODEL) return process.env.AGENT_MODEL;
  const dbModel = await getDbSetting(MODEL_KEY);
  return dbModel ?? DEFAULT_MODEL;
}

export async function getSettings(): Promise<AgentSettingsResponse> {
  // Resolve API key source — use startup snapshot to distinguish "originally
  // from env" vs "copied into env from DB at runtime".
  let apiKeySource: AgentConfigSource = "none";
  let maskedKey: string | null = null;
  let configured = false;

  if (ENV_HAD_API_KEY) {
    apiKeySource = "environment";
    maskedKey = maskApiKey(process.env.ANTHROPIC_API_KEY!);
    configured = true;
  } else {
    const dbKey = await getDbSetting(API_KEY_KEY);
    if (dbKey) {
      apiKeySource = "database";
      maskedKey = maskApiKey(dbKey);
      configured = true;
    }
  }

  // Resolve model source
  let modelSource: AgentConfigSource = "default";
  let currentModel = DEFAULT_MODEL;

  if (ENV_HAD_MODEL) {
    modelSource = "environment";
    currentModel = process.env.AGENT_MODEL!;
  } else {
    const dbModel = await getDbSetting(MODEL_KEY);
    if (dbModel) {
      modelSource = "database";
      currentModel = dbModel;
    }
  }

  // Check capabilities
  const dockerAvailable = fs.existsSync("/var/run/docker.sock");
  let githubAvailable = false;
  try {
    const token = await githubAppService.getAgentToken();
    githubAvailable = !!token;
  } catch {
    // ignore
  }

  return {
    apiKey: { configured, source: apiKeySource, maskedKey },
    model: {
      current: currentModel,
      source: modelSource,
      available: AVAILABLE_MODELS,
    },
    capabilities: {
      docker: {
        available: dockerAvailable,
        socketPath: "/var/run/docker.sock",
      },
      github: { available: githubAvailable },
      api: { available: true },
    },
    advanced: {
      thinking: agentConfig.thinking,
      effort: agentConfig.effort,
    },
  };
}

export async function validateApiKey(
  key: string,
): Promise<AgentApiKeyValidationResponse> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    if (response.ok) {
      return { success: true, valid: true, message: "API key is valid" };
    }

    if (response.status === 401) {
      return {
        success: true,
        valid: false,
        message: "Invalid API key",
      };
    }

    // Other errors (rate limit, etc.) likely mean the key format is valid
    if (response.status === 429) {
      return {
        success: true,
        valid: true,
        message: "API key is valid (rate limited)",
      };
    }

    const body = await response.text();
    return {
      success: true,
      valid: false,
      message: `Validation failed: ${response.status} - ${body.slice(0, 200)}`,
    };
  } catch (error) {
    return {
      success: false,
      valid: false,
      message: `Connection error: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

export async function updateSettings(data: {
  apiKey?: string;
  model?: string;
}): Promise<AgentSettingsResponse> {
  if (data.apiKey !== undefined) {
    await setDbSetting(API_KEY_KEY, data.apiKey);
    logger.info("Agent API key saved to database");

    // Update process.env so new agent subprocesses use the latest key.
    // Skip only if the key was originally provided via environment variable
    // (those should only be changed by restarting with a new env value).
    if (!ENV_HAD_API_KEY) {
      process.env.ANTHROPIC_API_KEY = data.apiKey;
    }

    // Initialize agent proxy service if it wasn't running
    if (!getAgentService()) {
      try {
        const agentApiKey = await initializeAgentApiKey();
        if (agentApiKey) {
          const agentService = new AgentProxyService();
          setAgentService(agentService);
          logger.info(
            "Agent proxy service initialized after API key configuration",
          );
        }
      } catch (error) {
        logger.error({ error }, "Failed to initialize agent service after API key save");
      }
    }
  }

  if (data.model !== undefined) {
    const validIds = AVAILABLE_MODELS.map((m) => m.id);
    if (!validIds.includes(data.model)) {
      throw new Error(`Invalid model: ${data.model}`);
    }
    await setDbSetting(MODEL_KEY, data.model);
    logger.info({ model: data.model }, "Agent model saved to database");
  }

  return getSettings();
}

export async function deleteApiKey(): Promise<void> {
  await deleteDbSetting(API_KEY_KEY);

  // If the key was not originally from the environment, clear it from process.env
  // so new subprocesses won't inherit it.
  if (!ENV_HAD_API_KEY) {
    delete process.env.ANTHROPIC_API_KEY;
  }

  // Shut down and clear the agent service so /status returns { enabled: false }
  const service = getAgentService();
  if (service) {
    await service.shutdown();
    setAgentService(null);
  }

  logger.info("Agent API key removed from database, agent service disabled");
}
