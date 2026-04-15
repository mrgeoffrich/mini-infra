import { z } from "zod";
import fs from "fs";
import path from "path";
import { serverConfig } from "./config-new";

export const LOG_COMPONENTS = [
  "http",
  "auth",
  "db",
  "docker",
  "stacks",
  "deploy",
  "haproxy",
  "tls",
  "backup",
  "integrations",
  "agent",
  "platform",
] as const;

export type LogComponent = (typeof LOG_COMPONENTS)[number];

const levelEnum = z.enum([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
]);

export type LogLevel = z.infer<typeof levelEnum>;

const rotationConfigSchema = z.object({
  enabled: z.boolean(),
  maxFiles: z.string().optional(),
  maxSize: z.string().optional(),
});

export type RotationConfig = z.infer<typeof rotationConfigSchema>;

const levelsSchema = z.object({
  http: levelEnum,
  auth: levelEnum,
  db: levelEnum,
  docker: levelEnum,
  stacks: levelEnum,
  deploy: levelEnum,
  haproxy: levelEnum,
  tls: levelEnum,
  backup: levelEnum,
  integrations: levelEnum,
  agent: levelEnum,
  platform: levelEnum,
});

const environmentLogConfigSchema = z.object({
  destination: z.string().nullable(),
  rotation: rotationConfigSchema.optional(),
  levels: levelsSchema,
});

const loggingConfigSchema = z.object({
  development: environmentLogConfigSchema,
  production: environmentLogConfigSchema,
  test: environmentLogConfigSchema,
  redactionPaths: z.array(z.string()),
});

export type EnvironmentLogConfig = z.infer<typeof environmentLogConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

// Legacy shape returned by getLoggerConfig for the pre-migration logger exports.
export interface LegacyLoggerConfig {
  level: LogLevel;
  destination?: string;
  prettyPrint: boolean;
  includeCaller: boolean;
  rotation?: RotationConfig;
}

// Map from legacy category name → new component name (used by the legacy shim
// that keeps old factory exports alive during the migration window).
const LEGACY_TO_COMPONENT: Record<string, LogComponent> = {
  app: "platform",
  http: "http",
  prisma: "db",
  services: "platform",
  dockerexecutor: "docker",
  deployments: "deploy",
  loadbalancer: "haproxy",
  "self-backup": "backup",
  tls: "tls",
  agent: "agent",
};

let loggingConfig: LoggingConfig | undefined;

function buildDefaultConfig(): LoggingConfig {
  const silentLevels: Record<LogComponent, LogLevel> = Object.fromEntries(
    LOG_COMPONENTS.map((c) => [c, "silent"]),
  ) as Record<LogComponent, LogLevel>;

  const infoLevels: Record<LogComponent, LogLevel> = Object.fromEntries(
    LOG_COMPONENTS.map((c) => [c, "info"]),
  ) as Record<LogComponent, LogLevel>;

  return {
    development: {
      destination: "logs/app.log",
      rotation: { enabled: true, maxSize: "10m", maxFiles: "10" },
      levels: { ...infoLevels, docker: "debug", stacks: "debug", deploy: "debug", haproxy: "debug", tls: "debug", agent: "debug" },
    },
    production: {
      destination: "logs/app.log",
      rotation: { enabled: true, maxSize: "50m", maxFiles: "14" },
      levels: { ...infoLevels, db: "warn" },
    },
    test: {
      destination: null,
      levels: silentLevels,
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
      "*.connectionString",
      "*.apiKey",
      "*.secret",
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      "req.body.password",
      'res.headers["set-cookie"]',
    ],
  };
}

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
    loggingConfig = buildDefaultConfig();
    return loggingConfig;
  }
}

export function getEnvironmentLogConfig(): EnvironmentLogConfig {
  const fullConfig = loadLoggingConfig();
  const environment = serverConfig.nodeEnv;
  return fullConfig[environment];
}

export function getComponentLevel(component: LogComponent): LogLevel {
  return getEnvironmentLogConfig().levels[component];
}

export function getDestinationConfig(): {
  destination: string | null;
  rotation?: RotationConfig;
} {
  const envConfig = getEnvironmentLogConfig();
  return { destination: envConfig.destination, rotation: envConfig.rotation };
}

export function getRedactionPaths(): string[] {
  return loadLoggingConfig().redactionPaths;
}

export function ensureLogDirectory(destination?: string | null): void {
  if (!destination) return;
  const logDir = path.dirname(path.resolve(destination));
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

/**
 * Legacy shim: synthesize a LegacyLoggerConfig for an old category name by
 * looking up the equivalent new component's level plus the single-file
 * destination. Used only by the legacy logger exports during migration.
 */
export function getLoggerConfig(legacyType: string): LegacyLoggerConfig {
  const component = LEGACY_TO_COMPONENT[legacyType] ?? "platform";
  const env = getEnvironmentLogConfig();
  return {
    level: env.levels[component],
    destination: env.destination ?? undefined,
    rotation: env.rotation,
    prettyPrint: false,
    includeCaller: true,
  };
}

export function legacyTypeToComponent(legacyType: string): LogComponent {
  return LEGACY_TO_COMPONENT[legacyType] ?? "platform";
}

// Reset for tests
export function resetLoggingConfigForTests(): void {
  loggingConfig = undefined;
}
