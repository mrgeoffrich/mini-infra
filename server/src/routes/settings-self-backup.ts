import express from "express";
import prisma from "../lib/prisma";
import { appLogger } from "../lib/logger-factory";
import { requirePermission, getCurrentUserId } from "../middleware/auth";
import { z } from "zod";
import { SelfBackupScheduler, SelfBackupExecutor } from "../services/backup";
import type {
  SelfBackupConfigResponse,
  UpdateSelfBackupConfigRequest,
  TriggerBackupResponse,
} from "@mini-infra/types";

const logger = appLogger();
const router = express.Router();

// Validation schema for configuration update
const configSchema = z.object({
  cronSchedule: z.string().min(1, "Cron schedule is required"),
  azureContainerName: z.string().min(1, "Azure container is required"),
  timezone: z.string().min(1, "Timezone is required"),
});

/**
 * GET / - Get current self-backup configuration
 */
router.get("/", requirePermission('backups:read'), async (req, res) => {
  try {
    // Load configuration from database
    const settings = await prisma.systemSettings.findMany({
      where: {
        category: "self-backup",
        isActive: true,
      },
    });

    if (settings.length === 0) {
      const response: SelfBackupConfigResponse = {
        success: true,
        config: null,
        scheduleInfo: null,
      };
      return res.json(response);
    }

    const settingsMap = new Map(settings.map(s => [s.key, s.value]));

    const config = {
      cronSchedule: settingsMap.get("cron_schedule") || "0 * * * *",
      azureContainerName: settingsMap.get("azure_container_name") || "",
      timezone: settingsMap.get("timezone") || "UTC",
      enabled: settingsMap.get("enabled") === "true",
    };

    // Get schedule info from scheduler
    const scheduler = SelfBackupScheduler.getInstance();
    const scheduleInfo = scheduler?.getScheduleInfo() || null;

    const response: SelfBackupConfigResponse = {
      success: true,
      config,
      scheduleInfo: scheduleInfo ? {
        ...scheduleInfo,
        nextScheduledAt: scheduleInfo.nextScheduledAt?.toISOString() || null,
      } : null,
    };

    res.json(response);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({
      error: errorMessage,
    }, "Failed to get self-backup configuration");

    res.status(500).json({
      success: false,
      error: "Failed to get self-backup configuration",
    });
  }
});

/**
 * PUT / - Update configuration (schedule, container, timezone)
 */
router.put("/", requirePermission('backups:write'), async (req, res) => {
  try {
    const userId = getCurrentUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "User not authenticated",
      });
    }

    // Validate request body
    const validatedData = configSchema.parse(req.body) as UpdateSelfBackupConfigRequest;

    // Update settings in database
    const settingsToUpdate = [
      { key: "cron_schedule", value: validatedData.cronSchedule },
      { key: "azure_container_name", value: validatedData.azureContainerName },
      { key: "timezone", value: validatedData.timezone },
    ];

    for (const setting of settingsToUpdate) {
      await prisma.systemSettings.upsert({
        where: {
          category_key: {
            category: "self-backup",
            key: setting.key,
          },
        },
        create: {
          category: "self-backup",
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

    // Update scheduler if it exists
    const scheduler = SelfBackupScheduler.getInstance();
    if (scheduler) {
      await scheduler.updateSchedule(
        validatedData.cronSchedule,
        validatedData.timezone,
        validatedData.azureContainerName
      );
    }

    logger.info({
      userId,
      cronSchedule: validatedData.cronSchedule,
      azureContainerName: validatedData.azureContainerName,
      timezone: validatedData.timezone,
    }, "Self-backup configuration updated");

    res.json({
      success: true,
      message: "Configuration updated successfully",
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.issues,
      });
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({
      error: errorMessage,
    }, "Failed to update self-backup configuration");

    res.status(500).json({
      success: false,
      error: "Failed to update configuration",
    });
  }
});

/**
 * POST /enable - Enable scheduled backups
 */
router.post("/enable", requirePermission('backups:write'), async (req, res) => {
  try {
    const userId = getCurrentUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "User not authenticated",
      });
    }

    // Update enabled setting in database
    await prisma.systemSettings.upsert({
      where: {
        category_key: {
          category: "self-backup",
          key: "enabled",
        },
      },
      create: {
        category: "self-backup",
        key: "enabled",
        value: "true",
        isEncrypted: false,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      },
      update: {
        value: "true",
        updatedBy: userId,
        updatedAt: new Date(),
      },
    });

    // Enable scheduler
    const scheduler = SelfBackupScheduler.getInstance();
    if (scheduler) {
      await scheduler.enableSchedule();
    }

    logger.info({ userId }, "Self-backup schedule enabled");

    res.json({
      success: true,
      message: "Backup schedule enabled",
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({
      error: errorMessage,
    }, "Failed to enable backup schedule");

    res.status(500).json({
      success: false,
      error: "Failed to enable backup schedule",
    });
  }
});

