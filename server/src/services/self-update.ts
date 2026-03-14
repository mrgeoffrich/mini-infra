import Docker from "dockerode";
import fs from "fs";
import { servicesLogger } from "../lib/logger-factory";
import DockerService from "./docker";
import prisma from "../lib/prisma";
import { RegistryCredentialService } from "./registry-credential";
import { RegistryManager } from "./docker-executor/registry-manager";

const logger = servicesLogger();

const UPDATE_LOCK_LABEL = "mini-infra.update-lock";
const SIDECAR_LABEL = "mini-infra.sidecar";

// In-memory mutex to prevent concurrent sidecar launches (fixes TOCTOU race).
// Acquired in the route handler before any async work; released in launchSidecar's finally block.
let launchInProgress = false;

/**
 * Attempt to acquire the launch mutex. Returns true if acquired, false if already held.
 * Must be called before any async work in the trigger flow to close the TOCTOU race window.
 */
export function acquireLaunchLock(): boolean {
  if (launchInProgress) return false;
  launchInProgress = true;
  return true;
}

/**
 * Release the launch mutex. Called in launchSidecar's finally block.
 */
export function releaseLaunchLock(): void {
  launchInProgress = false;
}

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

export type UpdateProgressCallback = (
  step: { step: string; status: "completed" | "failed" | "skipped"; detail?: string },
  completedCount: number,
  totalSteps: number,
) => void;

export interface TriggerUpdateOptions {
  fullImageRef: string; // Full image reference (e.g. "ghcr.io/user/repo:v2.1.0")
  allowedRegistryPattern: string;
  sidecarImage: string;
  containerPort: number;
  healthCheckUrl?: string; // Optional override (auto-detected from container name + port)
  healthCheckTimeoutMs?: number;
  gracefulStopSeconds?: number;
  onProgress?: UpdateProgressCallback;
}

/** Step names used for progress reporting */
export const SELF_UPDATE_LAUNCH_STEPS = [
  "Pull sidecar image",
  "Pull target image",
  "Create sidecar container",
  "Start sidecar container",
] as const;

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
  try {
    // Convert glob-like pattern to regex: "ghcr.io/user/repo:*" → /^ghcr\.io\/user\/repo:[^:/@]+$/
    const escaped = allowedPattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^:/@]+");
    const regex = new RegExp(`^${escaped}$`);
    return regex.test(fullImageRef);
  } catch {
    // Invalid regex from malformed pattern
    return false;
  }
}

