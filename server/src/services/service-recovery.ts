import prisma from "../lib/prisma";
import DockerService from "./docker";
import { ApplicationServiceFactory } from "./application-service-factory";
import { servicesLogger } from "../lib/logger-factory";
import { ServiceStatusValues, ApplicationServiceHealthStatusValues } from "@mini-infra/types";

interface RecoveryResult {
  environmentId: string;
  environmentName: string;
  servicesChecked: number;
  servicesRestored: number;
  servicesFailed: number;
  servicesUpdated: number;
}

/**
 * ServiceRecoveryManager handles restoration of service state on server startup
 * It reconciles database state with actual Docker containers and restores service instances
 */
export class ServiceRecoveryManager {
  private readonly dockerService: DockerService;
  private readonly serviceFactory: ApplicationServiceFactory;
  private readonly logger = servicesLogger();

  constructor(
    dockerService: DockerService,
    serviceFactory: ApplicationServiceFactory
  ) {
    this.dockerService = dockerService;
    this.serviceFactory = serviceFactory;
  }

  /**
   * Perform recovery of all active environments and their services
   * This should be called once during server startup
   */
  async performRecovery(): Promise<void> {
    const startTime = Date.now();
    this.logger.info("Starting service recovery process");

    try {
      // Initialize Docker service
      await this.dockerService.initialize();

      // Get all active environments from database
      const activeEnvironments = await prisma.environment.findMany({
        where: {
          isActive: true
        },
        include: {
          services: true,
          networks: true,
          volumes: true
        }
      });

      if (activeEnvironments.length === 0) {
        this.logger.info("No active environments found, recovery complete");
        return;
      }

      this.logger.info(
        { environmentCount: activeEnvironments.length },
        "Found active environments to recover"
      );

      // Get all running containers
      const allContainers = await this.dockerService.listContainers();

      // Process each environment
      const results: RecoveryResult[] = [];
      for (const environment of activeEnvironments) {
        const result = await this.recoverEnvironment(environment, allContainers);
        results.push(result);
      }

      // Log summary
      const totalTime = Date.now() - startTime;
      const totalServicesChecked = results.reduce((sum, r) => sum + r.servicesChecked, 0);
      const totalServicesRestored = results.reduce((sum, r) => sum + r.servicesRestored, 0);
      const totalServicesFailed = results.reduce((sum, r) => sum + r.servicesFailed, 0);
      const totalServicesUpdated = results.reduce((sum, r) => sum + r.servicesUpdated, 0);

      this.logger.info(
        {
          totalTimeMs: totalTime,
          environmentsProcessed: results.length,
          totalServicesChecked,
          totalServicesRestored,
          totalServicesFailed,
          totalServicesUpdated
        },
        "Service recovery process completed"
      );

      // Log details for each environment
      for (const result of results) {
        if (result.servicesRestored > 0 || result.servicesFailed > 0 || result.servicesUpdated > 0) {
          this.logger.info(
            {
              environmentId: result.environmentId,
              environmentName: result.environmentName,
              servicesChecked: result.servicesChecked,
              servicesRestored: result.servicesRestored,
              servicesFailed: result.servicesFailed,
              servicesUpdated: result.servicesUpdated
            },
            "Environment recovery summary"
          );
        }
      }

    } catch (error) {
      const totalTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      this.logger.error(
        {
          totalTimeMs: totalTime,
          error: errorMessage
        },
        "Service recovery process failed"
      );

      throw error;
    }
  }

