import { servicesLogger } from "../lib/logger-factory";
import DockerService from "./docker";
import prisma from "../lib/prisma";

const logger = servicesLogger();

export interface EnvironmentValidationResult {
  isValid: boolean;
  environmentId: string;
  environmentName: string;
  haproxyContainerId?: string;
  haproxyNetworkName?: string;
  errorMessage?: string;
  errorCode?: string;
}

export interface HAProxyEnvironmentContext {
  environmentId: string;
  environmentName: string;
  haproxyContainerId: string;
  haproxyNetworkName: string;
}

export class EnvironmentValidationService {
  private dockerService: DockerService;

  constructor() {
    this.dockerService = DockerService.getInstance();
  }

  /**
   * Validate that an environment has HAProxy running and is ready for deployments
   */
  async validateEnvironmentForDeployment(environmentId: string): Promise<EnvironmentValidationResult> {
    try {
      logger.info(
        { environmentId },
        "Starting environment validation for deployment"
      );

      // Get environment details
      const environment = await prisma.environment.findUnique({
        where: { id: environmentId }
      });

      if (!environment) {
        return {
          isValid: false,
          environmentId,
          environmentName: "Unknown",
          errorMessage: `Environment with ID '${environmentId}' not found`,
          errorCode: "ENVIRONMENT_NOT_FOUND"
        };
      }

      if (!environment.isActive) {
        return {
          isValid: false,
          environmentId,
          environmentName: environment.name,
          errorMessage: `Environment '${environment.name}' is not active`,
          errorCode: "ENVIRONMENT_INACTIVE"
        };
      }

      // Find HAProxy container in this environment
      const haproxyValidation = await this.findHAProxyContainer(environmentId, environment.name);
      if (!haproxyValidation.isValid) {
        return {
          isValid: false,
          environmentId,
          environmentName: environment.name,
          errorMessage: haproxyValidation.errorMessage,
          errorCode: haproxyValidation.errorCode
        };
      }

      // Get HAProxy network information
      const networkInfo = await this.getHAProxyNetwork(haproxyValidation.haproxyContainerId!, environment.name);
      if (!networkInfo.isValid) {
        return {
          isValid: false,
          environmentId,
          environmentName: environment.name,
          errorMessage: networkInfo.errorMessage,
          errorCode: networkInfo.errorCode
        };
      }

      logger.info(
        {
          environmentId,
          environmentName: environment.name,
          haproxyContainerId: haproxyValidation.haproxyContainerId,
          haproxyNetworkName: networkInfo.networkName
        },
        "Environment validation successful"
      );

      return {
        isValid: true,
        environmentId,
        environmentName: environment.name,
        haproxyContainerId: haproxyValidation.haproxyContainerId,
        haproxyNetworkName: networkInfo.networkName
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      logger.error(
        { environmentId, error: errorMessage },
        "Environment validation failed with exception"
      );

      return {
        isValid: false,
        environmentId,
        environmentName: "Unknown",
        errorMessage: `Environment validation failed: ${errorMessage}`,
        errorCode: "VALIDATION_ERROR"
      };
    }
  }

  /**
   * Find HAProxy container in the specified environment
   */
  private async findHAProxyContainer(environmentId: string, environmentName: string): Promise<{
    isValid: boolean;
    haproxyContainerId?: string;
    errorMessage?: string;
    errorCode?: string;
  }> {
    try {
      await this.dockerService.initialize();
      const containers = await this.dockerService.listContainers();

      // Look for HAProxy container with environment label
      const haproxyContainer = containers.find((container: any) => {
        const labels = container.labels || {};
        return (
          labels["mini-infra.service"] === "haproxy" &&
          labels["mini-infra.environment"] === environmentId &&
          container.status === "running"
        );
      });

      if (!haproxyContainer) {
        logger.warn(
          { environmentId, environmentName },
          "No running HAProxy container found in environment"
        );

        return {
          isValid: false,
          errorMessage: `No running HAProxy container found in environment '${environmentName}'. Deployments require HAProxy to be running.`,
          errorCode: "HAPROXY_NOT_FOUND"
        };
      }

      logger.debug(
        {
          environmentId,
          environmentName,
          haproxyContainerId: haproxyContainer.id.slice(0, 12),
          containerName: haproxyContainer.name
        },
        "Found running HAProxy container in environment"
      );

      return {
        isValid: true,
        haproxyContainerId: haproxyContainer.id
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      logger.error(
        { environmentId, environmentName, error: errorMessage },
        "Failed to find HAProxy container"
      );

      return {
        isValid: false,
        errorMessage: `Failed to find HAProxy container: ${errorMessage}`,
        errorCode: "HAPROXY_LOOKUP_FAILED"
      };
    }
  }

  /**
   * Get the Docker network that HAProxy is connected to
   */
  private async getHAProxyNetwork(haproxyContainerId: string, environmentName: string): Promise<{
    isValid: boolean;
    networkName?: string;
    errorMessage?: string;
    errorCode?: string;
  }> {
    try {
      const docker = await this.dockerService.getDockerInstance();
      const container = docker.getContainer(haproxyContainerId);
      const containerInfo = await container.inspect();

      if (!containerInfo || !containerInfo.NetworkSettings || !containerInfo.NetworkSettings.Networks) {
        return {
          isValid: false,
          errorMessage: `HAProxy container network information not available`,
          errorCode: "HAPROXY_NETWORK_INFO_MISSING"
        };
      }

      const networks = Object.keys(containerInfo.NetworkSettings.Networks);

      // Filter out the default bridge network - we want custom networks
      const customNetworks = networks.filter(network => network !== "bridge");

      if (customNetworks.length === 0) {
        return {
          isValid: false,
          errorMessage: `HAProxy container is not connected to any custom Docker networks`,
          errorCode: "HAPROXY_NO_CUSTOM_NETWORK"
        };
      }

      // Use the first custom network (HAProxy should typically be on one custom network)
      const networkName = customNetworks[0];

      if (customNetworks.length > 1) {
        logger.warn(
          {
            haproxyContainerId: haproxyContainerId.slice(0, 12),
            environmentName,
            networks: customNetworks
          },
          "HAProxy container connected to multiple custom networks, using first one"
        );
      }

      logger.debug(
        {
          haproxyContainerId: haproxyContainerId.slice(0, 12),
          environmentName,
          selectedNetwork: networkName,
          allNetworks: networks
        },
        "Found HAProxy network information"
      );

      return {
        isValid: true,
        networkName
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      logger.error(
        {
          haproxyContainerId: haproxyContainerId.slice(0, 12),
          environmentName,
          error: errorMessage
        },
        "Failed to get HAProxy network information"
      );

      return {
        isValid: false,
        errorMessage: `Failed to get HAProxy network information: ${errorMessage}`,
        errorCode: "HAPROXY_NETWORK_LOOKUP_FAILED"
      };
    }
  }

  /**
   * Get HAProxy environment context for deployment
   */
  async getHAProxyEnvironmentContext(environmentId: string): Promise<HAProxyEnvironmentContext | null> {
    const validation = await this.validateEnvironmentForDeployment(environmentId);

    if (!validation.isValid || !validation.haproxyContainerId || !validation.haproxyNetworkName) {
      return null;
    }

    return {
      environmentId: validation.environmentId,
      environmentName: validation.environmentName,
      haproxyContainerId: validation.haproxyContainerId,
      haproxyNetworkName: validation.haproxyNetworkName
    };
  }
}