/**
 * POST /disable - Disable scheduled backups
 */
router.post("/disable", requirePermission('backups:write'), async (req, res) => {
  try {
    const userId = getCurrentUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "User not authenticated",
      });
    }

    // Update enabled setting in database
    await prisma.systemSettings.upsert({
      where: {
        category_key: {
          category: "self-backup",
          key: "enabled",
        },
      },
      create: {
        category: "self-backup",
        key: "enabled",
        value: "false",
        isEncrypted: false,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      },
      update: {
        value: "false",
        updatedBy: userId,
        updatedAt: new Date(),
      },
    });

    // Disable scheduler
    const scheduler = SelfBackupScheduler.getInstance();
    if (scheduler) {
      await scheduler.disableSchedule();
    }

    logger.info({ userId }, "Self-backup schedule disabled");

    res.json({
      success: true,
      message: "Backup schedule disabled",
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({
      error: errorMessage,
    }, "Failed to disable backup schedule");

    res.status(500).json({
      success: false,
      error: "Failed to disable backup schedule",
    });
  }
});

/**
 * POST /trigger - Trigger manual backup immediately
 */
router.post("/trigger", requirePermission('backups:write'), async (req, res) => {
  try {
    const userId = getCurrentUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "User not authenticated",
      });
    }

    // Check if there's already a backup in progress
    const inProgressBackup = await prisma.selfBackup.findFirst({
      where: {
        status: "in_progress",
      },
    });

    if (inProgressBackup) {
      return res.status(409).json({
        success: false,
        error: "A backup is already in progress",
      });
    }

    // Get container name from settings
    const containerSetting = await prisma.systemSettings.findUnique({
      where: {
        category_key: {
          category: "self-backup",
          key: "azure_container_name",
        },
      },
    });

    if (!containerSetting || !containerSetting.value) {
      return res.status(400).json({
        success: false,
        error: "Azure container not configured",
      });
    }

    // Execute backup
    const executor = new SelfBackupExecutor(prisma);
    const backup = await executor.executeBackup(
      containerSetting.value,
      'manual',
      userId
    );

    logger.info({
      userId,
      backupId: backup.id,
      status: backup.status,
    }, "Manual backup triggered");

    const response: TriggerBackupResponse = {
      success: true,
      backup: {
        id: backup.id,
        startedAt: backup.startedAt.toISOString(),
        completedAt: backup.completedAt?.toISOString() || null,
        status: backup.status as 'in_progress' | 'completed' | 'failed',
        filePath: backup.filePath,
        azureBlobUrl: backup.azureBlobUrl,
        azureContainerName: backup.azureContainerName,
        fileName: backup.fileName,
        fileSize: backup.fileSize,
        errorMessage: backup.errorMessage,
        errorCode: backup.errorCode,
        triggeredBy: backup.triggeredBy as 'scheduled' | 'manual',
        userId: backup.userId,
        durationMs: backup.durationMs,
        createdAt: backup.createdAt.toISOString(),
        updatedAt: backup.updatedAt.toISOString(),
      },
    };

    res.json(response);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({
      error: errorMessage,
    }, "Failed to trigger manual backup");

    const response: TriggerBackupResponse = {
      success: false,
      error: "Failed to trigger backup: " + errorMessage,
    };

    res.status(500).json(response);
  }
});

/**
 * GET /schedule-info - Get next scheduled run time and status
 */
router.get("/schedule-info", requirePermission('backups:read'), async (req, res) => {
  try {
    const scheduler = SelfBackupScheduler.getInstance();
    const scheduleInfo = scheduler?.getScheduleInfo() || null;

    res.json({
      success: true,
      scheduleInfo: scheduleInfo ? {
        ...scheduleInfo,
        nextScheduledAt: scheduleInfo.nextScheduledAt?.toISOString() || null,
      } : null,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({
      error: errorMessage,
    }, "Failed to get schedule info");

    res.status(500).json({
      success: false,
      error: "Failed to get schedule info",
    });
  }
});

export default router;
