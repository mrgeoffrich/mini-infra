import { z } from "zod";
import fs from "fs";
import path from "path";
import { serverConfig } from "./config-new";

// Zod schemas for logging configuration validation
const rotationConfigSchema = z.object({
  enabled: z.boolean(),
  maxFiles: z.string().optional(),
  maxSize: z.string().optional(),
});

const loggerConfigSchema = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]),
  destination: z.string().optional(),
  prettyPrint: z.boolean().optional(),
  rotation: rotationConfigSchema.optional(),
});

const environmentLogConfigSchema = z.object({
  app: loggerConfigSchema,
  http: loggerConfigSchema,
  prisma: loggerConfigSchema,
  services: loggerConfigSchema,
  dockerexecutor: loggerConfigSchema,
});

const loggingConfigSchema = z.object({
  development: environmentLogConfigSchema,
  production: environmentLogConfigSchema,
  test: environmentLogConfigSchema,
  redactionPaths: z.array(z.string()),
});

export type LoggerConfig = z.infer<typeof loggerConfigSchema>;
export type EnvironmentLogConfig = z.infer<typeof environmentLogConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

let loggingConfig: LoggingConfig;

// Load and validate logging configuration
export function loadLoggingConfig(): LoggingConfig {
  if (loggingConfig) {
    return loggingConfig;
  }

  try {
    const configPath = path.join(process.cwd(), "config", "logging.json");
    const configFile = fs.readFileSync(configPath, "utf8");
    const rawConfig = JSON.parse(configFile);
    
    loggingConfig = loggingConfigSchema.parse(rawConfig);
    return loggingConfig;
  } catch (error) {
    console.error("❌ Failed to load logging configuration:", error);
    
    // Fallback to default configuration
    loggingConfig = {
      development: {
        app: { level: "debug" },
        http: { level: "info" },
        prisma: { level: "info" },
        services: { level: "debug" },
        dockerexecutor: { level: "debug" },
      },
      production: {
        app: { level: "info" },
        http: { level: "info" },
        prisma: { level: "warn" },
        services: { level: "info" },
        dockerexecutor: { level: "info" },
      },
      test: {
        app: { level: "silent" },
        http: { level: "silent" },
        prisma: { level: "silent" },
        services: { level: "silent" },
        dockerexecutor: { level: "silent" },
      },
      redactionPaths: [
        "password",
        "token",
        "accessToken",
        "refreshToken",
        "authorization",
        "cookie",
        "sessionToken",
        "connectionString",
        "apiKey",
        "secret",
        "*.password",
        "*.token",
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.password",
        'res.headers["set-cookie"]',
      ],
    };
    
    return loggingConfig;
  }
}

// Get logging configuration for current environment
export function getEnvironmentLogConfig(): EnvironmentLogConfig {
  const fullConfig = loadLoggingConfig();
  const environment = serverConfig.nodeEnv;
  
  return fullConfig[environment];
}

// Get specific logger configuration
export function getLoggerConfig(loggerType: keyof EnvironmentLogConfig): LoggerConfig {
  const envConfig = getEnvironmentLogConfig();
  return envConfig[loggerType];
}

// Get redaction paths
export function getRedactionPaths(): string[] {
  const fullConfig = loadLoggingConfig();
  return fullConfig.redactionPaths;
}

// Ensure log directory exists
export function ensureLogDirectory(destination?: string): void {
  if (!destination) return;
  
  const logDir = path.dirname(path.resolve(destination));
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}