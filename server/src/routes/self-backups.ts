import express from "express";
import prisma from "../lib/prisma";
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey } from "../middleware/auth";
import { AzureConfigService } from "../services/azure-config";
import type {
  BackupHistoryResponse,
  BackupHealthResponse,
  BackupHealthStatus,
  SelfBackupInfo,
} from "@mini-infra/types";

const logger = appLogger();
const router = express.Router();
const azureConfigService = new AzureConfigService(prisma);

/**
 * GET / - List backup history (paginated, filterable)
 */
router.get("/", requireSessionOrApiKey, async (req, res) => {
  try {
    const {
      status,
      triggeredBy,
      startDate,
      endDate,
      sortBy = 'startedAt',
      sortOrder = 'desc',
      page = '1',
      limit = '10',
    } = req.query;

    // Parse pagination parameters
    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;

    // Build where clause
    const where: any = {};

    if (status) {
      where.status = status;
    }

    if (triggeredBy) {
      where.triggeredBy = triggeredBy;
    }

    if (startDate || endDate) {
      where.startedAt = {};
      if (startDate) {
        where.startedAt.gte = new Date(startDate as string);
      }
      if (endDate) {
        where.startedAt.lte = new Date(endDate as string);
      }
    }

    // Get total count
    const total = await prisma.selfBackup.count({ where });

    // Get backups
    const backups = await prisma.selfBackup.findMany({
      where,
      orderBy: {
        [sortBy as string]: sortOrder,
      },
      skip,
      take: limitNum,
    });

    // Convert to API format
    const backupInfos: SelfBackupInfo[] = backups.map(backup => ({
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
    }));

    const response: BackupHistoryResponse = {
      success: true,
      backups: backupInfos,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    };

    res.json(response);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({
      error: errorMessage,
    }, "Failed to get backup history");

    res.status(500).json({
      success: false,
      error: "Failed to get backup history",
    });
  }
});

/**
 * GET /health - Get backup health status
 */
router.get("/health", requireSessionOrApiKey, async (req, res) => {
  try {
    // Check if configuration exists
    const containerSetting = await prisma.systemSettings.findUnique({
      where: {
        category_key: {
          category: "self-backup",
          key: "azure_container_name",
        },
      },
    });

    const enabledSetting = await prisma.systemSettings.findUnique({
      where: {
        category_key: {
          category: "self-backup",
          key: "enabled",
        },
      },
    });

    const isEnabled = enabledSetting?.value === "true";
    const isConfigured = !!containerSetting?.value;

    if (!isConfigured || !isEnabled) {
      const health: BackupHealthStatus = {
        status: 'not_configured',
        lastBackupAt: null,
        lastSuccessfulBackupAt: null,
        failureCount24h: 0,
        message: !isConfigured
          ? 'Self-backup not configured'
          : 'Self-backup disabled',
      };

      const response: BackupHealthResponse = {
        success: true,
        health,
      };

      return res.json(response);
    }

    // Get last backup
    const lastBackup = await prisma.selfBackup.findFirst({
      orderBy: {
        startedAt: 'desc',
      },
    });

    // Get last successful backup
    const lastSuccessfulBackup = await prisma.selfBackup.findFirst({
      where: {
        status: 'completed',
      },
      orderBy: {
        completedAt: 'desc',
      },
    });

    // Count failures in last 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const failureCount24h = await prisma.selfBackup.count({
      where: {
        status: 'failed',
        startedAt: {
          gte: twentyFourHoursAgo,
        },
      },
    });

    // Determine health status
    let status: 'healthy' | 'warning' | 'error' | 'not_configured' = 'healthy';
    let message = 'Backups running normally';

    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

    if (failureCount24h >= 3) {
      status = 'error';
      message = `${failureCount24h} backup failures in last 24 hours`;
    } else if (!lastSuccessfulBackup || lastSuccessfulBackup.completedAt! < fortyEightHoursAgo) {
      status = 'error';
      message = 'No successful backup in 48 hours';
    } else if (failureCount24h > 0 || (lastBackup && lastBackup.status === 'failed')) {
      status = 'warning';
      message = failureCount24h > 0
        ? `${failureCount24h} backup failure(s) in last 24 hours`
        : 'Last backup failed';
    }

    const health: BackupHealthStatus = {
      status,
      lastBackupAt: lastBackup?.startedAt.toISOString() || null,
      lastSuccessfulBackupAt: lastSuccessfulBackup?.completedAt?.toISOString() || null,
      failureCount24h,
      message,
    };

    const response: BackupHealthResponse = {
      success: true,
      health,
    };

    res.json(response);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({
      error: errorMessage,
    }, "Failed to get backup health status");

    res.status(500).json({
      success: false,
      error: "Failed to get health status",
    });
  }
});

