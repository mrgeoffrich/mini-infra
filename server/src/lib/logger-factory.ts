import pino from "pino";
import path from "path";
import {
  getLoggerConfig,
  getRedactionPaths,
  ensureLogDirectory,
  type LoggerConfig,
} from "./logging-config";

// Cache for logger instances
const loggerCache = new Map<string, pino.Logger>();

// Base Pino options for all loggers
function createBaseLoggerOptions(config: LoggerConfig): pino.LoggerOptions {
  const redactionPaths = getRedactionPaths();

  const baseOptions: pino.LoggerOptions = {
    level: config.level,
    redact: {
      paths: redactionPaths,
      censor: "[REDACTED]",
    },
  };

  // Configure transport targets (file and/or console)
  const targets = [];

  // Add file destination if specified
  if (config.destination) {
    ensureLogDirectory(config.destination);
    const destination = path.resolve(config.destination);
    
    if (config.rotation?.enabled) {
      // Use pino-roll for log rotation in production
      targets.push({
        target: "pino-roll",
        options: {
          file: destination,
          frequency: "daily",
          mkdir: true,
          ...(config.rotation.maxSize && { size: config.rotation.maxSize }),
          ...(config.rotation.maxFiles && { limit: config.rotation.maxFiles }),
        },
        level: config.level,
      });
    } else {
      // Simple file destination without rotation
      targets.push({
        target: "pino/file",
        options: {
          destination,
          mkdir: true,
        },
        level: config.level,
      });
    }

    // Add aggregate log file target (app-all.log) for all loggers
    const aggregateDestination = path.resolve("logs/app-all.log");
    ensureLogDirectory(aggregateDestination);
    
    if (config.rotation?.enabled) {
      // Use pino-roll for aggregate log rotation in production
      targets.push({
        target: "pino-roll",
        options: {
          file: aggregateDestination,
          frequency: "daily",
          mkdir: true,
          ...(config.rotation.maxSize && { size: config.rotation.maxSize }),
          ...(config.rotation.maxFiles && { limit: config.rotation.maxFiles }),
        },
        level: config.level,
      });
    } else {
      // Simple aggregate file destination without rotation
      targets.push({
        target: "pino/file",
        options: {
          destination: aggregateDestination,
          mkdir: true,
        },
        level: config.level,
      });
    }
  }

  // Add console output with pretty print for development
  if (config.prettyPrint) {
    targets.push({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "yyyy-mm-dd HH:MM:ss",
        ignore: "pid,hostname",
      },
      level: config.level,
    });
  }

  // Set up transport based on number of targets
  if (targets.length === 1) {
    baseOptions.transport = targets[0];
  } else if (targets.length > 1) {
    baseOptions.transport = {
      targets: targets,
    };
  }

  // Production structured JSON with timestamp
  if (!config.prettyPrint && !baseOptions.transport) {
    baseOptions.formatters = {
      level: (label: string) => ({ level: label }),
    };
    baseOptions.timestamp = pino.stdTimeFunctions.isoTime;
  }

  return baseOptions;
}

// Create or get cached logger instance
function createLogger(loggerType: string): pino.Logger {
  if (loggerCache.has(loggerType)) {
    return loggerCache.get(loggerType)!;
  }

  const config = getLoggerConfig(loggerType as any);
  const options = createBaseLoggerOptions(config);
  const logger = pino(options);

  loggerCache.set(loggerType, logger);
  return logger;
}

// Exported logger instances for different domains
export const appLogger = () => createLogger("app");
export const httpLogger = () => createLogger("http");
export const prismaLogger = () => createLogger("prisma");
export const servicesLogger = () => createLogger("services");
export const dockerExecutorLogger = () => createLogger("dockerexecutor");

// Generic logger factory function
export function getLogger(loggerType: "app" | "http" | "prisma" | "services" | "dockerexecutor"): pino.Logger {
  return createLogger(loggerType);
}

// Clear logger cache (useful for testing or config reloads)
export function clearLoggerCache(): void {
  loggerCache.clear();
}

// Create child logger with additional context
export function createChildLogger(
  loggerType: "app" | "http" | "prisma" | "services" | "dockerexecutor",
  context: Record<string, unknown>
): pino.Logger {
  const parentLogger = getLogger(loggerType);
  return parentLogger.child(context);
}

// Default export for backward compatibility
export default appLogger;