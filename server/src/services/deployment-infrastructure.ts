import { appLogger } from "../lib/logger-factory";
import DockerService from "./docker";
import prisma from "../lib/prisma";
import * as yaml from "js-yaml";

const logger = appLogger();

export class DeploymentInfrastructureService {
  private dockerService: DockerService;

  constructor() {
    this.dockerService = DockerService.getInstance();
  }

  /**
   * Create or update the Docker network for deployments
   */
  async ensureDeploymentNetwork(
    networkName: string,
    networkDriver: string = "bridge",
  ): Promise<{ success: boolean; networkId?: string; error?: string }> {
    try {
      const docker = await this.dockerService.getDockerInstance();

      // Check if network already exists
      const networks = await docker.listNetworks({
        filters: { name: [networkName] },
      });

      if (networks.length > 0) {
        logger.info(
          { networkName, networkId: networks[0].Id },
          "Deployment network already exists",
        );
        return { success: true, networkId: networks[0].Id };
      }

      // Create the network
      logger.info(
        { networkName, networkDriver },
        "Creating deployment network",
      );
      const network = await docker.createNetwork({
        Name: networkName,
        Driver: networkDriver,
        Labels: {
          "mini-infra.type": "deployment-network",
          "mini-infra.managed": "true",
        },
      });

      logger.info(
        { networkName, networkId: network.id },
        "Deployment network created successfully",
      );
      return { success: true, networkId: network.id };
    } catch (error) {
      logger.error(
        { error, networkName, networkDriver },
        "Failed to create deployment network",
      );
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error creating network",
      };
    }
  }

  /**
   * Deploy or update the Traefik container
   */
  async ensureTraefikContainer(config: {
    image: string;
    webPort: number;
    dashboardPort: number;
    configYaml: string;
    networkName: string;
  }): Promise<{ success: boolean; containerId?: string; error?: string }> {
    try {
      const docker = await this.dockerService.getDockerInstance();

      // Validate YAML configuration
      try {
        yaml.load(config.configYaml);
      } catch (yamlError) {
        return {
          success: false,
          error: `Invalid YAML configuration: ${yamlError instanceof Error ? yamlError.message : "Unknown YAML error"}`,
        };
      }

      // Check if Traefik container already exists
      const containers = await docker.listContainers({
        all: true,
        filters: { label: ["mini-infra.service=traefik"] },
      });

      // Stop and remove existing Traefik container
      if (containers.length > 0) {
        logger.info(
          { containerId: containers[0].Id },
          "Stopping existing Traefik container",
        );
        const existingContainer = docker.getContainer(containers[0].Id);

        try {
          await existingContainer.stop();
        } catch (stopError) {
          logger.warn(
            { error: stopError },
            "Failed to stop existing container (may already be stopped)",
          );
        }

        await existingContainer.remove();
        logger.info(
          { containerId: containers[0].Id },
          "Removed existing Traefik container",
        );
      }

      // Ensure the network exists
      const networkResult = await this.ensureDeploymentNetwork(
        config.networkName,
      );
      if (!networkResult.success) {
        return {
          success: false,
          error: `Failed to create network: ${networkResult.error}`,
        };
      }

      // Create Traefik container with command line configuration
      // We'll use command line args instead of config file for simplicity
      const container = await docker.createContainer({
        Image: config.image,
        name: "traefik-mini-infra",
        Labels: {
          "mini-infra.service": "traefik",
          "mini-infra.managed": "true",
          "mini-infra.type": "load-balancer",
        },
        ExposedPorts: {
          [`${config.webPort}/tcp`]: {},
          [`${config.dashboardPort}/tcp`]: {},
        },
        HostConfig: {
          PortBindings: {
            [`${config.webPort}/tcp`]: [
              { HostPort: config.webPort.toString() },
            ],
            [`${config.dashboardPort}/tcp`]: [
              { HostPort: config.dashboardPort.toString() },
            ],
          },
          Binds: ["/var/run/docker.sock:/var/run/docker.sock:ro"],
          NetworkMode: config.networkName,
        },
        // Use basic command line configuration for now
        Cmd: [
          `--entrypoints.web.address=:${config.webPort}`,
          `--entrypoints.traefik.address=:${config.dashboardPort}`,
          "--providers.docker=true",
          "--providers.docker.exposedbydefault=false",
          `--providers.docker.network=${config.networkName}`,
          "--api.dashboard=true",
          "--api.insecure=true",
          "--log.level=INFO",
        ],
      });

      // Start the container
      await container.start();

      logger.info(
        {
          containerId: container.id,
          webPort: config.webPort,
          dashboardPort: config.dashboardPort,
          networkName: config.networkName,
        },
        "Traefik container deployed successfully",
      );

      return { success: true, containerId: container.id };
    } catch (error) {
      logger.error({ error, config }, "Failed to deploy Traefik container");
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error deploying Traefik",
      };
    }
  }

  /**
   * Get the status of the deployment infrastructure
   */
  async getInfrastructureStatus(networkName: string): Promise<{
    networkStatus: { exists: boolean; id?: string; error?: string };
    traefikStatus: {
      exists: boolean;
      running: boolean;
      id?: string;
      error?: string;
    };
  }> {
    try {
      const docker = await this.dockerService.getDockerInstance();

      // Check network status
      const networks = await docker.listNetworks({
        filters: { name: [networkName] },
      });
      const networkStatus =
        networks.length > 0
          ? { exists: true, id: networks[0].Id }
          : { exists: false };

      // Check Traefik status
      const containers = await docker.listContainers({
        all: true,
        filters: { label: ["mini-infra.service=traefik"] },
      });

      let traefikStatus: {
        exists: boolean;
        running: boolean;
        id?: string;
        error?: string;
      };

      if (containers.length > 0) {
        const container = containers[0];
        traefikStatus = {
          exists: true,
          running: container.State === "running",
          id: container.Id,
        };
      } else {
        traefikStatus = { exists: false, running: false };
      }

      return { networkStatus, traefikStatus };
    } catch (error) {
      logger.error(
        { error, networkName },
        "Failed to get infrastructure status",
      );
      return {
        networkStatus: {
          exists: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        traefikStatus: {
          exists: false,
          running: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }

  /**
   * Clean up deployment infrastructure
   */
  async cleanupInfrastructure(
    networkName: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const docker = await this.dockerService.getDockerInstance();

      // Stop and remove Traefik container
      const containers = await docker.listContainers({
        all: true,
        filters: { label: ["mini-infra.service=traefik"] },
      });

      for (const containerInfo of containers) {
        const container = docker.getContainer(containerInfo.Id);
        try {
          await container.stop();
        } catch (stopError) {
          logger.warn(
            { error: stopError, containerId: containerInfo.Id },
            "Failed to stop container",
          );
        }
        await container.remove();
        logger.info(
          { containerId: containerInfo.Id },
          "Removed Traefik container",
        );
      }

      // Remove network
      const networks = await docker.listNetworks({
        filters: { name: [networkName] },
      });

      for (const networkInfo of networks) {
        const network = docker.getNetwork(networkInfo.Id);
        await network.remove();
        logger.info(
          { networkId: networkInfo.Id, networkName },
          "Removed deployment network",
        );
      }

      return { success: true };
    } catch (error) {
      logger.error({ error, networkName }, "Failed to cleanup infrastructure");
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error during cleanup",
      };
    }
  }
}
