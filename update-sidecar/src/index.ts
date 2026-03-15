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

  let oldContainerName: string | undefined;
  let newContainerId: string | undefined;

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
    const { container: newContainer, additionalNetworks } = await createContainer(docker, TARGET_IMAGE, settings);
    newContainerId = (newContainer as unknown as { id: string }).id;
    await newContainer.start();
    logger.info({ newContainerId }, "New container started");

    // Connect to additional networks after start (Docker API limitation:
    // only one network can be attached at creation time)
    if (additionalNetworks.size > 0) {
      await connectAdditionalNetworks(docker, newContainerId, additionalNetworks);
    }

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
 * Creates a new container with the target image and captured settings.
 *
 * Docker API only connects a container to ONE network at creation time.
 * If the original container was on multiple networks, we create with the
 * primary network (matching HostConfig.NetworkMode) and then explicitly
 * connect to additional networks after the container is started.
 */
async function createContainer(
  docker: Docker,
  image: string,
  settings: CapturedContainerSettings,
): Promise<{ container: Docker.Container; additionalNetworks: Map<string, { Aliases?: string[] }> }> {
  logger.info({ image, name: settings.name }, "Creating new container");

  // Determine the primary network (from NetworkMode)
  const primaryNetwork = settings.hostConfig.NetworkMode;
  const allNetworks = settings.networkingConfig.EndpointsConfig;
  const networkNames = Object.keys(allNetworks);

  // Build NetworkingConfig with only the primary network
  const primaryNetworkConfig: CapturedContainerSettings["networkingConfig"] = {
    EndpointsConfig: {},
  };

  // Collect additional networks to connect after start
  const additionalNetworks = new Map<string, { Aliases?: string[] }>();

  for (const [netName, netConfig] of Object.entries(allNetworks)) {
    if (netName === primaryNetwork) {
      primaryNetworkConfig.EndpointsConfig[netName] = netConfig;
    } else {
      additionalNetworks.set(netName, netConfig);
    }
  }

  // If primary network wasn't in EndpointsConfig, use first network
  if (Object.keys(primaryNetworkConfig.EndpointsConfig).length === 0 && networkNames.length > 0) {
    primaryNetworkConfig.EndpointsConfig[networkNames[0]] = allNetworks[networkNames[0]];
    for (let i = 1; i < networkNames.length; i++) {
      additionalNetworks.set(networkNames[i], allNetworks[networkNames[i]]);
    }
  }

  if (additionalNetworks.size > 0) {
    logger.info(
      { primaryNetwork, additionalNetworks: [...additionalNetworks.keys()] },
      "Container has multiple networks — will connect additional networks after start",
    );
  }

  const container = await docker.createContainer({
    Image: image,
    name: settings.name,
    Env: settings.env,
    Labels: settings.labels,
    ExposedPorts: settings.exposedPorts,
    HostConfig: settings.hostConfig,
    NetworkingConfig: primaryNetworkConfig,
  } as Docker.ContainerCreateOptions);

  return { container, additionalNetworks };
}

/**
 * Connects a container to additional Docker networks after it has been started.
 */
async function connectAdditionalNetworks(
  docker: Docker,
  containerId: string,
  additionalNetworks: Map<string, { Aliases?: string[] }>,
): Promise<void> {
  for (const [netName, netConfig] of additionalNetworks) {
    try {
      const network = docker.getNetwork(netName);
      await network.connect({
        Container: containerId,
        EndpointConfig: {
          Aliases: netConfig.Aliases,
        },
      });
      logger.info({ network: netName, containerId }, "Connected container to additional network");
    } catch (err) {
      logger.warn({ err, network: netName, containerId }, "Failed to connect container to additional network (non-fatal)");
    }
  }
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
