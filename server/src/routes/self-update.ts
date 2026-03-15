import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import appConfig from "../lib/config-new";
import { requirePermission, getCurrentUserId } from "../middleware/auth";
import prisma from "../lib/prisma";
import {
  launchSidecar,
  isUpdateInProgress,
  getOwnContainerId,
  createUpdateRecord,
  updateUpdateRecordSidecarId,
  getLatestUpdateRecord,
  acquireLaunchLock,
  releaseLaunchLock,
  recoverStaleUpdate,
  SELF_UPDATE_LAUNCH_STEPS,
  type SelfUpdateStatus,
} from "../services/self-update";
import { emitToChannel } from "../lib/socket";
import { Channel, ServerEvent } from "@mini-infra/types";

const logger = appLogger();
const router = express.Router();

// ---------------------------------------------------------------------------
// Hardcoded update configuration
// ---------------------------------------------------------------------------

const ALLOWED_REGISTRY_PATTERN = "ghcr.io/mrgeoffrich/mini-infra:*";
const IMAGE_BASE = ALLOWED_REGISTRY_PATTERN.replace(/:\*$/, "");
const HEALTH_CHECK_TIMEOUT_MS = 180000; // 3 minutes
const GRACEFUL_STOP_SECONDS = 30;

// Validation schema for trigger request
const triggerSchema = z.object({
  targetTag: z
    .string()
    .min(1, "Target tag is required")
    .max(128, "Target tag too long")
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
      "Invalid tag format. Enter just the tag (e.g. v2.1.0), not a full image reference.",
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
    // Recover stale updates where sidecar crashed and auto-removed
    await recoverStaleUpdate();

    // Check if an update sidecar is currently running
    const inProgress = await isUpdateInProgress();

    if (inProgress) {
      // Sidecar is running — check DB record for details
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
        status: { state: "pending" } as SelfUpdateStatus,
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

    res.json({
      success: true,
      available: true,
      containerId,
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
 *
 * Returns an operationId immediately; the sidecar pull + launch runs in the
 * background with progress emitted via Socket.IO on the SELF_UPDATE channel.
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

      // Acquire the launch mutex BEFORE any async work to close the
      // TOCTOU race window between concurrent trigger requests.
      if (!acquireLaunchLock()) {
        return res.status(409).json({
          success: false,
          error: "An update is already in progress",
        });
      }

      let iifeSpawned = false;
      try {
        // Double-check via Docker that no sidecar container is running
        const inProgress = await isUpdateInProgress();
        if (inProgress) {
          return res.status(409).json({
            success: false,
            error: "An update is already in progress",
          });
        }

        const fullImageRef = `${IMAGE_BASE}:${targetTag}`;
        const sidecarImage = `${IMAGE_BASE}-sidecar:${targetTag}`;
        const agentSidecarImage = `${IMAGE_BASE}-agent-sidecar:${targetTag}`;
        const containerPort = appConfig.server.port;

        logger.info(
          {
            targetTag,
            fullImageRef,
            sidecarImage,
            agentSidecarImage,
            containerId,
          },
          "Self-update triggered",
        );

        // Persist to DB BEFORE launching the sidecar so the record exists
        // even if the process crashes between launch and the response.
        const updateId = await createUpdateRecord({
          targetTag,
          fullImageRef,
          triggeredBy: userId,
        });

        const operationId = randomUUID();
        const stepNames = [...SELF_UPDATE_LAUNCH_STEPS];
        const totalSteps = stepNames.length;

        // Return immediately with operationId
        res.status(202).json({
          success: true,
          message: "Update initiated. The server will restart shortly.",
          updateId,
          operationId,
          targetTag,
        });

        // Run sidecar launch in background with Socket.IO progress.
        // launchSidecar() releases the lock in its own finally block.
        iifeSpawned = true;
        const launchStartTime = Date.now();
        (async () => {
          const steps: Array<{ step: string; status: "completed" | "failed" | "skipped"; detail?: string }> = [];

          try {
            emitToChannel(Channel.SELF_UPDATE, ServerEvent.SELF_UPDATE_LAUNCH_STARTED, {
              operationId,
              totalSteps,
              stepNames: [...stepNames],
              targetTag,
            });

            const sidecarId = await launchSidecar({
              fullImageRef,
              allowedRegistryPattern: ALLOWED_REGISTRY_PATTERN,
              sidecarImage,
              agentSidecarImage,
              containerPort,
              healthCheckTimeoutMs: HEALTH_CHECK_TIMEOUT_MS,
              gracefulStopSeconds: GRACEFUL_STOP_SECONDS,
              onProgress: (step, completedCount, total) => {
                steps.push(step);
                try {
                  emitToChannel(Channel.SELF_UPDATE, ServerEvent.SELF_UPDATE_LAUNCH_STEP, {
                    operationId,
                    step,
                    completedCount,
                    totalSteps: total,
                  });
                } catch { /* never break launch */ }
              },
            });

            // Update the record with the sidecar container ID
            await updateUpdateRecordSidecarId(updateId, sidecarId);

            emitToChannel(Channel.SELF_UPDATE, ServerEvent.SELF_UPDATE_LAUNCH_COMPLETED, {
              operationId,
              success: true,
              steps,
              errors: [],
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error({ err }, "Self-update sidecar launch failed");

            // Mark the DB record as failed so the UI doesn't spin forever
            try {
              await prisma.selfUpdate.update({
                where: { id: updateId },
                data: {
                  state: "failed",
                  errorMessage: message,
                  completedAt: new Date(),
                  durationMs: Date.now() - launchStartTime,
                },
              });
            } catch { /* best-effort DB update */ }

            emitToChannel(Channel.SELF_UPDATE, ServerEvent.SELF_UPDATE_LAUNCH_COMPLETED, {
              operationId,
              success: false,
              steps,
              errors: [message],
            });
          }
        })();
      } finally {
        // Release the lock only if the background IIFE was never spawned
        // (early return / validation error). If it WAS spawned, launchSidecar()
        // releases the lock in its own finally block.
        if (!iifeSpawned) releaseLaunchLock();
      }
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
        error: errorMessage,
      });
    }
  },
);

export default router;
