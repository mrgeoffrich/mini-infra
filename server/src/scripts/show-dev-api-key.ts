#!/usr/bin/env tsx
import { getDevApiKeyInfo, recreateDevApiKey } from "../services/dev-api-key";
import appConfig from "../lib/config-new";

/**
 * Script to display development API key information
 * Usage: npm run show-dev-key [--recreate]
 */

const RECREATE_FLAG = "--recreate";

async function main() {
  const args = process.argv.slice(2);
  const shouldRecreate = args.includes(RECREATE_FLAG);

  // Check if we're in development mode
  if (appConfig.server.nodeEnv !== "development") {
    console.error("❌ This script can only be run in development mode");
    console.error("💡 Set NODE_ENV=development in your .env file");
    process.exit(1);
  }

  console.log("🔍 Claude Development API Key Information\n");

  try {
    if (shouldRecreate) {
      console.log("🔄 Recreating development API key...\n");
      
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
      
      console.log("⚠️  Save this API key securely - it won't be displayed again!");
      
    } else {
      const apiKeyInfo = await getDevApiKeyInfo();
      
      if (!apiKeyInfo) {
        console.log("❌ No development API key found");
        console.log("💡 Run this script with --recreate flag to create a new key:");
        console.log("   npm run show-dev-key -- --recreate\n");
        process.exit(1);
      }

      console.log("📋 Current API Key Information:");
      console.log(`   User: ${apiKeyInfo.userName} (${apiKeyInfo.userEmail})`);
      console.log(`   User ID: ${apiKeyInfo.userId}`);
      console.log(`   Key Name: ${apiKeyInfo.keyName}`);
      console.log(`   Key ID: ${apiKeyInfo.keyId}`);
      console.log(`   Created: ${new Date(apiKeyInfo.createdAt).toLocaleString()}`);
      
      if (apiKeyInfo.lastUsedAt) {
        console.log(`   Last Used: ${new Date(apiKeyInfo.lastUsedAt).toLocaleString()}`);
      } else {
        console.log("   Last Used: Never");
      }
      
      console.log("\n⚠️  The actual API key value cannot be displayed for security reasons.");
      console.log("💡 If you need the key value, recreate it with:");
      console.log("   npm run show-dev-key -- --recreate\n");
    }

    console.log("🌐 API Endpoints:");
    console.log(`   Base URL: http://localhost:${appConfig.server.port}`);
    console.log("   Health Check: GET /health");
    console.log("   Containers: GET /api/containers");
    console.log("   Settings: GET /api/settings");
    console.log("   And all other API endpoints...\n");

    console.log("🔧 Example Usage:");
    console.log("   curl -H \"Authorization: Bearer <your-api-key>\" \\");
    console.log(`        http://localhost:${appConfig.server.port}/api/containers`);
    console.log("   Or:");
    console.log("   curl -H \"x-api-key: <your-api-key>\" \\");
    console.log(`        http://localhost:${appConfig.server.port}/api/containers\n`);

  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : String(error));
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