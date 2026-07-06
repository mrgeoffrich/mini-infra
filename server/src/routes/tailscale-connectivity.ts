import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/auth";
import prisma from "../lib/prisma";
import { getLogger } from "../lib/logger-factory";
import {
  CONNECTIVITY_STATUS_TYPES,
  Permission,
  TAILSCALE_INGRESS_DEFAULT_HOSTNAME,
  TAILSCALE_INGRESS_TEMPLATE_NAME,
  type TailscaleDeviceStatus,
  type TailscaleIngressStatus,
} from "@mini-infra/types";
import { TailscaleService } from "../services/tailscale/tailscale-service";

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
  requirePermission(Permission.SettingsRead),
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
  requirePermission(Permission.SettingsRead),
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

// Dedicated short-TTL cache for the ingress status. The 5-min connectivity
// cache above is too coarse for the deploy-validate loop, where the operator
// is watching for the device to come online — but we still don't want to hit
// the Tailscale device-list API on every poll. 10s keeps it fresh and cheap.
let ingressStatusCache: { data: TailscaleIngressStatus; timestamp: number } | null = null;
const INGRESS_CACHE_TTL = 10 * 1000;

/**
 * Status of the Tailscale ingress that fronts Mini Infra's own control plane.
 * Combines the deployed stack's hostname parameter, the resolved tailnet
 * domain, and whether the ingress device is online — everything the Network
 * Access page needs to validate and adopt the tailnet URL as the Public URL.
 */
router.get(
  "/tailscale/ingress",
  requirePermission(Permission.SettingsRead),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (ingressStatusCache && Date.now() - ingressStatusCache.timestamp < INGRESS_CACHE_TTL) {
        return res.json(ingressStatusCache.data);
      }

      // Resolve the hostname the ingress was actually deployed with (operators
      // can override the `hostname` param); fall back to the template default.
      const stack = await prisma.stack.findFirst({
        where: { environmentId: null, template: { name: TAILSCALE_INGRESS_TEMPLATE_NAME } },
        select: { parameterValues: true },
      });
      const paramValues = (stack?.parameterValues ?? {}) as Record<string, unknown>;
      const hostname =
        typeof paramValues.hostname === "string" && paramValues.hostname.length > 0
          ? paramValues.hostname
          : TAILSCALE_INGRESS_DEFAULT_HOSTNAME;

      const service = new TailscaleService(prisma);
      const clientId = await service.getClientId();

      // Not configured — return a clean unconfigured shape rather than 500 so
      // the page renders its "configure Tailscale first" guidance.
      if (!clientId) {
        const resp: TailscaleIngressStatus = {
          configured: false,
          hostname,
          tailnetDomain: null,
          ingressUrl: null,
          deviceOnline: false,
          deviceName: null,
        };
        ingressStatusCache = { data: resp, timestamp: Date.now() };
        return res.json(resp);
      }

      let tailnetDomain: string | null = null;
      let device: TailscaleDeviceStatus | undefined;
      try {
        const [domain, devices] = await Promise.all([
          service.getTailnetDomain(),
          service.listDevices(),
        ]);
        tailnetDomain = domain;
        device = devices.find((d) => d.hostname === hostname);
      } catch (err) {
        // Best-effort: a tailnet API blip shouldn't 500 the status page. Report
        // configured-but-unresolved so the UI shows "pending" rather than error.
        logger.warn(
          { error: err instanceof Error ? err.message : "Unknown", hostname },
          "Failed to query tailnet for ingress status",
        );
      }

      // Prefer the device's own MagicDNS name (handles tailnet auto-suffixing
      // on hostname collisions); fall back to the predicted host.tailnet form.
      const ingressUrl = device?.name
        ? `https://${device.name}`
        : tailnetDomain
          ? `https://${hostname}.${tailnetDomain}`
          : null;

      const resp: TailscaleIngressStatus = {
        configured: true,
        hostname,
        tailnetDomain,
        ingressUrl,
        deviceOnline: device?.online ?? false,
        deviceName: device?.name ?? null,
      };
      ingressStatusCache = { data: resp, timestamp: Date.now() };
      res.json(resp);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown" },
        "Failed to get Tailscale ingress status",
      );
      next(error);
    }
  },
);

export default router;
