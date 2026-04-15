import pino from "pino";
import path from "path";
import {
  LOG_COMPONENTS,
  type LogComponent,
  getComponentLevel,
  getDestinationConfig,
  getRedactionPaths,
  ensureLogDirectory,
} from "./logging-config";
import { getContext } from "./logging-context";

// Helper function to properly serialize errors for logging
export const serializeError = (error: unknown): unknown => {
  if (error instanceof Error) {
    const errWithProps = error as Error & Record<string, unknown>;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: errWithProps.code ?? undefined,
      errno: errWithProps.errno ?? undefined,
      syscall: errWithProps.syscall ?? undefined,
      ...Object.getOwnPropertyNames(error).reduce(
        (acc, key) => {
          if (!["name", "message", "stack"].includes(key)) {
            acc[key] = errWithProps[key];
          }
          return acc;
        },
        {} as Record<string, unknown>,
      ),
    };
  }
  return error;
};

const componentRootCache = new Map<LogComponent, pino.Logger>();
const subcomponentCache = new Map<string, pino.Logger>();

const STACKTRACE_OFFSET = 2;
const {
  symbols: { asJsonSym },
} = pino;

// Inject `caller` (file:line) into every log line by walking the stack trace.
function traceCaller(pinoInstance: pino.Logger): pino.Logger {
  const get = (target: pino.Logger, name: string | symbol): unknown =>
    name === asJsonSym
      ? asJson
      : (target as unknown as Record<string | symbol, unknown>)[name];

  function asJson(this: unknown, ...args: unknown[]): unknown {
    try {
      args[0] = args[0] || Object.create(null);

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
            const projectRoot = path.resolve(process.cwd());
            const relativePath = path
              .relative(projectRoot, fullPath)
              .replace(/\\/g, "/");
            (args[0] as Record<string, unknown>).caller = `${relativePath}:${lineNumber}`;
          }
        }
      }

      const pinoRecord = pinoInstance as unknown as Record<
        symbol,
        (...args: unknown[]) => unknown
      >;
      return pinoRecord[asJsonSym].apply(this, args);
    } catch {
      const pinoRecord = pinoInstance as unknown as Record<
        symbol,
        (...args: unknown[]) => unknown
      >;
      return pinoRecord[asJsonSym].apply(this, args);
    }
  }

  return new Proxy(pinoInstance, {
    get: get as ProxyHandler<pino.Logger>["get"],
  });
}

function contextMixin(): Record<string, unknown> {
  const ctx = getContext();
  if (!ctx) return {};
  const out: Record<string, unknown> = {};
  if (ctx.requestId) out.requestId = ctx.requestId;
  if (ctx.userId) out.userId = ctx.userId;
  if (ctx.operationId) out.operationId = ctx.operationId;
  return out;
}

interface PinoTransportTarget {
  target: string;
  options: Record<string, unknown>;
  level: string;
}

function buildTransportTargets(level: string): PinoTransportTarget[] {
  const { destination, rotation } = getDestinationConfig();
  if (!destination) return [];

  ensureLogDirectory(destination);
  const resolved = path.resolve(destination);

  if (rotation?.enabled) {
    return [
      {
        target: "pino-roll",
        options: {
          file: resolved,
          frequency: "daily",
          mkdir: true,
          ...(rotation.maxSize && { size: rotation.maxSize }),
          ...(rotation.maxFiles && {
            limit: { count: parseInt(rotation.maxFiles) },
          }),
        },
        level,
      },
    ];
  }

  return [
    {
      target: "pino/file",
      options: { destination: resolved, mkdir: true },
      level,
    },
  ];
}

function createComponentRoot(component: LogComponent): pino.Logger {
  const level = getComponentLevel(component);
  const redactionPaths = getRedactionPaths();

  const options: pino.LoggerOptions = {
    level,
    redact: { paths: redactionPaths, censor: "[REDACTED]" },
    serializers: { error: serializeError },
    base: { component },
    mixin: contextMixin,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
  };

  const targets = buildTransportTargets(level);
  if (targets.length === 1) {
    options.transport = targets[0];
  } else if (targets.length > 1) {
    options.transport = { targets };
  }

  const root = pino(options);
  return traceCaller(root);
}

function getComponentRoot(component: LogComponent): pino.Logger {
  const cached = componentRootCache.get(component);
  if (cached) return cached;
  const root = createComponentRoot(component);
  componentRootCache.set(component, root);
  return root;
}

/**
 * Primary logger factory. Returns a child of the component root with the
 * `subcomponent` field bound. Log lines automatically carry `component`,
 * `subcomponent`, `caller`, and — inside a request or operation scope —
 * `requestId` / `userId` / `operationId` via the pino mixin.
 */
export function getLogger(
  component: LogComponent,
  subcomponent: string,
): pino.Logger {
  if (!LOG_COMPONENTS.includes(component)) {
    throw new Error(`Unknown log component: ${component}`);
  }
  const cacheKey = `${component}::${subcomponent}`;
  const cached = subcomponentCache.get(cacheKey);
  if (cached) return cached;
  const child = getComponentRoot(component).child({ subcomponent });
  subcomponentCache.set(cacheKey, child);
  return child;
}

export function clearLoggerCache(): void {
  componentRootCache.clear();
  subcomponentCache.clear();
}
