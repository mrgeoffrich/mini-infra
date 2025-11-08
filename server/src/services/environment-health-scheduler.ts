import prisma from "../lib/prisma";
import DockerService from "./docker";
import { ApplicationServiceFactory } from "./application-service-factory";
import { servicesLogger } from "../lib/logger-factory";
import { ServiceStatusValues, ApplicationServiceHealthStatusValues } from "@mini-infra/types";

interface HealthCheckResult {
  environmentId: string;
  environmentName: string;
  servicesChecked: number;
  servicesHealthy: number;
  servicesUnhealthy: number;
  servicesMissing: number;
  servicesRestored: number;
}

/**
 * EnvironmentHealthScheduler performs periodic health checks on all active environments
 * It monitors service state and reconciles with Docker container state
 */
export class EnvironmentHealthScheduler {
  private readonly checkInterval: number;
  private readonly dockerService: DockerService;
  private readonly serviceFactory: ApplicationServiceFactory;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly logger = servicesLogger();

  constructor(
    dockerService: DockerService,
    serviceFactory: ApplicationServiceFactory,
    checkInterval: number = 5 * 60 * 1000 // 5 minutes default
  ) {
    this.dockerService = dockerService;
    this.serviceFactory = serviceFactory;
    this.checkInterval = checkInterval;
  }

  /**
   * Start the periodic health check scheduler
   */
  start(): void {
    if (this.isRunning) {
      this.logger.warn("Environment health scheduler is already running");
      return;
    }

    this.logger.info("Starting environment health scheduler");

    // Perform initial health checks
    this.performAllHealthChecks();

    // Schedule periodic health checks
    this.intervalId = setInterval(() => {
      this.performAllHealthChecks();
    }, this.checkInterval);

    this.isRunning = true;

    this.logger.info(
      {
        checkIntervalMs: this.checkInterval,
        nextCheckAt: new Date(Date.now() + this.checkInterval).toISOString()
      },
      "Environment health scheduler started successfully"
    );
  }

  /**
   * Stop the periodic health check scheduler
   */
  stop(): void {
    if (!this.isRunning) {
      this.logger.warn("Environment health scheduler is not running");
      return;
    }

    this.logger.info("Stopping environment health scheduler");

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;

    this.logger.info("Environment health scheduler stopped successfully");
  }

  /**
   * Perform health checks for all active environments
   */
  private async performAllHealthChecks(): Promise<void> {
    const startTime = Date.now();

    try {
      this.logger.debug("Starting health checks for all active environments");

      // Initialize Docker service
      await this.dockerService.initialize();

      // Get all active environments
      const activeEnvironments = await prisma.environment.findMany({
        where: {
          isActive: true
        },
        include: {
          services: true
        }
      });

      if (activeEnvironments.length === 0) {
        this.logger.debug("No active environments found to check");
        return;
      }

      this.logger.debug(
        { environmentCount: activeEnvironments.length },
        "Performing health checks for active environments"
      );

      // Get all running containers once for efficiency
      const allContainers = await this.dockerService.listContainers();

      // Execute all health checks with error handling
      const healthCheckPromises = activeEnvironments.map(async (environment) => {
        try {
          return await this.checkEnvironmentHealth(environment, allContainers);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";

          this.logger.error(
            {
              environmentId: environment.id,
              environmentName: environment.name,
              error: errorMessage
            },
            "Environment health check failed"
          );

          return {
            environmentId: environment.id,
            environmentName: environment.name,
            servicesChecked: environment.services.length,
            servicesHealthy: 0,
            servicesUnhealthy: environment.services.length,
            servicesMissing: 0,
            servicesRestored: 0
          };
        }
      });

      // Wait for all health checks to complete
      const results = await Promise.all(healthCheckPromises);

      const totalTime = Date.now() - startTime;
      const totalServicesChecked = results.reduce((sum, r) => sum + r.servicesChecked, 0);
      const totalServicesHealthy = results.reduce((sum, r) => sum + r.servicesHealthy, 0);
      const totalServicesUnhealthy = results.reduce((sum, r) => sum + r.servicesUnhealthy, 0);
      const totalServicesMissing = results.reduce((sum, r) => sum + r.servicesMissing, 0);
      const totalServicesRestored = results.reduce((sum, r) => sum + r.servicesRestored, 0);

      // Log summary
      this.logger.info(
        {
          totalTimeMs: totalTime,
          environmentsChecked: results.length,
          totalServicesChecked,
          totalServicesHealthy,
          totalServicesUnhealthy,
          totalServicesMissing,
          totalServicesRestored,
          nextCheckAt: new Date(Date.now() + this.checkInterval).toISOString()
        },
        "Environment health check cycle completed"
      );

      // Log details for any issues found
      const problemEnvironments = results.filter(
        r => r.servicesUnhealthy > 0 || r.servicesMissing > 0
      );

      if (problemEnvironments.length > 0) {
        this.logger.warn(
          {
            environments: problemEnvironments.map(r => ({
              environmentId: r.environmentId,
              environmentName: r.environmentName,
              unhealthy: r.servicesUnhealthy,
              missing: r.servicesMissing,
              restored: r.servicesRestored
            }))
          },
          "Some environments have unhealthy or missing services"
        );
      }

    } catch (error) {
      const totalTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      this.logger.error(
        {
          totalTimeMs: totalTime,
          error: errorMessage
        },
        "Failed to perform environment health checks"
      );
    }
  }

