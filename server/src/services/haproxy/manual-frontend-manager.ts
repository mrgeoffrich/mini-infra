import { loadbalancerLogger } from "../../lib/logger-factory";
import { HAProxyDataPlaneClient } from "./haproxy-dataplane-client";
import { HAProxyFrontendManager } from "./haproxy-frontend-manager";
import { PrismaClient } from "@prisma/client";
import { DockerExecutorService } from "../docker-executor";
import {
  EligibleContainer,
  CreateManualFrontendRequest,
  UpdateManualFrontendRequest,
} from "@mini-infra/types";

const logger = loadbalancerLogger();

export interface ContainerValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * ManualFrontendManager handles manual frontend creation and management
 * for connecting existing Docker containers to HAProxy
 */
export class ManualFrontendManager {
  private dockerExecutor: DockerExecutorService;
  private frontendManager: HAProxyFrontendManager;

  constructor() {
    this.dockerExecutor = new DockerExecutorService();
    this.frontendManager = new HAProxyFrontendManager();
  }

  /**
   * Get list of containers eligible for manual frontend creation
   *
   * @param environmentId The environment ID to get HAProxy network context
   * @param prisma Prisma client instance
   * @returns List of eligible containers with network compatibility info
   */
  async getEligibleContainers(
    environmentId: string,
    prisma: PrismaClient
  ): Promise<{ containers: EligibleContainer[]; haproxyNetwork: string }> {
    logger.info({ environmentId }, "Getting eligible containers for manual frontend");

    try {
      // Get environment details
      const environment = await prisma.environment.findUnique({
        where: { id: environmentId },
        include: {
          networks: true,
          services: {
            where: {
              serviceName: "haproxy",
            },
          },
        },
      });

      if (!environment) {
        throw new Error(`Environment not found: ${environmentId}`);
      }

      // Find HAProxy network
      const haproxyNetwork = environment.networks.find(
        (net) => net.name.includes("haproxy") || net.name.includes("network")
      );

      if (!haproxyNetwork) {
        throw new Error(`No HAProxy network found for environment: ${environmentId}`);
      }

      // Initialize docker executor
      await this.dockerExecutor.initialize();

      // Get all running containers
      const docker = this.dockerExecutor.getDockerClient();
      const containers = await docker.listContainers({
        all: false, // Only running containers
      });

      // Get existing manual frontends to check for conflicts
      const existingFrontends = await prisma.hAProxyFrontend.findMany({
        where: {
          environmentId,
          frontendType: "manual",
        },
        select: {
          containerId: true,
          containerName: true,
        },
      });

      // Also get containers from routes in shared frontends
      const existingRoutes = await prisma.hAProxyRoute.findMany({
        where: {
          sourceType: "manual",
          sharedFrontend: {
            environmentId,
          },
        },
        include: {
          sharedFrontend: true,
        },
      });

      // Collect all container IDs that are already connected
      const usedContainerIds = new Set<string>();

      // Add from manual frontends
      existingFrontends.forEach((f) => {
        if (f.containerId) {
          usedContainerIds.add(f.containerId);
        }
      });

      // Add from routes (manualFrontendId points to the frontend record which has containerId)
      for (const route of existingRoutes) {
        if (route.manualFrontendId) {
          const manualFrontend = await prisma.hAProxyFrontend.findUnique({
            where: { id: route.manualFrontendId },
            select: { containerId: true },
          });
          if (manualFrontend?.containerId) {
            usedContainerIds.add(manualFrontend.containerId);
          }
        }
      }

      // Filter and map containers
      const eligibleContainers: EligibleContainer[] = await Promise.all(
        containers.map(async (container) => {
          const containerName = container.Names?.[0]?.replace(/^\//, "") || "";
          const networks = Object.keys(container.NetworkSettings?.Networks || {});
          const isOnHAProxyNetwork = networks.includes(haproxyNetwork.name);
          const alreadyHasFrontend = usedContainerIds.has(container.Id);
          const isHAProxyContainer = containerName.includes("haproxy");

          // Determine eligibility
          let canConnect = true;
          let reason: string | undefined;

          if (isHAProxyContainer) {
            canConnect = false;
            reason = "Cannot connect HAProxy container to itself";
          } else if (!isOnHAProxyNetwork) {
            canConnect = false;
            reason = `Container is not on HAProxy network (${haproxyNetwork.name})`;
          } else if (alreadyHasFrontend) {
            canConnect = false;
            reason = "Container already has a manual frontend configured";
          }

          // Extract exposed ports
          const ports = (container.Ports || []).map((port: any) => ({
            containerPort: port.PrivatePort,
            protocol: port.Type || "tcp",
          }));

          return {
            id: container.Id,
            name: containerName,
            image: container.Image,
            state: container.State,
            networks,
            labels: container.Labels || {},
            ports,
            canConnect,
            reason,
          };
        })
      );

      logger.info(
        {
          environmentId,
          haproxyNetwork: haproxyNetwork.name,
          totalContainers: eligibleContainers.length,
          eligibleCount: eligibleContainers.filter((c) => c.canConnect).length,
        },
        "Retrieved eligible containers"
      );

      return {
        containers: eligibleContainers,
        haproxyNetwork: haproxyNetwork.name,
      };
    } catch (error) {
      logger.error({ error, environmentId }, "Failed to get eligible containers");
      throw error;
    }
  }

  /**
   * Validate a container for manual frontend creation
   *
   * @param containerId Docker container ID
   * @param environmentId Environment ID
   * @param prisma Prisma client instance
   * @returns Validation result
   */
  async validateContainer(
    containerId: string,
    environmentId: string,
    prisma: PrismaClient
  ): Promise<ContainerValidationResult> {
    const errors: string[] = [];

    try {
      await this.dockerExecutor.initialize();
      const docker = this.dockerExecutor.getDockerClient();

      // Check if container exists and is running
      try {
        const container = docker.getContainer(containerId);
        const info = await container.inspect();

        if (!info.State.Running) {
          errors.push("Container is not running");
        }
      } catch (error) {
        errors.push("Container not found or not accessible");
      }

      // Get eligible containers to check network compatibility
      const { containers } = await this.getEligibleContainers(environmentId, prisma);
      const targetContainer = containers.find((c) => c.id === containerId);

      if (!targetContainer) {
        errors.push("Container not found in eligible containers list");
      } else if (!targetContainer.canConnect) {
        errors.push(targetContainer.reason || "Container cannot be connected");
      }

      return {
        isValid: errors.length === 0,
        errors,
      };
    } catch (error) {
      logger.error({ error, containerId, environmentId }, "Container validation failed");
      errors.push(error instanceof Error ? error.message : "Validation failed");
      return { isValid: false, errors };
    }
  }

  /**
   * Create a manual frontend for a container using shared frontends
   *
   * This method uses shared frontends - if a shared frontend already exists
   * for the environment/port combination, a route is added to it. Otherwise,
   * a new shared frontend is created first.
   *
   * @param request Manual frontend creation request
   * @param haproxyClient HAProxy DataPlane client instance
   * @param prisma Prisma client instance
   * @returns Created frontend record (for backward compatibility) with route info
   */
  async createManualFrontend(
    request: CreateManualFrontendRequest,
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient
  ): Promise<any> {
    logger.info({ request }, "Creating manual frontend using shared frontend");

    try {
      // Validate container
      const validation = await this.validateContainer(
        request.containerId,
        request.environmentId,
        prisma
      );

      if (!validation.isValid) {
        throw new Error(`Container validation failed: ${validation.errors.join(", ")}`);
      }

      // Validate hostname uniqueness - check both HAProxyFrontend and HAProxyRoute tables
      const existingFrontend = await prisma.hAProxyFrontend.findFirst({
        where: {
          hostname: request.hostname,
          environmentId: request.environmentId,
          isSharedFrontend: false, // Only check non-shared frontends
        },
      });

      if (existingFrontend) {
        throw new Error(
          `Hostname ${request.hostname} is already in use by frontend: ${existingFrontend.frontendName}`
        );
      }

      // Also check existing routes in shared frontends
      const existingRoute = await prisma.hAProxyRoute.findFirst({
        where: {
          hostname: request.hostname,
          sharedFrontend: {
            environmentId: request.environmentId,
          },
        },
      });

      if (existingRoute) {
        throw new Error(
          `Hostname ${request.hostname} is already in use by an existing route`
        );
      }

      // Get container details
      await this.dockerExecutor.initialize();
      const docker = this.dockerExecutor.getDockerClient();
      const container = docker.getContainer(request.containerId);
      const containerInfo = await container.inspect();

      // Get container IP address on HAProxy network
      const { containers } = await this.getEligibleContainers(request.environmentId, prisma);
      const targetContainer = containers.find((c) => c.id === request.containerId);

      if (!targetContainer) {
        throw new Error("Container not found in eligible list");
      }

      // Get container IP on HAProxy network
      const haproxyNetworkName = targetContainer.networks.find(net =>
        net.includes("haproxy") || net.includes("network")
      );

      if (!haproxyNetworkName) {
        throw new Error("Container is not on HAProxy network");
      }

      const containerIpAddress = containerInfo.NetworkSettings.Networks[haproxyNetworkName]?.IPAddress;

      if (!containerIpAddress) {
        throw new Error(`Could not determine container IP address on network ${haproxyNetworkName}`);
      }

      // Generate backend name
      const sanitizedContainerName = request.containerName.replace(/[^a-zA-Z0-9]/g, "_");
      const backendName = `be_manual_${sanitizedContainerName}`;

      // Create backend in HAProxy
      logger.info({ backendName, containerIpAddress, port: request.containerPort }, "Creating backend");
      await haproxyClient.createBackend({
        name: backendName,
        mode: "http",
      });

      // Add server to backend
      await haproxyClient.addServer(backendName, {
        name: `${request.containerName}_server`,
        address: containerIpAddress,
        port: request.containerPort,
        check: "enabled",
        enabled: true,
      });

      // Get or create the shared frontend for this environment
      logger.info(
        { environmentId: request.environmentId },
        "Getting or creating shared HTTP frontend"
      );
      const sharedFrontend = await this.frontendManager.getOrCreateSharedFrontend(
        request.environmentId,
        "http",
        haproxyClient,
        prisma,
        {
          bindPort: 80,
          bindAddress: "*",
        }
      );

      // Add route to the shared frontend
      logger.info(
        {
          sharedFrontendId: sharedFrontend.id,
          hostname: request.hostname,
          backendName,
        },
        "Adding route to shared frontend"
      );
      const route = await this.frontendManager.addRouteToSharedFrontend(
        sharedFrontend.id,
        request.hostname,
        backendName,
        "manual",
        request.containerId, // Use containerId as sourceId for manual routes
        haproxyClient,
        prisma,
        {
          useSSL: request.enableSsl || false,
          tlsCertificateId: request.tlsCertificateId,
        }
      );

      // Create a "virtual" frontend record for backward compatibility
      // This record represents the manual connection and links to the route
      const manualFrontendRecord = await prisma.hAProxyFrontend.create({
        data: {
          frontendType: "manual",
          containerName: request.containerName,
          containerId: request.containerId,
          containerPort: request.containerPort,
          environmentId: request.environmentId,
          frontendName: `manual_${sanitizedContainerName}_${request.environmentId.slice(-8)}`,
          backendName,
          hostname: request.hostname,
          bindPort: 80,
          bindAddress: "*",
          useSSL: request.enableSsl || false,
          tlsCertificateId: request.tlsCertificateId,
          isSharedFrontend: false,
          sharedFrontendId: sharedFrontend.id,
          status: "active",
        },
      });

      // Update the route to link to the manual frontend record
      await prisma.hAProxyRoute.update({
        where: { id: route.id },
        data: { manualFrontendId: manualFrontendRecord.id },
      });

      logger.info(
        {
          frontendId: manualFrontendRecord.id,
          routeId: route.id,
          sharedFrontendName: sharedFrontend.frontendName,
          hostname: request.hostname,
        },
        "Manual frontend created successfully using shared frontend"
      );

      return manualFrontendRecord;
    } catch (error) {
      logger.error({ error, request }, "Failed to create manual frontend");
      throw error;
    }
  }

  /**
   * Delete a manual frontend
   *
   * For shared frontends, this removes the route but keeps the shared frontend.
   * It also removes the backend associated with this container.
   *
   * @param frontendName Frontend name to delete
   * @param haproxyClient HAProxy DataPlane client instance
   * @param prisma Prisma client instance
   */
  async deleteManualFrontend(
    frontendName: string,
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient
  ): Promise<void> {
    logger.info({ frontendName }, "Deleting manual frontend");

    try {
      // Get frontend from database
      const frontend = await prisma.hAProxyFrontend.findUnique({
        where: { frontendName },
      });

      if (!frontend) {
        throw new Error(`Frontend not found: ${frontendName}`);
      }

      if (frontend.frontendType !== "manual") {
        throw new Error(
          `Cannot delete deployment frontend via manual frontend API. Frontend type: ${frontend.frontendType}`
        );
      }

      // Check if this frontend uses a shared frontend
      if (frontend.sharedFrontendId) {
        // Remove the route from the shared frontend
        logger.info(
          { frontendName, sharedFrontendId: frontend.sharedFrontendId, hostname: frontend.hostname },
          "Removing route from shared frontend"
        );

        await this.frontendManager.removeRouteFromSharedFrontend(
          frontend.sharedFrontendId,
          frontend.hostname,
          haproxyClient,
          prisma
        );
      } else {
        // Legacy path: remove the dedicated frontend from HAProxy
        logger.info({ frontendName }, "Removing dedicated frontend from HAProxy");
        await this.frontendManager.removeFrontend(frontendName, haproxyClient);
      }

      // Remove backend from HAProxy
      if (frontend.backendName) {
        logger.info({ backendName: frontend.backendName }, "Removing backend from HAProxy");
        try {
          const version = await haproxyClient.getVersion();
          await haproxyClient["axiosInstance"].delete(
            `/services/haproxy/configuration/backends/${frontend.backendName}?version=${version}`
          );
        } catch (error: any) {
          // If backend doesn't exist, log warning but continue
          if (error?.response?.status !== 404) {
            logger.warn({ error, backendName: frontend.backendName }, "Failed to remove backend");
          }
        }
      }

      // Delete database record
      await prisma.hAProxyFrontend.delete({
        where: { frontendName },
      });

      logger.info({ frontendName }, "Manual frontend deleted successfully");
    } catch (error) {
      logger.error({ error, frontendName }, "Failed to delete manual frontend");
      throw error;
    }
  }

  /**
   * Update a manual frontend
   *
   * @param frontendName Frontend name to update
   * @param updates Update request
   * @param haproxyClient HAProxy DataPlane client instance
   * @param prisma Prisma client instance
   * @returns Updated frontend record
   */
  async updateManualFrontend(
    frontendName: string,
    updates: UpdateManualFrontendRequest,
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient
  ): Promise<any> {
    logger.info({ frontendName, updates }, "Updating manual frontend");

    try {
      // Get frontend from database
      const frontend = await prisma.hAProxyFrontend.findUnique({
        where: { frontendName },
      });

      if (!frontend) {
        throw new Error(`Frontend not found: ${frontendName}`);
      }

      if (frontend.frontendType !== "manual") {
        throw new Error(
          `Cannot update deployment frontend via manual frontend API. Frontend type: ${frontend.frontendType}`
        );
      }

      // Validate hostname uniqueness if changing
      if (updates.hostname && updates.hostname !== frontend.hostname) {
        const existingFrontend = await prisma.hAProxyFrontend.findFirst({
          where: {
            hostname: updates.hostname,
            environmentId: frontend.environmentId,
            NOT: {
              frontendName,
            },
          },
        });

        if (existingFrontend) {
          throw new Error(
            `Hostname ${updates.hostname} is already in use by frontend: ${existingFrontend.frontendName}`
          );
        }

        // Update hostname routing in HAProxy
        await this.frontendManager.updateFrontendBackend(
          frontendName,
          updates.hostname,
          frontend.backendName,
          haproxyClient
        );
      }

      // Update SSL configuration if changed
      if (updates.enableSsl !== undefined || updates.tlsCertificateId !== undefined) {
        // SSL update logic would go here
        // For now, we'll just update the database record
        logger.info({ frontendName }, "SSL configuration update not yet implemented");
      }

      // Update database record
      const updatedFrontend = await prisma.hAProxyFrontend.update({
        where: { frontendName },
        data: {
          hostname: updates.hostname || frontend.hostname,
          useSSL: updates.enableSsl ?? frontend.useSSL,
          tlsCertificateId: updates.tlsCertificateId ?? frontend.tlsCertificateId,
          updatedAt: new Date(),
        },
      });

      logger.info({ frontendName }, "Manual frontend updated successfully");

      return updatedFrontend;
    } catch (error) {
      logger.error({ error, frontendName, updates }, "Failed to update manual frontend");
      throw error;
    }
  }
}

// Export singleton instance
export const manualFrontendManager = new ManualFrontendManager();
