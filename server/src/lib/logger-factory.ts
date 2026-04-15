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

// Note on pino-http integration: pino-http ships its own nested copy of
// pino, so symbols like `stringifySym` differ between pino instances loaded
// from different paths. Passing a logger we built with the server's pino
// crashes pino-http at res.finish ("TypeError: logger[stringifySym] is not
// a function"). `buildPinoHttpOptions(component, subcomponent)` below
// exposes the base pino options so callers can hand them to pino-http and
// let it construct its own logger from its own pino copy — keeping the
// `component` / `subcomponent` / mixin / redaction behaviour consistent
// with the rest of the codebase.
//
// The previous implementation also wrapped every root logger in a Proxy
// that intercepted `asJsonSym` to inject a `caller` file:line field. The
// caller value was unreliable (stack offsets frequently resolved to
// node:internal frames) and the Proxy broke pino-http's symbol-based
// access — so the proxy was dropped. `subcomponent` is the single
// identification field going forward.

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

function buildBaseOptions(
  component: LogComponent,
  subcomponent?: string,
): pino.LoggerOptions {
  const level = getComponentLevel(component);
  const redactionPaths = getRedactionPaths();

  const base: Record<string, unknown> = { component };
  if (subcomponent) base.subcomponent = subcomponent;

  const options: pino.LoggerOptions = {
    level,
    redact: { paths: redactionPaths, censor: "[REDACTED]" },
    serializers: { error: serializeError },
    base,
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

  return options;
}

function createComponentRoot(component: LogComponent): pino.Logger {
  return pino(buildBaseOptions(component));
}

/**
 * Return the pino options that would produce a logger equivalent to
 * `getLogger(component, subcomponent)` — but *without* constructing the
 * logger here. Intended for pino-http, which needs to build its own pino
 * instance from its own nested pino copy so its internal symbol lookups
 * succeed (see the note at the top of this file).
 */
export function buildPinoHttpOptions(
  component: LogComponent,
  subcomponent: string,
): pino.LoggerOptions {
  return buildBaseOptions(component, subcomponent);
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
 * `subcomponent`, and — inside a request or operation scope — `requestId`
 * / `userId` / `operationId` via the pino mixin.
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
