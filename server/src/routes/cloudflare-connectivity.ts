import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requireSessionOrApiKey } from "../middleware/auth";
import prisma from "../lib/prisma";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();

const router = Router();

// Response cache implementation
interface CacheEntry {
  data: any;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

function getCachedResponse(key: string): any | null {
  const entry = cache.get(key);
  if (!entry) return null;

  const now = Date.now();
  if (now - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }

  return entry.data;
}

function setCachedResponse(key: string, data: any): void {
  cache.set(key, {
    data,
    timestamp: Date.now(),
  });
}

// Validation schemas
const historyQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 20)),
  offset: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 0)),
  status: z.enum(["connected", "failed", "timeout", "unreachable"]).optional(),
});


router.get(
  "/cloudflare",
  requireSessionOrApiKey,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = "cloudflare-connectivity-latest";
      const cached = getCachedResponse(cacheKey);

      if (cached) {
        logger.debug(
          {
            requestId: res.locals.requestId,
            cache: "hit",
          },
          "Returning cached Cloudflare connectivity status",
        );
        return res.json(cached);
      }

      // Get the latest connectivity status from database
      const latestStatus = await prisma.connectivityStatus.findFirst({
        where: {
          service: "cloudflare",
        },
        orderBy: {
          checkedAt: "desc",
        },
      });

      if (!latestStatus) {
        return res.status(404).json({
          error: "No connectivity status found for Cloudflare",
          service: "cloudflare",
        });
      }

      // Parse metadata if it's a string
      const metadata =
        typeof latestStatus.metadata === "string"
          ? JSON.parse(latestStatus.metadata)
          : latestStatus.metadata;

      const response = {
        id: latestStatus.id,
        service: latestStatus.service,
        status: latestStatus.status,
        message: latestStatus.errorMessage || null,
        metadata,
        checkedAt: latestStatus.checkedAt.toISOString(),
        responseTime: latestStatus.responseTimeMs
          ? Number(latestStatus.responseTimeMs)
          : null,
      };

      setCachedResponse(cacheKey, response);

      logger.debug(
        {
          requestId: res.locals.requestId,
          service: "cloudflare",
          status: latestStatus.status,
        },
        "Retrieved Cloudflare connectivity status",
      );

      res.json(response);
    } catch (error) {
      logger.error(
        {
          requestId: res.locals.requestId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get Cloudflare connectivity status",
      );
      next(error);
    }
  },
);


router.get(
  "/cloudflare/history",
  requireSessionOrApiKey,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate query parameters
      const queryResult = historyQuerySchema.safeParse(req.query);

      if (!queryResult.success) {
        return res.status(400).json({
          error: "Invalid query parameters",
          details: queryResult.error.flatten(),
        });
      }

      const { limit, offset, status } = queryResult.data;
      const cacheKey = `cloudflare-connectivity-history-${limit}-${offset}-${status || "all"}`;
      const cached = getCachedResponse(cacheKey);

      if (cached) {
        logger.debug(
          {
            requestId: res.locals.requestId,
            cache: "hit",
            limit,
            offset,
          },
          "Returning cached Cloudflare connectivity history",
        );
        return res.json(cached);
      }

      // Build where clause
      const where: any = {
        service: "cloudflare",
      };

      if (status) {
        where.status = status;
      }

      // Get total count for pagination
      const totalCount = await prisma.connectivityStatus.count({ where });

      // Get historical data with pagination
      const history = await prisma.connectivityStatus.findMany({
        where,
        orderBy: {
          checkedAt: "desc",
        },
        skip: offset,
        take: limit,
      });

      // Transform the data
      const transformedHistory = history.map((item: any) => {
        const metadata =
          typeof item.metadata === "string"
            ? JSON.parse(item.metadata)
            : item.metadata;

        return {
          id: item.id,
          service: item.service,
          status: item.status,
          message: item.errorMessage || null,
          metadata,
          checkedAt: item.checkedAt.toISOString(),
          responseTime: item.responseTimeMs
            ? Number(item.responseTimeMs)
            : null,
        };
      });

      const response = {
        data: transformedHistory,
        pagination: {
          total: totalCount,
          limit,
          offset,
          hasMore: offset + limit < totalCount,
        },
      };

      setCachedResponse(cacheKey, response);

      logger.debug(
        {
          requestId: res.locals.requestId,
          service: "cloudflare",
          recordCount: transformedHistory.length,
          totalCount,
          limit,
          offset,
        },
        "Retrieved Cloudflare connectivity history",
      );

      res.json(response);
    } catch (error) {
      logger.error(
        {
          requestId: res.locals.requestId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get Cloudflare connectivity history",
      );
      next(error);
    }
  },
);

export default router;
