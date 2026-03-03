import { PrismaClient } from "../../lib/prisma";
import { servicesLogger } from "../../lib/logger-factory";
import {
  DeploymentConfigurationInfo,
  ContainerConfig,
  HealthCheckConfig,
  RollbackConfig,
} from "@mini-infra/types";

// ====================
// Pure Mapper Functions
// ====================

export function toConfigurationInfo(config: any): DeploymentConfigurationInfo {
  return {
    id: config.id,
    applicationName: config.applicationName,
    dockerImage: config.dockerImage,
    dockerTag: config.dockerTag,
    dockerRegistry: config.dockerRegistry,
    containerConfig: config.containerConfig as ContainerConfig,
    healthCheckConfig: config.healthCheckConfig as HealthCheckConfig,
    rollbackConfig: config.rollbackConfig as RollbackConfig,
    listeningPort: config.listeningPort,
    hostname: config.hostname,
    isActive: config.isActive,
    environmentId: config.environmentId,
    enableSsl: config.enableSsl,
    tlsCertificateId: config.tlsCertificateId,
    certificateStatus: config.certificateStatus,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  };
}

export function toDeploymentContainerInfo(container: any): any {
  return {
    id: container.id,
    deploymentId: container.deploymentId,
    containerId: container.containerId,
    containerName: container.containerName,
    containerRole: container.containerRole,
    dockerImage: container.dockerImage,
    imageId: container.imageId,
    containerConfig: container.containerConfig,
    status: container.status,
    ipAddress: container.ipAddress,
    createdAt: container.createdAt.toISOString(),
    startedAt: container.startedAt ? container.startedAt.toISOString() : null,
    capturedAt: container.capturedAt.toISOString(),
  };
}

/**
 * Get container configuration serialized for deployment tracking
 */
export function serializeContainerConfiguration(config: ContainerConfig): any {
  return {
    ports: config.ports.map(port => ({
      containerPort: port.containerPort,
      hostPort: port.hostPort,
      protocol: port.protocol || 'tcp',
    })),
    volumes: config.volumes.map(volume => ({
      hostPath: volume.hostPath,
      containerPath: volume.containerPath,
      mode: volume.mode || 'rw',
    })),
    labels: { ...config.labels }, // Copy labels but exclude sensitive ones if needed
    networks: [...config.networks],
    // Note: environment variables are excluded for security
  };
}

// ====================
// Container Query Service
// ====================

export class ContainerQueryService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Retrieve containers for a specific deployment
   */
  async getDeploymentContainers(deploymentId: string): Promise<any[]> {
    try {
      const containers = await this.prisma.deploymentContainer.findMany({
        where: {
          deploymentId: deploymentId,
        },
        orderBy: {
          capturedAt: 'desc',
        },
      });

      servicesLogger().debug(
        {
          deploymentId,
          containerCount: containers.length,
        },
        "Retrieved containers for deployment",
      );

      return containers.map(container => toDeploymentContainerInfo(container));
    } catch (error) {
      servicesLogger().error(
        {
          deploymentId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to retrieve deployment containers",
      );
      throw error;
    }
  }

  /**
   * Retrieve containers for a specific configuration
   */
  async getConfigurationContainers(configurationId: string): Promise<any[]> {
    try {
      const containers = await this.prisma.deploymentContainer.findMany({
        where: {
          deployment: {
            configurationId: configurationId,
          },
        },
        include: {
          deployment: {
            select: {
              id: true,
              status: true,
              startedAt: true,
              completedAt: true,
            },
          },
        },
        orderBy: {
          capturedAt: 'desc',
        },
      });

      servicesLogger().debug(
        {
          configurationId,
          containerCount: containers.length,
        },
        "Retrieved containers for configuration",
      );

      return containers.map(container => ({
        ...toDeploymentContainerInfo(container),
        deployment: container.deployment,
      }));
    } catch (error) {
      servicesLogger().error(
        {
          configurationId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to retrieve configuration containers",
      );
      throw error;
    }
  }
}
