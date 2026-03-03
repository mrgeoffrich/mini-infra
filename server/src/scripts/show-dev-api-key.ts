#!/usr/bin/env tsx
import { getDevApiKeyInfo, recreateDevApiKey } from "../services/dev-api-key";
import appConfig from "../lib/config-new";
import prisma from "../lib/prisma";
import { securityConfig } from "../lib/security-config";
import { randomBytes } from "crypto";

/**
 * Script to recreate and display development API key
 * Usage: npm run show-dev-key
 */

/**
 * Initialize security secrets from database or generate new ones
 * This must run FIRST before creating API keys
 */
async function initializeSecuritySecrets() {
  const CATEGORY = "system";
  const SESSION_SECRET_KEY = "session_secret";
  const API_KEY_SECRET_KEY = "api_key_secret";

  // Check if session secret exists
  let sessionSetting = await prisma.systemSettings.findFirst({
    where: {
      category: CATEGORY,
      key: SESSION_SECRET_KEY,
      isActive: true,
    },
  });

  // Generate session secret if it doesn't exist
  if (!sessionSetting || !sessionSetting.value) {
    const newSessionSecret = randomBytes(32).toString("hex");

    sessionSetting = await prisma.systemSettings.upsert({
      where: {
        category_key: {
          category: CATEGORY,
          key: SESSION_SECRET_KEY,
        },
      },
      create: {
        category: CATEGORY,
        key: SESSION_SECRET_KEY,
        value: newSessionSecret,
        isEncrypted: false,
        isActive: true,
        createdBy: "system",
        updatedBy: "system",
      },
      update: {
        value: newSessionSecret,
        updatedBy: "system",
        updatedAt: new Date(),
      },
    });
  }

  // Check if API key secret exists
  let apiKeySetting = await prisma.systemSettings.findFirst({
    where: {
      category: CATEGORY,
      key: API_KEY_SECRET_KEY,
      isActive: true,
    },
  });

  // Generate API key secret if it doesn't exist
  if (!apiKeySetting || !apiKeySetting.value) {
    const newApiKeySecret = randomBytes(32).toString("hex");

    apiKeySetting = await prisma.systemSettings.upsert({
      where: {
        category_key: {
          category: CATEGORY,
          key: API_KEY_SECRET_KEY,
        },
      },
      create: {
        category: CATEGORY,
        key: API_KEY_SECRET_KEY,
        value: newApiKeySecret,
        isEncrypted: false,
        isActive: true,
        createdBy: "system",
        updatedBy: "system",
      },
      update: {
        value: newApiKeySecret,
        updatedBy: "system",
        updatedAt: new Date(),
      },
    });
  }

  // Load secrets into memory
  securityConfig.setSessionSecret(sessionSetting.value);
  securityConfig.setApiKeySecret(apiKeySetting.value);
}

async function main() {

  // Check if we're in development mode
  if (appConfig.server.nodeEnv !== "development") {
    console.error("❌ This script can only be run in development mode");
    console.error("💡 Set NODE_ENV=development in your .env file");
    process.exit(1);
  }

  // Initialize security secrets first
  await initializeSecuritySecrets();

  console.log("🔄 Recreating Claude Development API Key...\n");

  try {
    const newKeyResult = await recreateDevApiKey();
    if (!newKeyResult) {
      console.error("❌ Failed to recreate development API key");
      process.exit(1);
    }

    console.log("✅ New development API key created successfully!\n");
    console.log("🔑 API Key Details:");
    console.log(`   User ID: ${newKeyResult.userId}`);
    console.log(`   Key ID: ${newKeyResult.keyId}`);
    console.log(`   API Key: ${newKeyResult.apiKey}\n`);

    console.log("💡 Usage Instructions:");
    console.log("   Authorization Header: Bearer " + newKeyResult.apiKey);
    console.log("   x-api-key Header: " + newKeyResult.apiKey + "\n");

    console.log("🌐 API Endpoints:");
    console.log(`   Base URL: http://localhost:${appConfig.server.port}`);
    console.log("   Health Check: GET /health");
    console.log("   Containers: GET /api/containers");
    console.log("   Settings: GET /api/settings");
    console.log("   And all other API endpoints...\n");

    console.log("🔧 Example Usage:");
    console.log('   curl -H "Authorization: Bearer <your-api-key>" \\');
    console.log(
      `        http://localhost:${appConfig.server.port}/api/containers`,
    );
    console.log("   Or:");
    console.log('   curl -H "x-api-key: <your-api-key>" \\');
    console.log(
      `        http://localhost:${appConfig.server.port}/api/containers\n`,
    );
  } catch (error) {
    console.error(
      "❌ Error:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
}

// Handle command line execution
if (require.main === module) {
  main().catch((error) => {
    console.error("❌ Unexpected error:", error);
    process.exit(1);
  });
}
