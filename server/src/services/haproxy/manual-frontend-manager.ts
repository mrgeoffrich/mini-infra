import { getLogger } from "../../lib/logger-factory";
import { HAProxyDataPlaneClient, TransactionManager } from "./haproxy-dataplane-client";
import { HAProxyFrontendManager } from "./haproxy-frontend-manager";
import { PrismaClient } from "../../generated/prisma/client";
import { DockerExecutorService } from "../docker-executor";
import { createNetworkManager, type NetworkManager } from "../networks";
import { findOrCreateManagedNetworkByName, safeMembershipWrite, upsertNetworkMembership } from "../networks/membership-store";
import {
  EligibleContainer,
  CreateManualFrontendRequest,
  UpdateManualFrontendRequest,
  ErrorCode,
} from "@mini-infra/types";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";

/** Internal extended request that includes the server-resolved certificate ID */
interface InternalCreateRequest extends CreateManualFrontendRequest {
  tlsCertificateId?: string;
}

const logger = getLogger("haproxy", "manual-frontend-manager");

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
  private networkManager: NetworkManager;

  constructor() {
    this.dockerExecutor = new DockerExecutorService();
    this.frontendManager = new HAProxyFrontendManager();
    this.networkManager = createNetworkManager(this.dockerExecutor);
  }

  /**
   * Resolve the environment's HAProxy dataplane network — the network
   * HAProxy backends live on — via an `InfraResource` purpose lookup
   * instead of guessing from a network's name. Replaces the
   * `name.includes("haproxy") || name.includes("network")` substring
   * heuristic (network overhaul design doc §1.1, mechanism 7) that silently
   * mis-detected (or missed) the network whenever some other network on the
   * host happened to share a name fragment. Mirrors the lookup
   * `EnvironmentValidationService.getApplicationsNetworkFromResource` already
   * uses for deployment validation — same network, same purpose (`applications`).
   */
  private async getApplicationsNetworkName(environmentId: string, prisma: PrismaClient): Promise<string | null> {
    const resource = await prisma.infraResource.findUnique({
      where: {
        type_purpose_scope_environmentId: {
          type: "docker-network",
          purpose: "applications",
          scope: "environment",
          environmentId,
        },
      },
      select: { name: true },
    });
    return resource?.name ?? null;
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
      });

      if (!environment) {
        throw new NotFoundError(
          ErrorCode.HAPROXY_ENVIRONMENT_NOT_FOUND,
          `Environment not found: ${environmentId}`,
          {
            resource: { type: "environment", id: environmentId },
            action: "Choose an existing environment.",
          },
        );
      }

      // Find HAProxy network via purpose lookup (see getApplicationsNetworkName).
      const haproxyNetworkName = await this.getApplicationsNetworkName(environmentId, prisma);

      if (!haproxyNetworkName) {
        throw new NotFoundError(
          ErrorCode.HAPROXY_NETWORK_NOT_FOUND,
          `No HAProxy network found for environment: ${environmentId}`,
          {
            resource: { type: "dockerNetwork", id: environmentId },
            action: "Apply the environment's networking stack before connecting containers.",
          },
        );
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
          const isOnHAProxyNetwork = networks.includes(haproxyNetworkName);
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
            reason = `Will be joined to HAProxy network (${haproxyNetworkName})`;
          } else if (alreadyHasFrontend) {
            canConnect = false;
            reason = "Container already has a manual frontend configured";
          }

          // Extract exposed ports
          const ports = (container.Ports || []).map((port: { PrivatePort?: number; PublicPort?: number; Type?: string }) => ({
            containerPort: port.PrivatePort ?? 0,
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
          haproxyNetwork: haproxyNetworkName,
          totalContainers: eligibleContainers.length,
          eligibleCount: eligibleContainers.filter((c) => c.canConnect).length,
        },
        "Retrieved eligible containers"
      );

      return {
        containers: eligibleContainers,
        haproxyNetwork: haproxyNetworkName,
      };
    } catch (error) {
      logger.error({ error, environmentId }, "Failed to get eligible containers");
      throw error;
    }
  }

  /**
   * Connect a container to the HAProxy network for the given environment.
   *
   * Network overhaul Phase 6: also records a `source: 'haproxy'`
   * `NetworkMembership` row for the container (keyed by `containerName`,
   * since this is an arbitrary externally-adopted container, not a
   * mini-infra-managed `StackService`) — the manual-frontend flow is the
   * one remaining call site of the "HAProxy manual-frontend join" mechanism
   * from the network overhaul audit (design doc §1.1, mechanism 7).
   */
  async connectContainerToNetwork(
    containerId: string,
    containerName: string,
    environmentId: string,
    prisma: PrismaClient,
  ): Promise<void> {
    // NetworkManager reads the Docker client lazily off this.dockerExecutor —
    // it must be initialized first (mirrors every other method on this class).
    await this.dockerExecutor.initialize();

    const haproxyNetworkName = await this.getApplicationsNetworkName(environmentId, prisma);

    if (!haproxyNetworkName) {
      throw new NotFoundError(
        ErrorCode.HAPROXY_NETWORK_NOT_FOUND,
        `No HAProxy network found for environment: ${environmentId}`,
        {
          resource: { type: "dockerNetwork", id: environmentId },
          action: "Apply the environment's networking stack before connecting containers.",
        },
      );
    }

    await this.networkManager.connect(containerId, haproxyNetworkName);

    logger.info({ containerId, network: haproxyNetworkName }, "Container joined HAProxy network");

    await safeMembershipWrite(logger, { containerId, containerName, network: haproxyNetworkName }, async () => {
      const row = await findOrCreateManagedNetworkByName(prisma, haproxyNetworkName, {
        scope: "environment", environmentId, stackId: null, purpose: "applications",
      });
      await upsertNetworkMembership(prisma, { containerName, networkId: row.id, source: "haproxy" });
    });
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
      } catch {
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
  ): Promise<Record<string, unknown>> {
    logger.info({ request }, "Creating manual frontend using shared frontend");

    try {
      // Validate container
      const validation = await this.validateContainer(
        request.containerId,
        request.environmentId,
        prisma
      );

      if (!validation.isValid) {
        throw new ValidationError(
          ErrorCode.HAPROXY_CONTAINER_VALIDATION_FAILED,
          `Container validation failed: ${validation.errors.join(", ")}`,
          {
            resource: { type: "container", id: request.containerId },
            action: "Choose a different container or resolve the listed issues.",
            details: validation.errors,
          },
        );
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
        throw new ConflictError(
          ErrorCode.HAPROXY_HOSTNAME_IN_USE,
          `Hostname ${request.hostname} is already in use by frontend: ${existingFrontend.frontendName}`,
          {
            resource: { type: "haproxyFrontend", name: request.hostname },
            action: "Choose a different hostname, or edit the existing frontend instead.",
          },
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
        throw new ConflictError(
          ErrorCode.HAPROXY_HOSTNAME_IN_USE,
          `Hostname ${request.hostname} is already in use by an existing route`,
          {
            resource: { type: "haproxyRoute", name: request.hostname },
            action: "Choose a different hostname, or edit the existing route instead.",
          },
        );
      }

      // Get container details
      await this.dockerExecutor.initialize();
      const docker = this.dockerExecutor.getDockerClient();
      const container = docker.getContainer(request.containerId);
      const containerInfo = await container.inspect();

      // Get container IP address on HAProxy network
      const { containers, haproxyNetwork: haproxyNetworkName } = await this.getEligibleContainers(request.environmentId, prisma);
      const targetContainer = containers.find((c) => c.id === request.containerId);

      if (!targetContainer) {
        throw new NotFoundError(
          ErrorCode.HAPROXY_CONTAINER_NOT_ELIGIBLE,
          "Container not found in eligible list",
          {
            resource: { type: "container", id: request.containerId },
            action: "Refresh the eligible-containers list and try again.",
          },
        );
      }

      // Confirm the container is actually attached to the resolved HAProxy
      // network (rather than re-guessing which of its networks is the
      // HAProxy one via a substring match — `haproxyNetworkName` above is
      // already the definitive purpose-resolved name).
      if (!targetContainer.networks.includes(haproxyNetworkName)) {
        throw new ValidationError(
          ErrorCode.HAPROXY_CONTAINER_NOT_ELIGIBLE,
          "Container is not on HAProxy network",
          {
            resource: { type: "container", id: request.containerId },
            action: "Join the container to the HAProxy network before connecting it.",
          },
        );
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
        throw new NotFoundError(ErrorCode.HAPROXY_FRONTEND_NOT_FOUND, `Frontend not found: ${frontendName}`, {
          resource: { type: "haproxyFrontend", name: frontendName },
          action: "Refresh the page — the frontend may have already been removed.",
        });
      }

      if (frontend.frontendType !== "manual") {
        throw new ValidationError(
          ErrorCode.HAPROXY_FRONTEND_TYPE_MISMATCH,
          `Cannot delete deployment frontend via manual frontend API. Frontend type: ${frontend.frontendType}`,
          {
            resource: { type: "haproxyFrontend", name: frontendName },
            action: "Deployment-managed frontends are removed by stopping or removing the application/stack.",
          },
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
            } catch (error) {
              if ((error as { response?: { status?: number } }).response?.status !== 404) {
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
          } catch (error) {
            // If backend doesn't exist, log warning but continue
            if ((error as { response?: { status?: number } }).response?.status !== 404) {
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
  ): Promise<Record<string, unknown>> {
    logger.info({ frontendName, updates }, "Updating manual frontend");

    try {
      // Get frontend from database
      const frontend = await prisma.hAProxyFrontend.findUnique({
        where: { frontendName },
      });

      if (!frontend) {
        throw new NotFoundError(ErrorCode.HAPROXY_FRONTEND_NOT_FOUND, `Frontend not found: ${frontendName}`, {
          resource: { type: "haproxyFrontend", name: frontendName },
          action: "Refresh the page — the frontend may have already been removed.",
        });
      }

      if (frontend.frontendType !== "manual") {
        throw new ValidationError(
          ErrorCode.HAPROXY_FRONTEND_TYPE_MISMATCH,
          `Cannot update deployment frontend via manual frontend API. Frontend type: ${frontend.frontendType}`,
          {
            resource: { type: "haproxyFrontend", name: frontendName },
            action: "Deployment-managed frontends are updated by redeploying the application/stack.",
          },
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
          throw new ConflictError(
            ErrorCode.HAPROXY_HOSTNAME_IN_USE,
            `Hostname ${updates.hostname} is already in use by frontend: ${existingFrontend.frontendName}`,
            {
              resource: { type: "haproxyFrontend", name: updates.hostname },
              action: "Choose a different hostname, or edit the existing frontend instead.",
            },
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
