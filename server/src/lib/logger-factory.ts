import pino from "pino";
import path from "path";
import { trace, context } from "@opentelemetry/api";
import {
  getLoggerConfig,
  getRedactionPaths,
  ensureLogDirectory,
  getOpenObserveConfig,
  isOpenObserveConfigured,
  type LoggerConfig,
} from "./logging-config";

// Helper function to inject OpenTelemetry trace context into log records
export const injectTraceContext = (logObject: any) => {
  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    const spanContext = activeSpan.spanContext();
    if (spanContext.traceId && spanContext.spanId) {
      logObject.trace_id = spanContext.traceId;
      logObject.span_id = spanContext.spanId;
      logObject.trace_flags = spanContext.traceFlags;
    }
  }
  return logObject;
};

// Helper function to properly serialize errors for logging
export const serializeError = (error: any) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: (error as any).code || undefined,
      errno: (error as any).errno || undefined,
      syscall: (error as any).syscall || undefined,
      // Include any additional enumerable properties
      ...Object.getOwnPropertyNames(error).reduce((acc, key) => {
        if (!["name", "message", "stack"].includes(key)) {
          acc[key] = (error as any)[key];
        }
        return acc;
      }, {} as any),
    };
  }
  return error;
};

// Cache for logger instances
const loggerCache = new Map<string, pino.Logger>();

// Constants for stack trace parsing
const STACKTRACE_OFFSET = 2;
const LINE_OFFSET = 7;
const {
  symbols: { asJsonSym },
} = pino;

// Function to create a proxy wrapper for adding caller information
function traceCaller(pinoInstance: pino.Logger): pino.Logger {
  const get = (target: any, name: string | symbol) =>
    name === asJsonSym ? asJson : target[name];

  function asJson(this: any, ...args: any[]) {
    try {
      args[0] = args[0] || Object.create(null);

      // Inject OpenTelemetry trace context
      injectTraceContext(args[0]);

      // Extract caller information from stack trace
      const stack = Error().stack;
      if (stack) {
        const stackLines = stack
          .split("\n")
          .filter(
            (s) =>
              !s.includes("node_modules/pino") &&
              !s.includes("node_modules\\pino") &&
              !s.includes("logger-factory") &&
              s.includes(" at "),
          );

        if (stackLines.length > STACKTRACE_OFFSET) {
          const callerLine = stackLines[STACKTRACE_OFFSET];
          const match =
            callerLine.match(/at .* \((.+):(\d+):\d+\)/) ||
            callerLine.match(/at (.+):(\d+):\d+/);

          if (match) {
            const fullPath = match[1];
            const lineNumber = match[2];
            // Make path relative to project root
            const projectRoot = path.resolve(process.cwd());
            const relativePath = path
              .relative(projectRoot, fullPath)
              .replace(/\\/g, "/");
            args[0].caller = `${relativePath}:${lineNumber}`;
          }
        }
      }

      return (pinoInstance as any)[asJsonSym].apply(this, args);
    } catch (error) {
      // If there's an error in caller tracking, fall back to original logging
      return (pinoInstance as any)[asJsonSym].apply(this, args);
    }
  }

  return new Proxy(pinoInstance, { get });
}

// Transport target interface for Pino
interface PinoTransportTarget {
  target: string;
  options: Record<string, any>;
  level: string;
}

// Base Pino options for all loggers
function createBaseLoggerOptions(config: LoggerConfig): pino.LoggerOptions {
  const redactionPaths = getRedactionPaths();

  const baseOptions: pino.LoggerOptions = {
    level: config.level,
    redact: {
      paths: redactionPaths,
      censor: "[REDACTED]",
    },
    serializers: {
      error: serializeError,
    },
  };

  // Configure transport targets (file and/or console)
  const targets: PinoTransportTarget[] = [];

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

  // Add OpenObserve target if properly configured
  if (isOpenObserveConfigured()) {
    const openobserveConfig = getOpenObserveConfig();
    targets.push({
      target: "@openobserve/pino-openobserve",
      options: {
        url: process.env.OPENOBSERVE_URL,
        organization: process.env.OPENOBSERVE_ORGANIZATION_NAME,
        auth: {
          username: process.env.OPENOBSERVE_USERNAME,
          password: process.env.OPENOBSERVE_PASSWORD,
        },
        streamName: process.env.OPENOBSERVE_STREAM_NAME,
        batchSize: openobserveConfig?.batchSize || 100,
        timeThreshold: openobserveConfig?.timeThreshold || 30000,
        silentSuccess: true,
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
  let logger = pino(options);

  // Apply caller information tracking if enabled
  if (config.includeCaller) {
    logger = traceCaller(logger);
  }

  loggerCache.set(loggerType, logger);
  return logger;
}

// Exported logger instances for different domains
export const appLogger = () => createLogger("app");
export const httpLogger = () => createLogger("http");
export const prismaLogger = () => createLogger("prisma");
export const servicesLogger = () => createLogger("services");
export const dockerExecutorLogger = () => createLogger("dockerexecutor");
export const deploymentLogger = () => createLogger("deployments");
export const loadbalancerLogger = () => createLogger("loadbalancer");

// Generic logger factory function
export function getLogger(
  loggerType:
    | "app"
    | "http"
    | "prisma"
    | "services"
    | "dockerexecutor"
    | "deployments"
    | "loadbalancer",
): pino.Logger {
  return createLogger(loggerType);
}

// Clear logger cache (useful for testing or config reloads)
export function clearLoggerCache(): void {
  loggerCache.clear();
}

// Create child logger with additional context
export function createChildLogger(
  loggerType:
    | "app"
    | "http"
    | "prisma"
    | "services"
    | "dockerexecutor"
    | "deployments"
    | "loadbalancer",
  context: Record<string, unknown>,
): pino.Logger {
  const parentLogger = getLogger(loggerType);
  return parentLogger.child(context);
}

// Default export for backward compatibility
export default appLogger;