  /**
   * Check health of a single environment and its services
   */
  private async checkEnvironmentHealth(
    environment: any,
    allContainers: any[]
  ): Promise<HealthCheckResult> {
    const result: HealthCheckResult = {
      environmentId: environment.id,
      environmentName: environment.name,
      servicesChecked: 0,
      servicesHealthy: 0,
      servicesUnhealthy: 0,
      servicesMissing: 0,
      servicesRestored: 0
    };

    this.logger.debug(
      {
        environmentId: environment.id,
        environmentName: environment.name,
        serviceCount: environment.services.length
      },
      "Checking environment health"
    );

    // Check each service
    for (const service of environment.services) {
      // Only check services that should be running
      if (service.status === ServiceStatusValues.RUNNING ||
          service.status === ServiceStatusValues.STARTING ||
          service.status === ServiceStatusValues.DEGRADED) {

        result.servicesChecked++;

        const serviceHealth = await this.checkServiceHealth(
          service,
          environment,
          allContainers
        );

        if (serviceHealth.healthy) {
          result.servicesHealthy++;
        } else if (serviceHealth.missing) {
          result.servicesMissing++;
        } else {
          result.servicesUnhealthy++;
        }

        if (serviceHealth.restored) {
          result.servicesRestored++;
        }
      }
    }

    // Update environment status based on service health
    await this.updateEnvironmentStatus(environment.id, result);

    return result;
  }

