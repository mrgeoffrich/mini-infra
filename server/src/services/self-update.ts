import Docker from "dockerode";
import fs from "fs";
import { servicesLogger } from "../lib/logger-factory";
import DockerService from "./docker";

const logger = servicesLogger();

const UPDATE_LOCK_LABEL = "mini-infra.update-lock";
const SIDECAR_LABEL = "mini-infra.sidecar";
const STATUS_VOLUME_PREFIX = "mini-infra-update-status-";

export type SelfUpdateState =
  | "idle"
  | "checking"
  | "pulling"
  | "inspecting"
  | "stopping"
  | "creating"
  | "health-checking"
  | "complete"
  | "rolling-back"
  | "rollback-complete"
  | "failed";

export interface SelfUpdateStatus {
  state: SelfUpdateState;
  targetTag?: string;
  progress?: number;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface UpdateCheckResult {
  currentImage: string;
  currentTag: string;
  availableTags: string[];
}

export interface TriggerUpdateOptions {
  targetTag: string;
  allowedRegistryPattern: string;
  sidecarImage: string;
  healthCheckUrl: string;
  healthCheckTimeoutMs?: number;
  gracefulStopSeconds?: number;
}

/**
 * Reads the container ID of the currently running Mini Infra instance.
 * In Docker, the hostname is typically the container ID.
 * Falls back to reading /proc/1/cpuset for older Docker versions.
 */
export function getOwnContainerId(): string | null {
  // HOSTNAME is the most reliable method in Docker
  const hostname = process.env.HOSTNAME;
  if (hostname && /^[a-f0-9]{12,64}$/.test(hostname)) {
    return hostname;
  }

  // Fallback: read from cgroup (works on cgroup v1)
  try {
    const cpuset = fs.readFileSync("/proc/1/cpuset", "utf-8").trim();
    const match = cpuset.match(/[a-f0-9]{64}/);
    if (match) return match[0];
  } catch {
    // Not running in Docker, or cgroup v2
  }

  // Fallback: read from /proc/self/mountinfo (cgroup v2)
  try {
    const mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf-8");
    const match = mountinfo.match(
      /\/docker\/containers\/([a-f0-9]{64})\//,
    );
    if (match) return match[1];
  } catch {
    // Not available
  }

  return null;
}

/**
 * Validates that a target image reference matches the allowed registry pattern.
 * Prevents pulling arbitrary images during an update.
 */
export function validateTargetImage(
  fullImageRef: string,
  allowedPattern: string,
): boolean {
  // Convert glob-like pattern to regex: "ghcr.io/user/repo:*" → /^ghcr\.io\/user\/repo:.+$/
  const escaped = allowedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".+");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(fullImageRef);
}

/**
 * Checks whether an update is already in progress by looking for
 * a running sidecar container or the update-lock label on self.
 */
export async function isUpdateInProgress(): Promise<boolean> {
  try {
    const docker = await DockerService.getInstance().getDockerInstance();
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [`${SIDECAR_LABEL}=true`],
        status: ["created", "running"],
      },
    });
    return containers.length > 0;
  } catch (err) {
    logger.error({ err }, "Failed to check update lock status");
    return false;
  }
}

/**
 * Launches the sidecar container to perform the self-update.
 * Returns the sidecar container ID.
 */
export async function launchSidecar(
  options: TriggerUpdateOptions,
): Promise<string> {
  const docker = await DockerService.getInstance().getDockerInstance();
  const containerId = getOwnContainerId();

  if (!containerId) {
    throw new Error(
      "Cannot determine own container ID. Are you running inside Docker?",
    );
  }

  // Validate the target image against the allowed registry
  const fullImageRef = options.targetTag.includes(":")
    ? options.targetTag
    : `${options.targetTag}:latest`;

  if (!validateTargetImage(fullImageRef, options.allowedRegistryPattern)) {
    throw new Error(
      `Target image "${fullImageRef}" does not match allowed registry pattern "${options.allowedRegistryPattern}"`,
    );
  }

  const inProgress = await isUpdateInProgress();
  if (inProgress) {
    throw new Error("An update is already in progress");
  }

  // Create a temporary volume for status file sharing
  const statusVolumeName = `${STATUS_VOLUME_PREFIX}${Date.now()}`;
  await docker.createVolume({ Name: statusVolumeName });

  logger.info(
    {
      sidecarImage: options.sidecarImage,
      targetImage: fullImageRef,
      containerId,
      statusVolume: statusVolumeName,
    },
    "Launching self-update sidecar",
  );

  const sidecar = await docker.createContainer({
    Image: options.sidecarImage,
    name: `mini-infra-sidecar-${Date.now()}`,
    Env: [
      `TARGET_IMAGE=${fullImageRef}`,
      `CONTAINER_ID=${containerId}`,
      `HEALTH_CHECK_URL=${options.healthCheckUrl}`,
      `HEALTH_CHECK_TIMEOUT_MS=${options.healthCheckTimeoutMs ?? 60000}`,
      `GRACEFUL_STOP_SECONDS=${options.gracefulStopSeconds ?? 30}`,
      `STATUS_FILE=/status/update-status.json`,
    ],
    Labels: {
      [SIDECAR_LABEL]: "true",
      [UPDATE_LOCK_LABEL]: new Date().toISOString(),
    },
    HostConfig: {
      Binds: [
        "/var/run/docker.sock:/var/run/docker.sock:ro",
        `${statusVolumeName}:/status`,
      ],
      AutoRemove: true,
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,noexec,nosuid" },
    },
  } as Docker.ContainerCreateOptions);

  await sidecar.start();

  const sidecarId = (sidecar as unknown as { id: string }).id;
  logger.info({ sidecarId }, "Sidecar container started");

  return sidecarId;
}