/**
 * Checks whether an update is already in progress by looking for
 * a running sidecar container.
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
  // The caller (route handler) must have already acquired the lock via acquireLaunchLock().
  // We verify it here as a safety check but do NOT re-acquire — that's the caller's job.
  if (!launchInProgress) {
    throw new Error("Launch lock not held — call acquireLaunchLock() before launchSidecar()");
  }

  const totalSteps = SELF_UPDATE_LAUNCH_STEPS.length;
  let completedCount = 0;

  const reportStep = (
    step: string,
    status: "completed" | "failed" | "skipped",
    detail?: string,
  ) => {
    if (status === "completed") completedCount++;
    try {
      options.onProgress?.({ step, status, detail }, completedCount, totalSteps);
    } catch { /* never break caller */ }
  };

  try {
    const docker = await DockerService.getInstance().getDockerInstance();
    const containerId = getOwnContainerId();

    if (!containerId) {
      throw new Error(
        "Cannot determine own container ID. Are you running inside Docker?",
      );
    }

    // Validate the target image against the allowed registry
    const fullImageRef = options.fullImageRef;

    if (!validateTargetImage(fullImageRef, options.allowedRegistryPattern)) {
      throw new Error(
        `Target image "${fullImageRef}" does not match allowed registry pattern "${options.allowedRegistryPattern}"`,
      );
    }

    const inProgress = await isUpdateInProgress();
    if (inProgress) {
      throw new Error("An update is already in progress");
    }

    // Inspect own container to discover name and network
    const ownContainer = docker.getContainer(containerId);
    const ownInfo = await ownContainer.inspect();
    const containerName = ownInfo.Name.replace(/^\//, "");

    // Auto-detect health check URL from container name and port,
    // using Docker DNS to resolve the container name
    const healthCheckUrl =
      options.healthCheckUrl ||
      `http://${containerName}:${options.containerPort}/health`;

    // Find a user-defined Docker network to attach the sidecar to
    // (required for Docker DNS resolution of container names)
    const ownNetworks = Object.keys(ownInfo.NetworkSettings?.Networks ?? {});
    const sidecarNetwork = ownNetworks.find(
      (n) => n !== "host" && n !== "none" && n !== "bridge",
    ) ?? ownNetworks[0];

    logger.info(
      {
        sidecarImage: options.sidecarImage,
        targetImage: fullImageRef,
        containerId,
        containerName,
        healthCheckUrl,
        sidecarNetwork,
      },
      "Launching self-update sidecar",
    );

    // Step 1: Pull the sidecar image
    const registryCredentialService = new RegistryCredentialService(prisma);
    try {
      const registryManager = new RegistryManager(docker, registryCredentialService);
      await registryManager.pullImageWithAutoAuth(options.sidecarImage);
      logger.info({ sidecarImage: options.sidecarImage }, "Sidecar image pulled");
      reportStep("Pull sidecar image", "completed", options.sidecarImage);
    } catch (pullErr) {
      logger.error({ err: pullErr, sidecarImage: options.sidecarImage }, "Failed to pull sidecar image");
      reportStep("Pull sidecar image", "failed", pullErr instanceof Error ? pullErr.message : String(pullErr));
      throw new Error(`Failed to pull sidecar image "${options.sidecarImage}": ${pullErr instanceof Error ? pullErr.message : pullErr}`);
    }

    // Step 2: Pull the target image (server has working registry credentials)
    try {
      const registryManager = new RegistryManager(docker, registryCredentialService);
      await registryManager.pullImageWithAutoAuth(fullImageRef);
      logger.info({ targetImage: fullImageRef }, "Target image pulled");
      reportStep("Pull target image", "completed", fullImageRef);
    } catch (pullErr) {
      logger.error({ err: pullErr, targetImage: fullImageRef }, "Failed to pull target image");
      reportStep("Pull target image", "failed", pullErr instanceof Error ? pullErr.message : String(pullErr));
      throw new Error(`Failed to pull target image "${fullImageRef}": ${pullErr instanceof Error ? pullErr.message : pullErr}`);
    }

    // Step 3: Create sidecar container
    // Target image is already pre-pulled, so no registry credentials needed
    const sidecarEnv = [
      `TARGET_IMAGE=${fullImageRef}`,
      `CONTAINER_ID=${containerId}`,
      `HEALTH_CHECK_URL=${healthCheckUrl}`,
      `HEALTH_CHECK_TIMEOUT_MS=${options.healthCheckTimeoutMs ?? 60000}`,
      `GRACEFUL_STOP_SECONDS=${options.gracefulStopSeconds ?? 30}`,
    ];

    const createOptions: Docker.ContainerCreateOptions = {
      Image: options.sidecarImage,
      name: `mini-infra-sidecar-${Date.now()}`,
      Env: sidecarEnv,
      Labels: {
        [SIDECAR_LABEL]: "true",
        [UPDATE_LOCK_LABEL]: new Date().toISOString(),
      },
      HostConfig: {
        AutoRemove: true,
        Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,noexec,nosuid" },
      },
    };

    // Attach sidecar to the same Docker network so it can resolve
    // the container name for health checks via Docker DNS
    if (sidecarNetwork) {
      (createOptions as any).NetworkingConfig = {
        EndpointsConfig: {
          [sidecarNetwork]: {},
        },
      };
    }

    const sidecar = await docker.createContainer(createOptions);
    reportStep("Create sidecar container", "completed");

    // Step 4: Start sidecar container
    await sidecar.start();

    const sidecarId = (sidecar as unknown as { id: string }).id;
    logger.info({ sidecarId }, "Sidecar container started");
    reportStep("Start sidecar container", "completed", sidecarId.slice(0, 12));

    return sidecarId;
  } finally {
    releaseLaunchLock();
  }
}

/**
 * Checks the exit status of the most recent sidecar container.
 * Returns null if no exited sidecar container is found.
 */
async function getSidecarExitInfo(): Promise<{ exitCode: number; containerId: string } | null> {
  try {
    const docker = await DockerService.getInstance().getDockerInstance();
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [`${SIDECAR_LABEL}=true`],
        status: ["exited", "dead"],
      },
    });

    if (containers.length === 0) return null;

    const latest = containers.sort((a, b) => b.Created - a.Created)[0];
    const container = docker.getContainer(latest.Id);
    const info = await container.inspect();

    return {
      exitCode: info.State.ExitCode,
      containerId: latest.Id,
    };
  } catch (err) {
    logger.warn({ err }, "Failed to get sidecar exit info");
    return null;
  }
}

