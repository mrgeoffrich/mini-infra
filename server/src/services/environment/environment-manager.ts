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
} from '../interfaces/application-service';
import { ServiceRegistry } from './service-registry';
import { ApplicationServiceFactory } from '../application-service-factory';
import { DockerExecutorService } from '../docker-executor';
import { servicesLogger } from '../../lib/logger-factory';
import { UserEventService } from '../user-events';
import { portUtils } from '../port-utils';
import { seedStacksForEnvironment } from '../stacks/seed';
import { StackReconciler } from '../stacks/stack-reconciler';
import { StackRoutingManager } from '../stacks/stack-routing-manager';
import { HAProxyFrontendManager } from '../haproxy';

export class EnvironmentManager {
  private static instance: EnvironmentManager;
  private readonly logger = servicesLogger();
  private readonly serviceRegistry: ServiceRegistry;
  private readonly serviceFactory: ApplicationServiceFactory;
  private readonly dockerExecutor: DockerExecutorService;
  private readonly userEventService: UserEventService;

  constructor(private readonly prisma: PrismaClient) {
    this.serviceRegistry = ServiceRegistry.getInstance();
    this.serviceFactory = ApplicationServiceFactory.getInstance();
    this.dockerExecutor = new DockerExecutorService();
    this.userEventService = new UserEventService(prisma);
  }

  public static getInstance(prisma: PrismaClient): EnvironmentManager {
    if (!EnvironmentManager.instance) {
      EnvironmentManager.instance = new EnvironmentManager(prisma);
    }
    return EnvironmentManager.instance;
  }

  public async createEnvironment(request: CreateEnvironmentRequest, userId?: string): Promise<Environment> {
    const startTime = Date.now();
    let userEvent: any = null;

    this.logger.info({ request }, 'Creating new environment');

    try {
      // Create user event for tracking
      userEvent = await this.userEventService.createEvent({
        eventType: 'environment_create',
        eventCategory: 'infrastructure',
        eventName: `Create Environment: ${request.name}`,
        userId: userId || undefined,
        triggeredBy: userId ? 'manual' : 'api',
        resourceType: 'environment',
        resourceName: request.name,
        description: `Creating ${request.type} environment${request.services ? ` with ${request.services.length} service(s)` : ''}`,
        metadata: {
          environmentName: request.name,
          environmentType: request.type,
          networkType: request.networkType || 'local',
          serviceCount: request.services?.length || 0,
          services: request.services?.map(s => ({ name: s.serviceName, type: s.serviceType })) || []
        }
      });

      // Validate service configurations
      if (request.services) {
        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Validating ${request.services.length} service configuration(s)...`);
        for (const serviceConfig of request.services) {
          if (!this.serviceRegistry.isServiceTypeAvailable(serviceConfig.serviceType)) {
            throw new Error(`Unknown service type: ${serviceConfig.serviceType}`);
          }
        }
        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] All service configurations validated successfully`);
      }

      // Create environment record
      await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Creating environment record...`);
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
      await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Environment record created (ID: ${environmentData.id})`);

