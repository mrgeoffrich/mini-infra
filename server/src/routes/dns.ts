import { Router, Request, Response, NextFunction } from "express";
import { requirePermission } from "../middleware/auth";
import { getLogger } from "../lib/logger-factory";
import { DnsCacheService } from "../services/dns";

const logger = getLogger("platform", "dns");
const router = Router();

/**
 * GET /api/dns/zones
 * List all cached DNS zones with record counts
 */
router.get(
  "/zones",
  requirePermission("settings:read"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dnsCacheService = DnsCacheService.getInstance();
      if (!dnsCacheService) {
        return res.status(503).json({
          success: false,
          message: "DNS cache service not initialized",
        });
      }

      const zones = await dnsCacheService.getZones();
      const lastRefreshed = await dnsCacheService.getLastRefreshedAt();

      res.json({
        success: true,
        data: {
          zones,
          lastRefreshed: lastRefreshed?.toISOString() ?? null,
        },
      });
    } catch (error) {
      logger.error({ error }, "Failed to list DNS zones");
      next(error);
    }
  }
);

/**
 * GET /api/dns/zones/:zoneId/records
 * Get cached DNS records for a specific zone
 */
router.get(
  "/zones/:zoneId/records",
  requirePermission("settings:read"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dnsCacheService = DnsCacheService.getInstance();
      if (!dnsCacheService) {
        return res.status(503).json({
          success: false,
          message: "DNS cache service not initialized",
        });
      }

      const zoneId = String(req.params.zoneId);
      const zone = await dnsCacheService.getZone(zoneId);

      if (!zone) {
        return res.status(404).json({
          success: false,
          message: "Zone not found",
        });
      }

      const records = await dnsCacheService.getRecordsForZone(zoneId);

      res.json({
        success: true,
        data: { zone, records },
      });
    } catch (error) {
      logger.error({ error }, "Failed to get DNS zone records");
      next(error);
    }
  }
);

/**
 * POST /api/dns/refresh
 * Trigger a DNS cache refresh from Cloudflare
 */
router.post(
  "/refresh",
  requirePermission("settings:write"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dnsCacheService = DnsCacheService.getInstance();
      if (!dnsCacheService) {
        return res.status(503).json({
          success: false,
          message: "DNS cache service not initialized",
        });
      }

      const result = await dnsCacheService.refreshCache();
      const lastRefreshed = await dnsCacheService.getLastRefreshedAt();

      res.json({
        success: true,
        data: {
          zonesUpdated: result.zonesUpdated,
          recordsUpdated: result.recordsUpdated,
          lastRefreshed: lastRefreshed?.toISOString() ?? new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error({ error }, "Failed to refresh DNS cache");
      next(error);
    }
  }
);

/**
 * GET /api/dns/validate/:hostname
 * Validate a hostname against cached DNS data
 */
router.get(
  "/validate/:hostname",
  requirePermission("settings:read"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dnsCacheService = DnsCacheService.getInstance();
      if (!dnsCacheService) {
        return res.status(503).json({
          success: false,
          message: "DNS cache service not initialized",
        });
      }

      const hostname = String(req.params.hostname);
      const result = await dnsCacheService.checkHostname(hostname);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error({ error }, "Failed to validate hostname DNS");
      next(error);
    }
  }
);

export default router;