  /**
   * Recover a single environment and its services
   */
  private async recoverEnvironment(
    environment: any,
    allContainers: any[]
  ): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      environmentId: environment.id,
      environmentName: environment.name,
      servicesChecked: 0,
      servicesRestored: 0,
      servicesFailed: 0,
      servicesUpdated: 0
    };

    this.logger.debug(
      {
        environmentId: environment.id,
        environmentName: environment.name,
        serviceCount: environment.services.length
      },
      "Recovering environment"
    );

    // Check each service in the environment
    for (const service of environment.services) {
      result.servicesChecked++;

      // Only attempt recovery for services that should be running
      if (service.status === ServiceStatusValues.RUNNING || service.status === ServiceStatusValues.STARTING) {
        const recovered = await this.recoverService(
          service,
          environment,
          allContainers
        );

        if (recovered.restored) {
          result.servicesRestored++;
        } else if (recovered.updated) {
          result.servicesUpdated++;
        }

        if (recovered.failed) {
          result.servicesFailed++;
        }
      }
    }

    // Update environment status if needed
    if (result.servicesFailed > 0 && result.servicesRestored === 0) {
      // All services failed to recover, mark environment as failed
      await prisma.environment.update({
        where: { id: environment.id },
        data: {
          status: ServiceStatusValues.FAILED,
          isActive: false
        }
      });
      result.servicesUpdated++;

      this.logger.warn(
        {
          environmentId: environment.id,
          environmentName: environment.name
        },
        "Environment marked as failed - no services could be recovered"
      );
    } else if (result.servicesFailed > 0) {
      // Some services failed, mark as degraded
      await prisma.environment.update({
        where: { id: environment.id },
        data: {
          status: ServiceStatusValues.DEGRADED
        }
      });
      result.servicesUpdated++;

      this.logger.warn(
        {
          environmentId: environment.id,
          environmentName: environment.name,
          servicesRestored: result.servicesRestored,
          servicesFailed: result.servicesFailed
        },
        "Environment marked as degraded - some services could not be recovered"
      );
    }

    return result;
  }

  /**
   * Recover a single service by finding its container and restoring the service instance
   */
  private async recoverService(
    service: any,
    environment: any,
    allContainers: any[]
  ): Promise<{
    restored: boolean;
    updated: boolean;
    failed: boolean;
  }> {
    const result = {
      restored: false,
      updated: false,
      failed: false
    };

    try {
      // Find the container for this service
      const container = this.findServiceContainer(
        service,
        environment,
        allContainers
      );

      if (!container) {
        // Container not found, update database to reflect this
        this.logger.warn(
          {
            serviceName: service.serviceName,
            serviceType: service.serviceType,
            environmentId: environment.id,
            environmentName: environment.name
          },
          "Service container not found, marking as stopped"
        );

        await prisma.environmentService.update({
          where: { id: service.id },
          data: {
            status: ServiceStatusValues.STOPPED,
            health: ApplicationServiceHealthStatusValues.UNKNOWN,
            stoppedAt: new Date()
          }
        });

        result.updated = true;
        result.failed = true;
        return result;
      }

      // Check if container is actually running
      if (container.status !== "running") {
        this.logger.warn(
          {
            serviceName: service.serviceName,
            serviceType: service.serviceType,
            environmentId: environment.id,
            containerStatus: container.status
          },
          "Service container exists but not running, updating status"
        );

        await prisma.environmentService.update({
          where: { id: service.id },
          data: {
            status: ServiceStatusValues.STOPPED,
            health: ApplicationServiceHealthStatusValues.UNKNOWN,
            stoppedAt: new Date()
          }
        });

        result.updated = true;
        result.failed = true;
        return result;
      }

      // Container is running, restore service instance
      const restored = await this.restoreServiceInstance(
        service,
        environment,
        container
      );

      if (restored) {
        this.logger.info(
          {
            serviceName: service.serviceName,
            serviceType: service.serviceType,
            environmentId: environment.id,
            environmentName: environment.name,
            containerId: container.id.slice(0, 12)
          },
          "Service instance restored successfully"
        );

        result.restored = true;
      } else {
        result.failed = true;
      }

      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      this.logger.error(
        {
          serviceName: service.serviceName,
          serviceType: service.serviceType,
          environmentId: environment.id,
          error: errorMessage
        },
        "Failed to recover service"
      );

      // Update service status to failed
      try {
        await prisma.environmentService.update({
          where: { id: service.id },
          data: {
            status: ServiceStatusValues.FAILED,
            health: ApplicationServiceHealthStatusValues.UNHEALTHY
          }
        });
        result.updated = true;
      } catch (updateError) {
        this.logger.error(
          {
            serviceName: service.serviceName,
            error: updateError instanceof Error ? updateError.message : "Unknown error"
          },
          "Failed to update service status after recovery failure"
        );
      }

      result.failed = true;
      return result;
    }
  }

  /**
   * Find the Docker container for a service
   */
  private findServiceContainer(
    service: any,
    environment: any,
    allContainers: any[]
  ): any | null {
    // Look for container with matching labels
    const container = allContainers.find((container: any) => {
      const labels = container.labels || {};
      return (
        labels["mini-infra.service"] === service.serviceType &&
        labels["mini-infra.environment"] === environment.id
      );
    });

    return container || null;
  }

  /**
   * Restore a service instance to the ApplicationServiceFactory
   */
  private async restoreServiceInstance(
    service: any,
    environment: any,
    container: any
  ): Promise<boolean> {
    try {
      // Check if service instance already exists (shouldn't happen, but be safe)
      const existing = this.serviceFactory.getService(service.serviceName);
      if (existing) {
        this.logger.debug(
          {
            serviceName: service.serviceName
          },
          "Service instance already exists in factory, skipping restore"
        );
        return true;
      }

      // Create service instance using the factory
      const result = await this.serviceFactory.createService({
        serviceName: service.serviceName,
        serviceType: service.serviceType,
        config: service.config || {},
        projectName: environment.name,
        environmentId: environment.id
      });

      if (!result.success) {
        this.logger.error(
          {
            serviceName: service.serviceName,
            serviceType: service.serviceType,
            message: result.message
          },
          "Failed to create service instance during recovery"
        );
        return false;
      }

      // Verify the service is healthy
      if (result.service) {
        try {
          const status = await result.service.getStatus();

          // Update database with current status
          await prisma.environmentService.update({
            where: { id: service.id },
            data: {
              status: String(status.status),
              health: String(status.health)
            }
          });

          this.logger.debug(
            {
              serviceName: service.serviceName,
              status: status.status,
              health: status.health
            },
            "Service status verified and updated"
          );
        } catch (statusError) {
          this.logger.warn(
            {
              serviceName: service.serviceName,
              error: statusError instanceof Error ? statusError.message : "Unknown error"
            },
            "Could not verify service status during recovery"
          );
        }
      }

      return true;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      this.logger.error(
        {
          serviceName: service.serviceName,
          error: errorMessage
        },
        "Failed to restore service instance"
      );

      return false;
    }
  }
}
