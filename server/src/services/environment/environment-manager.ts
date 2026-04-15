import { PrismaClient, Prisma } from "../../generated/prisma/client";
import type { UserEventInfo } from '@mini-infra/types';
import {
  Environment,
  EnvironmentType,
  EnvironmentNetworkType,
  EnvironmentNetwork,
  CreateEnvironmentRequest,
  UpdateEnvironmentRequest,
} from '@mini-infra/types';
import { DockerExecutorService } from '../docker-executor';
import { getLogger } from '../../lib/logger-factory';
import { UserEventService } from '../user-events';
import { seedStacksForEnvironment } from '../stacks/seed';

export class EnvironmentManager {
  private static instance: EnvironmentManager;
  private readonly logger = getLogger("stacks", "environment-manager");
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
    let userEvent: UserEventInfo | null = null;

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

      // Seed stacks for the new environment (stacks create their own infra resources on apply)
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

  public async getEnvironmentById(id: string): Promise<Environment | null> {
    try {
      const environment = await this.prisma.environment.findUnique({
        where: { id },
        include: {
          networks: true,
          _count: {
              select: {
                stacks: { where: { template: { source: 'user' } } },
              },
            },
            stacks: {
              where: { template: { source: 'system' }, status: { notIn: ['removed', 'undeployed'] } },
              select: { id: true },
            },
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
          _count: {
              select: {
                stacks: { where: { template: { source: 'user' } } },
              },
            },
            stacks: {
              where: { template: { source: 'system' }, status: { notIn: ['removed', 'undeployed'] } },
              select: { id: true },
            },
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
      const where: Prisma.EnvironmentWhereInput = {};
      if (type) where.type = type;

      const [environments, total] = await Promise.all([
        this.prisma.environment.findMany({
          where,
          include: {
            networks: true,
            _count: {
              select: {
                stacks: { where: { template: { source: 'user' } } },
              },
            },
            stacks: {
              where: { template: { source: 'system' }, status: { notIn: ['removed', 'undeployed'] } },
              select: { id: true },
            },
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
          tunnelId: request.tunnelId,
          tunnelServiceUrl: request.tunnelServiceUrl,
        },
        include: {
          networks: true,
          _count: {
              select: {
                stacks: { where: { template: { source: 'user' } } },
              },
            },
            stacks: {
              where: { template: { source: 'system' }, status: { notIn: ['removed', 'undeployed'] } },
              select: { id: true },
            },
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
    options: { deleteNetworks?: boolean; userId?: string } = {}
  ): Promise<boolean> {
    const { deleteNetworks = false, userId } = options;
    const startTime = Date.now();
    let userEvent: UserEventInfo | null = null;

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
        description: `Deleting ${environment.type} environment (networks: ${deleteNetworks ? 'yes' : 'no'})`,
        metadata: {
          environmentId: environment.id,
          environmentName: environment.name,
          environmentType: environment.type,
          deleteNetworks,
          networkCount: environment.networks.length,
        }
      });

      this.logger.info({
        environmentId: id,
        deleteNetworks,
        networkCount: environment.networks.length,
        userEventId: userEvent.id
      }, 'Starting environment deletion');

      // Initialize Docker executor for network operations
      await this.dockerExecutor.initialize();

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

      // Clean up undeployed/removed stacks that reference this environment
      const orphanedStacks = await this.prisma.stack.findMany({
        where: { environmentId: id, status: { in: ['removed', 'undeployed'] } },
        select: { id: true, name: true, status: true },
      });
      if (orphanedStacks.length > 0) {
        this.logger.info({
          environmentId: id,
          stackCount: orphanedStacks.length,
          stacks: orphanedStacks.map(s => `${s.name} (${s.status})`),
        }, 'Cleaning up orphaned stacks');
        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Cleaning up ${orphanedStacks.length} orphaned stack(s)...`);

        await this.prisma.stack.deleteMany({
          where: { id: { in: orphanedStacks.map(s => s.id) } },
        });
      }

      // Clean up stack templates that reference this environment
      const templates = await this.prisma.stackTemplate.findMany({
        where: { environmentId: id },
        select: { id: true, name: true },
      });
      if (templates.length > 0) {
        this.logger.info({
          environmentId: id,
          templateCount: templates.length,
          templates: templates.map(t => t.name),
        }, 'Cleaning up stack templates');
        await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Cleaning up ${templates.length} stack template(s)...`);

        for (const template of templates) {
          await this.prisma.$transaction([
            this.prisma.stack.deleteMany({ where: { templateId: template.id } }),
            this.prisma.stackTemplate.update({
              where: { id: template.id },
              data: { currentVersionId: null, draftVersionId: null },
            }),
            this.prisma.stackTemplate.delete({ where: { id: template.id } }),
          ]);
        }
      }

      // Delete environment (cascade will handle related records)
      await this.userEventService.appendLogs(userEvent.id, `[${new Date().toISOString()}] Deleting environment record...`);
      await this.prisma.environment.delete({
        where: { id }
      });

      const duration = Date.now() - startTime;

      this.logger.info({
        environmentId: id,
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
            deleteNetworks,
            duration
          },
          durationMs: duration
        });
      }

      throw error;
    }
  }

  private mapPrismaToEnvironment(prismaEnv: Prisma.EnvironmentGetPayload<{
    include: {
      networks: true;
      _count: { select: { stacks: true } };
      stacks: { select: { id: true } };
    };
  }>): Environment {
    return {
      id: prismaEnv.id,
      name: prismaEnv.name,
      description: prismaEnv.description ?? undefined,
      type: prismaEnv.type as EnvironmentType,
      networkType: prismaEnv.networkType as EnvironmentNetworkType,
      networks: prismaEnv.networks.map((n): EnvironmentNetwork => ({
        id: n.id,
        environmentId: n.environmentId,
        name: n.name,
        purpose: n.purpose as EnvironmentNetwork['purpose'],
        driver: n.driver,
        options: (n.options ?? undefined) as EnvironmentNetwork['options'],
        dockerId: n.dockerId ?? undefined,
        createdAt: n.createdAt
      })),
      stackCount: prismaEnv._count?.stacks ?? 0,
      systemStackCount: prismaEnv.stacks?.length ?? 0,
      tunnelId: prismaEnv.tunnelId ?? undefined,
      tunnelServiceUrl: prismaEnv.tunnelServiceUrl ?? undefined,
      createdAt: prismaEnv.createdAt,
      updatedAt: prismaEnv.updatedAt
    };
  }
}