import { servicesLogger } from "../../lib/logger-factory";
import DockerService from "../docker";
import prisma from "../../lib/prisma";

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

      // Look up the applications network from InfraResource table
      const infraNetwork = await this.getApplicationsNetworkFromResource(environmentId);
      if (!infraNetwork.networkName) {
        return {
          isValid: false,
          environmentId,
          environmentName: environment.name,
          errorMessage: 'Applications network not found. Ensure the HAProxy stack has been applied for this environment.',
          errorCode: 'NETWORK_RESOURCE_NOT_FOUND'
        };
      }
      const networkName = infraNetwork.networkName;

      logger.info(
        {
          environmentId,
          environmentName: environment.name,
          haproxyContainerId: haproxyValidation.haproxyContainerId,
          haproxyNetworkName: networkName
        },
        "Environment validation successful"
      );

      return {
        isValid: true,
        environmentId,
        environmentName: environment.name,
        haproxyContainerId: haproxyValidation.haproxyContainerId,
        haproxyNetworkName: networkName
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

  /**
   * Look up the applications network from the InfraResource table.
   * Returns the network name if found, undefined otherwise.
   */
  private async getApplicationsNetworkFromResource(environmentId: string): Promise<{
    networkName?: string;
  }> {
    try {
      const resource = await prisma.infraResource.findUnique({
        where: {
          type_purpose_scope_environmentId: {
            type: 'docker-network',
            purpose: 'applications',
            scope: 'environment',
            environmentId,
          },
        },
      });

      if (resource) {
        logger.debug(
          { environmentId, networkName: resource.name },
          'Found applications network from InfraResource'
        );
        return { networkName: resource.name };
      }

      return {};
    } catch (error) {
      logger.debug(
        { environmentId, error: error instanceof Error ? error.message : 'Unknown' },
        'InfraResource lookup failed, will fall back to container inspection'
      );
      return {};
    }
  }
}