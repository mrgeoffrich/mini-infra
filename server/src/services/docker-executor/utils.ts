import { getLogger } from "../../lib/logger-factory";
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
 * Shape of a single entry in Docker's `HostConfig.Devices` array — see
 * https://docs.docker.com/engine/api/v1.45/#tag/Container/operation/ContainerCreate.
 * Dockerode types this as `any`; we narrow it so call sites stay strongly
 * typed.
 */
export interface DockerDeviceMapping {
  PathOnHost: string;
  PathInContainer: string;
  CgroupPermissions: string;
}

/**
 * Parse one entry of `containerConfig.devices` into Docker's
 * `HostConfig.Devices` shape.
 *
 * Accepted input forms (matches `docker run --device`):
 *  - `/dev/net/tun` → host & container both `/dev/net/tun`, perms `rwm`
 *  - `/dev/host:/dev/container` → host & container split, perms `rwm`
 *  - `/dev/host:/dev/container:rw` → all three explicit
 *
 * Throws on empty strings, more than three colon-separated segments, or
 * empty segments — the caller surfaces the error before reaching the
 * Docker daemon (which would otherwise reject with a less actionable
 * message).
 */
export function parseDeviceSpec(spec: string): DockerDeviceMapping {
  if (typeof spec !== "string" || spec.length === 0) {
    throw new Error(`Invalid device spec: expected non-empty string, got ${JSON.stringify(spec)}`);
  }
  const parts = spec.split(":");
  if (parts.length > 3 || parts.some((p) => p.length === 0)) {
    throw new Error(
      `Invalid device spec "${spec}": expected "HOST", "HOST:CONTAINER", or "HOST:CONTAINER:PERMS" with no empty segments`,
    );
  }
  const [pathOnHost, pathInContainer, cgroupPermissions] = parts;
  return {
    PathOnHost: pathOnHost,
    PathInContainer: pathInContainer ?? pathOnHost,
    CgroupPermissions: cgroupPermissions ?? "rwm",
  };
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

    getLogger("docker", "utils").debug(
      {
        networkName,
        fromSettings: !!networkSetting?.value,
      },
      "Retrieved Docker network name for container operations",
    );

    return networkName;
  } catch (error) {
    getLogger("docker", "utils").warn(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to get Docker network name from settings, using default",
    );
    return "mini-infra-network";
  }
}