/**
 * GET /:id - Get specific backup details
 */
router.get("/:id", requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const backup = await prisma.selfBackup.findUnique({
      where: { id },
    });

    if (!backup) {
      return res.status(404).json({
        success: false,
        error: "Backup not found",
      });
    }

    const backupInfo: SelfBackupInfo = {
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
    };

    res.json({
      success: true,
      backup: backupInfo,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({
      error: errorMessage,
      backupId: req.params.id,
    }, "Failed to get backup details");

    res.status(500).json({
      success: false,
      error: "Failed to get backup details",
    });
  }
});

/**
 * GET /:id/download - Generate SAS URL and redirect to download
 */
router.get("/:id/download", requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch backup from database
    const backup = await prisma.selfBackup.findUnique({
      where: { id },
    });

    if (!backup) {
      return res.status(404).json({
        success: false,
        error: "Backup not found",
      });
    }

    // Validate backup is completed
    if (backup.status !== 'completed') {
      return res.status(400).json({
        success: false,
        error: `Cannot download backup with status: ${backup.status}`,
      });
    }

    // Validate Azure blob URL exists
    if (!backup.azureBlobUrl) {
      return res.status(400).json({
        success: false,
        error: "Backup has no Azure blob URL",
      });
    }

    // Validate container name exists
    if (!backup.azureContainerName) {
      return res.status(400).json({
        success: false,
        error: "Backup has no Azure container name",
      });
    }

    // Extract blob name from URL
    // URL format: https://{accountName}.blob.core.windows.net/{containerName}/{blobName}
    const urlParts = backup.azureBlobUrl.split('/');
    const blobName = urlParts.slice(4).join('/'); // Everything after container name

    if (!blobName) {
      return res.status(400).json({
        success: false,
        error: "Invalid Azure blob URL format",
      });
    }

    // Generate SAS URL (15-minute expiration)
    const sasUrl = await azureConfigService.generateBlobSasUrl(
      backup.azureContainerName,
      blobName,
      15
    );

    logger.info({
      backupId: id,
      fileName: backup.fileName,
      containerName: backup.azureContainerName,
      blobName,
    }, "Redirecting to SAS URL for backup download");

    // Redirect to SAS URL
    res.redirect(302, sasUrl);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({
      error: errorMessage,
      backupId: req.params.id,
    }, "Failed to generate download URL");

    res.status(500).json({
      success: false,
      error: "Failed to generate download URL",
      details: errorMessage,
    });
  }
});

/**
 * DELETE /:id - Delete backup record (not blob itself)
 */
router.delete("/:id", requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if backup exists
    const backup = await prisma.selfBackup.findUnique({
      where: { id },
    });

    if (!backup) {
      return res.status(404).json({
        success: false,
        error: "Backup not found",
      });
    }

    // Delete the record
    await prisma.selfBackup.delete({
      where: { id },
    });

    logger.info({
      backupId: id,
    }, "Backup record deleted");

    res.json({
      success: true,
      message: "Backup record deleted",
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({
      error: errorMessage,
      backupId: req.params.id,
    }, "Failed to delete backup record");

    res.status(500).json({
      success: false,
      error: "Failed to delete backup record",
    });
  }
});

export default router;
