import {
  IApplicationService,
  NetworkRequirement,
  VolumeRequirement
} from './interfaces/application-service';
import { ServiceRegistry } from './service-registry';
import { servicesLogger } from '../lib/logger-factory';
import DockerService from './docker';

export interface ServiceCreationOptions {
  serviceName: string;
  serviceType: string;
  config?: Record<string, any>;
  projectName?: string;
  environmentId?: string;
}

export interface ServiceCreationResult {
  success: boolean;
  service?: IApplicationService;
  message?: string;
  details?: Record<string, any>;
}

export class ApplicationServiceFactory {
  private static instance: ApplicationServiceFactory;
  private readonly logger = servicesLogger();
  private readonly serviceRegistry: ServiceRegistry;
  private readonly activeServices = new Map<string, IApplicationService>();
  private dockerService?: DockerService;

  private constructor() {
    this.serviceRegistry = ServiceRegistry.getInstance();
  }

  public static getInstance(): ApplicationServiceFactory {
    if (!ApplicationServiceFactory.instance) {
      ApplicationServiceFactory.instance = new ApplicationServiceFactory();
    }
    return ApplicationServiceFactory.instance;
  }

  /**
   * Set the Docker service for enhanced stop operations
   * This allows the factory to stop containers directly when service instances are missing
   */
  public setDockerService(dockerService: DockerService): void {
    this.dockerService = dockerService;
  }

