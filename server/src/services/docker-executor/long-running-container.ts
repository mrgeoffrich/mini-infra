import Docker, { Container } from "dockerode";
import { servicesLogger } from "../../lib/logger-factory";
import ContainerLabelManager from "../container-label-manager";
import type { ContainerExecutionOptions } from "./types";
import { generateTaskId } from "./utils";

/**
 * LongRunningContainerManager - Creates persistent, long-running Docker containers
 */
export class LongRunningContainerManager {
  private docker: Docker;
  private labelManager: ContainerLabelManager;

  constructor(docker: Docker, labelManager: ContainerLabelManager) {
    this.docker = docker;
    this.labelManager = labelManager;
  }

  /**
   * Create a long-running container with compose-style labels
   * Unlike executeContainer, this creates but doesn't auto-remove the container
   */
  public async createLongRunningContainer(
    options: ContainerExecutionOptions & {
      name?: string;
      ports?: Record<string, { HostPort: string }[]>;
      volumes?: string[];
      mounts?: Array<{
        Target: string;
        Source: string;
        Type: 'volume' | 'bind';
        ReadOnly?: boolean;
      }>;
      networks?: string[];
      restartPolicy?: 'no' | 'on-failure' | 'unless-stopped' | 'always';
      healthcheck?: {
        Test: string[];
        Interval?: number;
        Timeout?: number;
        Retries?: number;
        StartPeriod?: number;
      };
      logConfig?: {
        Type: string;
        Config: Record<string, string>;
      };
    }
  ): Promise<Container> {
    try {
      servicesLogger().info(
        {
          image: options.image,
          name: options.name,
          projectName: options.projectName,
          serviceName: options.serviceName,
        },
        "Creating long-running container"
      );

      // Convert environment variables to Docker format
      const env = Object.entries(options.env).map(
        ([key, value]) => `${key}=${value}`,
      );

      const containerOptions: any = {
        Image: options.image,
        name: options.name,
        Env: env,
        Labels: this.labelManager.generateTaskExecutionLabels({
          projectName: options.projectName,
          serviceName: options.serviceName,
          containerPurpose: "utility",
          isTemporary: false, // Long-running containers are not temporary
          taskType: "long-running-service",
          taskId: options.name || generateTaskId(options),
          customLabels: options.labels,
        }),
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        HostConfig: {},
      };

      // Add custom command if provided
      if (options.cmd) {
        containerOptions.Cmd = options.cmd;
      }

      // Add network mode if provided
      if (options.networkMode) {
        containerOptions.HostConfig.NetworkMode = options.networkMode;
      }

      // Add port bindings - need both ExposedPorts and PortBindings
      if (options.ports) {
        // First expose the ports at container level
        containerOptions.ExposedPorts = {};
        for (const port of Object.keys(options.ports)) {
          containerOptions.ExposedPorts[port] = {};
        }
        // Then bind them to host ports
        containerOptions.HostConfig.PortBindings = options.ports;
      }

      // Add bind mounts
      if (options.volumes) {
        containerOptions.HostConfig.Binds = options.volumes;
      }

      // Add volume mounts
      if (options.mounts) {
        containerOptions.HostConfig.Mounts = options.mounts;
      }

      // Add restart policy
      if (options.restartPolicy) {
        containerOptions.HostConfig.RestartPolicy = {
          Name: options.restartPolicy
        };
      }

      // Add logging configuration
      if (options.logConfig) {
        containerOptions.HostConfig.LogConfig = options.logConfig;
      }

      // Add health check
      if (options.healthcheck) {
        containerOptions.Healthcheck = {
          Test: options.healthcheck.Test,
          Interval: options.healthcheck.Interval || 30000000000, // 30s in nanoseconds
          Timeout: options.healthcheck.Timeout || 5000000000,   // 5s in nanoseconds
          Retries: options.healthcheck.Retries || 3,
          StartPeriod: options.healthcheck.StartPeriod || 10000000000 // 10s in nanoseconds
        };
      }

      // Set up networking
      if (options.networks && options.networks.length > 0) {
        containerOptions.NetworkingConfig = {
          EndpointsConfig: {}
        };
        for (const network of options.networks) {
          containerOptions.NetworkingConfig.EndpointsConfig[network] = {};
        }
      }

      const container = await this.docker.createContainer(containerOptions);

      servicesLogger().info(
        {
          containerId: container.id,
          name: options.name,
          projectName: options.projectName,
          serviceName: options.serviceName,
        },
        "Long-running container created successfully"
      );

      return container;
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          image: options.image,
          name: options.name,
        },
        "Failed to create long-running container"
      );
      throw error;
    }
  }
}
