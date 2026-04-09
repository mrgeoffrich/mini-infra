import NodeCache from "node-cache";
import prisma from "./prisma";
import { servicesLogger } from "./logger-factory";

const logger = servicesLogger();

// 30-minute TTL, check for expired keys every 2 minutes
const cache = new NodeCache({ stdTTL: 1800, checkperiod: 120 });

const CACHE_KEY_PUBLIC_URL = "public_url";
const CACHE_KEY_CORS_ORIGIN = "cors_origin";

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
          callback(null, requestOrigin === publicUrl ? publicUrl : false as any);
        } else {
          // CORS enabled but no public URL set — allow all (can't restrict without a URL)
          callback(null, true);
        }
      } else if (nodeEnv === "development") {
        callback(null, DEV_CORS_ORIGINS.includes(requestOrigin || "") ? true : false as any);
      } else {
        // CORS disabled: permissive
        callback(null, true);
      }
    } catch (err) {
      callback(err as Error);
    }
  };
}
