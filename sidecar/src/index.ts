import Docker from "dockerode";
import { logger } from "./logger";
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

  let oldContainerName: string | undefined;
  let newContainerId: string | undefined;

  try {
    // -----------------------------------------------------------------------
    // 1. Pull the target image
    // -----------------------------------------------------------------------
    logger.info({ state: "pulling", targetTag: TARGET_IMAGE }, "Update status: pulling");
    await pullImage(docker, TARGET_IMAGE);

    // -----------------------------------------------------------------------
    // 2. Inspect the running container to capture its settings
    // -----------------------------------------------------------------------
    logger.info({ state: "inspecting" }, "Update status: inspecting");
    const settings = await inspectContainer(docker, CONTAINER_ID);
    oldContainerName = settings.name;

    // -----------------------------------------------------------------------
    // 3. Stop the running container gracefully
    // -----------------------------------------------------------------------
    logger.info({ state: "stopping" }, "Update status: stopping");
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
    logger.info({ state: "creating" }, "Update status: creating");
    const newContainer = await createContainer(docker, TARGET_IMAGE, settings);
    newContainerId = (newContainer as unknown as { id: string }).id;
    await newContainer.start();
    logger.info({ newContainerId }, "New container started");

    // -----------------------------------------------------------------------
    // 5. Health-check the new container
    // -----------------------------------------------------------------------
    logger.info({ state: "health-checking" }, "Update status: health-checking");
    const healthy = await waitForHealthy({
      url: HEALTH_CHECK_URL,
      timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
    });

    if (healthy) {
      // Success — clean up the old container
      logger.info({ state: "complete", targetTag: TARGET_IMAGE }, "Update status: complete");
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
    logger.info({ state: "rolling-back" }, "Update status: rolling-back");
    await rollback(docker, newContainerId, oldContainer, settings.name);
    logger.info(
      { state: "rollback-complete", error: "New container failed health check" },
      "Update status: rollback-complete",
    );
    process.exit(1);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.fatal({ err }, "Update failed");

    // Attempt rollback if we got far enough to have stopped the old container.
    if (oldContainerName) {
      try {
        logger.info({ state: "rolling-back", error: errorMessage }, "Update status: rolling-back");
        const oldContainer = docker.getContainer(CONTAINER_ID);

        if (newContainerId) {
          await rollback(docker, newContainerId, oldContainer, oldContainerName);
        } else {
          logger.info("No new container to remove, restoring old container only");
          await oldContainer.rename({ name: oldContainerName });
          await oldContainer.start();
          logger.info("Rollback complete — old container restored");
        }

        logger.info(
          { state: "rollback-complete", error: errorMessage },
          "Update status: rollback-complete",
        );
      } catch (rollbackErr) {
        logger.fatal({ rollbackErr }, "Rollback also failed — manual intervention required");
      }
    }

    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pulls a Docker image, logging layer-level progress.
 */
async function pullImage(docker: Docker, image: string): Promise<void> {
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

          logger.info({ state: "pulling", progress, image }, `Pull progress: ${progress}%`);
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

  await oldContainer.rename({ name: originalName });
  await oldContainer.start();
  logger.info("Rollback complete — old container restored");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main();
