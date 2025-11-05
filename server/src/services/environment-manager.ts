import { PrismaClient } from '@prisma/client';
import {
  Environment,
  EnvironmentType,
  EnvironmentNetworkType,
  CreateEnvironmentRequest,
  UpdateEnvironmentRequest,
  ServiceConfiguration,
  EnvironmentOperationResult,
  ServiceOperationResult,
  EnvironmentStatusResponse,
  ServiceStatus,
  ServiceStatusValues,
  ApplicationServiceHealthStatus,
  ApplicationServiceHealthStatusValues
} from '@mini-infra/types';
import {
  NetworkRequirement,
  VolumeRequirement
} from './interfaces/application-service';
import { ServiceRegistry } from './service-registry';
import { ApplicationServiceFactory } from './application-service-factory';
import { DockerExecutorService } from './docker-executor';
import { servicesLogger } from '../lib/logger-factory';

export class EnvironmentManager {
  private static instance: EnvironmentManager;
  private readonly logger = servicesLogger();
  private readonly serviceRegistry: ServiceRegistry;
  private readonly serviceFactory: ApplicationServiceFactory;
  private readonly dockerExecutor: DockerExecutorService;

  constructor(private readonly prisma: PrismaClient) {
    this.serviceRegistry = ServiceRegistry.getInstance();
    this.serviceFactory = ApplicationServiceFactory.getInstance();
    this.dockerExecutor = new DockerExecutorService();
  }

  public static getInstance(prisma: PrismaClient): EnvironmentManager {
    if (!EnvironmentManager.instance) {
      EnvironmentManager.instance = new EnvironmentManager(prisma);
    }
    return EnvironmentManager.instance;
  }

  public async createEnvironment(request: CreateEnvironmentRequest): Promise<Environment> {
    this.logger.info({ request }, 'Creating new environment');

    try {
      // Validate service configurations
      if (request.services) {
        for (const serviceConfig of request.services) {
          if (!this.serviceRegistry.isServiceTypeAvailable(serviceConfig.serviceType)) {
            throw new Error(`Unknown service type: ${serviceConfig.serviceType}`);
          }
        }
      }

      // Create environment record
      const environmentData = await this.prisma.environment.create({
        data: {
          name: request.name,
          description: request.description,
          type: request.type,
          networkType: request.networkType || 'local',
          status: 'uninitialized',
          isActive: false
        },
        include: {
          services: true,
          networks: true,
          volumes: true
        }
      });

      // If services are provided, create them
      if (request.services && request.services.length > 0) {
        await this.addServicesToEnvironment(environmentData.id, request.services);
      }

      // Fetch the complete environment with relations
      const environment = await this.getEnvironmentById(environmentData.id);
      if (!environment) {
        throw new Error('Failed to retrieve created environment');
      }

      this.logger.info({
        environmentId: environment.id,
        environmentName: environment.name,
        serviceCount: environment.services.length
      }, 'Environment created successfully');

      return environment;

    } catch (error) {
      this.logger.error({ error, request }, 'Failed to create environment');
      throw error;
    }
  }

  public async getEnvironmentById(id: string): Promise<Environment | null> {
    try {
      const environment = await this.prisma.environment.findUnique({
        where: { id },
        include: {
          services: true,
          networks: true,
          volumes: true
        }
      });

      if (!environment) {
        return null;
      }

      return this.mapPrismaToEnvironment(environment);

    } catch (error) {
      this.logger.error({ error, environmentId: id }, 'Failed to get environment by ID');
      throw error;
    }
  }

  public async getEnvironmentByName(name: string): Promise<Environment | null> {
    try {
      const environment = await this.prisma.environment.findUnique({
        where: { name },
        include: {
          services: true,
          networks: true,
          volumes: true
        }
      });

      if (!environment) {
        return null;
      }

      return this.mapPrismaToEnvironment(environment);

    } catch (error) {
      this.logger.error({ error, environmentName: name }, 'Failed to get environment by name');
      throw error;
    }
  }

