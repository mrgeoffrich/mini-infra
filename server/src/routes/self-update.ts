import express from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requirePermission, getCurrentUserId } from "../middleware/auth";
import prisma from "../lib/prisma";
import {
  launchSidecar,
  isUpdateInProgress,
  readSidecarStatus,
  getOwnContainerId,
  createUpdateRecord,
  getLatestUpdateRecord,
  type SelfUpdateStatus,
} from "../services/self-update";

const logger = appLogger();
const router = express.Router();

// Validation schema for trigger request
const triggerSchema = z.object({
  targetTag: z
    .string()
    .min(1, "Target tag is required")
    .max(256, "Target tag too long")
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._\-/:]*$/,
      "Invalid image tag format",
    ),
});

/**
 * GET /status - Get current self-update status
 *
 * Priority order:
 * 1. Live sidecar status (if a sidecar is running)
 * 2. Most recent DB record (persists across restarts)
 * 3. Idle
 */
router.get("/status", requirePermission("settings:read"), async (req, res) => {
  try {
    // Check if an update sidecar is currently running
    const inProgress = await isUpdateInProgress();

    if (inProgress) {
      // Try to read live status from the sidecar
      const sidecarStatus = await readSidecarStatus();
      if (sidecarStatus) {
        return res.json({ success: true, status: sidecarStatus });
      }

      // Sidecar is running but status not available yet — check DB record
      const dbRecord = await getLatestUpdateRecord();
      if (dbRecord && !["complete", "rollback-complete", "failed"].includes(dbRecord.state)) {
        return res.json({
          success: true,
          status: {
            state: dbRecord.state,
            targetTag: dbRecord.targetTag,
            progress: dbRecord.progress,
            startedAt: dbRecord.startedAt.toISOString(),
          } as SelfUpdateStatus,
        });
      }

      // Fallback: sidecar exists but no details available
      return res.json({
        success: true,
        status: { state: "pulling" } as SelfUpdateStatus,
      });
    }

    // No sidecar running — return latest DB record or idle
    const dbRecord = await getLatestUpdateRecord();
    if (dbRecord) {
      return res.json({
        success: true,
        status: {
          state: dbRecord.state,
          targetTag: dbRecord.targetTag,
          progress: dbRecord.progress,
          error: dbRecord.errorMessage,
          startedAt: dbRecord.startedAt.toISOString(),
          updatedAt: dbRecord.completedAt?.toISOString(),
        } as SelfUpdateStatus,
      });
    }

    res.json({ success: true, status: { state: "idle" } as SelfUpdateStatus });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error({ error: errorMessage }, "Failed to get self-update status");
    res.status(500).json({
      success: false,
      error: "Failed to get update status",
    });
  }
});

/**
 * POST /check - Check if we're running in Docker and can self-update
 */
