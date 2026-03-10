import Docker from "dockerode";
import { logger } from "./logger";
import { StatusReporter } from "./status-reporter";
import { inspectContainer, CapturedContainerSettings } from "./container-inspector";
import { waitForHealthy } from "./health-checker";

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const TARGET_IMAGE = requireEnv("TARGET_IMAGE");
const CONTAINER_ID = requireEnv("CONTAINER_ID");
const HEALTH_CHECK_URL = requireEnv("HEALTH_CHECK_URL");
const HEALTH_CHECK_TIMEOUT_MS = parseInt(
  process.env.HEALTH_CHECK_TIMEOUT_MS ?? "60000",
  10,
);
const STATUS_FILE = process.env.STATUS_FILE ?? "/status/update-status.json";
const GRACEFUL_STOP_SECONDS = parseInt(
  process.env.GRACEFUL_STOP_SECONDS ?? "30",
  10,
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    logger.fatal(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Main update orchestration
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const docker = new Docker({ socketPath: "/var/run/docker.sock" });
  const status = new StatusReporter(STATUS_FILE);

  let oldContainerName: string | undefined;
  let newContainerId: string | undefined;

  try {
    // -----------------------------------------------------------------------
    // 1. Pull the target image
    // -----------------------------------------------------------------------
    status.report("pulling", { targetTag: TARGET_IMAGE });
    await pullImage(docker, TARGET_IMAGE, status);

    // -----------------------------------------------------------------------
    // 2. Inspect the running container to capture its settings
    // -----------------------------------------------------------------------
    status.report("inspecting");
    const settings = await inspectContainer(docker, CONTAINER_ID);
    oldContainerName = settings.name;

    // -----------------------------------------------------------------------
    // 3. Stop the running container gracefully
    // -----------------------------------------------------------------------
    status.report("stopping");
    const oldContainer = docker.getContainer(CONTAINER_ID);
    logger.info(
      { containerId: CONTAINER_ID, timeout: GRACEFUL_STOP_SECONDS },
      "Stopping old container",
    );
    await oldContainer.stop({ t: GRACEFUL_STOP_SECONDS });

    // Rename so we can reuse the original name for the new container
    const backupName = `${settings.name}-old-${Date.now()}`;
    await oldContainer.rename({ name: backupName });
    logger.info({ from: settings.name, to: backupName }, "Renamed old container");

    // -----------------------------------------------------------------------
    // 4. Create and start the new container
    // -----------------------------------------------------------------------
    status.report("creating");
    const newContainer = await createContainer(docker, TARGET_IMAGE, settings);
    newContainerId = (newContainer as unknown as { id: string }).id;
    await newContainer.start();
    logger.info({ newContainerId }, "New container started");

    // -----------------------------------------------------------------------
    // 5. Health-check the new container
    // -----------------------------------------------------------------------
    status.report("health-checking");
    const healthy = await waitForHealthy({
      url: HEALTH_CHECK_URL,
      timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
    });

    if (healthy) {
      // Success — clean up the old container
      status.report("complete", { targetTag: TARGET_IMAGE });
      logger.info("Update successful, removing old container");
      try {
        await oldContainer.remove({ v: false });
      } catch (err) {
        logger.warn({ err }, "Failed to remove old container (non-fatal)");
      }
      process.exit(0);
    }

    // -------------------------------------------------------------------
    // 6. Rollback — new container failed health checks
    // -------------------------------------------------------------------
    logger.error("New container failed health check, initiating rollback");
    status.report("rolling-back");
    await rollback(docker, newContainerId, oldContainer, settings.name);
    status.report("rollback-complete", {
      error: "New container failed health check",
    });
    process.exit(1);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.fatal({ err }, "Update failed");
    status.report("failed", { error: errorMessage });

    // Attempt rollback if we got far enough to have stopped the old container
    if (oldContainerName && newContainerId) {
      try {
        logger.info("Attempting rollback after failure");
        status.report("rolling-back", { error: errorMessage });
        const oldContainer = docker.getContainer(CONTAINER_ID);
        await rollback(docker, newContainerId, oldContainer, oldContainerName);
        status.report("rollback-complete", { error: errorMessage });
      } catch (rollbackErr) {
        logger.fatal({ rollbackErr }, "Rollback also failed — manual intervention required");
        status.report("failed", {
          error: `Update failed: ${errorMessage}. Rollback also failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
        });
      }
    }

    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pulls a Docker image, reporting layer-level progress to the status reporter.
 */
async function pullImage(
  docker: Docker,
  image: string,
  status: StatusReporter,
): Promise<void> {
  logger.info({ image }, "Pulling image");

  const stream = await docker.pull(image);

  await new Promise<void>((resolve, reject) => {
    const layerProgress = new Map<string, { current: number; total: number }>();

    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      },
      (event: { id?: string; status?: string; progressDetail?: { current?: number; total?: number } }) => {
        // Track per-layer progress for an overall percentage
        if (event.id && event.progressDetail?.total) {
          layerProgress.set(event.id, {
            current: event.progressDetail.current ?? 0,
            total: event.progressDetail.total,
          });

          let totalBytes = 0;
          let downloadedBytes = 0;
          for (const lp of layerProgress.values()) {
            totalBytes += lp.total;
            downloadedBytes += lp.current;
          }

          const progress =
            totalBytes > 0
              ? Math.round((downloadedBytes / totalBytes) * 100)
              : 0;

          status.report("pulling", { targetTag: image, progress });
        }
      },
    );
  });

  logger.info({ image }, "Image pulled successfully");
}

/**
 * Creates a new container with the target image and captured settings.
 */
async function createContainer(
  docker: Docker,
  image: string,
  settings: CapturedContainerSettings,
): Promise<Docker.Container> {
  logger.info({ image, name: settings.name }, "Creating new container");

  return docker.createContainer({
    Image: image,
    name: settings.name,
    Env: settings.env,
    Labels: settings.labels,
    ExposedPorts: settings.exposedPorts,
    HostConfig: settings.hostConfig,
    NetworkingConfig: settings.networkingConfig,
  } as Docker.ContainerCreateOptions);
}

/**
 * Rolls back by stopping/removing the new container and restoring the old one.
 */
async function rollback(
  docker: Docker,
  newContainerId: string,
  oldContainer: Docker.Container,
  originalName: string,
): Promise<void> {
  // Stop and remove the failed new container
  const newContainer = docker.getContainer(newContainerId);
  try {
    await newContainer.stop({ t: 10 });
  } catch {
    // May already be stopped
  }
  try {
    await newContainer.remove({ v: false });
  } catch (err) {
    logger.warn({ err }, "Failed to remove new container during rollback");
  }

  // Restore the old container's original name and start it
  await oldContainer.rename({ name: originalName });
  await oldContainer.start();
  logger.info("Rollback complete — old container restored");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main();