  public async createService(options: ServiceCreationOptions): Promise<ServiceCreationResult> {
    const { serviceName, serviceType, config = {}, projectName, environmentId } = options;

    try {
      // Check if service type is available
      const serviceDefinition = this.serviceRegistry.getServiceDefinition(serviceType);
      if (!serviceDefinition) {
        return {
          success: false,
          message: `Unknown service type: ${serviceType}`,
          details: { availableTypes: this.serviceRegistry.getAvailableServiceTypes() }
        };
      }

      // Validate configuration
      if (!this.serviceRegistry.validateServiceConfiguration(serviceType, config)) {
        return {
          success: false,
          message: `Invalid configuration for service type: ${serviceType}`,
          details: { config }
        };
      }

      // Check if service instance already exists
      const existingService = this.getService(serviceName);
      if (existingService) {
        this.logger.warn({ serviceName, serviceType }, 'Service instance already exists, returning existing instance');
        return {
          success: true,
          service: existingService,
          message: 'Service instance already exists'
        };
      }

      // Create service instance
      const service = this.instantiateService(serviceDefinition, serviceName, config, projectName, environmentId);

      // Store service instance
      this.activeServices.set(serviceName, service);

      this.logger.info({
        serviceName,
        serviceType,
        config: Object.keys(config)
      }, 'Application service created successfully');

      return {
        success: true,
        service,
        message: 'Service created successfully'
      };

    } catch (error) {
      this.logger.error({
        error,
        serviceName,
        serviceType,
        config
      }, 'Failed to create application service');

      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        details: { error: error instanceof Error ? error.message : 'Unknown error' }
      };
    }
  }

  private instantiateService(
    serviceDefinition: any,
    serviceName: string,
    config: Record<string, any>,
    projectName?: string,
    environmentId?: string
  ): IApplicationService {
    const { implementation } = serviceDefinition;

    // Create service instance with appropriate constructor arguments
    // Different services may require different constructor parameters
    switch (serviceDefinition.serviceType) {
      case 'haproxy':
        return new implementation(projectName || serviceName, environmentId);

      default:
        // Generic instantiation - may need to be customized per service
        return new implementation(serviceName, config);
    }
  }

  public getService(serviceName: string): IApplicationService | undefined {
    return this.activeServices.get(serviceName);
  }

  public getAllServices(): Map<string, IApplicationService> {
    return new Map(this.activeServices);
  }

  public getServicesByType(serviceType: string): Array<{ name: string; service: IApplicationService }> {
    const services: Array<{ name: string; service: IApplicationService }> = [];

    for (const [serviceName, service] of this.activeServices) {
      if (service.metadata.name === serviceType) {
        services.push({ name: serviceName, service });
      }
    }

    return services;
  }

  public hasService(serviceName: string): boolean {
    return this.activeServices.has(serviceName);
  }

  public async destroyService(serviceName: string): Promise<boolean> {
    const service = this.activeServices.get(serviceName);
    if (!service) {
      this.logger.warn({ serviceName }, 'Service not found for destruction');
      return false;
    }

    try {
      // Attempt to stop and cleanup the service
      await service.stopAndCleanup();

      // Remove from active services
      this.activeServices.delete(serviceName);

      this.logger.info({ serviceName }, 'Service destroyed successfully');
      return true;

    } catch (error) {
      this.logger.error({
        error,
        serviceName
      }, 'Failed to destroy service');
      return false;
    }
  }

  public async destroyAllServices(): Promise<void> {
    const serviceNames = Array.from(this.activeServices.keys());

    this.logger.info({
      serviceCount: serviceNames.length,
      services: serviceNames
    }, 'Destroying all active services');

    const destroyPromises = serviceNames.map(serviceName => this.destroyService(serviceName));
    await Promise.all(destroyPromises);
  }

  public getServiceCount(): number {
    return this.activeServices.size;
  }

  public getServiceNames(): string[] {
    return Array.from(this.activeServices.keys());
  }

  public async getServiceStatus(serviceName: string) {
    const service = this.getService(serviceName);
    if (!service) {
      return null;
    }

    try {
      return await service.getStatus();
    } catch (error) {
      this.logger.error({
        error,
        serviceName
      }, 'Failed to get service status');
      return null;
    }
  }

  public async initializeService(
    serviceName: string,
    networks?: NetworkRequirement[],
    volumes?: VolumeRequirement[]
  ): Promise<boolean> {
    const service = this.getService(serviceName);
    if (!service) {
      this.logger.warn({ serviceName }, 'Service not found for initialization');
      return false;
    }

    try {
      await service.initialize(networks, volumes);
      this.logger.info({ serviceName }, 'Service initialized successfully');
      return true;
    } catch (error) {
      this.logger.error({
        error,
        serviceName
      }, 'Failed to initialize service');
      return false;
    }
  }

  public async startService(serviceName: string) {
    const service = this.getService(serviceName);
    if (!service) {
      throw new Error(`Service not found: ${serviceName}`);
    }

    try {
      const result = await service.start();
      this.logger.info({
        serviceName,
        success: result.success,
        duration: result.duration
      }, 'Service start attempt completed');

      return result;
    } catch (error) {
      this.logger.error({
        error,
        serviceName
      }, 'Failed to start service');
      throw error;
    }
  }

  public async stopService(serviceName: string, environmentId?: string): Promise<void> {
    const service = this.getService(serviceName);

    if (service) {
      // Service exists in factory - use normal stop process
      try {
        await service.stopAndCleanup();
        this.activeServices.delete(serviceName);
        this.logger.info({ serviceName }, 'Service stopped successfully');
        return;
      } catch (error) {
        this.logger.error({
          error,
          serviceName
        }, 'Failed to stop service');
        throw error;
      }
    }

    // Service not in factory - try to stop container directly via Docker
    this.logger.warn(
      { serviceName, environmentId },
      'Service not found in factory, attempting to stop container directly'
    );

    if (!this.dockerService) {
      this.logger.error(
        { serviceName },
        'Cannot stop container directly - Docker service not configured'
      );
      // Don't throw error - service already not in factory, consider it stopped
      this.logger.info(
        { serviceName },
        'Service not in factory and Docker unavailable - treating as already stopped'
      );
      return;
    }

    try {
      await this.dockerService.initialize();
      const containers = await this.dockerService.listContainers();

      // Find container by service name or environment labels
      const container = containers.find((c: any) => {
        const labels = c.labels || {};
        const name = c.name || '';

        // Match by name or by environment ID label
        if (environmentId) {
          return labels["mini-infra.environment"] === environmentId &&
                 (name.includes(serviceName) || labels["mini-infra.service"]);
        }

        return name.includes(serviceName);
      });

      if (!container) {
        this.logger.info(
          { serviceName, environmentId },
          'No container found - treating as already stopped'
        );
        return;
      }

      this.logger.info(
        {
          serviceName,
          containerId: container.id.slice(0, 12),
          containerName: container.name
        },
        'Found container, stopping directly via Docker'
      );

      // Stop and remove container
      const docker = await this.dockerService.getDockerInstance();
      const dockerContainer = docker.getContainer(container.id);

      if (container.status === 'running') {
        await dockerContainer.stop();
        this.logger.debug({ containerId: container.id.slice(0, 12) }, 'Container stopped');
      }

      await dockerContainer.remove();
      this.logger.info(
        { serviceName, containerId: container.id.slice(0, 12) },
        'Container stopped and removed successfully'
      );

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Check if error is because container doesn't exist (404)
      if (errorMessage.includes('404') || errorMessage.includes('no such container')) {
        this.logger.info(
          { serviceName },
          'Container does not exist - treating as already stopped'
        );
        return;
      }

      this.logger.error({
        error: errorMessage,
        serviceName,
        environmentId
      }, 'Failed to stop container directly via Docker');

      // Don't throw - we did our best, and service is not in factory anyway
      this.logger.warn(
        { serviceName },
        'Could not stop container, but service already removed from factory'
      );
    }
  }
}