  /**
   * Check health of a single service
   */
  private async checkServiceHealth(
    service: any,
    environment: any,
    allContainers: any[]
  ): Promise<{
    healthy: boolean;
    missing: boolean;
    restored: boolean;
  }> {
    const result = {
      healthy: false,
      missing: false,
      restored: false
    };

    try {
      // First check if service exists in factory
      const serviceInstance = this.serviceFactory.getService(service.serviceName);

      // Find the container
      const container = this.findServiceContainer(service, environment, allContainers);

      if (!container) {
        // Container is missing
        result.missing = true;

        this.logger.warn(
          {
            serviceName: service.serviceName,
            serviceType: service.serviceType,
            environmentId: environment.id
          },
          "Service container not found during health check"
        );

        // Update database
        await prisma.environmentService.update({
          where: { id: service.id },
          data: {
            status: ServiceStatusValues.STOPPED,
            health: ApplicationServiceHealthStatusValues.UNKNOWN,
            stoppedAt: new Date()
          }
        });

        // Remove from factory if it exists
        if (serviceInstance) {
          await this.serviceFactory.destroyService(service.serviceName);
        }

        return result;
      }

      // Container exists - check if it's running
      if (container.status !== "running") {
        result.missing = true;

        this.logger.warn(
          {
            serviceName: service.serviceName,
            serviceType: service.serviceType,
            environmentId: environment.id,
            containerStatus: container.status
          },
          "Service container not running during health check"
        );

        // Update database
        await prisma.environmentService.update({
          where: { id: service.id },
          data: {
            status: ServiceStatusValues.STOPPED,
            health: ApplicationServiceHealthStatusValues.UNKNOWN,
            stoppedAt: new Date()
          }
        });

        // Remove from factory if it exists
        if (serviceInstance) {
          await this.serviceFactory.destroyService(service.serviceName);
        }

        return result;
      }

      // Container is running - ensure service instance exists in factory
      if (!serviceInstance) {
        // Service is running but not in factory - restore it
        this.logger.info(
          {
            serviceName: service.serviceName,
            serviceType: service.serviceType,
            environmentId: environment.id
          },
          "Service running but not in factory, restoring instance"
        );

        const factoryResult = await this.serviceFactory.createService({
          serviceName: service.serviceName,
          serviceType: service.serviceType,
          config: service.config || {},
          projectName: environment.name,
          environmentId: environment.id
        });

        if (factoryResult.success) {
          result.restored = true;
          this.logger.info(
            {
              serviceName: service.serviceName,
              serviceType: service.serviceType
            },
            "Service instance restored to factory during health check"
          );
        } else {
          this.logger.error(
            {
              serviceName: service.serviceName,
              message: factoryResult.message
            },
            "Failed to restore service instance during health check"
          );
          result.missing = true;
          return result;
        }
      }

      // Check service health via the service instance
      const activeService = this.serviceFactory.getService(service.serviceName);
      if (activeService) {
        try {
          const status = await activeService.getStatus();

          // Update database with current status
          const currentDbStatus = service.status;
          const currentDbHealth = service.health;

          if (currentDbStatus !== status.status || currentDbHealth !== status.health.status) {
            await prisma.environmentService.update({
              where: { id: service.id },
              data: {
                status: String(status.status),
                health: String(status.health.status)
              }
            });

            this.logger.debug(
              {
                serviceName: service.serviceName,
                oldStatus: currentDbStatus,
                newStatus: status.status,
                oldHealth: currentDbHealth,
                newHealth: status.health
              },
              "Service status updated during health check"
            );
          }

          result.healthy = String(status.health.status) === ApplicationServiceHealthStatusValues.HEALTHY;

        } catch (statusError) {
          this.logger.warn(
            {
              serviceName: service.serviceName,
              error: statusError instanceof Error ? statusError.message : "Unknown error"
            },
            "Could not get service status during health check"
          );
          result.healthy = false;
        }
      } else {
        result.healthy = false;
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
        "Failed to check service health"
      );

      result.healthy = false;
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
   * Update environment status based on service health results
   */
  private async updateEnvironmentStatus(
    environmentId: string,
    result: HealthCheckResult
  ): Promise<void> {
    try {
      const environment = await prisma.environment.findUnique({
        where: { id: environmentId }
      });

      if (!environment) {
        return;
      }

      let newStatus = environment.status;

      if (result.servicesMissing > 0 && result.servicesHealthy === 0) {
        // All services are missing - mark as failed
        newStatus = ServiceStatusValues.FAILED;

        this.logger.warn(
          {
            environmentId,
            environmentName: result.environmentName
          },
          "Environment marked as failed - all services missing"
        );
      } else if (result.servicesUnhealthy > 0 || result.servicesMissing > 0) {
        // Some services unhealthy - mark as degraded
        newStatus = ServiceStatusValues.DEGRADED;

        this.logger.warn(
          {
            environmentId,
            environmentName: result.environmentName,
            unhealthy: result.servicesUnhealthy,
            missing: result.servicesMissing
          },
          "Environment marked as degraded - some services unhealthy or missing"
        );
      } else if (result.servicesHealthy > 0 && result.servicesChecked === result.servicesHealthy) {
        // All services healthy - mark as running
        newStatus = ServiceStatusValues.RUNNING;
      }

      // Update if status changed
      if (newStatus !== environment.status) {
        await prisma.environment.update({
          where: { id: environmentId },
          data: { status: newStatus }
        });

        this.logger.info(
          {
            environmentId,
            environmentName: result.environmentName,
            oldStatus: environment.status,
            newStatus
          },
          "Environment status updated during health check"
        );
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      this.logger.error(
        {
          environmentId,
          error: errorMessage
        },
        "Failed to update environment status during health check"
      );
    }
  }

  /**
   * Check if the scheduler is currently running
   */
  isSchedulerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get the configured check interval
   */
  getCheckInterval(): number {
    return this.checkInterval;
  }
}
