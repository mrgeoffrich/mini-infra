/**
 * Backup Health Calculator
 *
 * Calculates the current backup health status from the database.
 * Shared between the REST route and the Socket.IO emitter.
 */

import prisma from "../../lib/prisma";
import type { BackupHealthStatus } from "@mini-infra/types";

/**
 * Calculate the current backup health status.
 */
export async function calculateBackupHealth(): Promise<BackupHealthStatus> {
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
    return {
      status: "not_configured",
      lastBackupAt: null,
      lastSuccessfulBackupAt: null,
      failureCount24h: 0,
      message: !isConfigured
        ? "Self-backup not configured"
        : "Self-backup disabled",
    };
  }

  // Get last backup
  const lastBackup = await prisma.selfBackup.findFirst({
    orderBy: {
      startedAt: "desc",
    },
  });

  // Get last successful backup
  const lastSuccessfulBackup = await prisma.selfBackup.findFirst({
    where: {
      status: "completed",
    },
    orderBy: {
      completedAt: "desc",
    },
  });

  // Count failures in last 24 hours
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const failureCount24h = await prisma.selfBackup.count({
    where: {
      status: "failed",
      startedAt: {
        gte: twentyFourHoursAgo,
      },
    },
  });

  // Determine health status
  let status: "healthy" | "warning" | "error" | "not_configured" = "healthy";
  let message = "Backups running normally";

  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

  if (failureCount24h >= 3) {
    status = "error";
    message = `${failureCount24h} backup failures in last 24 hours`;
  } else if (
    !lastSuccessfulBackup ||
    lastSuccessfulBackup.completedAt! < fortyEightHoursAgo
  ) {
    status = "error";
    message = "No successful backup in 48 hours";
  } else if (
    failureCount24h > 0 ||
    (lastBackup && lastBackup.status === "failed")
  ) {
    status = "warning";
    message =
      failureCount24h > 0
        ? `${failureCount24h} backup failure(s) in last 24 hours`
        : "Last backup failed";
  }

  return {
    status,
    lastBackupAt: lastBackup?.startedAt.toISOString() || null,
    lastSuccessfulBackupAt:
      lastSuccessfulBackup?.completedAt?.toISOString() || null,
    failureCount24h,
    message,
  };
}