  public async listEnvironments(
    type?: EnvironmentType,
    status?: ServiceStatus,
    page: number = 1,
    limit: number = 20
  ): Promise<{ environments: Environment[]; total: number }> {
    try {
      const where: any = {};
      if (type) where.type = type;
      if (status) where.status = status;

      const [environments, total] = await Promise.all([
        this.prisma.environment.findMany({
          where,
          include: {
            services: true,
            networks: true,
            volumes: true
          },
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { createdAt: 'desc' }
        }),
        this.prisma.environment.count({ where })
      ]);

      return {
        environments: environments.map(env => this.mapPrismaToEnvironment(env)),
        total
      };

    } catch (error) {
      this.logger.error({ error, type, status, page, limit }, 'Failed to list environments');
      throw error;
    }
  }

  public async updateEnvironment(id: string, request: UpdateEnvironmentRequest): Promise<Environment | null> {
    try {
      const environment = await this.prisma.environment.update({
        where: { id },
        data: {
          description: request.description,
          type: request.type,
          networkType: request.networkType,
          isActive: request.isActive
        },
        include: {
          services: true,
          networks: true,
          volumes: true
        }
      });

      this.logger.info({ environmentId: id, request }, 'Environment updated successfully');
      return this.mapPrismaToEnvironment(environment);

    } catch (error) {
      this.logger.error({ error, environmentId: id, request }, 'Failed to update environment');
      throw error;
    }
  }

  public async deleteEnvironment(
    id: string,
    options: { deleteVolumes?: boolean; deleteNetworks?: boolean } = {}
  ): Promise<boolean> {
    const { deleteVolumes = false, deleteNetworks = false } = options;

    try {
      // Check if environment is running
      const environment = await this.getEnvironmentById(id);
      if (!environment) {
        return false;
      }

      if (environment.status === ServiceStatusValues.RUNNING) {
        throw new Error('Cannot delete a running environment. Stop it first.');
      }

      this.logger.info({
        environmentId: id,
        deleteVolumes,
        deleteNetworks,
        networkCount: environment.networks.length,
        volumeCount: environment.volumes.length
      }, 'Starting environment deletion');

      // Delete Docker volumes if requested
      if (deleteVolumes && environment.volumes.length > 0) {
        this.logger.info({
          environmentId: id,
          volumes: environment.volumes.map(v => v.name)
        }, 'Deleting Docker volumes');

        for (const volume of environment.volumes) {
          try {
            await this.dockerExecutor.removeVolume(volume.name);
            this.logger.debug({
              environmentId: id,
              volumeName: volume.name
            }, 'Docker volume deleted successfully');
          } catch (error) {
            this.logger.warn({
              error,
              environmentId: id,
              volumeName: volume.name
            }, 'Failed to delete Docker volume (volume may not exist in Docker)');
            // Continue with deletion even if Docker volume removal fails
          }
        }
      }

      // Delete Docker networks if requested
      if (deleteNetworks && environment.networks.length > 0) {
        this.logger.info({
          environmentId: id,
          networks: environment.networks.map(n => n.name)
        }, 'Deleting Docker networks');

        for (const network of environment.networks) {
          try {
            await this.dockerExecutor.removeNetwork(network.name);
            this.logger.debug({
              environmentId: id,
              networkName: network.name
            }, 'Docker network deleted successfully');
          } catch (error) {
            this.logger.warn({
              error,
              environmentId: id,
              networkName: network.name
            }, 'Failed to delete Docker network (network may not exist in Docker)');
            // Continue with deletion even if Docker network removal fails
          }
        }
      }

      // Delete environment (cascade will handle related records)
      await this.prisma.environment.delete({
        where: { id }
      });

      this.logger.info({
        environmentId: id,
        deleteVolumes,
        deleteNetworks
      }, 'Environment deleted successfully');
      return true;

    } catch (error) {
      this.logger.error({
        error,
        environmentId: id,
        deleteVolumes,
        deleteNetworks
      }, 'Failed to delete environment');
      throw error;
    }
  }

