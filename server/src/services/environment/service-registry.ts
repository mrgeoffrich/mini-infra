import {
  IApplicationService,
  ServiceMetadata,
  NetworkRequirement,
  VolumeRequirement
} from '../interfaces/application-service';
import { HAProxyService } from '../haproxy/haproxy-service';
import { servicesLogger } from '../../lib/logger-factory';

export interface ServiceTypeDefinition {
  serviceType: string;
  implementation: new (...args: any[]) => IApplicationService;
  metadata: ServiceMetadata;
  description: string;
}

export class ServiceRegistry {
  private static instance: ServiceRegistry;
  private readonly logger = servicesLogger();
  private readonly services = new Map<string, ServiceTypeDefinition>();

  private constructor() {
    this.registerDefaultServices();
  }

  public static getInstance(): ServiceRegistry {
    if (!ServiceRegistry.instance) {
      ServiceRegistry.instance = new ServiceRegistry();
    }
    return ServiceRegistry.instance;
  }

  private registerDefaultServices(): void {
    // Register HAProxy service
    // Create temporary instance just to get metadata
    const haproxyInstance = new HAProxyService();
    this.registerService({
      serviceType: 'haproxy',
      implementation: HAProxyService,
      metadata: haproxyInstance.metadata,
      description: 'HAProxy load balancer with DataPlane API'
    });

    this.logger.info({ registeredServices: Array.from(this.services.keys()) }, 'Default services registered');
  }

  public registerService(definition: ServiceTypeDefinition): void {
    if (this.services.has(definition.serviceType)) {
      this.logger.warn({ serviceType: definition.serviceType }, 'Service type already registered, overwriting');
    }

    this.services.set(definition.serviceType, definition);
    this.logger.info({ serviceType: definition.serviceType }, 'Service type registered');
  }

  public getServiceDefinition(serviceType: string): ServiceTypeDefinition | undefined {
    return this.services.get(serviceType);
  }

  public getAllServiceDefinitions(): ServiceTypeDefinition[] {
    return Array.from(this.services.values());
  }

  public isServiceTypeAvailable(serviceType: string): boolean {
    return this.services.has(serviceType);
  }

  public getAvailableServiceTypes(): string[] {
    return Array.from(this.services.keys());
  }

  public getServiceMetadata(serviceType: string): ServiceMetadata | undefined {
    const definition = this.services.get(serviceType);
    return definition?.metadata;
  }

  public getAllServiceMetadata(): Array<ServiceMetadata & { serviceType: string; description: string }> {
    return Array.from(this.services.values()).map(def => ({
      ...def.metadata,
      serviceType: def.serviceType,
      description: def.description
    }));
  }

  public validateServiceConfiguration(serviceType: string, config: Record<string, any>): boolean {
    const definition = this.getServiceDefinition(serviceType);
    if (!definition) {
      this.logger.warn({ serviceType }, 'Unknown service type');
      return false;
    }

    // Basic validation - could be extended with JSON schema validation
    this.logger.debug({ serviceType, config }, 'Service configuration validated');
    return true;
  }

  public getServiceDependencies(serviceType: string): string[] {
    const metadata = this.getServiceMetadata(serviceType);
    return metadata?.dependencies || [];
  }

  public getServiceNetworkRequirements(serviceType: string): NetworkRequirement[] {
    const metadata = this.getServiceMetadata(serviceType);
    return metadata?.requiredNetworks || [];
  }

  public getServiceVolumeRequirements(serviceType: string): VolumeRequirement[] {
    const metadata = this.getServiceMetadata(serviceType);
    return metadata?.requiredVolumes || [];
  }

  public resolveDependencyOrder(serviceTypes: string[]): string[] {
    const resolved: string[] = [];
    const visiting: Set<string> = new Set();
    const visited: Set<string> = new Set();

    const visit = (serviceType: string) => {
      if (visited.has(serviceType)) {
        return;
      }

      if (visiting.has(serviceType)) {
        throw new Error(`Circular dependency detected involving service: ${serviceType}`);
      }

      visiting.add(serviceType);

      const dependencies = this.getServiceDependencies(serviceType);
      for (const dependency of dependencies) {
        if (serviceTypes.includes(dependency)) {
          visit(dependency);
        }
      }

      visiting.delete(serviceType);
      visited.add(serviceType);
      resolved.push(serviceType);
    };

    for (const serviceType of serviceTypes) {
      if (!visited.has(serviceType)) {
        visit(serviceType);
      }
    }

    this.logger.debug({
      inputOrder: serviceTypes,
      resolvedOrder: resolved
    }, 'Service dependency order resolved');

    return resolved;
  }
}