import config from "config";
import { z } from "zod";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Load environment variables from .env file
dotenv.config({ quiet: process.env.NODE_ENV === "test" });

// Define the configuration schema for validation
const configSchema = z.object({
  server: z.object({
    nodeEnv: z.enum(["development", "production", "test"]),
    port: z.number(),
  }),
  database: z.object({
    url: z.string(),
  }),
  auth: z.object({
    allowedEmails: z.array(z.string()).nullable(),
  }),
  logging: z.object({
    level: z.enum([
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
      "silent",
    ]),
  }),
  docker: z.object({
    containerCacheTtl: z.number(),
    containerPollInterval: z.number(),
  }),
  azure: z.object({
    apiTimeout: z.number(),
  }),
  connectivity: z.object({
    checkInterval: z.number(),
  }),
  security: z.object({
    allowInsecure: z.boolean(),
  }),
  agent: z.object({
    model: z.string(),
    thinking: z.enum(["adaptive", "enabled", "disabled"]),
    effort: z.enum(["low", "medium", "high", "max"]),
  }),
});

export type Config = z.infer<typeof configSchema>;

// Helper function to get config with environment variable fallback
function getConfigValue<T>(path: string, envKey?: string, defaultValue?: T): T {
  // Try to get from environment first
  if (envKey && process.env[envKey] !== undefined) {
    const envValue = process.env[envKey];
    // Handle numeric values
    if (typeof defaultValue === "number") {
      return Number(envValue) as T;
    }
    return envValue as T;
  }

  // Fall back to node-config
  if (config.has(path)) {
    return config.get<T>(path);
  }

  // Use default value if provided (check if argument was actually passed)
   
  if (arguments.length >= 3) {
    return defaultValue as T;
  }

  throw new Error(`Configuration value not found for path: ${path}`);
}

// Build configuration object with environment variable overrides
const appConfig: Config = {
  server: {
    nodeEnv: getConfigValue("server.nodeEnv", "NODE_ENV", "production") as
      | "development"
      | "production"
      | "test",
    port: getConfigValue("server.port", "PORT", 5005),
  },
  database: {
    url: getConfigValue("database.url", "DATABASE_URL", "file:./dev.db"),
  },
  auth: {
    allowedEmails: (() => {
      const envValue = process.env.ALLOWED_ADMIN_EMAILS;
      if (envValue) {
        return envValue.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
      }
      return null;
    })(),
  },
  logging: {
    level: getConfigValue("logging.level", "LOG_LEVEL", "info") as
      | "trace"
      | "debug"
      | "info"
      | "warn"
      | "error"
      | "fatal"
      | "silent",
  },
  docker: {
    containerCacheTtl: 3000,
    containerPollInterval: 5000,
  },
  azure: {
    apiTimeout: 15000,
  },
  connectivity: {
    checkInterval: 300000, // 5 minutes
  },
  agent: {
    model: getConfigValue("agent.model", "AGENT_MODEL", "claude-sonnet-4-6"),
    thinking: getConfigValue("agent.thinking", "AGENT_THINKING", "adaptive") as
      | "adaptive"
      | "enabled"
      | "disabled",
    effort: getConfigValue("agent.effort", "AGENT_EFFORT", "medium") as
      | "low"
      | "medium"
      | "high"
      | "max",
  },
  security: {
    allowInsecure: (() => {
      const value = getConfigValue<string | boolean>("security.allowInsecure", "ALLOW_INSECURE", false);
      return value === "true" || value === true;
    })(),
  },
};

// Validate the final configuration
let validatedConfig: Config;

try {
  validatedConfig = configSchema.parse(appConfig);

  // Log security configuration for transparency
  if (validatedConfig.security.allowInsecure) {
    console.log("⚠️  Security: Allowing insecure connections (configured via ALLOW_INSECURE)");
  }
} catch (error) {
  // Use console.error since logger isn't available yet
  console.error("❌ FATAL: Invalid configuration detected during startup");
  console.error("Configuration validation error:", error);
  console.error("Please check your environment variables and configuration files");

  // Also try to write to a basic log file if possible
  try {
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const errorLogPath = path.join(logDir, 'startup-errors.log');
    const errorDetails = {
      timestamp: new Date().toISOString(),
      error: 'Configuration validation failed',
      details: error instanceof Error ? error.message : String(error),
      config: appConfig
    };
    fs.appendFileSync(errorLogPath, JSON.stringify(errorDetails) + '\n');
    console.error(`Error details also written to: ${errorLogPath}`);
  } catch (writeError) {
    console.error("Could not write error to log file:", writeError);
  }

  process.exit(1);
}

export default validatedConfig;

// Export individual config sections for convenience
export const {
  server: serverConfig,
  database: databaseConfig,
  auth: authConfig,
  logging: loggingConfig,
  docker: dockerConfig,
  azure: azureConfig,
  connectivity: connectivityConfig,
  security: securityConfig,
  agent: agentConfig,
} = validatedConfig;

