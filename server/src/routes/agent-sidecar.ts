import express from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requirePermission, getCurrentUserId } from "../middleware/auth";
import prisma from "../lib/prisma";
import { getOwnContainerId } from "../services/self-update";
import {
  getAgentSidecarUrl,
  isAgentSidecarHealthy,
  proxyToSidecar,
  restartAgentSidecar,
  findAgentSidecar,
  getAgentSidecarConfig,
} from "../services/agent-sidecar";

const logger = appLogger();
const router = express.Router();

const SETTINGS_CATEGORY = "agent-sidecar";

const configSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.string().min(1).max(100).optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(10000).max(600000).optional(),
  autoStart: z.boolean().optional(),
  image: z.string().min(1).max(500).optional(),
});

// ---------------------------------------------------------------------------
// GET /status — agent sidecar health/status
// ---------------------------------------------------------------------------

router.get(
  "/status",
  requirePermission("agent:read"),
  async (_req: express.Request, res: express.Response) => {
    try {
      const containerId = getOwnContainerId();
      if (!containerId) {
        res.json({
          success: true,
          available: false,
          reason: "Not running inside a Docker container",
          containerRunning: false,
          health: null,
        });
        return;
      }

      const sidecarUrl = getAgentSidecarUrl();
      const existing = await findAgentSidecar();
      const healthy = isAgentSidecarHealthy();

      let health = null;
      if (sidecarUrl && healthy) {
        try {
          const response = await proxyToSidecar("/health", { method: "GET" });
          if (response.ok) {
            health = await response.json();
          }
        } catch {
          // Sidecar unreachable
        }
      }

      res.json({
        success: true,
        available: !!sidecarUrl && healthy,
        containerRunning: existing?.state === "running",
        containerId: existing?.id?.slice(0, 12) ?? null,
        health,
      });
    } catch (err) {
      logger.error({ err }, "Failed to get agent sidecar status");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /restart — restart the agent sidecar
// ---------------------------------------------------------------------------

router.post(
  "/restart",
  requirePermission("agent:write"),
  async (_req: express.Request, res: express.Response) => {
    try {
      const result = await restartAgentSidecar();
      if (!result) {
        res.status(503).json({
          success: false,
          error: "Failed to restart agent sidecar",
          message:
            "The sidecar could not be started. Check settings and Docker availability.",
        });
        return;
      }

      res.json({
        success: true,
        containerId: result.containerId.slice(0, 12),
        url: result.url,
      });
    } catch (err) {
      logger.error({ err }, "Failed to restart agent sidecar");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /config — get agent sidecar configuration
// ---------------------------------------------------------------------------

router.get(
  "/config",
  requirePermission("settings:read"),
  async (_req: express.Request, res: express.Response) => {
    try {
      const config = await getAgentSidecarConfig();
      res.json({ success: true, config });
    } catch (err) {
      logger.error({ err }, "Failed to get agent sidecar config");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /config — update agent sidecar configuration
// ---------------------------------------------------------------------------

router.put(
  "/config",
  requirePermission("settings:write"),
  async (req: express.Request, res: express.Response) => {
    try {
      const parsed = configSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({
            success: false,
            error: "Validation error",
            details: parsed.error.issues,
          });
        return;
      }

      const userId = getCurrentUserId(req);
      if (!userId) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
      }

      const updates = parsed.data;
      const settingEntries: Array<{ key: string; value: string }> = [];

      if (updates.enabled !== undefined)
        settingEntries.push({
          key: "enabled",
          value: String(updates.enabled),
        });
      if (updates.model !== undefined)
        settingEntries.push({ key: "model", value: updates.model });
      if (updates.maxTurns !== undefined)
        settingEntries.push({
          key: "max_turns",
          value: String(updates.maxTurns),
        });
      if (updates.timeoutMs !== undefined)
        settingEntries.push({
          key: "timeout_ms",
          value: String(updates.timeoutMs),
        });
      if (updates.autoStart !== undefined)
        settingEntries.push({
          key: "auto_start",
          value: String(updates.autoStart),
        });
      if (updates.image !== undefined)
        settingEntries.push({ key: "image", value: updates.image });

      for (const { key, value } of settingEntries) {
        await prisma.systemSettings.upsert({
          where: {
            category_key: { category: SETTINGS_CATEGORY, key },
          },
          create: {
            category: SETTINGS_CATEGORY,
            key,
            value,
            createdBy: userId,
            updatedBy: userId,
          },
          update: {
            value,
            updatedBy: userId,
          },
        });
      }

      const config = await getAgentSidecarConfig();
      res.json({ success: true, config });
    } catch (err) {
      logger.error({ err }, "Failed to update agent sidecar config");
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

export default router;
