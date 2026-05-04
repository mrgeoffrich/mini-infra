import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/auth";
import prisma from "../lib/prisma";
import { getLogger } from "../lib/logger-factory";
import { CONNECTIVITY_STATUS_TYPES } from "@mini-infra/types";

const logger = getLogger("integrations", "tailscale-connectivity");

const router = Router();

interface CacheEntry {
  data: unknown;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000;

function getCachedResponse(key: string): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedResponse(key: string, data: unknown): void {
  cache.set(key, { data, timestamp: Date.now() });
}

const historyQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 20)),
  offset: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 0)),
  status: z.enum(CONNECTIVITY_STATUS_TYPES).optional(),
});

router.get(
  "/tailscale",
  requirePermission("settings:read"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = "tailscale-connectivity-latest";
      const cached = getCachedResponse(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const latestStatus = await prisma.connectivityStatus.findFirst({
        where: { service: "tailscale" },
        orderBy: { checkedAt: "desc" },
      });

      if (!latestStatus) {
        return res.status(404).json({
          error: "No connectivity status found for Tailscale",
          service: "tailscale",
        });
      }

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
      res.json(response);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown" },
        "Failed to get Tailscale connectivity status",
      );
      next(error);
    }
  },
);

router.get(
  "/tailscale/history",
  requirePermission("settings:read"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const queryResult = historyQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        return res.status(400).json({
          error: "Invalid query parameters",
          details: queryResult.error.flatten(),
        });
      }

      const { limit, offset, status } = queryResult.data;
      const cacheKey = `tailscale-connectivity-history-${limit}-${offset}-${status || "all"}`;
      const cached = getCachedResponse(cacheKey);
      if (cached) return res.json(cached);

      const where: Record<string, unknown> = { service: "tailscale" };
      if (status) where.status = status;

      const totalCount = await prisma.connectivityStatus.count({ where });
      const history = await prisma.connectivityStatus.findMany({
        where,
        orderBy: { checkedAt: "desc" },
        skip: offset,
        take: limit,
      });

      const transformedHistory = history.map((item) => ({
        id: item.id,
        service: item.service,
        status: item.status,
        message: item.errorMessage || null,
        metadata:
          typeof item.metadata === "string"
            ? JSON.parse(item.metadata)
            : item.metadata,
        checkedAt: item.checkedAt.toISOString(),
        responseTime: item.responseTimeMs
          ? Number(item.responseTimeMs)
          : null,
      }));

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
      res.json(response);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown" },
        "Failed to get Tailscale connectivity history",
      );
      next(error);
    }
  },
);

export default router;
