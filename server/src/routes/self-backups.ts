import express from "express";
import prisma from "../lib/prisma";
import { Prisma } from "../generated/prisma/client";
import { getLogger } from "../lib/logger-factory";
import { requirePermission } from "../middleware/auth";
import {
  ProviderNoLongerConfiguredError,
  StorageService,
} from "../services/storage/storage-service";
import { calculateBackupHealth } from "../services/backup/backup-health-calculator";
import type {
  BackupHistoryResponse,
  BackupHealthResponse,
  SelfBackupInfo,
  StorageProviderId,
} from "@mini-infra/types";

const logger = getLogger("backup", "self-backups");
const router = express.Router();

/**
 * GET / - List backup history (paginated, filterable)
 */
router.get("/", requirePermission('backups:read'), async (req, res) => {
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
    const where: Prisma.SelfBackupWhereInput = {};

    if (status) {
      where.status = status as string;
    }

    if (triggeredBy) {
      where.triggeredBy = triggeredBy as string;
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
      storageObjectUrl: backup.storageObjectUrl,
      storageLocationId: backup.storageLocationId,
      storageProviderAtCreation: backup.storageProviderAtCreation,
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
router.get("/health", requirePermission('backups:read'), async (req, res) => {
  try {
    const health = await calculateBackupHealth();

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
router.get("/:id", requirePermission('backups:read'), async (req, res) => {
  try {
    const id = String(req.params.id);

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
      storageObjectUrl: backup.storageObjectUrl,
      storageLocationId: backup.storageLocationId,
      storageProviderAtCreation: backup.storageProviderAtCreation,
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
router.get("/:id/download", requirePermission('backups:read'), async (req, res) => {
  try {
    const id = String(req.params.id);

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

    // Validate stored object URL exists
    if (!backup.storageObjectUrl) {
      return res.status(400).json({
        success: false,
        error: "Backup has no storage object URL",
      });
    }

    // Validate location id exists
    if (!backup.storageLocationId) {
      return res.status(400).json({
        success: false,
        error: "Backup has no storage location id",
      });
    }

    // Resolve the object name. Azure's storageObjectUrl is the full Blob URL
    // (`https://{account}.blob.core.windows.net/{container}/{blob}`); Drive's
    // is `<folderId>/<fileName>`. For Drive we use the file name verbatim;
    // for Azure we strip the host + container.
    const provider = backup.storageProviderAtCreation as StorageProviderId;
    let objectName: string;
    if (provider === "azure") {
      const urlParts = backup.storageObjectUrl.split("/");
      objectName =
        urlParts.length >= 5 ? urlParts.slice(4).join("/") : backup.fileName;
    } else {
      objectName = backup.fileName;
    }

    if (!objectName) {
      return res.status(400).json({
        success: false,
        error: "Could not derive storage object name",
      });
    }

    // Resolve the backend that wrote this row, not the active one. If the
    // operator forgot the original provider, surface a friendly 409 instead
    // of letting the SDK fail with an opaque auth error downstream.
    const storageService = StorageService.getInstance(prisma);
    const backend = await storageService.getBackendByProviderIdOrThrow(provider);

    // Prefer a redirect handle (Azure SAS) when the backend can mint one.
    if (backend.getDownloadHandle) {
      try {
        const handle = await backend.getDownloadHandle(
          { id: backup.storageLocationId },
          objectName,
          15,
        );
        if (handle.redirectUrl) {
          logger.info(
            {
              backupId: id,
              fileName: backup.fileName,
              storageLocationId: backup.storageLocationId,
              providerId: backend.providerId,
              objectName,
            },
            "Redirecting to download URL for self-backup",
          );
          return res.redirect(302, handle.redirectUrl);
        }
      } catch (handleError) {
        logger.warn(
          {
            error:
              handleError instanceof Error
                ? handleError.message
                : "Unknown error",
            providerId: backend.providerId,
          },
          "getDownloadHandle failed; falling through to server-side stream",
        );
      }
    }

    // Fallback: stream through the server. Drive lands here because it has no
    // SAS-equivalent; Azure can also land here when SAS minting fails.
    const download = await backend.getDownloadStream(
      { id: backup.storageLocationId },
      objectName,
    );
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${backup.fileName}"`,
    );
    if (download.contentLength > 0) {
      res.setHeader("Content-Length", String(download.contentLength));
    }
    logger.info(
      {
        backupId: id,
        fileName: backup.fileName,
        providerId: backend.providerId,
        objectName,
        contentLength: download.contentLength,
      },
      "Streaming self-backup through server (no download-handle redirect)",
    );
    const stream = download.stream as NodeJS.ReadableStream;
    stream.on("error", (err) => {
      logger.error(
        { error: err instanceof Error ? err.message : "Unknown error" },
        "Self-backup download stream errored",
      );
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });
    stream.pipe(res);
    return;
  } catch (error) {
    if (error instanceof ProviderNoLongerConfiguredError) {
      logger.warn(
        { backupId: req.params.id, providerId: error.providerId },
        "Self-backup download blocked: original provider no longer configured",
      );
      return res.status(409).json({
        success: false,
        error: "PROVIDER_NO_LONGER_CONFIGURED",
        message: error.message,
        providerId: error.providerId,
      });
    }
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
router.delete("/:id", requirePermission('backups:write'), async (req, res) => {
  try {
    const id = String(req.params.id);

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
