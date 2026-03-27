import { PrismaClient } from '@prisma/client';
import {
  Environment,
  EnvironmentType,
  EnvironmentNetworkType,
  CreateEnvironmentRequest,
  UpdateEnvironmentRequest,
} from '@mini-infra/types';
import { DockerExecutorService } from '../docker-executor';
import { servicesLogger } from '../../lib/logger-factory';
import { UserEventService } from '../user-events';
import { seedStacksForEnvironment } from '../stacks/seed';

export class EnvironmentManager {
  private static instance: EnvironmentManager;
  private readonly logger = servicesLogger();
  private readonly dockerExecutor: DockerExecutorService;
  private readonly userEventService: UserEventService;

  constructor(private readonly prisma: PrismaClient) {
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
        description: `Creating ${request.type} environment`,
        metadata: {
          environmentName: request.name,
          environmentType: request.type,
          networkType: request.networkType || 'local',
        }
      });

      // Create environment record
      await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Creating environment record...`);
      const environmentData = await this.prisma.environment.create({
        data: {
          name: request.name,
          description: request.description,
          type: request.type,
          networkType: request.networkType || 'local',
        },
      });
      await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Environment record created (ID: ${environmentData.id})`);

      // Create environment networks based on network type
      await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Creating environment networks...`);
      await this.createEnvironmentNetworks(environmentData.id, environmentData.name, environmentData.networkType);
      await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Environment networks created`);

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
        userEventId: userEvent.id
      }, 'Environment created successfully');

      // Complete the user event
      await this.userEventService.updateEvent(userEvent.id, {
        status: 'completed',
        resultSummary: `Environment '${environment.name}' created successfully`,
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
    page: number = 1,
    limit: number = 20
  ): Promise<{ environments: Environment[]; total: number }> {
    try {
      const where: any = {};
      if (type) where.type = type;

      const [environments, total] = await Promise.all([
        this.prisma.environment.findMany({
          where,
          include: {
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
      this.logger.error({ error, type, page, limit }, 'Failed to list environments');
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
        },
        include: {
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
        }
      });

      this.logger.info({
        environmentId: id,
        deleteVolumes,
        deleteNetworks,
        networkCount: environment.networks.length,
        volumeCount: environment.volumes.length,
        userEventId: userEvent.id
      }, 'Starting environment deletion');

      // Initialize Docker executor for volume/network operations
      await this.dockerExecutor.initialize();

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

  private mapPrismaToEnvironment(prismaEnv: any): Environment {
    return {
      id: prismaEnv.id,
      name: prismaEnv.name,
      description: prismaEnv.description,
      type: prismaEnv.type as EnvironmentType,
      networkType: prismaEnv.networkType as EnvironmentNetworkType,
      services: [],
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