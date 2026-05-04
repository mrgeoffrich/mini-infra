import NodeCache from "node-cache";
import prisma from "./prisma";
import { getLogger } from "./logger-factory";

const logger = getLogger("platform", "public-url-service");

// 30-minute TTL, check for expired keys every 2 minutes
const cache = new NodeCache({ stdTTL: 1800, checkperiod: 120 });

const CACHE_KEY_PUBLIC_URL = "public_url";
const CACHE_KEY_CORS_ORIGIN = "cors_origin";
const CACHE_KEY_HTTPS_ONLY = "https_only_mode";

// Wrapper to distinguish "not cached" from "cached as null"
interface CachedValue {
  value: string | null;
}

/**
 * Get the public URL from the database, with 30-minute caching.
 * Returns null when not configured.
 */
export async function getPublicUrl(): Promise<string | null> {
  const cached = cache.get<CachedValue>(CACHE_KEY_PUBLIC_URL);
  if (cached !== undefined) {
    return cached.value;
  }

  try {
    const setting = await prisma.systemSettings.findFirst({
      where: { category: "system", key: "public_url", isActive: true },
    });
    const value = setting?.value || null;
    cache.set(CACHE_KEY_PUBLIC_URL, { value });
    return value;
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : "Unknown error" }, "Failed to read public_url from DB, returning null");
    return null;
  }
}

/**
 * Check if CORS restriction is enabled. When enabled, only the public URL is allowed as an origin.
 * Returns false when not configured (permissive CORS).
 */
export async function isCorsEnabled(): Promise<boolean> {
  const cached = cache.get<CachedValue>(CACHE_KEY_CORS_ORIGIN);
  if (cached !== undefined) {
    return cached.value === "true";
  }

  try {
    const setting = await prisma.systemSettings.findFirst({
      where: { category: "system", key: "cors_enabled", isActive: true },
    });
    const value = setting?.value || null;
    cache.set(CACHE_KEY_CORS_ORIGIN, { value });
    return value === "true";
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : "Unknown error" }, "Failed to read cors_enabled from DB, returning false");
    return false;
  }
}

/**
 * Invalidate cached values. Called when settings are updated via the API.
 */
export function invalidatePublicUrlCache(): void {
  cache.del(CACHE_KEY_PUBLIC_URL);
  logger.info("public_url cache invalidated");
}

export function invalidateCorsEnabledCache(): void {
  cache.del(CACHE_KEY_CORS_ORIGIN);
  logger.info("cors_enabled cache invalidated");
}

/**
 * Check if HTTPS-only mode is enabled. When enabled, the server emits CSP
 * `upgrade-insecure-requests`, sends HSTS, and marks auth cookies `Secure`.
 * Returns false when not configured (permissive — fresh HTTP installs work).
 */
export async function isHttpsOnlyEnabled(): Promise<boolean> {
  const cached = cache.get<CachedValue>(CACHE_KEY_HTTPS_ONLY);
  if (cached !== undefined) {
    return cached.value === "true";
  }

  try {
    const setting = await prisma.systemSettings.findFirst({
      where: { category: "system", key: "https_only_mode", isActive: true },
    });
    const value = setting?.value || null;
    cache.set(CACHE_KEY_HTTPS_ONLY, { value });
    return value === "true";
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : "Unknown error" }, "Failed to read https_only_mode from DB, returning false");
    return false;
  }
}

export function invalidateHttpsOnlyCache(): void {
  cache.del(CACHE_KEY_HTTPS_ONLY);
  logger.info("https_only_mode cache invalidated");
}

/**
 * Recovery escape hatch: when `MINI_INFRA_FORCE_INSECURE=true` is set on the
 * server's environment, the Helmet dispatcher and cookie helper short-circuit
 * to insecure regardless of the DB row. Used to recover from a bricked HTTP
 * install where someone toggled HTTPS-only mode on without TLS in place.
 */
export function isForceInsecureOverride(): boolean {
  return process.env.MINI_INFRA_FORCE_INSECURE === "true";
}

/** Dev CORS origins — used when no cors_origin setting is configured in development */
const DEV_CORS_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5005",
  "http://localhost:3005",
];

/**
 * Dynamic CORS origin function for use with the `cors` middleware and Socket.IO.
 * - When CORS is enabled: only the public URL is allowed as an origin
 * - When disabled in development: dev allowlist
 * - When disabled in production: permissive (all origins allowed)
 */
export function createDynamicCorsOrigin(
  nodeEnv: string,
): (requestOrigin: string | undefined, callback: (err: Error | null, origin?: boolean | string) => void) => void {
  return async (requestOrigin, callback) => {
    try {
      const corsEnabled = await isCorsEnabled();
      if (corsEnabled) {
        const publicUrl = await getPublicUrl();
        if (publicUrl) {
          callback(null, requestOrigin === publicUrl ? publicUrl : false);
        } else {
          // CORS enabled but no public URL set — allow all (can't restrict without a URL)
          callback(null, true);
        }
      } else if (nodeEnv === "development") {
        callback(null, DEV_CORS_ORIGINS.includes(requestOrigin || "") ? true : false);
      } else {
        // CORS disabled: permissive
        callback(null, true);
      }
    } catch (err) {
      callback(err as Error);
    }
  };
}