  public async startEnvironment(id: string): Promise<EnvironmentOperationResult> {
    const startTime = Date.now();

    try {
      const environment = await this.getEnvironmentById(id);
      if (!environment) {
        return {
          success: false,
          message: 'Environment not found'
        };
      }

      if (environment.status === ServiceStatusValues.RUNNING) {
        return {
          success: true,
          message: 'Environment is already running'
        };
      }

      this.logger.info({ environmentId: id }, 'Starting environment');

      // Update status to starting
      await this.updateEnvironmentStatus(id, ServiceStatusValues.STARTING);

      try {
        // Initialize Docker executor
        await this.dockerExecutor.initialize();

        // Create networks and volumes first
        await this.provisionInfrastructure(environment);

        // Start services in dependency order
        await this.startAllServices(environment);

        // Update status to running
        await this.updateEnvironmentStatus(id, ServiceStatusValues.RUNNING);
        await this.markEnvironmentActive(id, true);

        const duration = Date.now() - startTime;

        this.logger.info({
          environmentId: id,
          duration
        }, 'Environment started successfully');

        return {
          success: true,
          message: 'Environment started successfully',
          duration
        };

      } catch (error) {
        // Update status to failed
        await this.updateEnvironmentStatus(id, ServiceStatusValues.FAILED);

        throw error;
      }

    } catch (error) {
      const duration = Date.now() - startTime;

      this.logger.error({
        error,
        environmentId: id,
        duration
      }, 'Failed to start environment');

      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
        duration,
        details: { error: error instanceof Error ? error.message : 'Unknown error' }
      };
    }
  }

  public async stopEnvironment(id: string): Promise<EnvironmentOperationResult> {
    const startTime = Date.now();

    try {
      const environment = await this.getEnvironmentById(id);
      if (!environment) {
        return {
          success: false,
          message: 'Environment not found'
        };
      }

      if (environment.status === ServiceStatusValues.STOPPED) {
        return {
          success: true,
          message: 'Environment is already stopped'
        };
      }

      this.logger.info({ environmentId: id }, 'Stopping environment');

      // Update status to stopping
      await this.updateEnvironmentStatus(id, ServiceStatusValues.STOPPING);

      try {
        // Stop services in reverse dependency order
        await this.stopAllServices(environment);

        // Update status to stopped
        await this.updateEnvironmentStatus(id, ServiceStatusValues.STOPPED);
        await this.markEnvironmentActive(id, false);

        const duration = Date.now() - startTime;

        this.logger.info({
          environmentId: id,
          duration
        }, 'Environment stopped successfully');

        return {
          success: true,
          message: 'Environment stopped successfully',
          duration
        };

      } catch (error) {
        // Update status to failed
        await this.updateEnvironmentStatus(id, ServiceStatusValues.FAILED);

        throw error;
      }

    } catch (error) {
      const duration = Date.now() - startTime;

      this.logger.error({
        error,
        environmentId: id,
        duration
      }, 'Failed to stop environment');

      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
        duration,
        details: { error: error instanceof Error ? error.message : 'Unknown error' }
      };
    }
  }

  public async getEnvironmentStatus(id: string): Promise<EnvironmentStatusResponse | null> {
    try {
      const environment = await this.getEnvironmentById(id);
      if (!environment) {
        return null;
      }

      // Check service health
      const servicesHealth = [];
      for (const service of environment.services) {
        const serviceInstance = this.serviceFactory.getService(service.serviceName);
        let healthDetails = undefined;

        if (serviceInstance) {
          try {
            const statusInfo = await serviceInstance.getStatus();
            healthDetails = statusInfo.health.details;
          } catch (error) {
            this.logger.warn({
              error,
              serviceName: service.serviceName
            }, 'Failed to get service health');
          }
        }

        servicesHealth.push({
          serviceName: service.serviceName,
          status: service.status as ServiceStatus,
          health: service.health as ApplicationServiceHealthStatus,
          healthDetails
        });
      }

      // Check network status
      const networksStatus = [];
      for (const network of environment.networks) {
        try {
          const exists = await this.dockerExecutor.networkExists(network.name);
          networksStatus.push({
            name: network.name,
            exists,
            dockerId: network.dockerId || undefined
          });
        } catch (error) {
          networksStatus.push({
            name: network.name,
            exists: false
          });
        }
      }

      // Check volume status
      const volumesStatus = [];
      for (const volume of environment.volumes) {
        try {
          const exists = await this.dockerExecutor.volumeExists(volume.name);
          volumesStatus.push({
            name: volume.name,
            exists,
            dockerId: volume.dockerId || undefined
          });
        } catch (error) {
          volumesStatus.push({
            name: volume.name,
            exists: false
          });
        }
      }

      return {
        environment,
        servicesHealth,
        networksStatus,
        volumesStatus
      };

    } catch (error) {
      this.logger.error({ error, environmentId: id }, 'Failed to get environment status');
      throw error;
    }
  }

  public async addServicesToEnvironment(environmentId: string, services: ServiceConfiguration[]): Promise<void> {
    try {
      for (const serviceConfig of services) {
        await this.addServiceToEnvironment(environmentId, serviceConfig);
      }
    } catch (error) {
      this.logger.error({
        error,
        environmentId,
        services
      }, 'Failed to add services to environment');
      throw error;
    }
  }

  public async addServiceToEnvironment(environmentId: string, serviceConfig: ServiceConfiguration): Promise<void> {
    try {
      // Validate service type
      if (!this.serviceRegistry.isServiceTypeAvailable(serviceConfig.serviceType)) {
        throw new Error(`Unknown service type: ${serviceConfig.serviceType}`);
      }

      // Get service metadata to determine requirements
      const metadata = this.serviceRegistry.getServiceMetadata(serviceConfig.serviceType);
      if (!metadata) {
        throw new Error(`No metadata found for service type: ${serviceConfig.serviceType}`);
      }

      // Get environment for prefixing
      const environment = await this.prisma.environment.findUnique({
        where: { id: environmentId }
      });
      if (!environment) {
        throw new Error(`Environment not found: ${environmentId}`);
      }

      // Create networks for this service with environment prefix
      for (const networkReq of metadata.requiredNetworks) {
        const prefixedNetworkName = `${environment.name}-${networkReq.name}`;
        await this.prisma.environmentNetwork.upsert({
          where: {
            environmentId_name: {
              environmentId,
              name: prefixedNetworkName
            }
          },
          create: {
            environmentId,
            name: prefixedNetworkName,
            driver: networkReq.driver || 'bridge',
            options: networkReq.options || {}
          },
          update: {} // No update needed if exists
        });
      }

      // Create volumes for this service with environment prefix
      for (const volumeReq of metadata.requiredVolumes) {
        const prefixedVolumeName = `${environment.name}-${volumeReq.name}`;
        await this.prisma.environmentVolume.upsert({
          where: {
            environmentId_name: {
              environmentId,
              name: prefixedVolumeName
            }
          },
          create: {
            environmentId,
            name: prefixedVolumeName,
            driver: volumeReq.driver || 'local',
            options: volumeReq.options || {}
          },
          update: {} // No update needed if exists
        });
      }

      // Create service record
      await this.prisma.environmentService.create({
        data: {
          environmentId,
          serviceName: serviceConfig.serviceName,
          serviceType: serviceConfig.serviceType,
          status: 'uninitialized',
          health: ApplicationServiceHealthStatusValues.UNKNOWN,
          config: serviceConfig.config || {}
        }
      });

      this.logger.info({
        environmentId,
        serviceName: serviceConfig.serviceName,
        serviceType: serviceConfig.serviceType
      }, 'Service added to environment');

    } catch (error) {
      this.logger.error({
        error,
        environmentId,
        serviceConfig
      }, 'Failed to add service to environment');
      throw error;
    }
  }

  private async provisionInfrastructure(environment: Environment): Promise<void> {
    // Create networks
    for (const network of environment.networks) {
      try {
        const exists = await this.dockerExecutor.networkExists(network.name);
        if (!exists) {
          await this.dockerExecutor.createNetwork(
            network.name,
            environment.name,
            {
              driver: network.driver,
              ...network.options
            }
          );

          this.logger.info({
            environmentId: environment.id,
            networkName: network.name
          }, 'Network created for environment');
        }
      } catch (error) {
        this.logger.error({
          error,
          environmentId: environment.id,
          networkName: network.name
        }, 'Failed to create network');
        throw error;
      }
    }

    // Create volumes
    for (const volume of environment.volumes) {
      try {
        const exists = await this.dockerExecutor.volumeExists(volume.name);
        if (!exists) {
          await this.dockerExecutor.createVolume(
            volume.name,
            environment.name
          );

          this.logger.info({
            environmentId: environment.id,
            volumeName: volume.name
          }, 'Volume created for environment');
        }
      } catch (error) {
        this.logger.error({
          error,
          environmentId: environment.id,
          volumeName: volume.name
        }, 'Failed to create volume');
        throw error;
      }
    }
  }

  private async startAllServices(environment: Environment): Promise<void> {
    const serviceTypes = environment.services.map(s => s.serviceType);
    const startOrder = this.serviceRegistry.resolveDependencyOrder(serviceTypes);

    for (const serviceType of startOrder) {
      const envService = environment.services.find(s => s.serviceType === serviceType);
      if (!envService) continue;

      await this.startEnvironmentService(environment, envService);
    }
  }

  private async stopAllServices(environment: Environment): Promise<void> {
    const serviceTypes = environment.services.map(s => s.serviceType);
    const stopOrder = this.serviceRegistry.resolveDependencyOrder(serviceTypes).reverse();

    for (const serviceType of stopOrder) {
      const envService = environment.services.find(s => s.serviceType === serviceType);
      if (!envService) continue;

      await this.stopEnvironmentService(envService);
    }
  }

  private async startEnvironmentService(environment: Environment, envService: any): Promise<void> {
    try {
      // Create service instance with environment-prefixed service name
      const prefixedServiceName = `${environment.name}-${envService.serviceName}`;
      const result = await this.serviceFactory.createService({
        serviceName: prefixedServiceName,
        serviceType: envService.serviceType,
        config: envService.config,
        projectName: environment.name,
        environmentId: environment.id
      });

      if (!result.success || !result.service) {
        throw new Error(result.message || 'Failed to create service instance');
      }

      // Get networks and volumes for this service
      const networks = environment.networks.map(n => ({
        name: n.name,
        driver: n.driver,
        options: n.options
      }));

      const volumes = environment.volumes.map(v => ({
        name: v.name,
        driver: v.driver,
        options: v.options
      }));

      // Initialize service
      await result.service.initialize(networks, volumes);

      // Start service
      const startResult = await result.service.start();

      if (!startResult.success) {
        throw new Error(startResult.message || 'Service failed to start');
      }

      // Update service status
      await this.updateServiceStatus(
        envService.id,
        ServiceStatusValues.RUNNING,
        ApplicationServiceHealthStatusValues.HEALTHY
      );

      this.logger.info({
        environmentId: environment.id,
        serviceName: envService.serviceName,
        duration: startResult.duration
      }, 'Environment service started successfully');

    } catch (error) {
      await this.updateServiceStatus(
        envService.id,
        ServiceStatusValues.FAILED,
        ApplicationServiceHealthStatusValues.UNHEALTHY
      );

      this.logger.error({
        error,
        environmentId: environment.id,
        serviceName: envService.serviceName
      }, 'Failed to start environment service');

      throw error;
    }
  }

  private async stopEnvironmentService(envService: any): Promise<void> {
    try {
      // Check if service is already stopped or uninitialized
      if (envService.status === ServiceStatusValues.STOPPED ||
          envService.status === ServiceStatusValues.UNINITIALIZED) {
        this.logger.debug({
          serviceName: envService.serviceName,
          currentStatus: envService.status
        }, 'Service already in stopped/uninitialized state, skipping stop operation');

        // Ensure status is set to stopped
        await this.updateServiceStatus(
          envService.id,
          ServiceStatusValues.STOPPED,
          ApplicationServiceHealthStatusValues.UNKNOWN
        );

        return;
      }

      // Get environment to pass ID to factory
      const environment = await this.getEnvironmentById(envService.environmentId);
      if (!environment) {
        throw new Error(`Environment not found: ${envService.environmentId}`);
      }

      // Attempt to stop service (factory will handle missing service instances gracefully)
      await this.serviceFactory.stopService(envService.serviceName, environment.id);

      // Update service status
      await this.updateServiceStatus(
        envService.id,
        ServiceStatusValues.STOPPED,
        ApplicationServiceHealthStatusValues.UNKNOWN
      );

      // Update stopped timestamp
      await this.prisma.environmentService.update({
        where: { id: envService.id },
        data: {
          stoppedAt: new Date()
        }
      });

      this.logger.info({
        serviceName: envService.serviceName,
        environmentId: environment.id
      }, 'Environment service stopped successfully');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Only mark as failed if it's a real error, not just "service not found"
      if (!errorMessage.includes('Service not found')) {
        await this.updateServiceStatus(
          envService.id,
          ServiceStatusValues.FAILED,
          ApplicationServiceHealthStatusValues.UNHEALTHY
        );
      } else {
        // If service wasn't found, mark as stopped since it's not running anyway
        this.logger.warn({
          serviceName: envService.serviceName,
          error: errorMessage
        }, 'Service not found, marking as stopped');

        await this.updateServiceStatus(
          envService.id,
          ServiceStatusValues.STOPPED,
          ApplicationServiceHealthStatusValues.UNKNOWN
        );
      }

      this.logger.error({
        error: errorMessage,
        serviceName: envService.serviceName
      }, 'Failed to stop environment service');

      throw error;
    }
  }

  private async updateEnvironmentStatus(id: string, status: ServiceStatus): Promise<void> {
    await this.prisma.environment.update({
      where: { id },
      data: { status }
    });
  }

  private async markEnvironmentActive(id: string, isActive: boolean): Promise<void> {
    await this.prisma.environment.update({
      where: { id },
      data: { isActive }
    });
  }

  private async updateServiceStatus(
    serviceId: string,
    status: ServiceStatus,
    health: ApplicationServiceHealthStatus
  ): Promise<void> {
    const updateData: any = { status, health };

    if (status === ServiceStatusValues.RUNNING) {
      updateData.startedAt = new Date();
      updateData.stoppedAt = null;
    } else if (status === ServiceStatusValues.STOPPED) {
      updateData.stoppedAt = new Date();
    }

    await this.prisma.environmentService.update({
      where: { id: serviceId },
      data: updateData
    });
  }

  private mapPrismaToEnvironment(prismaEnv: any): Environment {
    return {
      id: prismaEnv.id,
      name: prismaEnv.name,
      description: prismaEnv.description,
      type: prismaEnv.type as EnvironmentType,
      networkType: prismaEnv.networkType as EnvironmentNetworkType,
      status: prismaEnv.status as ServiceStatus,
      isActive: prismaEnv.isActive,
      services: prismaEnv.services.map((s: any) => ({
        id: s.id,
        environmentId: s.environmentId,
        serviceName: s.serviceName,
        serviceType: s.serviceType,
        status: s.status as ServiceStatus,
        health: s.health as ApplicationServiceHealthStatus,
        config: s.config,
        startedAt: s.startedAt,
        stoppedAt: s.stoppedAt,
        lastError: s.lastError,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      })),
      networks: prismaEnv.networks.map((n: any) => ({
        id: n.id,
        environmentId: n.environmentId,
        name: n.name,
        driver: n.driver,
        options: n.options,
        dockerId: n.dockerId,
        createdAt: n.createdAt
      })),
      volumes: prismaEnv.volumes.map((v: any) => ({
        id: v.id,
        environmentId: v.environmentId,
        name: v.name,
        driver: v.driver,
        options: v.options,
        dockerId: v.dockerId,
        createdAt: v.createdAt
      })),
      createdAt: prismaEnv.createdAt,
      updatedAt: prismaEnv.updatedAt
    };
  }
}