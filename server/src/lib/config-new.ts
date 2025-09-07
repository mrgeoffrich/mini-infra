import config from "config";
import { z } from "zod";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// Define the configuration schema for validation
const configSchema = z.object({
  server: z.object({
    nodeEnv: z.enum(["development", "production", "test"]),
    port: z.number(),
    publicUrl: z.string().optional(),
  }),
  database: z.object({
    url: z.string(),
  }),
  auth: z.object({
    google: z.object({
      clientId: z.string().nullable(),
      clientSecret: z.string().nullable(),
    }),
    session: z.object({
      secret: z.string().nullable(),
    }),
    apiKey: z.object({
      secret: z.string(),
    }),
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

  // Use default value if provided
  if (defaultValue !== undefined) {
    return defaultValue;
  }

  throw new Error(`Configuration value not found for path: ${path}`);
}

// Build configuration object with environment variable overrides
const appConfig: Config = {
  server: {
    nodeEnv: getConfigValue("server.nodeEnv", "NODE_ENV", "development") as
      | "development"
      | "production"
      | "test",
    port: getConfigValue("server.port", "PORT", 5000),
    publicUrl: getConfigValue("server.publicUrl", "PUBLIC_URL", undefined),
  },
  database: {
    url: getConfigValue("database.url", "DATABASE_URL", "file:./dev.db"),
  },
  auth: {
    google: {
      clientId: getConfigValue(
        "auth.google.clientId",
        "GOOGLE_CLIENT_ID",
        null,
      ),
      clientSecret: getConfigValue(
        "auth.google.clientSecret",
        "GOOGLE_CLIENT_SECRET",
        null,
      ),
    },
    session: {
      secret: getConfigValue("auth.session.secret", "SESSION_SECRET", null),
    },
    apiKey: {
      secret: getConfigValue(
        "auth.apiKey.secret",
        "API_KEY_SECRET",
        "default-secret-change-in-production",
      ),
    },
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
    containerCacheTtl: getConfigValue(
      "docker.containerCacheTtl",
      "CONTAINER_CACHE_TTL",
      3000,
    ),
    containerPollInterval: getConfigValue(
      "docker.containerPollInterval",
      "CONTAINER_POLL_INTERVAL",
      5000,
    ),
  },
  azure: {
    apiTimeout: getConfigValue("azure.apiTimeout", "AZURE_API_TIMEOUT", 15000),
  },
  connectivity: {
    checkInterval: getConfigValue(
      "connectivity.checkInterval",
      "CONNECTIVITY_CHECK_INTERVAL",
      300000,
    ),
  },
};

// Validate the final configuration
let validatedConfig: Config;

try {
  validatedConfig = configSchema.parse(appConfig);
} catch (error) {
  console.error("❌ Invalid configuration:", error);
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
} = validatedConfig;
