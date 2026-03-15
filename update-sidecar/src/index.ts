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
  process.env.HEALTH_CHECK_TIMEOUT_MS ?? "180000",
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

  try {
    // -----------------------------------------------------------------------
    // 1. Verify the target image exists locally (pre-pulled by the server)
    // -----------------------------------------------------------------------
    logger.info({ state: "pulling", targetTag: TARGET_IMAGE }, "Update status: verifying image");
    try {
      await docker.getImage(TARGET_IMAGE).inspect();
      logger.info({ image: TARGET_IMAGE }, "Target image found locally (pre-pulled by server)");
    } catch {
      throw new Error(
        `Target image "${TARGET_IMAGE}" not found locally. The server must pre-pull the image before launching the sidecar.`,
      );
    }

    // -----------------------------------------------------------------------
    // 2. Inspect the running container to capture its settings
    // -----------------------------------------------------------------------
    logger.info({ state: "inspecting" }, "Update status: inspecting");
    const settings = await inspectContainer(docker, CONTAINER_ID);

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

    // Remove old container to free up the name for the new one
    await oldContainer.remove({ v: false });
    logger.info({ containerId: CONTAINER_ID }, "Old container removed");

    // -----------------------------------------------------------------------
    // 4. Create and start the new container
    // -----------------------------------------------------------------------
    logger.info({ state: "creating" }, "Update status: creating");
    const newContainer = await createContainer(docker, TARGET_IMAGE, settings);
    await newContainer.start();
    logger.info("New container started");

    // -----------------------------------------------------------------------
    // 5. Health-check the new container
    // -----------------------------------------------------------------------
    logger.info({ state: "health-checking" }, "Update status: health-checking");
    const healthy = await waitForHealthy({
      url: HEALTH_CHECK_URL,
      timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
    });

    if (healthy) {
      logger.info({ state: "complete", targetTag: TARGET_IMAGE }, "Update status: complete");
      process.exit(0);
    }

    logger.error({ state: "failed", error: "New container failed health check" }, "Update status: failed");
    process.exit(1);
  } catch (err) {
    logger.fatal({ err }, "Update failed");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a new container with the target image and captured settings.
 * All networks are passed at creation time (requires Docker API >= 1.44).
 */
async function createContainer(
  docker: Docker,
  image: string,
  settings: CapturedContainerSettings,
): Promise<Docker.Container> {
  logger.info({ image, name: settings.name }, "Creating new container");

  const container = await docker.createContainer({
    Image: image,
    name: settings.name,
    Env: settings.env,
    Labels: settings.labels,
    ExposedPorts: settings.exposedPorts,
    HostConfig: settings.hostConfig,
    NetworkingConfig: settings.networkingConfig,
  } as Docker.ContainerCreateOptions);

  return container;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main();