/**
 * Reads the update status by exec-ing into the running sidecar container.
 * This avoids spawning a new container on each poll.
 * Returns null if no sidecar is running or the status file isn't available yet.
 */
export async function readSidecarStatus(): Promise<SelfUpdateStatus | null> {
  try {
    const docker = await DockerService.getInstance().getDockerInstance();

    // Find the running sidecar container
    const containers = await docker.listContainers({
      filters: {
        label: [`${SIDECAR_LABEL}=true`],
        status: ["running"],
      },
    });

    if (containers.length === 0) {
      return null;
    }

    const sidecar = docker.getContainer(containers[0].Id);
    const exec = await sidecar.exec({
      Cmd: ["cat", "/status/update-status.json"],
      AttachStdout: true,
      AttachStderr: false,
    });

    const stream = await exec.start({ Detach: false });

    const output = await new Promise<string>((resolve) => {
      let data = "";
      stream.on("data", (chunk: Buffer) => {
        // Docker multiplexed stream: first 8 bytes are header
        data += chunk.subarray(8).toString();
      });
      stream.on("end", () => resolve(data));
    });

    if (!output.trim()) return null;

    try {
      return JSON.parse(output.trim()) as SelfUpdateStatus;
    } catch (parseErr) {
      logger.warn({ parseErr, raw: output.trim() }, "Failed to parse sidecar status file");
      return null;
    }
  } catch (err) {
    logger.debug({ err }, "Could not read sidecar status (sidecar may have exited)");
    return null;
  }
}

/**
 * Cleans up orphaned sidecar containers and status volumes from previous updates.
 * Called during server startup.
 */
export async function cleanupOrphanedSidecars(): Promise<void> {
  try {
    const docker = await DockerService.getInstance().getDockerInstance();

    // Remove any stopped sidecar containers
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [`${SIDECAR_LABEL}=true`],
        status: ["exited", "dead"],
      },
    });

    for (const containerInfo of containers) {
      try {
        const container = docker.getContainer(containerInfo.Id);
        await container.remove({ v: false });
        logger.info(
          { containerId: containerInfo.Id },
          "Removed orphaned sidecar container",
        );
      } catch (err) {
        logger.warn(
          { err, containerId: containerInfo.Id },
          "Failed to remove orphaned sidecar container",
        );
      }
    }

    // Clean up old status volumes
    const volumes = await docker.listVolumes({
      filters: { name: [STATUS_VOLUME_PREFIX] },
    });

    if (volumes.Volumes) {
      for (const vol of volumes.Volumes) {
        try {
          const volume = docker.getVolume(vol.Name);
          await volume.remove();
          logger.info({ volume: vol.Name }, "Removed orphaned status volume");
        } catch (err) {
          logger.warn(
            { err, volume: vol.Name },
            "Failed to remove orphaned status volume",
          );
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to clean up orphaned sidecar resources");
  }
}

/**
 * Reads the last update result from a status volume (if one exists).
 * Returns the status and cleans up the volume afterward.
 */
export async function readAndCleanupLastUpdateResult(): Promise<SelfUpdateStatus | null> {
  const status = await readSidecarStatus();

  if (status) {
    // Clean up the status volume now that we've read it
    try {
      const docker = await DockerService.getInstance().getDockerInstance();
      const volumes = await docker.listVolumes({
        filters: { name: [STATUS_VOLUME_PREFIX] },
      });
      if (volumes.Volumes) {
        for (const vol of volumes.Volumes) {
          try {
            const volume = docker.getVolume(vol.Name);
            await volume.remove();
          } catch {
            // Volume may still be in use
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return status;
}