      // Create environment networks based on network type
      await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Creating environment networks...`);
      await this.createEnvironmentNetworks(environmentData.id, environmentData.name, environmentData.networkType);
      await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Environment networks created`);

      // If services are provided, create them
      if (request.services && request.services.length > 0) {
        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Adding ${request.services.length} service(s) to environment...`);
        await this.addServicesToEnvironment(environmentData.id, request.services);
        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] All services added successfully`);
      }

      // Seed stacks for the new environment
      await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Seeding stacks for environment...`);
      await seedStacksForEnvironment(this.prisma, environmentData.id);
      await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Stack seeding complete`);

      // Fetch the complete environment with relations
      const environment = await this.getEnvironmentById(environmentData.id);
      if (!environment) {
        throw new Error('Failed to retrieve created environment');
      }

      const duration = Date.now() - startTime;

      this.logger.info({
        environmentId: environment.id,
        environmentName: environment.name,
        serviceCount: environment.services.length,
        userEventId: userEvent.id
      }, 'Environment created successfully');

      // Complete the user event
      await this.userEventService.updateEvent(userEvent.id, {
        status: 'completed',
        resultSummary: `Environment '${environment.name}' created successfully with ${environment.services.length} service(s)`,
        durationMs: duration
      });

      return environment;

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.logger.error({ error, request, userEventId: userEvent?.id }, 'Failed to create environment');

      // Update user event with failure details
      if (userEvent) {
        await this.userEventService.updateEvent(userEvent.id, {
          status: 'failed',
          errorMessage: `Failed to create environment: ${errorMessage}`,
          errorDetails: {
            type: error instanceof Error ? error.constructor.name : 'Unknown',
            message: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
            request,
            duration
          },
          durationMs: duration
        });
      }

      throw error;
    }
  }

  /**
   * Get the expected network definitions for an environment based on its network type.
   */
  private getExpectedNetworks(envName: string, networkType: string): Array<{ name: string; purpose: string }> {
    const networks: Array<{ name: string; purpose: string }> = [
      { name: `${envName}-applications`, purpose: 'applications' },
    ];
    if (networkType === 'internet') {
      networks.push({ name: `${envName}-tunnel`, purpose: 'tunnel' });
    }
    return networks;
  }

  /**
   * Create environment network records based on network type.
   * All environments get an 'applications' network.
   * Internet-facing environments also get a 'tunnel' network.
   */
  private async createEnvironmentNetworks(environmentId: string, envName: string, networkType: string): Promise<void> {
    const expected = this.getExpectedNetworks(envName, networkType);
    for (const net of expected) {
      await this.prisma.environmentNetwork.upsert({
        where: { environmentId_purpose: { environmentId, purpose: net.purpose } },
        create: {
          environmentId,
          name: net.name,
          purpose: net.purpose,
          driver: 'bridge',
        },
        update: {},
      });
    }
  }

  /**
   * Remediate environment networks — create any missing network records
   * and fix names that don't match the expected convention.
   * Returns the list of networks that were created or renamed.
   */
  public async remediateNetworks(environmentId: string): Promise<{ created: string[]; renamed: string[]; existing: string[] }> {
    const environment = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: { networks: true },
    });
    if (!environment) {
      throw new Error('Environment not found');
    }

    const expected = this.getExpectedNetworks(environment.name, environment.networkType);
    const existingByPurpose = new Map(environment.networks.map((n) => [n.purpose, n]));

    const created: string[] = [];
    const renamed: string[] = [];
    const existing: string[] = [];

    for (const net of expected) {
      const existingNet = existingByPurpose.get(net.purpose);
      if (existingNet) {
        if (existingNet.name !== net.name) {
          // Name doesn't match convention — update it
          await this.prisma.environmentNetwork.update({
            where: { id: existingNet.id },
            data: { name: net.name },
          });
          renamed.push(`${existingNet.name} -> ${net.name}`);
        } else {
          existing.push(net.name);
        }
      } else {
        await this.prisma.environmentNetwork.create({
          data: {
            environmentId,
            name: net.name,
            purpose: net.purpose,
            driver: 'bridge',
          },
        });
        created.push(net.name);
      }
    }

    this.logger.info({ environmentId, created, renamed, existing }, 'Remediated environment networks');
    return { created, renamed, existing };
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
    options: { deleteVolumes?: boolean; deleteNetworks?: boolean; userId?: string } = {}
  ): Promise<boolean> {
    const { deleteVolumes = false, deleteNetworks = false, userId } = options;
    const startTime = Date.now();
    let userEvent: any = null;

    try {
      // Check if environment is running
      const environment = await this.getEnvironmentById(id);
      if (!environment) {
        return false;
      }

      if (environment.status === ServiceStatusValues.RUNNING) {
        throw new Error('Cannot delete a running environment. Stop it first.');
      }

      // Create user event for tracking
      userEvent = await this.userEventService.createEvent({
        eventType: 'environment_delete',
        eventCategory: 'infrastructure',
        eventName: `Delete Environment: ${environment.name}`,
        userId: userId || undefined,
        triggeredBy: userId ? 'manual' : 'api',
        resourceId: environment.id,
        resourceType: 'environment',
        resourceName: environment.name,
        description: `Deleting ${environment.type} environment (volumes: ${deleteVolumes ? 'yes' : 'no'}, networks: ${deleteNetworks ? 'yes' : 'no'})`,
        metadata: {
          environmentId: environment.id,
          environmentName: environment.name,
          environmentType: environment.type,
          deleteVolumes,
          deleteNetworks,
          networkCount: environment.networks.length,
          volumeCount: environment.volumes.length,
          serviceCount: environment.services.length
        }
      });

      this.logger.info({
        environmentId: id,
        deleteVolumes,
        deleteNetworks,
        networkCount: environment.networks.length,
        volumeCount: environment.volumes.length,
        serviceCount: environment.services.length,
        userEventId: userEvent.id
      }, 'Starting environment deletion');

      // Initialize Docker executor for volume/network operations
      await this.dockerExecutor.initialize();

      // Clean up service instances and containers first to free volumes/networks
      if (environment.services.length > 0) {
        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Cleaning up ${environment.services.length} service container(s)...`);
        this.logger.info({
          environmentId: id,
          services: environment.services.map(s => s.serviceName)
        }, 'Cleaning up service containers before deletion');

        let cleanedServices = 0;
        let failedServices = 0;

        for (const service of environment.services) {
          try {
            const prefixedServiceName = `${environment.name}-${service.serviceName}`;

            // Use stopService which handles both factory cleanup AND Docker container removal
            // This works even if the service instance is not in the factory
            await this.serviceFactory.stopService(prefixedServiceName, environment.id);

            cleanedServices++;
            this.logger.debug({
              environmentId: id,
              serviceName: service.serviceName
            }, 'Service container cleaned up successfully');
            await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Service '${service.serviceName}' container cleaned up successfully`);
          } catch (error) {
            failedServices++;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.warn({
              error,
              environmentId: id,
              serviceName: service.serviceName
            }, 'Failed to clean up service container (may not exist)');
            await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] WARNING: Failed to clean up service '${service.serviceName}': ${errorMessage}`);
            // Continue with deletion even if service cleanup fails
          }
        }

        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Cleaned up ${cleanedServices}/${environment.services.length} service container(s) (${failedServices} failed or already removed)`);
      }

      // Delete Docker volumes if requested
      if (deleteVolumes && environment.volumes.length > 0) {
        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Deleting ${environment.volumes.length} Docker volume(s)...`);
        this.logger.info({
          environmentId: id,
          volumes: environment.volumes.map(v => v.name)
        }, 'Deleting Docker volumes');

        let deletedVolumes = 0;
        let failedVolumes = 0;

        for (const volume of environment.volumes) {
          try {
            await this.dockerExecutor.removeVolume(volume.name);
            deletedVolumes++;
            this.logger.debug({
              environmentId: id,
              volumeName: volume.name
            }, 'Docker volume deleted successfully');
            await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Volume '${volume.name}' deleted successfully`);
          } catch (error) {
            failedVolumes++;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.warn({
              error,
              environmentId: id,
              volumeName: volume.name
            }, 'Failed to delete Docker volume (volume may not exist in Docker)');
            await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] WARNING: Failed to delete volume '${volume.name}': ${errorMessage}`);
            // Continue with deletion even if Docker volume removal fails
          }
        }

        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Deleted ${deletedVolumes}/${environment.volumes.length} volume(s) (${failedVolumes} failed)`);
      }

      // Delete Docker networks if requested
      if (deleteNetworks && environment.networks.length > 0) {
        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Deleting ${environment.networks.length} Docker network(s)...`);
        this.logger.info({
          environmentId: id,
          networks: environment.networks.map(n => n.name)
        }, 'Deleting Docker networks');

        let deletedNetworks = 0;
        let failedNetworks = 0;

        for (const network of environment.networks) {
          try {
            await this.dockerExecutor.removeNetwork(network.name);
            deletedNetworks++;
            this.logger.debug({
              environmentId: id,
              networkName: network.name
            }, 'Docker network deleted successfully');
            await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Network '${network.name}' deleted successfully`);
          } catch (error) {
            failedNetworks++;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.warn({
              error,
              environmentId: id,
              networkName: network.name
            }, 'Failed to delete Docker network (network may not exist in Docker)');
            await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] WARNING: Failed to delete network '${network.name}': ${errorMessage}`);
            // Continue with deletion even if Docker network removal fails
          }
        }

        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Deleted ${deletedNetworks}/${environment.networks.length} network(s) (${failedNetworks} failed)`);
      }

      // Delete environment (cascade will handle related records)
      await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Deleting environment record...`);
      await this.prisma.environment.delete({
        where: { id }
      });

      const duration = Date.now() - startTime;

      this.logger.info({
        environmentId: id,
        deleteVolumes,
        deleteNetworks,
        userEventId: userEvent.id
      }, 'Environment deleted successfully');

      // Complete the user event
      await this.userEventService.updateEvent(userEvent.id, {
        status: 'completed',
        resultSummary: `Environment '${environment.name}' deleted successfully`,
        durationMs: duration
      });

      return true;

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.logger.error({
        error,
        environmentId: id,
        deleteVolumes,
        deleteNetworks,
        userEventId: userEvent?.id
      }, 'Failed to delete environment');

      // Update user event with failure details
      if (userEvent) {
        await this.userEventService.updateEvent(userEvent.id, {
          status: 'failed',
          errorMessage: `Failed to delete environment: ${errorMessage}`,
          errorDetails: {
            type: error instanceof Error ? error.constructor.name : 'Unknown',
            message: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
            environmentId: id,
            deleteVolumes,
            deleteNetworks,
            duration
          },
          durationMs: duration
        });
      }

      throw error;
    }
  }

  public async startEnvironment(id: string, userId?: string): Promise<EnvironmentOperationResult> {
    const startTime = Date.now();
    let userEvent: any = null;

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

      // Pre-flight port validation for HAProxy services
      const hasHAProxy = environment.services.some(s => s.serviceType === 'haproxy');
      if (hasHAProxy) {
        this.logger.info({ environmentId: id }, 'Validating HAProxy ports before starting');
        const { validation } = await portUtils.validatePortsForEnvironment(id);

        if (!validation.isValid) {
          this.logger.warn({ environmentId: id, validation }, 'Port validation failed');
          return {
            success: false,
            message: validation.message,
            details: {
              unavailablePorts: validation.unavailablePorts,
              conflicts: validation.conflicts
            }
          };
        }
        this.logger.info({ environmentId: id }, 'Port validation passed');
      }

      // Create user event for tracking
      userEvent = await this.userEventService.createEvent({
        eventType: 'environment_start',
        eventCategory: 'infrastructure',
        eventName: `Start Environment: ${environment.name}`,
        userId: userId || undefined,
        triggeredBy: userId ? 'manual' : 'api',
        resourceId: environment.id,
        resourceType: 'environment',
        resourceName: environment.name,
        description: `Starting ${environment.type} environment with ${environment.services.length} service(s)`,
        metadata: {
          environmentId: environment.id,
          environmentName: environment.name,
          environmentType: environment.type,
          serviceCount: environment.services.length,
          networkCount: environment.networks.length,
          volumeCount: environment.volumes.length,
          services: environment.services.map(s => ({
            name: s.serviceName,
            type: s.serviceType,
            status: s.status
          }))
        }
      });

      this.logger.info({ environmentId: id, userEventId: userEvent.id }, 'Starting environment');

      // Update status to starting
      await this.updateEnvironmentStatus(id, ServiceStatusValues.STARTING);

      try {
        // Initialize Docker executor
        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Initializing Docker executor...`);
        await this.dockerExecutor.initialize();
        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Docker executor initialized successfully`);

        // Apply all stacks for this environment (reconciler handles networks/volumes/containers)
        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Applying stacks...`);
        const stacks = await this.prisma.stack.findMany({
          where: { environmentId: id, status: { not: 'removed' } },
          include: { services: { orderBy: { order: 'asc' } } },
        });

        const hasStatelessWeb = stacks.some(s =>
          s.services?.some(svc => svc.serviceType === 'StatelessWeb')
        );
        const routingManager = hasStatelessWeb
          ? new StackRoutingManager(this.prisma, new HAProxyFrontendManager())
          : undefined;
        const reconciler = new StackReconciler(this.dockerExecutor, this.prisma, routingManager);

        for (const stack of stacks) {
          await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Applying stack '${stack.name}' (v${stack.version})...`);
          const result = await reconciler.apply(stack.id);

          if (!result.success) {
            const failed = result.serviceResults.filter(r => !r.success);
            const msg = `Stack '${stack.name}' apply failed: ${failed.map(f => `${f.serviceName}: ${f.error}`).join(', ')}`;
            await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] ERROR: ${msg}`);
            throw new Error(msg);
          }

          await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Stack '${stack.name}' applied successfully (${result.serviceResults.length} services)`);
        }

        // Update all environment service statuses to RUNNING
        for (const envService of environment.services) {
          await this.updateServiceStatus(envService.id, ServiceStatusValues.RUNNING, ApplicationServiceHealthStatusValues.HEALTHY);
        }

        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] All stacks applied successfully`);

        // Update status to running
        await this.updateEnvironmentStatus(id, ServiceStatusValues.RUNNING);
        await this.markEnvironmentActive(id, true);

        const duration = Date.now() - startTime;

        this.logger.info({
          environmentId: id,
          duration,
          userEventId: userEvent.id
        }, 'Environment started successfully');

        // Complete the user event
        await this.userEventService.updateEvent(userEvent.id, {
          status: 'completed',
          resultSummary: `Environment '${environment.name}' started successfully with ${environment.services.length} service(s)`,
          durationMs: duration
        });

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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.logger.error({
        error,
        environmentId: id,
        duration,
        userEventId: userEvent?.id
      }, 'Failed to start environment');

      // Update user event with failure details
      if (userEvent) {
        await this.userEventService.updateEvent(userEvent.id, {
          status: 'failed',
          errorMessage: `Failed to start environment: ${errorMessage}`,
          errorDetails: {
            type: error instanceof Error ? error.constructor.name : 'Unknown',
            message: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
            environmentId: id,
            duration
          },
          durationMs: duration
        });
      }

      return {
        success: false,
        message: errorMessage,
        duration,
        details: { error: errorMessage }
      };
    }
  }

  public async stopEnvironment(id: string, userId?: string): Promise<EnvironmentOperationResult> {
    const startTime = Date.now();
    let userEvent: any = null;

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

      // Create user event for tracking
      userEvent = await this.userEventService.createEvent({
        eventType: 'environment_stop',
        eventCategory: 'infrastructure',
        eventName: `Stop Environment: ${environment.name}`,
        userId: userId || undefined,
        triggeredBy: userId ? 'manual' : 'api',
        resourceId: environment.id,
        resourceType: 'environment',
        resourceName: environment.name,
        description: `Stopping ${environment.type} environment with ${environment.services.length} service(s)`,
        metadata: {
          environmentId: environment.id,
          environmentName: environment.name,
          environmentType: environment.type,
          serviceCount: environment.services.length,
          services: environment.services.map(s => ({
            name: s.serviceName,
            type: s.serviceType,
            status: s.status
          }))
        }
      });

      this.logger.info({ environmentId: id, userEventId: userEvent.id }, 'Stopping environment');

      // Update status to stopping
      await this.updateEnvironmentStatus(id, ServiceStatusValues.STOPPING);

      try {
        // Stop all stacks for this environment
        const stacks = await this.prisma.stack.findMany({
          where: { environmentId: id, status: { not: 'removed' } },
        });

        const reconciler = new StackReconciler(this.dockerExecutor, this.prisma);

        for (const stack of stacks) {
          await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Stopping stack '${stack.name}'...`);
          const result = await reconciler.stopStack(stack.id);
          await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Stack '${stack.name}' stopped (${result.stoppedContainers} containers)`);
        }

        // Update all environment service statuses to STOPPED
        for (const envService of environment.services) {
          await this.updateServiceStatus(envService.id, ServiceStatusValues.STOPPED, ApplicationServiceHealthStatusValues.UNKNOWN);
          await this.prisma.environmentService.update({
            where: { id: envService.id },
            data: { stoppedAt: new Date() },
          });
        }

        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] All stacks stopped successfully`);

        // Update status to stopped
        await this.updateEnvironmentStatus(id, ServiceStatusValues.STOPPED);
        await this.markEnvironmentActive(id, false);

        const duration = Date.now() - startTime;

        this.logger.info({
          environmentId: id,
          duration,
          userEventId: userEvent.id
        }, 'Environment stopped successfully');

        // Complete the user event
        await this.userEventService.updateEvent(userEvent.id, {
          status: 'completed',
          resultSummary: `Environment '${environment.name}' stopped successfully. ${environment.services.length} service(s) stopped.`,
          durationMs: duration
        });

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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.logger.error({
        error,
        environmentId: id,
        duration,
        userEventId: userEvent?.id
      }, 'Failed to stop environment');

      // Update user event with failure details
      if (userEvent) {
        await this.userEventService.updateEvent(userEvent.id, {
          status: 'failed',
          errorMessage: `Failed to stop environment: ${errorMessage}`,
          errorDetails: {
            type: error instanceof Error ? error.constructor.name : 'Unknown',
            message: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
            environmentId: id,
            duration
          },
          durationMs: duration
        });
      }

      return {
        success: false,
        message: errorMessage,
        duration,
        details: { error: errorMessage }
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

  private async provisionInfrastructure(environment: Environment, userEventId?: string): Promise<void> {
    // Create networks
    for (const network of environment.networks) {
      try {
        const exists = await this.dockerExecutor.networkExists(network.name);
        if (!exists) {
          if (userEventId) {
            await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Creating network '${network.name}' (driver: ${network.driver})...`);
          }

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

          if (userEventId) {
            await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Network '${network.name}' created successfully`);
          }
        } else if (userEventId) {
          await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Network '${network.name}' already exists`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error({
          error,
          environmentId: environment.id,
          networkName: network.name
        }, 'Failed to create network');

        if (userEventId) {
          await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] ERROR: Failed to create network '${network.name}': ${errorMessage}`);
        }

        throw error;
      }
    }

    // Create volumes
    for (const volume of environment.volumes) {
      try {
        const exists = await this.dockerExecutor.volumeExists(volume.name);
        if (!exists) {
          if (userEventId) {
            await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Creating volume '${volume.name}' (driver: ${volume.driver})...`);
          }

          await this.dockerExecutor.createVolume(
            volume.name,
            environment.name
          );

          this.logger.info({
            environmentId: environment.id,
            volumeName: volume.name
          }, 'Volume created for environment');

          if (userEventId) {
            await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Volume '${volume.name}' created successfully`);
          }
        } else if (userEventId) {
          await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Volume '${volume.name}' already exists`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error({
          error,
          environmentId: environment.id,
          volumeName: volume.name
        }, 'Failed to create volume');

        if (userEventId) {
          await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] ERROR: Failed to create volume '${volume.name}': ${errorMessage}`);
        }

        throw error;
      }
    }
  }

  private async startAllServices(environment: Environment, userEventId?: string): Promise<void> {
    const serviceTypes = environment.services.map(s => s.serviceType);
    const startOrder = this.serviceRegistry.resolveDependencyOrder(serviceTypes);

    let serviceIndex = 0;
    for (const serviceType of startOrder) {
      const envService = environment.services.find(s => s.serviceType === serviceType);
      if (!envService) continue;

      serviceIndex++;
      if (userEventId) {
        await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Starting service ${serviceIndex}/${environment.services.length}: ${envService.serviceName} (${envService.serviceType})...`);
      }

      await this.startEnvironmentService(environment, envService, userEventId);

      if (userEventId) {
        await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Service '${envService.serviceName}' started successfully`);
      }
    }
  }

  private async stopAllServices(environment: Environment, userEventId?: string): Promise<void> {
    const serviceTypes = environment.services.map(s => s.serviceType);
    const stopOrder = this.serviceRegistry.resolveDependencyOrder(serviceTypes).reverse();

    let serviceIndex = 0;
    for (const serviceType of stopOrder) {
      const envService = environment.services.find(s => s.serviceType === serviceType);
      if (!envService) continue;

      serviceIndex++;
      if (userEventId) {
        await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Stopping service ${serviceIndex}/${environment.services.length}: ${envService.serviceName} (${envService.serviceType})...`);
      }

      await this.stopEnvironmentService(envService, userEventId);

      if (userEventId) {
        await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Service '${envService.serviceName}' stopped successfully`);
      }
    }
  }

  private async startEnvironmentService(environment: Environment, envService: any, userEventId?: string): Promise<void> {
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

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

      if (userEventId) {
        await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] ERROR: Failed to start service '${envService.serviceName}': ${errorMessage}`);
      }

      throw error;
    }
  }

  private async stopEnvironmentService(envService: any, userEventId?: string): Promise<void> {
    try {
      // Check if service is already stopped or uninitialized
      if (envService.status === ServiceStatusValues.STOPPED ||
          envService.status === ServiceStatusValues.UNINITIALIZED) {
        this.logger.debug({
          serviceName: envService.serviceName,
          currentStatus: envService.status
        }, 'Service already in stopped/uninitialized state, skipping stop operation');

        if (userEventId) {
          await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Service '${envService.serviceName}' is already stopped/uninitialized`);
        }

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

      // Use environment-prefixed service name (must match the name used during creation)
      const prefixedServiceName = `${environment.name}-${envService.serviceName}`;

      // Attempt to stop service (factory will handle missing service instances gracefully)
      await this.serviceFactory.stopService(prefixedServiceName, environment.id);

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

        if (userEventId) {
          await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] WARNING: Failed to stop service '${envService.serviceName}': ${errorMessage}`);
        }
      } else {
        // If service wasn't found, mark as stopped since it's not running anyway
        this.logger.warn({
          serviceName: envService.serviceName,
          error: errorMessage
        }, 'Service not found, marking as stopped');

        if (userEventId) {
          await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] WARNING: Service '${envService.serviceName}' not found, marking as stopped`);
        }

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