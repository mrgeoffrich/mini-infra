import { loadbalancerLogger } from "../../lib/logger-factory";
import { HAProxyDataPlaneClient, TransactionManager } from "./haproxy-dataplane-client";
import { HAProxyFrontendManager } from "./haproxy-frontend-manager";
import { PrismaClient } from "@prisma/client";
import { DockerExecutorService } from "../docker-executor";
import {
  EligibleContainer,
  CreateManualFrontendRequest,
  UpdateManualFrontendRequest,
} from "@mini-infra/types";

/** Internal extended request that includes the server-resolved certificate ID */
interface InternalCreateRequest extends CreateManualFrontendRequest {
  tlsCertificateId?: string;
}

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

          let needsNetworkJoin = false;

          if (isHAProxyContainer) {
            canConnect = false;
            reason = "Cannot connect HAProxy container to itself";
          } else if (!isOnHAProxyNetwork) {
            canConnect = true;
            needsNetworkJoin = true;
            reason = `Will be joined to HAProxy network (${haproxyNetwork.name})`;
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
            needsNetworkJoin: needsNetworkJoin || undefined,
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
   * Connect a container to the HAProxy network for the given environment.
   */
  async connectContainerToNetwork(
    containerId: string,
    environmentId: string,
    prisma: PrismaClient,
  ): Promise<void> {
    await this.dockerExecutor.initialize();
    const docker = this.dockerExecutor.getDockerClient();

    const environment = await prisma.environment.findUnique({
      where: { id: environmentId },
      include: { networks: true },
    });

    const haproxyNetwork = environment?.networks.find(
      (net) => net.name.includes("haproxy") || net.name.includes("network"),
    );

    if (!haproxyNetwork) {
      throw new Error(`No HAProxy network found for environment: ${environmentId}`);
    }

    const network = docker.getNetwork(haproxyNetwork.name);
    await network.connect({ Container: containerId });

    logger.info({ containerId, network: haproxyNetwork.name }, "Container joined HAProxy network");
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
    request: InternalCreateRequest,
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
      // Exclude "removed" frontends as they are no longer active
      const existingFrontend = await prisma.hAProxyFrontend.findFirst({
        where: {
          hostname: request.hostname,
          environmentId: request.environmentId,
          isSharedFrontend: false, // Only check non-shared frontends
          status: { not: "removed" }, // Exclude removed frontends
        },
      });

      if (existingFrontend) {
        throw new Error(
          `Hostname ${request.hostname} is already in use by frontend: ${existingFrontend.frontendName}`
        );
      }

      // Also check existing routes in shared frontends (exclude removed routes)
      const existingRoute = await prisma.hAProxyRoute.findFirst({
        where: {
          hostname: request.hostname,
          status: { not: "removed" }, // Exclude removed routes
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
      // Use container name for DNS resolution (preferred) to survive container restarts
      const serverAddress = targetContainer.name || containerIpAddress;
      logger.info({
        backendName,
        serverAddress,
        containerName: targetContainer.name,
        containerIpAddress,
        port: request.containerPort
      }, "Creating backend with Docker DNS resolution");
      await haproxyClient.createBackend({
        name: backendName,
        mode: "http",
      });

      // Add server to backend using container name for DNS resolution
      const serverName = `${request.containerName}_server`;
      await haproxyClient.addServer(backendName, {
        name: serverName,
        address: serverAddress,
        port: request.containerPort,
        check: "enabled",
        enabled: true,
      });

      // Persist backend and server records to database
      try {
        const backendRecord = await prisma.hAProxyBackend.upsert({
          where: {
            name_environmentId: {
              name: backendName,
              environmentId: request.environmentId,
            },
          },
          update: {
            mode: 'http',
            status: 'active',
            errorMessage: null,
          },
          create: {
            name: backendName,
            environmentId: request.environmentId,
            mode: 'http',
            sourceType: 'manual',
            status: 'active',
          },
        });

        await prisma.hAProxyServer.upsert({
          where: {
            name_backendId: {
              name: serverName,
              backendId: backendRecord.id,
            },
          },
          update: {
            address: serverAddress,
            port: request.containerPort,
            check: 'enabled',
            checkPath: request.healthCheckPath ?? null,
            containerId: request.containerId,
            containerName: request.containerName,
            status: 'active',
            errorMessage: null,
          },
          create: {
            name: serverName,
            backendId: backendRecord.id,
            address: serverAddress,
            port: request.containerPort,
            check: 'enabled',
            checkPath: request.healthCheckPath ?? null,
            containerId: request.containerId,
            containerName: request.containerName,
            status: 'active',
          },
        });

        logger.info(
          { backendName, serverName, backendRecordId: backendRecord.id },
          'Manual backend and server records persisted to database'
        );
      } catch (dbError) {
        logger.warn(
          { backendName, error: dbError instanceof Error ? dbError.message : 'Unknown error' },
          'Failed to persist manual backend/server records to database (non-critical)'
        );
      }

      // Get or create the shared frontend for this environment
      // Use HTTPS frontend when SSL is enabled, otherwise HTTP
      const frontendType = request.enableSsl ? "https" : "http";
      const bindPort = request.enableSsl ? 443 : 80;

      logger.info(
        { environmentId: request.environmentId, frontendType, bindPort, hasTlsCert: !!request.tlsCertificateId },
        `Getting or creating shared ${frontendType.toUpperCase()} frontend`
      );
      const sharedFrontend = await this.frontendManager.getOrCreateSharedFrontend(
        request.environmentId,
        frontendType,
        haproxyClient,
        prisma,
        {
          bindPort,
          bindAddress: "*",
          tlsCertificateId: request.enableSsl ? request.tlsCertificateId : undefined,
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

      // Update the backend record with manualFrontendId
      try {
        await prisma.hAProxyBackend.updateMany({
          where: {
            name: backendName,
            environmentId: request.environmentId,
          },
          data: { manualFrontendId: manualFrontendRecord.id },
        });
      } catch (dbError) {
        logger.warn(
          { backendName, error: dbError instanceof Error ? dbError.message : 'Unknown error' },
          'Failed to update backend manualFrontendId (non-critical)'
        );
      }

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
        // Use a transaction to remove the route AND backend atomically.
        // This prevents validation failures when the backend's server address
        // is unresolvable (e.g., the container has been removed).
        logger.info(
          { frontendName, sharedFrontendId: frontend.sharedFrontendId, hostname: frontend.hostname },
          "Removing route and backend from shared frontend in transaction"
        );

        const tm = new TransactionManager(haproxyClient);
        await tm.executeInTransaction(async () => {
          await this.frontendManager.removeRouteFromSharedFrontend(
            frontend.sharedFrontendId!,
            frontend.hostname,
            haproxyClient,
            prisma
          );

          // Remove backend from HAProxy within the same transaction
          if (frontend.backendName) {
            logger.info({ backendName: frontend.backendName }, "Removing backend from HAProxy");
            try {
              await haproxyClient.deleteBackend(frontend.backendName);
            } catch (error: any) {
              if (error?.response?.status !== 404) {
                logger.warn({ error, backendName: frontend.backendName }, "Failed to remove backend");
              }
            }
          }
        });
      } else {
        // Manual path: remove the dedicated frontend from HAProxy
        logger.info({ frontendName }, "Removing dedicated frontend from HAProxy");
        await this.frontendManager.removeFrontend(frontendName, haproxyClient);

        // Remove backend from HAProxy
        if (frontend.backendName) {
          logger.info({ backendName: frontend.backendName }, "Removing backend from HAProxy");
          try {
            await haproxyClient.deleteBackend(frontend.backendName);
          } catch (error: any) {
            // If backend doesn't exist, log warning but continue
            if (error?.response?.status !== 404) {
              logger.warn({ error, backendName: frontend.backendName }, "Failed to remove backend");
            }
          }
        }
      }

      // Delete backend from database (servers cascade-delete)
      if (frontend.backendName && frontend.environmentId) {
        try {
          await prisma.hAProxyBackend.deleteMany({
            where: {
              name: frontend.backendName,
              environmentId: frontend.environmentId,
            },
          });
          logger.info({ backendName: frontend.backendName }, 'Backend deleted from database');
        } catch (dbError) {
          logger.warn(
            { backendName: frontend.backendName, error: dbError instanceof Error ? dbError.message : 'Unknown error' },
            'Failed to delete backend from database (non-critical)'
          );
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
