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
import { EgressNetworkAllocator } from '../egress/egress-network-allocator';
import { EgressPolicyLifecycleService } from '../egress/egress-policy-lifecycle';
import { getEnvFirewallManager } from '../egress';
import { StackReconciler } from '../stacks/stack-reconciler';
import DockerService from '../docker';

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

  /**
   * Create an environment and schedule egress-gateway provisioning to run in
   * the background. The returned promise resolves as soon as the environment
   * row is committed — egress subnet allocation, network creation, and the
   * egress-gateway system stack apply continue asynchronously and report
   * their status via the returned `userEventId` (a UserEvent emitted on the
   * EVENTS Socket.IO channel).
   *
   * Callers that need the gateway provisioned before deploying further stacks
   * (e.g. the dev seeder) should poll GET /api/events/:userEventId until the
   * event reaches a terminal status (`completed` or `failed`). UI users see
   * progress on the Events page automatically.
   */
  public async createEnvironment(
    request: CreateEnvironmentRequest,
    userId?: string,
  ): Promise<{ environment: Environment; userEventId: string; provisioning: Promise<void> }> {
    const startTime = Date.now();
    let userEvent: UserEventInfo | null = null;

    this.logger.info({ request }, 'Creating new environment');

    try {
      // Create user event for tracking. Stays in `running` state until the
      // background provisioning task finalises it.
      userEvent = await this.userEventService.createEvent({
        eventType: 'environment_create',
        eventCategory: 'infrastructure',
        eventName: `Create Environment: ${request.name}`,
        userId: userId || undefined,
        triggeredBy: userId ? 'manual' : 'api',
        status: 'running',
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

      // Fetch the complete environment with relations
      const environment = await this.getEnvironmentById(environmentData.id);
      if (!environment) {
        throw new Error('Failed to retrieve created environment');
      }

      // Backfill resourceId on the UserEvent now that the row exists
      await this.prisma.userEvent.update({
        where: { id: userEvent.id },
        data: { resourceId: environmentData.id },
      });

      // Schedule egress provisioning to run in the background. The HTTP caller
      // gets a fast response; status is observable via the UserEvent.
      // The returned `provisioning` promise lets callers (tests, graceful
      // shutdown) await completion if they need to. `runProvisioningInBackground`
      // owns its own try/catch and never rejects.
      const userEventId = userEvent.id;
      const provisioning = this.runProvisioningInBackground(
        environmentData.id,
        environment.name,
        userEventId,
        userId,
        startTime,
      );

      this.logger.info({
        environmentId: environment.id,
        environmentName: environment.name,
        userEventId,
      }, 'Environment row created; egress provisioning running in background');

      return { environment, userEventId, provisioning };

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
   * Wrapper that drives `provisionEgressGateway` to completion and finalises
   * the UserEvent. Always swallows errors so the unhandled-rejection handler
   * never sees them — failures are surfaced via the UserEvent status instead.
   */
  private async runProvisioningInBackground(
    environmentId: string,
    environmentName: string,
    userEventId: string,
    userId: string | undefined,
    startTime: number,
  ): Promise<void> {
    try {
      await this.provisionEgressGateway(environmentId, environmentName, userEventId, userId);

      const duration = Date.now() - startTime;
      await this.userEventService.updateEvent(userEventId, {
        status: 'completed',
        resultSummary: `Environment '${environmentName}' created successfully`,
        durationMs: duration,
      });
      this.logger.info({ environmentId, userEventId, duration }, 'Background environment provisioning completed');
    } catch (err) {
      // provisionEgressGateway is defensive and shouldn't throw, but guard anyway.
      const duration = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ error: err, environmentId, userEventId }, 'Background environment provisioning threw unexpectedly');
      try {
        await this.userEventService.updateEvent(userEventId, {
          status: 'failed',
          errorMessage: `Egress gateway provisioning failed: ${msg}`,
          errorDetails: {
            type: err instanceof Error ? err.constructor.name : 'Unknown',
            message: msg,
            stack: err instanceof Error ? err.stack : undefined,
            environmentId,
          },
          durationMs: duration,
        });
      } catch (updateErr) {
        this.logger.error({ error: updateErr, userEventId }, 'Failed to mark UserEvent as failed during async provisioning');
      }
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
      // Read prior firewall state so we can detect transitions after the update.
      const prior = await this.prisma.environment.findUnique({
        where: { id },
        select: { egressFirewallEnabled: true, name: true },
      });

      const environment = await this.prisma.environment.update({
        where: { id },
        data: {
          description: request.description,
          type: request.type,
          networkType: request.networkType,
          tunnelId: request.tunnelId,
          tunnelServiceUrl: request.tunnelServiceUrl,
          egressFirewallEnabled: request.egressFirewallEnabled,
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

      // Keep egress policy snapshot fresh on any environment update (name changes
      // are not currently exposed via UpdateEnvironmentRequest, but future-proof
      // by refreshing unconditionally — the call is a no-op when no policies exist).
      const egressPolicyLifecycle = new EgressPolicyLifecycleService(this.prisma);
      await egressPolicyLifecycle.refreshEnvironmentNameSnapshot(id);

      // If egressFirewallEnabled transitioned, push the change to the fw-agent.
      // Best-effort: failures are logged but don't fail the request — the DB row
      // is the source of truth and the agent will reconcile on next boot.
      if (prior && request.egressFirewallEnabled !== undefined && request.egressFirewallEnabled !== prior.egressFirewallEnabled) {
        await this.applyFirewallTransition(id, prior.name, request.egressFirewallEnabled);
      }

      return this.mapPrismaToEnvironment(environment);

    } catch (error) {
      this.logger.error({ error, environmentId: id, request }, 'Failed to update environment');
      throw error;
    }
  }

  private async applyFirewallTransition(envId: string, envName: string, enabled: boolean): Promise<void> {
    const manager = getEnvFirewallManager();
    if (!manager) {
      this.logger.warn({ envId, enabled }, 'EnvFirewallManager not initialised; firewall transition skipped (will reconcile on next boot)');
      return;
    }
    try {
      if (enabled) {
        await manager.applyEnv(envId, 'observe');
      } else {
        await manager.removeEnv(envId, envName);
      }
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), envId, enabled },
        'fw-agent transition failed (non-fatal — DB state is authoritative)',
      );
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

      // Archive any remaining non-archived egress policies for this environment
      // before deleting the environment row. This is a safety net — per-stack
      // policies should already be archived via the stack-delete hooks, but any
      // stacks deleted by the cascade steps above (stack.deleteMany) won't have
      // gone through those hooks.
      const egressPolicyLifecycle = new EgressPolicyLifecycleService(this.prisma);
      await egressPolicyLifecycle.archiveForEnvironment(id, userId ?? null);

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

  /**
   * Provision the egress gateway for a newly-created environment.
   *
   * Steps:
   * 1. Allocate a /24 subnet from the egress pool and persist it on the
   *    `egress` InfraResource.metadata so the egress-gateway stack's
   *    reconcileOutputs reuses the same subnet when it creates the Docker
   *    network.
   * 2. Create the per-env egress Docker network and attach mini-infra-server
   *    so the container-map-pusher can reach the gateway admin API.
   * 3. Allocate the gateway IP via EgressNetworkAllocator.allocateGatewayIp() —
   *    inspects connected containers and picks the first free address. Done
   *    after the server has joined so we don't collide with whatever IP
   *    Docker auto-assigned to it. Persist on Environment.egressGatewayIp.
   * 4. Instantiate the egress-gateway system stack for this environment and
   *    apply it so the container comes up.
   * 5. After apply, reconnect the container to the egress network with the
   *    static IP so the gateway is reachable at the pre-allocated address.
   *
   * Every non-bypass managed container in this env will then be auto-attached
   * to the same egress network at create time (see egress-injection.ts), so
   * `egress-gateway:3128` resolves from any app/pool/StatelessWeb container.
   *
   * All steps are wrapped in try/catch. A failure at any step leaves the env
   * usable but logs a loud warning. The failure is appended to the UserEvent
   * so operators can see "egress gateway failed to deploy".
   */
  private async provisionEgressGateway(
    environmentId: string,
    environmentName: string,
    userEventId: string,
    userId?: string,
  ): Promise<void> {
    try {
      await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Provisioning egress gateway...`);

      const egressNetworkName = `${environmentName}-egress`;
      const executor = new DockerExecutorService();
      await executor.initialize();
      const allocator = new EgressNetworkAllocator(this.prisma);

      // Step 1: Determine subnet. If the egress network already exists (e.g.
      // from a prior failed attempt, or external creation), use its subnet so
      // we stay consistent with reality. Otherwise allocate a fresh /24 from
      // the pool.
      let subnet: string;
      let gateway: string;
      const networkAlreadyExists = await executor.networkExists(egressNetworkName);
      if (networkAlreadyExists) {
        const dockerClient = executor.getDockerClient();
        const inspect = await dockerClient.getNetwork(egressNetworkName).inspect();
        const ipamCfg = inspect.IPAM?.Config?.[0];
        if (!ipamCfg?.Subnet) {
          throw new Error(`Existing network ${egressNetworkName} has no IPAM subnet`);
        }
        subnet = ipamCfg.Subnet;
        const subnetOctets = subnet.split('/')[0].split('.');
        gateway = ipamCfg.Gateway ?? `${subnetOctets.slice(0, 3).join('.')}.1`;
        this.logger.info({ environmentId, subnet, gateway, egressNetworkName }, 'Reusing existing egress network subnet');
      } else {
        const allocated = await allocator.allocateSubnet();
        subnet = allocated.subnet;
        gateway = allocated.gateway;
      }

      // Note: egressGatewayIp is allocated after the network exists and the
      // mini-infra-server has joined, so we can pick the first IP that isn't
      // already taken. See "Step 3c" below.

      // Step 2: Pre-create the InfraResource record with the subnet in metadata
      // so that when the egress-gateway stack runs reconcileOutputs it reuses
      // this subnet for the egress network. Use upsert-by-findFirst since
      // SQLite NULL uniqueness prevents true upsert.
      const existingResource = await this.prisma.infraResource.findFirst({
        where: { type: 'docker-network', purpose: 'egress', scope: 'environment', environmentId },
      });
      if (existingResource) {
        const existingMeta = (existingResource.metadata as Record<string, unknown> | null) ?? {};
        await this.prisma.infraResource.update({
          where: { id: existingResource.id },
          data: {
            metadata: { ...existingMeta, subnet, gateway } as Prisma.InputJsonValue,
          },
        });
      } else {
        await this.prisma.infraResource.create({
          data: {
            type: 'docker-network',
            purpose: 'egress',
            scope: 'environment',
            environmentId,
            name: egressNetworkName,
            metadata: { subnet, gateway } as Prisma.InputJsonValue,
          },
        });
      }

      // Step 3a: Create the egress Docker network up-front with the allocated
      // subnet. We do this before the egress-gateway stack apply so that
      // mini-infra-server can join (Step 3b) and we can pick a non-colliding
      // gateway IP (Step 3c) before any container races onto the network.
      if (!networkAlreadyExists) {
        try {
          await executor.createNetwork(egressNetworkName, '', {
            driver: 'bridge',
            labels: {
              'mini-infra.infra-resource': 'true',
              'mini-infra.resource-purpose': 'egress',
              'mini-infra.environment': environmentId,
            },
            ipam: { subnet, gateway },
          });
          await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Egress network ${egressNetworkName} created (subnet ${subnet})`);
        } catch (netErr) {
          const msg = netErr instanceof Error ? netErr.message : String(netErr);
          this.logger.error({ environmentId, err: msg }, 'Failed to create egress network for env');
          await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] WARNING: egress network create failed: ${msg}`);
          // Continue — stack apply may still succeed if something else creates the network
        }
      }

      // Step 3b: Connect the mini-infra-server container itself to this env's
      // egress network so the container-map-pusher and log-ingester can reach
      // the egress-gateway's admin API at egressGatewayIp:8054. Inside Docker,
      // os.hostname() returns the container ID — use that to self-attach.
      try {
        const { hostname } = await import('node:os');
        const selfContainerId = hostname();
        const dockerClient = executor.getDockerClient();
        const network = dockerClient.getNetwork(egressNetworkName);
        await network.connect({ Container: selfContainerId });
        this.logger.info({ environmentId, egressNetworkName, selfContainerId }, 'Connected mini-infra-server to env egress network');
      } catch (connErr) {
        const msg = connErr instanceof Error ? connErr.message : String(connErr);
        if (msg.includes('already exists') || msg.includes('already in network') || msg.includes('endpoint with name')) {
          // Idempotent — already connected from a prior provisioning
          this.logger.debug({ environmentId, egressNetworkName }, 'mini-infra-server already attached to env egress network');
        } else {
          this.logger.warn({ environmentId, egressNetworkName, err: msg }, 'Failed to attach mini-infra-server to env egress network — container-map push will be unreachable');
          await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] WARNING: mini-infra-server could not join ${egressNetworkName}: ${msg}`);
        }
      }

      // Step 3c: Pick the egress gateway IP. Done now (after the network exists
      // and the mini-infra-server has joined) so allocateGatewayIp inspects the
      // live network and skips IPs already claimed — Docker auto-assigns from
      // .2 upward, so a hardcoded .2 collides with whichever container joined
      // the network first.
      let egressGatewayIp: string;
      try {
        egressGatewayIp = await allocator.allocateGatewayIp(egressNetworkName);
      } catch (allocErr) {
        const msg = allocErr instanceof Error ? allocErr.message : String(allocErr);
        this.logger.error({ environmentId, egressNetworkName, err: msg }, 'Failed to allocate egress gateway IP — skipping gateway deployment');
        await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] WARNING: Failed to allocate egress gateway IP: ${msg}`);
        return;
      }

      this.logger.info({ environmentId, subnet, gateway, egressGatewayIp }, 'Allocated egress subnet and gateway IP');

      await this.prisma.environment.update({
        where: { id: environmentId },
        data: { egressGatewayIp },
      });
      await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Egress subnet ${subnet} allocated; gateway IP ${egressGatewayIp}`);

      // Step 4: Instantiate the egress-gateway system stack
      const egressTemplate = await this.prisma.stackTemplate.findUnique({
        where: { name_source: { name: 'egress-gateway', source: 'system' } },
        include: {
          currentVersion: {
            include: {
              services: { orderBy: { order: 'asc' as const } },
              configFiles: true,
            },
          },
        },
      });

      if (!egressTemplate || !egressTemplate.currentVersion) {
        this.logger.warn({ environmentId }, 'egress-gateway system template not found or has no published version; skipping egress gateway provisioning');
        await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] WARNING: egress-gateway template not found; skipping gateway deployment`);
        return;
      }

      const version = egressTemplate.currentVersion;

      // Build the stack row from the template version
      const { toServiceCreateInput } = await import('../stacks/utils');
      type ServiceDef = Parameters<typeof toServiceCreateInput>[0];
      const services: ServiceDef[] = (version.services as unknown as ServiceDef[]);

      const egressStack = await this.prisma.stack.create({
        data: {
          name: 'egress-gateway',
          description: egressTemplate.description ?? null,
          environmentId,
          version: 1,
          status: 'undeployed',
          templateId: egressTemplate.id,
          templateVersion: version.version,
          builtinVersion: version.version,
          parameters: version.parameters as Prisma.InputJsonValue,
          parameterValues: version.defaultParameterValues as Prisma.InputJsonValue,
          resourceOutputs: version.resourceOutputs as Prisma.InputJsonValue ?? undefined,
          resourceInputs: version.resourceInputs as Prisma.InputJsonValue ?? undefined,
          networks: version.networks as Prisma.InputJsonValue,
          volumes: version.volumes as Prisma.InputJsonValue,
          services: {
            create: services.map(toServiceCreateInput),
          },
        },
        include: { services: true },
      });

      await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Egress gateway stack created (ID: ${egressStack.id})`);

      // Ensure a default egress policy exists for the egress-gateway stack.
      // (Its services have egressBypass:true so it never generates events that
      // need attribution, but the policy row is required for consistency.)
      const egressPolicyLifecycle = new EgressPolicyLifecycleService(this.prisma);
      await egressPolicyLifecycle.ensureDefaultPolicy(egressStack.id, userId ?? null);

      // Step 5: Apply the stack
      try {
        const dockerExecutor = new DockerExecutorService();
        await dockerExecutor.initialize();
        const reconciler = new StackReconciler(dockerExecutor, this.prisma);

        const applyResult = await reconciler.apply(egressStack.id, {
          triggeredBy: userId ?? 'system',
        });

        if (applyResult.success) {
          this.logger.info({ environmentId, stackId: egressStack.id, egressGatewayIp }, 'Egress gateway deployed successfully');
          await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Egress gateway deployed successfully at ${egressGatewayIp}`);

          // Step 6: Reconnect egress container to the egress network with the
          // pre-allocated static IP so it's reachable at the expected address.
          await this.assignStaticGatewayIp(environmentName, egressStack.id, egressGatewayIp, userEventId);
        } else {
          const failureMessages = applyResult.serviceResults
            .filter(r => !r.success)
            .map(r => r.error ?? r.serviceName)
            .join(', ');
          this.logger.error({ environmentId, stackId: egressStack.id, failureMessages }, 'Egress gateway stack apply failed');
          await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] WARNING: Egress gateway apply failed: ${failureMessages}`);
        }
      } catch (applyErr) {
        const msg = applyErr instanceof Error ? applyErr.message : String(applyErr);
        this.logger.error({ error: applyErr, environmentId, stackId: egressStack.id }, 'Egress gateway stack apply threw an error');
        await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] WARNING: Egress gateway apply error: ${msg}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ error: err, environmentId }, 'Egress gateway provisioning failed; environment is still usable without egress filtering');
      try {
        await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] WARNING: Egress gateway provisioning failed: ${msg}`);
      } catch { /* never let log append errors surface */ }
    }
  }

  /**
   * After the egress-gateway container is created by the reconciler,
   * disconnect it from the egress network and reconnect with the pre-allocated
   * static IP so it's reachable at the expected address.
   */
  private async assignStaticGatewayIp(
    environmentName: string,
    stackId: string,
    egressGatewayIp: string,
    userEventId: string,
  ): Promise<void> {
    const networkName = `${environmentName}-egress`;
    const containerName = `${environmentName}-egress-gateway-egress-gateway`;

    try {
      const dockerService = DockerService.getInstance();
      if (!dockerService.isConnected()) {
        this.logger.warn({ stackId }, 'Docker not connected; skipping static IP assignment for egress gateway');
        return;
      }

      // Use docker-executor to get the raw Docker client
      const executor = new DockerExecutorService();
      await executor.initialize();
      const docker = executor.getDockerClient();

      // Find the egress-gateway container by name
      const containers = await docker.listContainers({ all: true, filters: JSON.stringify({ name: [containerName] }) });
      const containerInfo = containers.find(c => c.Names?.some(n => n === `/${containerName}`));
      if (!containerInfo) {
        this.logger.warn({ containerName, stackId }, 'Egress gateway container not found; skipping static IP assignment');
        await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] WARNING: Could not find egress gateway container for static IP assignment`);
        return;
      }

      const network = docker.getNetwork(networkName);

      // Disconnect from the network first (clears the auto-assigned IP)
      try {
        await network.disconnect({ Container: containerInfo.Id, Force: true });
      } catch (disconnectErr) {
        this.logger.debug({ error: disconnectErr, containerName, networkName }, 'Disconnect before static IP reconnect (may already be disconnected)');
      }

      // Reconnect with the pre-allocated static IP
      await network.connect({
        Container: containerInfo.Id,
        EndpointConfig: {
          IPAMConfig: { IPv4Address: egressGatewayIp },
          Aliases: ['egress-gateway'],
        },
      });

      this.logger.info({ containerName, networkName, egressGatewayIp }, 'Egress gateway container assigned static IP');
      await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] Egress gateway container assigned static IP ${egressGatewayIp} on ${networkName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ error: err, containerName, networkName, egressGatewayIp }, 'Failed to assign static IP to egress gateway container');
      await this.userEventService.appendLogs(userEventId, `[${new Date().toISOString()}] WARNING: Failed to assign static IP ${egressGatewayIp}: ${msg}`);
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
      egressFirewallEnabled: prismaEnv.egressFirewallEnabled ?? false,
      createdAt: prismaEnv.createdAt,
      updatedAt: prismaEnv.updatedAt
    };
  }
}