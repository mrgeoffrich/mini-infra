import {
  IApplicationService,
  NetworkRequirement,
  VolumeRequirement
} from './interfaces/application-service';
import { ServiceRegistry } from './service-registry';
import { servicesLogger } from '../lib/logger-factory';

export interface ServiceCreationOptions {
  serviceName: string;
  serviceType: string;
  config?: Record<string, any>;
  projectName?: string;
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

  private constructor() {
    this.serviceRegistry = ServiceRegistry.getInstance();
  }

  public static getInstance(): ApplicationServiceFactory {
    if (!ApplicationServiceFactory.instance) {
      ApplicationServiceFactory.instance = new ApplicationServiceFactory();
    }
    return ApplicationServiceFactory.instance;
  }

  public async createService(options: ServiceCreationOptions): Promise<ServiceCreationResult> {
    const { serviceName, serviceType, config = {}, projectName } = options;

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
      const service = this.instantiateService(serviceDefinition, serviceName, config, projectName);

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
    projectName?: string
  ): IApplicationService {
    const { implementation } = serviceDefinition;

    // Create service instance with appropriate constructor arguments
    // Different services may require different constructor parameters
    switch (serviceDefinition.serviceType) {
      case 'haproxy':
        return new implementation(projectName || serviceName);

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

  public async stopService(serviceName: string): Promise<void> {
    const service = this.getService(serviceName);
    if (!service) {
      throw new Error(`Service not found: ${serviceName}`);
    }

    try {
      await service.stopAndCleanup();
      this.logger.info({ serviceName }, 'Service stopped successfully');
    } catch (error) {
      this.logger.error({
        error,
        serviceName
      }, 'Failed to stop service');
      throw error;
    }
  }
}