import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getLogger } from "../lib/logger-factory";
import { requirePermission, getCurrentUserId } from "../middleware/auth";
import { asyncHandler } from "../lib/async-handler";
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
import {
  Channel,
  ServerEvent,
  type OperationStep,
  Permission,
  ErrorCode,
} from "@mini-infra/types";
import { ConflictError, UnauthorizedError } from "../lib/errors";

const logger = getLogger("platform", "self-update");
const router = express.Router();

// ---------------------------------------------------------------------------
// Hardcoded update configuration
// ---------------------------------------------------------------------------

const ALLOWED_REGISTRY_PATTERN = "ghcr.io/mrgeoffrich/mini-infra:*";
const IMAGE_BASE = ALLOWED_REGISTRY_PATTERN.replace(/:\*$/, "");
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
router.get(
  "/status",
  requirePermission(Permission.SettingsRead),
  asyncHandler(async (req, res) => {
    // Recover stale updates where sidecar crashed and auto-removed
    await recoverStaleUpdate();

    // Check if an update sidecar is currently running
    const inProgress = await isUpdateInProgress();

    if (inProgress) {
      // Sidecar is running — check DB record for details
      const dbRecord = await getLatestUpdateRecord();
      if (
        dbRecord &&
        !["complete", "rollback-complete", "failed"].includes(dbRecord.state)
      ) {
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
  }),
);

/**
 * POST /check - Check if we're running in Docker and can self-update
 */
router.post(
  "/check",
  requirePermission(Permission.SettingsRead),
  asyncHandler(async (req, res) => {
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
  }),
);

/**
 * POST /trigger - Trigger a self-update to the specified tag
 *
 * Returns an operationId immediately; the sidecar pull + launch runs in the
 * background with progress emitted via Socket.IO on the SELF_UPDATE channel.
 */
router.post(
  "/trigger",
  requirePermission(Permission.SettingsWrite),
  asyncHandler(async (req, res) => {
    // Validate request body
    const { targetTag } = triggerSchema.parse(req.body);

    const userId = getCurrentUserId(req);
    if (!userId) {
      throw new UnauthorizedError(
        ErrorCode.USER_NOT_AUTHENTICATED,
        "User not authenticated",
      );
    }

    // Verify we're running in Docker
    const containerId = getOwnContainerId();
    if (!containerId) {
      throw new ConflictError(
        ErrorCode.SELF_UPDATE_CONTAINER_ID_UNKNOWN,
        "Self-update is only available when running inside Docker",
        {
          resource: { type: "selfUpdate" },
          action: "Self-update requires running inside a Docker container.",
        },
      );
    }

    // Acquire the launch mutex BEFORE any async work to close the
    // TOCTOU race window between concurrent trigger requests.
    if (!acquireLaunchLock()) {
      throw new ConflictError(
        ErrorCode.SELF_UPDATE_IN_PROGRESS,
        "An update is already in progress",
        {
          resource: { type: "selfUpdate" },
          action:
            "Wait for the current update to finish before starting another.",
        },
      );
    }

    let iifeSpawned = false;
    try {
      // Double-check via Docker that no sidecar container is running
      const inProgress = await isUpdateInProgress();
      if (inProgress) {
        throw new ConflictError(
          ErrorCode.SELF_UPDATE_IN_PROGRESS,
          "An update is already in progress",
          {
            resource: { type: "selfUpdate" },
            action:
              "Wait for the current update to finish before starting another.",
          },
        );
      }

      const fullImageRef = `${IMAGE_BASE}:${targetTag}`;
      const sidecarImage = `${IMAGE_BASE}-sidecar:${targetTag}`;
      const agentSidecarImage = `${IMAGE_BASE}-agent-sidecar:${targetTag}`;
      const egressFwAgentImage = `${IMAGE_BASE}-egress-fw-agent:${targetTag}`;

      // Run the sidecar using the current (known-good) version rather than
      // the target version, so a broken sidecar in a new release can't
      // brick the update process. Falls back to target tag in dev mode.
      // BUILD_VERSION includes the "v" prefix (e.g. "v1.4.5") but image
      // tags do not (e.g. "1.4.5"), so strip it.
      const currentVersion = process.env.BUILD_VERSION?.replace(/^v/, "");
      const sidecarRunImage =
        currentVersion && currentVersion !== "dev"
          ? `${IMAGE_BASE}-sidecar:${currentVersion}`
          : undefined;

      logger.info(
        {
          targetTag,
          fullImageRef,
          sidecarImage,
          sidecarRunImage: sidecarRunImage ?? sidecarImage,
          agentSidecarImage,
          egressFwAgentImage,
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
        const steps: OperationStep[] = [];

        try {
          emitToChannel(
            Channel.SELF_UPDATE,
            ServerEvent.SELF_UPDATE_LAUNCH_STARTED,
            {
              operationId,
              totalSteps,
              stepNames: [...stepNames],
              targetTag,
            },
          );

          const sidecarId = await launchSidecar({
            fullImageRef,
            allowedRegistryPattern: ALLOWED_REGISTRY_PATTERN,
            sidecarImage,
            sidecarRunImage,
            agentSidecarImage,
            egressFwAgentImage,
            gracefulStopSeconds: GRACEFUL_STOP_SECONDS,
            onProgress: (step, completedCount, total) => {
              steps.push(step);
              try {
                emitToChannel(
                  Channel.SELF_UPDATE,
                  ServerEvent.SELF_UPDATE_LAUNCH_STEP,
                  {
                    operationId,
                    step,
                    completedCount,
                    totalSteps: total,
                  },
                );
              } catch {
                /* never break launch */
              }
            },
          });

          // Update the record with the sidecar container ID
          await updateUpdateRecordSidecarId(updateId, sidecarId);

          emitToChannel(
            Channel.SELF_UPDATE,
            ServerEvent.SELF_UPDATE_LAUNCH_COMPLETED,
            {
              operationId,
              success: true,
              steps,
              errors: [],
            },
          );
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
          } catch {
            /* best-effort DB update */
          }

          emitToChannel(
            Channel.SELF_UPDATE,
            ServerEvent.SELF_UPDATE_LAUNCH_COMPLETED,
            {
              operationId,
              success: false,
              steps,
              errors: [message],
            },
          );
        }
      })();
    } finally {
      // Release the lock only if the background IIFE was never spawned
      // (early return / validation error, including the taxonomy errors
      // thrown above). If it WAS spawned, launchSidecar() releases the lock
      // in its own finally block.
      if (!iifeSpawned) releaseLaunchLock();
    }
  }),
);

export default router;