/**
 * Cleans up orphaned sidecar containers from previous updates.
 * Called during server startup, after finalizeLastUpdate.
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
  } catch (err) {
    logger.warn({ err }, "Failed to clean up orphaned sidecar resources");
  }
}

// ---------------------------------------------------------------------------
// Database persistence — survives container restarts
// ---------------------------------------------------------------------------

/**
 * Creates a SelfUpdate record when an update is triggered.
 * This record persists in the SQLite DB on the mounted volume,
 * so the new container can read it after restart.
 */
export async function createUpdateRecord(options: {
  targetTag: string;
  fullImageRef: string;
  triggeredBy: string;
}): Promise<string> {
  const record = await prisma.selfUpdate.create({
    data: {
      targetTag: options.targetTag,
      fullImageRef: options.fullImageRef,
      state: "pending",
      triggeredBy: options.triggeredBy,
    },
  });

  logger.info({ updateId: record.id }, "Self-update record created");
  return record.id;
}

/**
 * Updates a SelfUpdate record with the sidecar container ID after launch.
 */
export async function updateUpdateRecordSidecarId(
  updateId: string,
  sidecarId: string,
): Promise<void> {
  await prisma.selfUpdate.update({
    where: { id: updateId },
    data: { sidecarId },
  });
}

/**
 * Finalizes the most recent in-progress update record on startup.
 * Uses the sidecar container's exit code to determine the outcome:
 *   exit 0 → complete, exit non-0 → rollback-complete.
 * If no sidecar container is found, assumes success (we are alive).
 */
export async function finalizeLastUpdate(): Promise<void> {
  // Find the most recent non-terminal update record
  const record = await prisma.selfUpdate.findFirst({
    where: {
      state: {
        notIn: ["complete", "rollback-complete", "failed"],
      },
    },
    orderBy: { startedAt: "desc" },
  });

  if (!record) {
    logger.debug("No in-progress update record to finalize");
    return;
  }

  // If the sidecar is still running, don't finalize yet
  const running = await isUpdateInProgress();
  if (running) {
    logger.info("Sidecar still running at startup, deferring finalization");
    return;
  }

  const exitInfo = await getSidecarExitInfo();

  const now = new Date();
  let state: string;
  let errorMessage: string | null = null;

  if (exitInfo) {
    if (exitInfo.exitCode === 0) {
      state = "complete";
    } else {
      state = "rollback-complete";
      errorMessage = `Update sidecar exited with code ${exitInfo.exitCode}`;
    }
  } else {
    // No sidecar container found (manually removed or cleaned up).
    // Since we are running, the system is in a stable state.
    state = "complete";
  }

  await prisma.selfUpdate.update({
    where: { id: record.id },
    data: {
      state,
      errorMessage,
      completedAt: now,
      durationMs: now.getTime() - record.startedAt.getTime(),
    },
  });

  logger.info({ updateId: record.id, state }, "Self-update record finalized");
}

/**
 * Detects and recovers stale update records.
 * If the DB record is in a non-terminal state but no sidecar container
 * is running, the sidecar crashed (and AutoRemove destroyed it).
 * Mark the record as failed so the UI doesn't spin forever.
 */
export async function recoverStaleUpdate(): Promise<void> {
  const record = await prisma.selfUpdate.findFirst({
    where: {
      state: {
        notIn: ["complete", "rollback-complete", "failed"],
      },
    },
    orderBy: { startedAt: "desc" },
  });

  if (!record) return;

  const running = await isUpdateInProgress();
  if (running) return; // Sidecar is still alive, nothing to recover

  const now = new Date();
  await prisma.selfUpdate.update({
    where: { id: record.id },
    data: {
      state: "failed",
      errorMessage: "Update sidecar exited unexpectedly (container auto-removed)",
      completedAt: now,
      durationMs: now.getTime() - record.startedAt.getTime(),
    },
  });

  logger.info(
    { updateId: record.id },
    "Recovered stale update record — sidecar no longer running",
  );
}

/**
 * Returns the most recent self-update record (for the status endpoint).
 */
export async function getLatestUpdateRecord(): Promise<{
  id: string;
  targetTag: string;
  fullImageRef: string;
  state: string;
  progress: number | null;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  triggeredBy: string;
} | null> {
  return prisma.selfUpdate.findFirst({
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      targetTag: true,
      fullImageRef: true,
      state: true,
      progress: true,
      errorMessage: true,
      startedAt: true,
      completedAt: true,
      durationMs: true,
      triggeredBy: true,
    },
  });
}
