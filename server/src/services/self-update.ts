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
// Sidecar containers are always kept (AutoRemove: false) so that
// finalizeLastUpdate() can inspect their exit code after a restart.
// cleanupOrphanedSidecars() removes them once the update record is finalized.

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
  | "pending"
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
  sidecarImage: string; // Target-tagged sidecar image to pull (e.g. "...-sidecar:v2.1.0")
  sidecarRunImage?: string; // Current-version sidecar image to run (e.g. "...-sidecar:v2.0.0")
  agentSidecarImage?: string; // Pre-pull so it's available after update
  gracefulStopSeconds?: number;
  onProgress?: UpdateProgressCallback;
}

/** Step names used for progress reporting */
export const SELF_UPDATE_LAUNCH_STEPS = [
  "Pull sidecar image",
  "Pull target image",
  "Pull agent sidecar image",
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

    // Use the current-version sidecar image for running (known-good),
    // while still pulling the target-tagged sidecar for future use.
    const sidecarRunImage = options.sidecarRunImage ?? options.sidecarImage;

    logger.info(
      {
        sidecarImage: options.sidecarImage,
        sidecarRunImage,
        targetImage: fullImageRef,
        containerId,
      },
      "Launching self-update sidecar",
    );

    // Step 1: Pull sidecar images
    // Always pull the target-tagged sidecar (for future updates from the new version).
    // Also pull the current-version sidecar if different (the one we'll actually run).
    const registryCredentialService = new RegistryCredentialService(prisma);
    try {
      const registryManager = new RegistryManager(docker, registryCredentialService);
      await registryManager.pullImageWithAutoAuth(options.sidecarImage);
      logger.info({ sidecarImage: options.sidecarImage }, "Sidecar image pulled");

      // Also ensure the current-version sidecar is available locally
      if (sidecarRunImage !== options.sidecarImage) {
        await registryManager.pullImageWithAutoAuth(sidecarRunImage);
        logger.info({ sidecarRunImage }, "Current-version sidecar image pulled");
      }

      reportStep("Pull sidecar image", "completed", sidecarRunImage);
    } catch (pullErr) {
      logger.error({ err: pullErr, sidecarImage: options.sidecarImage, sidecarRunImage }, "Failed to pull sidecar image");
      reportStep("Pull sidecar image", "failed", pullErr instanceof Error ? pullErr.message : String(pullErr));
      throw new Error(`Failed to pull sidecar image: ${pullErr instanceof Error ? pullErr.message : pullErr}`);
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

    // Step 3: Pull the agent sidecar image (pre-pull so it's available after update)
    if (options.agentSidecarImage) {
      try {
        const registryManager = new RegistryManager(docker, registryCredentialService);
        await registryManager.pullImageWithAutoAuth(options.agentSidecarImage);
        logger.info({ agentSidecarImage: options.agentSidecarImage }, "Agent sidecar image pulled");
        reportStep("Pull agent sidecar image", "completed", options.agentSidecarImage);
      } catch (pullErr) {
        logger.error({ err: pullErr, agentSidecarImage: options.agentSidecarImage }, "Failed to pull agent sidecar image");
        reportStep("Pull agent sidecar image", "failed", pullErr instanceof Error ? pullErr.message : String(pullErr));
        throw new Error(`Failed to pull agent sidecar image "${options.agentSidecarImage}": ${pullErr instanceof Error ? pullErr.message : pullErr}`);
      }
    } else {
      reportStep("Pull agent sidecar image", "skipped", "No agent sidecar image configured");
    }

    // Step 4: Create sidecar container
    // Target image is already pre-pulled, so no registry credentials needed
    const sidecarEnv = [
      `TARGET_IMAGE=${fullImageRef}`,
      `CONTAINER_ID=${containerId}`,
      `GRACEFUL_STOP_SECONDS=${options.gracefulStopSeconds ?? 30}`,
    ];

    const labels: Record<string, string> = {
      [SIDECAR_LABEL]: "true",
      [UPDATE_LOCK_LABEL]: new Date().toISOString(),
    };

    const createOptions: Docker.ContainerCreateOptions = {
      Image: sidecarRunImage,
      name: `mini-infra-sidecar-${Date.now()}`,
      Env: sidecarEnv,
      Labels: labels,
      HostConfig: {
        AutoRemove: false,
        Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,noexec,nosuid" },
      },
    };

    const sidecar = await docker.createContainer(createOptions);
    reportStep("Create sidecar container", "completed");

    // Step 5: Start sidecar container
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
 * Checks the exit status of a specific sidecar container by ID.
 * Falls back to finding the most recent exited sidecar if no ID is provided.
 * Returns null if no matching exited sidecar container is found.
 */
async function getSidecarExitInfo(sidecarId?: string | null): Promise<{ exitCode: number; containerId: string } | null> {
  try {
    const docker = await DockerService.getInstance().getDockerInstance();

    // If we have a specific sidecar ID, inspect it directly
    if (sidecarId) {
      try {
        const container = docker.getContainer(sidecarId);
        const info = await container.inspect();
        if (info.State.Status === "exited" || info.State.Status === "dead") {
          return { exitCode: info.State.ExitCode, containerId: sidecarId };
        }
        // Container exists but hasn't exited yet
        return null;
      } catch {
        // Container not found (already removed) — fall through to generic search
      }
    }

    // Fallback: find any exited sidecar container
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
/**
 * Retries finalization in the background when the sidecar is still running at startup.
 * Polls every 5s for up to 60s until the sidecar exits, then finalizes the record.
 */
function retryFinalization(recordId: string, sidecarId: string | null, startedAt: Date): void {
  const RETRY_INTERVAL_MS = 5000;
  const MAX_RETRIES = 12; // 60s total
  let retries = 0;

  const timer = setInterval(async () => {
    retries++;
    try {
      const stillRunning = await isUpdateInProgress();
      if (stillRunning && retries < MAX_RETRIES) return;

      clearInterval(timer);

      const exitInfo = await getSidecarExitInfo(sidecarId);
      const now = new Date();
      let state: string;
      let errorMessage: string | null = null;

      if (exitInfo) {
        state = exitInfo.exitCode === 0 ? "complete" : "rollback-complete";
        if (exitInfo.exitCode !== 0) {
          errorMessage = `Update sidecar exited with code ${exitInfo.exitCode}`;
        }
      } else if (stillRunning) {
        // Timed out waiting for sidecar — leave for recoverStaleUpdate()
        logger.warn({ recordId }, "Sidecar still running after 60s, deferring to recovery");
        return;
      } else {
        state = "complete";
      }

      await prisma.selfUpdate.update({
        where: { id: recordId },
        data: {
          state,
          errorMessage,
          completedAt: now,
          durationMs: now.getTime() - startedAt.getTime(),
        },
      });

      logger.info({ updateId: recordId, state, retries }, "Self-update record finalized (deferred)");
    } catch (err) {
      clearInterval(timer);
      logger.warn({ err, recordId }, "Deferred finalization failed");
    }
  }, RETRY_INTERVAL_MS);
}

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

  // If the sidecar is still running, retry after a delay.
  // The sidecar is likely finishing its health check on this container,
  // so it should exit shortly. Retry every 5s for up to 60s.
  const running = await isUpdateInProgress();
  if (running) {
    logger.info("Sidecar still running at startup, will retry finalization in background");
    retryFinalization(record.id, record.sidecarId, record.startedAt);
    return;
  }

  // Use the specific sidecar ID from the update record to avoid
  // picking up stale containers from previous update attempts.
  const exitInfo = await getSidecarExitInfo(record.sidecarId);

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

  // Fast path: in-memory lock says launch is actively in progress.
  if (launchInProgress) return;

  const running = await isUpdateInProgress();
  if (running) return; // Sidecar is still alive, nothing to recover

  // Check if the specific sidecar container has exited.
  // Since sidecars are always kept (AutoRemove: false), we can inspect the exit code.
  const exitInfo = await getSidecarExitInfo(record.sidecarId);

  // Grace period: don't recover records created less than 5 minutes ago
  // UNLESS the sidecar container has already exited (we have a definitive outcome).
  // The grace period prevents premature "failed" marks during the sidecar launch
  // process (image pull + container creation) when no sidecar container exists yet.
  if (!exitInfo) {
    const ageMs = Date.now() - record.startedAt.getTime();
    if (ageMs < 5 * 60 * 1000) return;
  }

  const now = new Date();
  let state: string;
  let errorMessage: string | null;

  if (exitInfo) {
    // Sidecar exited and container still exists — use its exit code
    if (exitInfo.exitCode === 0) {
      state = "complete";
      errorMessage = null;
    } else {
      state = "rollback-complete";
      errorMessage = `Update sidecar exited with code ${exitInfo.exitCode}`;
    }
  } else {
    // No sidecar container at all — it was auto-removed, likely a crash
    state = "failed";
    errorMessage = "Update sidecar exited unexpectedly (container auto-removed)";
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

  logger.info(
    { updateId: record.id, state },
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