router.post("/check", requirePermission("settings:read"), async (req, res) => {
  try {
    const containerId = getOwnContainerId();

    if (!containerId) {
      return res.json({
        success: true,
        available: false,
        reason: "Not running inside a Docker container",
      });
    }

    // Read configured registry pattern from settings
    const registrySetting = await prisma.systemSettings.findUnique({
      where: {
        category_key: {
          category: "self-update",
          key: "allowed_registry_pattern",
        },
      },
    });

    res.json({
      success: true,
      available: true,
      containerId,
      configured: !!registrySetting?.value,
      allowedRegistryPattern: registrySetting?.value ?? null,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error({ error: errorMessage }, "Failed to check update availability");
    res.status(500).json({
      success: false,
      error: "Failed to check update availability",
    });
  }
});

/**
 * POST /trigger - Trigger a self-update to the specified tag
 */
router.post(
  "/trigger",
  requirePermission("settings:write"),
  async (req, res) => {
    try {
      // Validate request body
      const { targetTag } = triggerSchema.parse(req.body);

      const userId = getCurrentUserId(req);
      if (!userId) {
        return res.status(401).json({
          success: false,
          error: "User not authenticated",
        });
      }

      // Verify we're running in Docker
      const containerId = getOwnContainerId();
      if (!containerId) {
        return res.status(400).json({
          success: false,
          error: "Self-update is only available when running inside Docker",
        });
      }

      // Check for existing update
      const inProgress = await isUpdateInProgress();
      if (inProgress) {
        return res.status(409).json({
          success: false,
          error: "An update is already in progress",
        });
      }

      // Load configuration from settings
      const settings = await prisma.systemSettings.findMany({
        where: {
          category: "self-update",
          isActive: true,
        },
      });
      const settingsMap = new Map(settings.map((s) => [s.key, s.value]));

      const allowedRegistryPattern = settingsMap.get(
        "allowed_registry_pattern",
      );
      if (!allowedRegistryPattern) {
        return res.status(400).json({
          success: false,
          error:
            "Self-update not configured. Set allowed_registry_pattern in self-update settings.",
        });
      }

      const sidecarImage =
        settingsMap.get("sidecar_image") ||
        process.env.SIDECAR_IMAGE_TAG ||
        null;
      if (!sidecarImage) {
        return res.status(400).json({
          success: false,
          error:
            "Sidecar image not configured. Set sidecar_image in self-update settings.",
        });
      }

      const healthCheckUrl =
        settingsMap.get("health_check_url") ?? "http://localhost:5000/health";
      const healthCheckTimeoutMs = parseInt(
        settingsMap.get("health_check_timeout_ms") ?? "60000",
        10,
      );
      const gracefulStopSeconds = parseInt(
        settingsMap.get("graceful_stop_seconds") ?? "30",
        10,
      );

      // Build the full image ref for DB record
      const fullImageRef = targetTag.includes(":")
        ? targetTag
        : `${targetTag}:latest`;

      logger.info(
        {
          targetTag,
          fullImageRef,
          allowedRegistryPattern,
          sidecarImage,
          containerId,
        },
        "Self-update triggered",
      );

      // Launch the sidecar — this is a fire-and-forget operation.
      // The sidecar will stop this container, so we respond immediately.
      const sidecarId = await launchSidecar({
        targetTag,
        allowedRegistryPattern,
        sidecarImage,
        healthCheckUrl,
        healthCheckTimeoutMs,
        gracefulStopSeconds,
      });

      // Persist to DB so the new container knows an update was triggered
      const updateId = await createUpdateRecord({
        targetTag,
        fullImageRef,
        sidecarId,
        triggeredBy: userId,
      });

      res.status(202).json({
        success: true,
        message: "Update initiated. The server will restart shortly.",
        updateId,
        sidecarId,
        targetTag,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: error.issues,
        });
      }

      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Client errors: image validation failures, not-in-Docker, already in progress
      const isClientError =
        errorMessage.includes("does not match allowed registry") ||
        errorMessage.includes("only available when running inside Docker") ||
        errorMessage.includes("already in progress") ||
        errorMessage.includes("Cannot determine own container ID");

      if (isClientError) {
        return res.status(400).json({
          success: false,
          error: errorMessage,
        });
      }

      logger.error({ error: errorMessage }, "Failed to trigger self-update");
      res.status(500).json({
        success: false,
        error: "Failed to trigger self-update",
      });
    }
  },
);

/**
 * GET /config - Get self-update configuration
 */
router.get("/config", requirePermission("settings:read"), async (req, res) => {
  try {
    const settings = await prisma.systemSettings.findMany({
      where: {
        category: "self-update",
        isActive: true,
      },
    });

    const settingsMap = new Map(settings.map((s) => [s.key, s.value]));

    res.json({
      success: true,
      config: {
        allowedRegistryPattern:
          settingsMap.get("allowed_registry_pattern") ?? null,
        sidecarImage:
          settingsMap.get("sidecar_image") ||
          process.env.SIDECAR_IMAGE_TAG ||
          null,
        healthCheckUrl:
          settingsMap.get("health_check_url") ?? "http://localhost:5000/health",
        healthCheckTimeoutMs: parseInt(
          settingsMap.get("health_check_timeout_ms") ?? "60000",
          10,
        ),
        gracefulStopSeconds: parseInt(
          settingsMap.get("graceful_stop_seconds") ?? "30",
          10,
        ),
      },
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error(
      { error: errorMessage },
      "Failed to get self-update configuration",
    );
    res.status(500).json({
      success: false,
      error: "Failed to get self-update configuration",
    });
  }
});

// Validation schema for config update
const configSchema = z.object({
  allowedRegistryPattern: z
    .string()
    .min(1, "Allowed registry pattern is required"),
  sidecarImage: z.string().min(1, "Sidecar image is required"),
  healthCheckUrl: z.string().url("Must be a valid URL").optional(),
  healthCheckTimeoutMs: z.number().int().min(5000).max(300000).optional(),
  gracefulStopSeconds: z.number().int().min(5).max(120).optional(),
});

/**
 * PUT /config - Update self-update configuration
 */
router.put(
  "/config",
  requirePermission("settings:write"),
  async (req, res) => {
    try {
      const validated = configSchema.parse(req.body);
      const userId = getCurrentUserId(req);
      if (!userId) {
        return res.status(401).json({
          success: false,
          error: "User not authenticated",
        });
      }

      const settingsToUpdate = [
        {
          key: "allowed_registry_pattern",
          value: validated.allowedRegistryPattern,
        },
        { key: "sidecar_image", value: validated.sidecarImage },
        {
          key: "health_check_url",
          value: validated.healthCheckUrl ?? "http://localhost:5000/health",
        },
        {
          key: "health_check_timeout_ms",
          value: String(validated.healthCheckTimeoutMs ?? 60000),
        },
        {
          key: "graceful_stop_seconds",
          value: String(validated.gracefulStopSeconds ?? 30),
        },
      ];

      for (const setting of settingsToUpdate) {
        await prisma.systemSettings.upsert({
          where: {
            category_key: {
              category: "self-update",
              key: setting.key,
            },
          },
          create: {
            category: "self-update",
            key: setting.key,
            value: setting.value,
            isEncrypted: false,
            isActive: true,
            createdBy: userId,
            updatedBy: userId,
          },
          update: {
            value: setting.value,
            updatedBy: userId,
            updatedAt: new Date(),
          },
        });
      }

      logger.info(
        {
          allowedRegistryPattern: validated.allowedRegistryPattern,
          sidecarImage: validated.sidecarImage,
        },
        "Self-update configuration updated",
      );

      res.json({
        success: true,
        message: "Self-update configuration updated successfully",
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: error.issues,
        });
      }

      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(
        { error: errorMessage },
        "Failed to update self-update configuration",
      );
      res.status(500).json({
        success: false,
        error: "Failed to update configuration",
      });
    }
  },
);

export default router;
