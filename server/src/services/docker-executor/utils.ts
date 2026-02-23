import { servicesLogger } from "../../lib/logger-factory";
import prisma from "../../lib/prisma";
import type { ContainerExecutionOptions } from "./types";

/**
 * Infer the task type from container execution options
 */
export function inferTaskType(options: ContainerExecutionOptions): string {
  if (options.image.includes("postgres") || options.image.includes("pg_")) {
    if (options.cmd?.some(cmd => cmd.includes("pg_dump"))) {
      return "postgres-backup";
    } else if (options.cmd?.some(cmd => cmd.includes("pg_restore") || cmd.includes("psql"))) {
      return "postgres-restore";
    }
    return "postgres-task";
  }

  if (options.image.includes("mongo")) {
    return "mongodb-task";
  }

  if (options.image.includes("redis")) {
    return "redis-task";
  }

  if (options.serviceName?.includes("backup") || options.cmd?.some(cmd => cmd.includes("backup"))) {
    return "backup";
  }

  if (options.serviceName?.includes("restore") || options.cmd?.some(cmd => cmd.includes("restore"))) {
    return "restore";
  }

  return "utility";
}

/**
 * Generate a unique task ID for tracking
 */
export function generateTaskId(options: ContainerExecutionOptions): string {
  const timestamp = Date.now();
  const imageShort = options.image.split("/").pop()?.split(":")[0] || "unknown";
  return `${imageShort}-${timestamp}`;
}

/**
 * Get the Docker network name from system settings
 */
export async function getDockerNetworkName(): Promise<string> {
  try {
    const networkSetting = await prisma.systemSettings.findFirst({
      where: {
        category: "system",
        key: "docker_network_name",
      },
    });

    const networkName = networkSetting?.value || "mini-infra-network";

    servicesLogger().debug(
      {
        networkName,
        fromSettings: !!networkSetting?.value,
      },
      "Retrieved Docker network name for container operations",
    );

    return networkName;
  } catch (error) {
    servicesLogger().warn(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to get Docker network name from settings, using default",
    );
    return "mini-infra-network";
  }
}
