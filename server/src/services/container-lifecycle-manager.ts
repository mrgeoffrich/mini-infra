import Docker from "dockerode";
import { servicesLogger } from "../lib/logger-factory";
import DockerService from "./docker";
import prisma from "../lib/prisma";
import {
  ContainerConfig,
  TraefikConfig,
  DeploymentPort,
  DeploymentVolume,
  ContainerEnvVar,
} from "@mini-infra/types";

// ====================
// Container Lifecycle Types
// ====================

export interface ContainerCreateOptions {
  name: string;
  image: string;
  tag?: string;
  config: ContainerConfig;
  traefikConfig?: TraefikConfig;
  deploymentId?: string;
  labels?: Record<string, string>;
}

export interface ContainerStatusInfo {
  id: string;
  name: string;
  status: string;
  health?: string;
  created: Date;
  started?: Date;
  finished?: Date;
  exitCode?: number;
  error?: string;
}

export interface OrphanedContainer {
  id: string;
  name: string;
  created: Date;
  labels: Record<string, string>;
  reason: string;
}

// ====================
// Container Lifecycle Manager
// ====================

export class ContainerLifecycleManager {
  private dockerService: DockerService;

  constructor() {
    this.dockerService = DockerService.getInstance();
  }

  /**
   * Get the Docker network name from system settings
   */
  private async getDockerNetworkName(): Promise<string> {
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
        "Retrieved Docker network name for container deployment",
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

  // ====================
  // Container Creation
  // ====================

  /**
   * Create a new container with proper Traefik labels and deployment configuration
   */
  async createContainer(options: ContainerCreateOptions): Promise<string> {
    try {
      if (!this.dockerService.isConnected()) {
        throw new Error("Docker service is not connected");
      }

      servicesLogger().info(
        {
          containerName: options.name,
          image: options.image,
          tag: options.tag || "latest",
          deploymentId: options.deploymentId,
        },
        "Creating container",
      );

      // Build full image name
      // If image already includes a tag, use it as-is, otherwise add the tag
      const fullImage = options.image.includes(':') 
        ? options.image 
        : `${options.image}:${options.tag || "latest"}`;

      // Prepare container labels (merge deployment labels with Traefik labels)
      const labels = this.buildContainerLabels(
        options.config,
        options.traefikConfig,
        options.deploymentId,
        options.labels,
      );

      // Prepare port bindings
      const portBindings = this.buildPortBindings(options.config.ports);
      const exposedPorts = this.buildExposedPorts(options.config.ports);

      // Prepare volume bindings
      const binds = this.buildVolumeBindings(options.config.volumes);

      // Prepare environment variables
      const env = this.buildEnvironmentVariables(options.config.environment);

      // Prepare network configuration
      const defaultNetworkName = await this.getDockerNetworkName();
      const networkMode =
        options.config.networks.length > 0
          ? options.config.networks[0]
          : defaultNetworkName;

      // Create container configuration
      const containerConfig = {
        Image: fullImage,
        name: options.name,
        Labels: labels,
        Env: env,
        ExposedPorts: exposedPorts,
        HostConfig: {
          PortBindings: portBindings,
          Binds: binds,
          NetworkMode: networkMode,
          RestartPolicy: { Name: "unless-stopped" },
        },
        NetworkingConfig: this.buildNetworkConfig(options.config.networks),
      };

      servicesLogger().debug(
        {
          containerName: options.name,
          config: containerConfig,
        },
        "Container configuration prepared",
      );

      // Create the container
      const docker = (this.dockerService as any).docker as Docker;
      const container = await docker.createContainer(containerConfig);

      servicesLogger().info(
        {
          containerId: container.id,
          containerName: options.name,
          image: fullImage,
          deploymentId: options.deploymentId,
        },
        "Container created successfully",
      );

      return container.id;
    } catch (error) {
      servicesLogger().error(
        {
          containerName: options.name,
          image: options.image,
          deploymentId: options.deploymentId,
          error: error instanceof Error ? error.message : "Unknown error",
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to create container",
      );
      throw error;
    }
  }

  // ====================
  // Container Lifecycle Operations
  // ====================

  /**
   * Start a container
   */
  async startContainer(containerId: string): Promise<void> {
    try {
      if (!this.dockerService.isConnected()) {
        throw new Error("Docker service is not connected");
      }

      servicesLogger().info({ containerId }, "Starting container");

      const docker = (this.dockerService as any).docker as Docker;
      const container = docker.getContainer(containerId);
      await container.start();

      servicesLogger().info({ containerId }, "Container started successfully");
    } catch (error) {
      servicesLogger().error(
        {
          containerId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to start container",
      );
      throw error;
    }
  }

  /**
   * Stop a container with graceful shutdown
   */
  async stopContainer(
    containerId: string,
    timeout: number = 30,
  ): Promise<void> {
    try {
      if (!this.dockerService.isConnected()) {
        throw new Error("Docker service is not connected");
      }

      servicesLogger().info({ containerId, timeout }, "Stopping container");

      const docker = (this.dockerService as any).docker as Docker;
      const container = docker.getContainer(containerId);

      // Try graceful stop first
      try {
        await container.stop({ t: timeout });
      } catch (error: any) {
        // If container is already stopped, that's fine
        if (error.statusCode !== 304) {
          throw error;
        }
      }

      servicesLogger().info({ containerId }, "Container stopped successfully");
    } catch (error) {
      servicesLogger().error(
        {
          containerId,
          timeout,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to stop container",
      );
      throw error;
    }
  }

  /**
   * Remove a container (with optional force)
   */
  async removeContainer(
    containerId: string,
    force: boolean = false,
  ): Promise<void> {
    try {
      if (!this.dockerService.isConnected()) {
        throw new Error("Docker service is not connected");
      }

      servicesLogger().info({ containerId, force }, "Removing container");

      const docker = (this.dockerService as any).docker as Docker;
      const container = docker.getContainer(containerId);

      await container.remove({
        force,
        v: true, // Remove associated volumes
      });

      servicesLogger().info({ containerId }, "Container removed successfully");
    } catch (error) {
      servicesLogger().error(
        {
          containerId,
          force,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to remove container",
      );
      throw error;
    }
  }

  /**
   * Restart a container
   */
  async restartContainer(
    containerId: string,
    timeout: number = 30,
  ): Promise<void> {
    try {
      servicesLogger().info({ containerId, timeout }, "Restarting container");

      await this.stopContainer(containerId, timeout);
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Brief pause
      await this.startContainer(containerId);

      servicesLogger().info(
        { containerId },
        "Container restarted successfully",
      );
    } catch (error) {
      servicesLogger().error(
        {
          containerId,
          timeout,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to restart container",
      );
      throw error;
    }
  }

  // ====================
  // Container Status and Monitoring
  // ====================

  /**
   * Get detailed status information for a container
   */
  async getContainerStatus(
    containerId: string,
  ): Promise<ContainerStatusInfo | null> {
    try {
      if (!this.dockerService.isConnected()) {
        throw new Error("Docker service is not connected");
      }

      const docker = (this.dockerService as any).docker as Docker;
      const container = docker.getContainer(containerId);

      try {
        const data = await container.inspect();

        return {
          id: data.Id,
          name: data.Name.replace(/^\//, ""),
          status: data.State.Status,
          health: data.State.Health?.Status,
          created: new Date(data.Created),
          started: data.State.StartedAt
            ? new Date(data.State.StartedAt)
            : undefined,
          finished: data.State.FinishedAt
            ? new Date(data.State.FinishedAt)
            : undefined,
          exitCode: data.State.ExitCode,
          error: data.State.Error || undefined,
        };
      } catch (error: any) {
        if (error.statusCode === 404) {
          return null; // Container doesn't exist
        }
        throw error;
      }
    } catch (error) {
      servicesLogger().error(
        {
          containerId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get container status",
      );
      throw error;
    }
  }

  /**
   * Check if a container is running
   */
  async isContainerRunning(containerId: string): Promise<boolean> {
    try {
      const status = await this.getContainerStatus(containerId);
      return status?.status === "running" || false;
    } catch (error) {
      servicesLogger().error(
        {
          containerId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to check if container is running",
      );
      return false;
    }
  }

  /**
   * Wait for container to reach a specific status
   */
  async waitForContainerStatus(
    containerId: string,
    targetStatus: string,
    timeoutMs: number = 60000,
    pollIntervalMs: number = 1000,
  ): Promise<boolean> {
    const startTime = Date.now();

    servicesLogger().info(
      {
        containerId,
        targetStatus,
        timeoutMs,
        pollIntervalMs,
      },
      "Waiting for container status",
    );

    while (Date.now() - startTime < timeoutMs) {
      try {
        const status = await this.getContainerStatus(containerId);

        if (!status) {
          servicesLogger().warn(
            { containerId },
            "Container no longer exists while waiting for status",
          );
          return false;
        }

        if (status.status === targetStatus) {
          servicesLogger().info(
            {
              containerId,
              targetStatus,
              actualStatus: status.status,
              elapsedMs: Date.now() - startTime,
            },
            "Container reached target status",
          );
          return true;
        }

        // Check for failure states
        if (status.status === "exited" && targetStatus === "running") {
          servicesLogger().warn(
            {
              containerId,
              targetStatus,
              actualStatus: status.status,
              exitCode: status.exitCode,
              error: status.error,
            },
            "Container exited while waiting for running status",
          );
          return false;
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      } catch (error) {
        servicesLogger().error(
          {
            containerId,
            targetStatus,
            error: error instanceof Error ? error.message : "Unknown error",
          },
          "Error while waiting for container status",
        );
        return false;
      }
    }

    servicesLogger().warn(
      {
        containerId,
        targetStatus,
        timeoutMs,
        elapsedMs: Date.now() - startTime,
      },
      "Timeout waiting for container status",
    );

    return false;
  }

  // ====================
  // Container Cleanup
  // ====================

  /**
   * Find orphaned containers from failed deployments
   */
  async findOrphanedContainers(
    maxAgeHours: number = 24,
  ): Promise<OrphanedContainer[]> {
    try {
      if (!this.dockerService.isConnected()) {
        throw new Error("Docker service is not connected");
      }

      servicesLogger().info(
        { maxAgeHours },
        "Searching for orphaned containers",
      );

      const docker = (this.dockerService as any).docker as Docker;
      const containers = await docker.listContainers({ all: true });

      const cutoffTime = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
      const orphaned: OrphanedContainer[] = [];

      for (const container of containers) {
        const created = new Date(container.Created * 1000);
        const labels = container.Labels || {};

        // Check if this looks like a deployment container that might be orphaned
        const isDeploymentContainer =
          labels["mini-infra.deployment.id"] ||
          labels["mini-infra.application"] ||
          container.Names[0]?.includes("deployment-") ||
          container.Names[0]?.includes("-blue") ||
          container.Names[0]?.includes("-green");

        if (!isDeploymentContainer) {
          continue;
        }

        let reason = "";

        // Check various orphan conditions
        if (container.State === "exited" && created < cutoffTime) {
          reason = "Container exited and is older than maximum age";
        } else if (
          container.State === "created" &&
          created < new Date(Date.now() - 30 * 60 * 1000)
        ) {
          reason =
            "Container created but never started (older than 30 minutes)";
        } else if (labels["mini-infra.deployment.cleanup"] === "true") {
          reason = "Container marked for cleanup";
        }

        if (reason) {
          orphaned.push({
            id: container.Id,
            name: container.Names[0]?.replace(/^\//, "") || "unknown",
            created,
            labels,
            reason,
          });
        }
      }

      servicesLogger().info(
        {
          orphanedCount: orphaned.length,
          maxAgeHours,
        },
        "Found orphaned containers",
      );

      return orphaned;
    } catch (error) {
      servicesLogger().error(
        {
          maxAgeHours,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to find orphaned containers",
      );
      throw error;
    }
  }

  /**
   * Clean up orphaned containers
   */
  async cleanupOrphanedContainers(
    maxAgeHours: number = 24,
    dryRun: boolean = false,
  ): Promise<number> {
    try {
      const orphaned = await this.findOrphanedContainers(maxAgeHours);

      if (orphaned.length === 0) {
        servicesLogger().info("No orphaned containers found to cleanup");
        return 0;
      }

      if (dryRun) {
        servicesLogger().info(
          { orphanedContainers: orphaned },
          "Dry run: Would cleanup orphaned containers",
        );
        return orphaned.length;
      }

      let cleanedCount = 0;

      for (const container of orphaned) {
        try {
          servicesLogger().info(
            {
              containerId: container.id,
              containerName: container.name,
              reason: container.reason,
            },
            "Cleaning up orphaned container",
          );

          // Stop if running
          try {
            await this.stopContainer(container.id, 10);
          } catch (error) {
            // Ignore stop errors, container might already be stopped
          }

          // Remove container
          await this.removeContainer(container.id, true);
          cleanedCount++;

          servicesLogger().info(
            {
              containerId: container.id,
              containerName: container.name,
            },
            "Orphaned container cleaned up successfully",
          );
        } catch (error) {
          servicesLogger().error(
            {
              containerId: container.id,
              containerName: container.name,
              error: error instanceof Error ? error.message : "Unknown error",
            },
            "Failed to cleanup orphaned container",
          );
        }
      }

      servicesLogger().info(
        {
          totalOrphaned: orphaned.length,
          cleanedCount,
          failedCount: orphaned.length - cleanedCount,
        },
        "Orphaned container cleanup completed",
      );

      return cleanedCount;
    } catch (error) {
      servicesLogger().error(
        {
          maxAgeHours,
          dryRun,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to cleanup orphaned containers",
      );
      throw error;
    }
  }

  // ====================
  // Private Helper Methods
  // ====================

  /**
   * Build container labels including Traefik configuration
   */
  private buildContainerLabels(
    config: ContainerConfig,
    traefikConfig?: TraefikConfig,
    deploymentId?: string,
    additionalLabels?: Record<string, string>,
  ): Record<string, string> {
    const labels: Record<string, string> = {
      // Basic mini-infra labels
      "mini-infra.managed": "true",
      "mini-infra.created": new Date().toISOString(),
      ...config.labels,
      ...additionalLabels,
    };

    // Add deployment-specific labels
    if (deploymentId) {
      labels["mini-infra.deployment.id"] = deploymentId;
    }

    // Add Traefik labels if configuration is provided
    if (traefikConfig) {
      labels["traefik.enable"] = "true";
      labels[`traefik.http.routers.${traefikConfig.routerName}.rule`] =
        traefikConfig.rule;
      labels[`traefik.http.routers.${traefikConfig.routerName}.service`] =
        traefikConfig.serviceName;

      // Set service port (use first port from config)
      if (config.ports.length > 0) {
        labels[
          `traefik.http.services.${traefikConfig.serviceName}.loadbalancer.server.port`
        ] = config.ports[0].containerPort.toString();
      }

      // Add middlewares if specified
      if (traefikConfig.middlewares && traefikConfig.middlewares.length > 0) {
        labels[`traefik.http.routers.${traefikConfig.routerName}.middlewares`] =
          traefikConfig.middlewares.join(",");
      }

      // Add TLS configuration if enabled
      if (traefikConfig.tls) {
        labels[`traefik.http.routers.${traefikConfig.routerName}.tls`] = "true";
      }
    }

    return labels;
  }

  /**
   * Build Docker port bindings from deployment port configuration
   */
  private buildPortBindings(ports: DeploymentPort[]): Record<string, any[]> {
    const bindings: Record<string, any[]> = {};

    for (const port of ports) {
      const key = `${port.containerPort}/${port.protocol || "tcp"}`;

      if (port.hostPort) {
        bindings[key] = [{ HostPort: port.hostPort.toString() }];
      } else {
        bindings[key] = [{}]; // Let Docker assign a random port
      }
    }

    return bindings;
  }

  /**
   * Build Docker exposed ports from deployment port configuration
   */
  private buildExposedPorts(ports: DeploymentPort[]): Record<string, {}> {
    const exposed: Record<string, {}> = {};

    for (const port of ports) {
      const key = `${port.containerPort}/${port.protocol || "tcp"}`;
      exposed[key] = {};
    }

    return exposed;
  }

  /**
   * Build Docker volume bindings from deployment volume configuration
   */
  private buildVolumeBindings(volumes: DeploymentVolume[]): string[] {
    return volumes.map(
      (volume) =>
        `${volume.hostPath}:${volume.containerPath}:${volume.mode || "rw"}`,
    );
  }

  /**
   * Build environment variables array from deployment configuration
   */
  private buildEnvironmentVariables(envVars: ContainerEnvVar[]): string[] {
    return envVars.map((envVar) => `${envVar.name}=${envVar.value}`);
  }

  /**
   * Build network configuration for container creation
   */
  private buildNetworkConfig(networks: string[]): any {
    if (networks.length === 0) {
      return {};
    }

    const config: any = {
      EndpointsConfig: {},
    };

    // Configure each network
    for (const network of networks) {
      config.EndpointsConfig[network] = {};
    }

    return config;
  }
}

export default ContainerLifecycleManager;
