import Docker from 'dockerode';
import { PrismaClient } from '@prisma/client';
import {
  StackPlan,
  PlanWarning,
  ServiceAction,
  FieldDiff,
  StackServiceDefinition,
  StackDefinition,
  StackConfigFile,
  StackContainerConfig,
  StackNetwork,
  StackParameterDefinition,
  StackParameterValue,
  StackVolume,
  ApplyOptions,
  ApplyResult,
  DestroyResult,
  ServiceApplyResult,
  serializeStack,
} from '@mini-infra/types';
import { DockerExecutorService } from '../docker-executor';
import { computeDefinitionHash } from './definition-hash';
import { StackContainerManager } from './stack-container-manager';
import { StackRoutingManager } from './stack-routing-manager';
import { HAProxyDataPlaneClient } from '../haproxy';
import { servicesLogger } from '../../lib/logger-factory';
import {
  buildStackTemplateContext,
  buildContainerMap,
  mergeParameterValues,
  toServiceDefinition,
  resolveServiceConfigs,
  prepareServiceContainer,
} from './utils';

export class StackReconciler {
  private containerManager: StackContainerManager;

  constructor(
    private dockerExecutor: DockerExecutorService,
    private prisma: PrismaClient,
    private routingManager?: StackRoutingManager
  ) {
    this.containerManager = new StackContainerManager(dockerExecutor);
  }

  async plan(stackId: string): Promise<StackPlan> {
    const log = servicesLogger().child({ operation: 'stack-plan', stackId });

    // 1. Load stack with services, environment, and template version info
    const stack = await this.prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: {
        services: { orderBy: { order: 'asc' } },
        environment: true,
        template: { select: { currentVersion: { select: { version: true } } } },
      },
    });

    log.info({ stackName: stack.name, serviceCount: stack.services.length }, 'Computing plan');

    // 2. Build template context with parameters and resolve service definitions
    const params = mergeParameterValues(
      (stack.parameters as unknown as StackParameterDefinition[]) ?? [],
      (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {}
    );
    const templateContext = buildStackTemplateContext(stack, params);

    // 3. Resolve service definitions (templates + type coercion) and compute hashes
    const { resolvedDefinitions, serviceHashes } = resolveServiceConfigs(stack.services, templateContext);

    // 4. Query running containers for this stack
    const docker = this.dockerExecutor.getDockerClient();
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`mini-infra.stack-id=${stackId}`] },
    });

    // 4b. Detect port and name conflicts with containers outside this stack
    const projectName = stack.environment ? `${stack.environment.name}-${stack.name}` : stack.name;
    const planWarnings = await this.detectConflicts(resolvedDefinitions, stackId, projectName, docker);

    const containerMap = buildContainerMap(containers);

    // 5. Compare desired services against running containers
    const actions: ServiceAction[] = [];
    const snapshot = stack.lastAppliedSnapshot as unknown as StackDefinition | null;

    for (const svc of stack.services) {
      const container = containerMap.get(svc.serviceName);
      const desiredHash = serviceHashes.get(svc.serviceName)!;
      const desiredImage = `${svc.dockerImage}:${svc.dockerTag}`;

      if (!container) {
        actions.push({
          serviceName: svc.serviceName,
          action: 'create',
          reason: 'service not deployed',
          desiredImage,
        });
        continue;
      }

      const currentHash = container.Labels['mini-infra.definition-hash'];
      const currentImage = container.Image;
      const isRunning = container.State === 'running';

      if (!isRunning) {
        actions.push({
          serviceName: svc.serviceName,
          action: 'recreate',
          reason: 'container not running',
          currentImage,
          desiredImage,
        });
        continue;
      }

      if (currentHash === desiredHash) {
        actions.push({
          serviceName: svc.serviceName,
          action: 'no-op',
          currentImage,
          desiredImage,
        });
        continue;
      }

      // Hash mismatch — generate diffs
      const diffs = this.generateDiffs(svc.serviceName, snapshot, toServiceDefinition(svc));
      const reason = this.buildReason(currentImage, desiredImage, diffs);

      actions.push({
        serviceName: svc.serviceName,
        action: 'recreate',
        reason,
        diff: diffs.length > 0 ? diffs : undefined,
        currentImage,
        desiredImage,
      });
    }

    // 6. Detect orphaned containers
    const definedServiceNames = new Set(stack.services.map((s) => s.serviceName));
    for (const [serviceName, container] of containerMap) {
      if (!definedServiceNames.has(serviceName)) {
        actions.push({
          serviceName,
          action: 'remove',
          reason: 'service removed from definition',
          currentImage: container.Image,
        });
      }
    }

    const templateUpdateAvailable =
      stack.templateVersion != null &&
      (stack as any).template?.currentVersion?.version != null &&
      (stack as any).template.currentVersion.version > stack.templateVersion;

    const plan: StackPlan = {
      stackId,
      stackName: stack.name,
      stackVersion: stack.version,
      planTime: new Date().toISOString(),
      actions,
      hasChanges: actions.some((a) => a.action !== 'no-op'),
      templateUpdateAvailable,
      warnings: planWarnings.length > 0 ? planWarnings : undefined,
    };

    log.info(
      {
        hasChanges: plan.hasChanges,
        creates: actions.filter((a) => a.action === 'create').length,
        recreates: actions.filter((a) => a.action === 'recreate').length,
        removes: actions.filter((a) => a.action === 'remove').length,
        noOps: actions.filter((a) => a.action === 'no-op').length,
      },
      'Plan computed'
    );

    return plan;
  }

  async apply(stackId: string, options?: ApplyOptions): Promise<ApplyResult> {
    const startTime = Date.now();
    const log = servicesLogger().child({ operation: 'stack-apply', stackId });

    // 1. Get plan (use pre-computed plan if provided)
    const plan = options?.plan ?? await this.plan(stackId);

    // 1b. Force-pull: pull all images and promote no-op services to recreate
    // if the pulled image digest differs from the running container's image.
    if (options?.forcePull) {
      await this.promoteStalePullActions(plan, stackId, log);
    }

    // 2. Filter actions if serviceNames provided
    let actions = plan.actions.filter((a) => a.action !== 'no-op');
    if (options?.serviceNames && options.serviceNames.length > 0) {
      const filterSet = new Set(options.serviceNames);
      actions = actions.filter((a) => filterSet.has(a.serviceName));
    }

    // 3. Dry run — return plan without executing
    if (options?.dryRun) {
      return {
        success: true,
        stackId,
        appliedVersion: plan.stackVersion,
        serviceResults: actions.map((a) => ({
          serviceName: a.serviceName,
          action: a.action,
          success: true,
          duration: 0,
        })),
        duration: Date.now() - startTime,
      };
    }

    // 4. Load stack for DB updates and service definitions
    const stack = await this.prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: { services: { orderBy: { order: 'asc' } }, environment: true },
    });

    try {
      const projectName = stack.environment ? `${stack.environment.name}-${stack.name}` : stack.name;

      // Build template context with parameters and resolve service definitions
      const params = mergeParameterValues(
        (stack.parameters as unknown as StackParameterDefinition[]) ?? [],
        (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {}
      );
      const templateContext = buildStackTemplateContext(stack, params);

      // Build maps for service definitions, hashes, and resolved configs
      const serviceMap = new Map(stack.services.map((s) => [s.serviceName, s]));
      const { resolvedConfigsMap, resolvedDefinitions, serviceHashes } = resolveServiceConfigs(stack.services, templateContext);

      // 5. Ensure infrastructure — create networks and volumes
      const networks = stack.networks as unknown as StackNetwork[];
      const volumes = stack.volumes as unknown as StackVolume[];
      const stackLabels = { 'mini-infra.stack': stack.name, 'mini-infra.stack-id': stackId };

      for (const net of networks) {
        const netName = `${projectName}_${net.name}`;
        const exists = await this.dockerExecutor.networkExists(netName);
        if (!exists) {
          log.info({ network: netName }, 'Creating network');
          await this.dockerExecutor.createNetwork(netName, projectName, {
            driver: net.driver,
            labels: stackLabels,
          });
        }
      }

      for (const vol of volumes) {
        const volName = `${projectName}_${vol.name}`;
        const exists = await this.dockerExecutor.volumeExists(volName);
        if (!exists) {
          log.info({ volume: volName }, 'Creating volume');
          await this.dockerExecutor.createVolume(volName, projectName, { labels: stackLabels });
        }
      }

      // 6. Sort actions: creates first, then recreates, then removes
      const actionOrder: Record<string, number> = { create: 0, recreate: 1, remove: 2 };
      actions.sort((a, b) => {
        const orderDiff = (actionOrder[a.action] ?? 99) - (actionOrder[b.action] ?? 99);
        if (orderDiff !== 0) return orderDiff;
        // Within same action type, respect service order
        const svcA = serviceMap.get(a.serviceName);
        const svcB = serviceMap.get(b.serviceName);
        return (svcA?.order ?? 999) - (svcB?.order ?? 999);
      });

      // Resolve network names
      const networkNames = networks.map((n) => `${projectName}_${n.name}`);

      // 7. Execute actions
      const serviceResults: ServiceApplyResult[] = [];

      // Get current containers for recreate/remove operations
      const docker = this.dockerExecutor.getDockerClient();
      const currentContainers = await docker.listContainers({
        all: true,
        filters: { label: [`mini-infra.stack-id=${stackId}`] },
      });
      const containerByService = buildContainerMap(currentContainers);

      for (const action of actions) {
        const actionStart = Date.now();
        const svc = serviceMap.get(action.serviceName);
        const serviceDef = resolvedDefinitions.get(action.serviceName) ?? null;
        const isStatelessWeb = svc?.serviceType === 'StatelessWeb';

        if (isStatelessWeb && !this.routingManager) {
          throw new Error(`StackRoutingManager is required for StatelessWeb service "${action.serviceName}"`);
        }

        try {
          if (isStatelessWeb) {
            const result = await this.applyStatelessWeb(
              action, svc!, serviceDef!, projectName, stackId, stack,
              networkNames, serviceHashes, resolvedConfigsMap, containerByService,
              actionStart, log
            );
            serviceResults.push(result);
          } else {
            const result = await this.applyStateful(
              action, svc, serviceDef, projectName, stackId, stack,
              networkNames, serviceHashes, resolvedConfigsMap, containerByService,
              actionStart, log
            );
            serviceResults.push(result);
          }
        } catch (err: any) {
          log.error({ service: action.serviceName, error: err.message }, 'Action failed');
          serviceResults.push({
            serviceName: action.serviceName,
            action: action.action,
            success: false,
            duration: Date.now() - actionStart,
            error: err.message,
          });
        }

        // Notify caller of per-service progress
        if (options?.onProgress) {
          try {
            options.onProgress(serviceResults[serviceResults.length - 1], serviceResults.length, actions.length);
          } catch { /* never let callback errors break apply */ }
        }
      }

      // 8. Update stack in DB
      const allSucceeded = serviceResults.every((r) => r.success);
      const resultStatus = allSucceeded ? 'synced' : 'error';
      await this.prisma.stack.update({
        where: { id: stackId },
        data: {
          lastAppliedVersion: stack.version,
          lastAppliedAt: new Date(),
          lastAppliedSnapshot: serializeStack({
            ...stack,
            networks: stack.networks as unknown as StackNetwork[],
            volumes: stack.volumes as unknown as StackVolume[],
            services: stack.services.map((s) => ({
              ...s,
              serviceType: s.serviceType as StackServiceDefinition['serviceType'],
              containerConfig: s.containerConfig as unknown as StackContainerConfig,
              configFiles: (s.configFiles as unknown as StackConfigFile[]) ?? null,
              initCommands: (s.initCommands as unknown as StackServiceDefinition['initCommands']) ?? null,
              dependsOn: s.dependsOn as unknown as string[],
              routing: (s.routing as unknown as StackServiceDefinition['routing']) ?? null,
            })),
          } as any) as any,
          status: resultStatus,
        },
      });

      // 9. Record deployment history
      await this.prisma.stackDeployment.create({
        data: {
          stackId,
          action: 'apply',
          success: allSucceeded,
          version: stack.version,
          status: resultStatus,
          duration: Date.now() - startTime,
          serviceResults: serviceResults as any,
          triggeredBy: options?.triggeredBy ?? null,
        },
      });

      return {
        success: allSucceeded,
        stackId,
        appliedVersion: stack.version,
        serviceResults,
        duration: Date.now() - startTime,
      };
    } catch (err: any) {
      // Record unexpected failure as a deployment record
      const duration = Date.now() - startTime;
      log.error({ error: err.message }, 'Apply failed unexpectedly');
      try {
        await this.prisma.stackDeployment.create({
          data: {
            stackId,
            action: 'apply',
            success: false,
            version: stack.version,
            status: 'error',
            duration,
            error: err.message,
            triggeredBy: options?.triggeredBy ?? null,
          },
        });
        await this.prisma.stack.update({
          where: { id: stackId },
          data: { status: 'error' },
        });
      } catch (dbErr) {
        log.error({ error: dbErr }, 'Failed to record deployment failure');
      }
      throw err;
    }
  }

  /**
   * Pull all images for the stack's services and promote no-op actions to
   * 'recreate' when the freshly-pulled image ID differs from the running
   * container's image ID. Mutates `plan.actions` in place.
   */
  private async promoteStalePullActions(
    plan: StackPlan,
    stackId: string,
    log: any
  ): Promise<void> {
    const docker = this.dockerExecutor.getDockerClient();

    // Load service definitions for image names
    const stack = await this.prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: { services: true },
    });
    const serviceImageMap = new Map(
      stack.services.map((s) => [s.serviceName, `${s.dockerImage}:${s.dockerTag}`])
    );

    // Pull all images (regardless of action — we always want latest)
    const pulledImageIds = new Map<string, string>();
    for (const svc of stack.services) {
      const imageRef = `${svc.dockerImage}:${svc.dockerTag}`;
      try {
        log.info({ service: svc.serviceName, image: imageRef }, 'Force-pulling image');
        await this.containerManager.pullImage(svc.dockerImage, svc.dockerTag);

        // Get the image ID of the freshly-pulled image
        const image = docker.getImage(imageRef);
        const inspectData = await image.inspect();
        pulledImageIds.set(svc.serviceName, inspectData.Id);
      } catch (err: any) {
        log.warn({ service: svc.serviceName, error: err.message }, 'Force-pull failed, skipping');
      }
    }

    // Get running containers to compare image IDs
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`mini-infra.stack-id=${stackId}`] },
    });
    const containerByService = buildContainerMap(containers);

    // Promote no-op actions to recreate if the image digest changed
    for (const action of plan.actions) {
      if (action.action !== 'no-op') continue;

      const pulledId = pulledImageIds.get(action.serviceName);
      if (!pulledId) continue;

      const container = containerByService.get(action.serviceName);
      if (!container) continue;

      // container.ImageID is the full image digest of the image the container was created from
      if (container.ImageID !== pulledId) {
        log.info(
          {
            service: action.serviceName,
            oldImageId: container.ImageID?.substring(0, 24),
            newImageId: pulledId.substring(0, 24),
          },
          'Image updated — promoting to recreate'
        );
        action.action = 'recreate';
        action.reason = 'image updated (force pull)';
        action.currentImage = container.Image;
        action.desiredImage = serviceImageMap.get(action.serviceName);
        plan.hasChanges = true;
      }
    }
  }

  async stopStack(stackId: string, options?: { triggeredBy?: string }): Promise<{ success: boolean; stoppedContainers: number }> {
    const startTime = Date.now();
    const log = servicesLogger().child({ operation: 'stack-stop', stackId });

    const docker = this.dockerExecutor.getDockerClient();
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`mini-infra.stack-id=${stackId}`] },
    });

    log.info({ containerCount: containers.length }, 'Stopping stack containers');

    let stopped = 0;
    // Stop in reverse order (highest order first = dependents before dependencies)
    const sorted = [...containers].sort((a, b) => {
      const orderA = parseInt(a.Labels['mini-infra.stack-version'] || '0');
      const orderB = parseInt(b.Labels['mini-infra.stack-version'] || '0');
      return orderB - orderA;
    });

    for (const containerInfo of sorted) {
      try {
        await this.containerManager.stopAndRemoveContainer(containerInfo.Id);
        stopped++;
      } catch (err) {
        log.warn({ containerId: containerInfo.Id, error: err }, 'Failed to stop container, continuing');
      }
    }

    // Update stack status to undeployed
    await this.prisma.stack.update({
      where: { id: stackId },
      data: { status: 'undeployed' },
    });

    // Record deployment history
    await this.prisma.stackDeployment.create({
      data: {
        stackId,
        action: 'stop',
        success: true,
        status: 'undeployed',
        duration: Date.now() - startTime,
        triggeredBy: options?.triggeredBy ?? null,
      },
    });

    log.info({ stopped }, 'Stack stopped');
    return { success: true, stoppedContainers: stopped };
  }

  /**
   * Destroy a stack: stop and remove all containers, networks, and volumes,
   * then delete the stack from the database.
   */
  async destroyStack(stackId: string, options?: { triggeredBy?: string }): Promise<DestroyResult> {
    const startTime = Date.now();
    const log = servicesLogger().child({ operation: 'stack-destroy', stackId });

    const stack = await this.prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: { services: true, environment: true },
    });

    const projectName = stack.environment ? `${stack.environment.name}-${stack.name}` : stack.name;
    const networks = (stack.networks as unknown as StackNetwork[]) ?? [];
    const volumes = (stack.volumes as unknown as StackVolume[]) ?? [];

    log.info({ stackName: stack.name, projectName }, 'Destroying stack');

    // 1. Stop and remove all containers
    const docker = this.dockerExecutor.getDockerClient();
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`mini-infra.stack-id=${stackId}`] },
    });

    let containersRemoved = 0;
    for (const containerInfo of containers) {
      try {
        await this.containerManager.stopAndRemoveContainer(containerInfo.Id);
        containersRemoved++;
      } catch (err) {
        log.warn({ containerId: containerInfo.Id, error: err }, 'Failed to remove container, continuing');
      }
    }

    // 2. Remove networks
    const networksRemoved: string[] = [];
    for (const net of networks) {
      const netName = `${projectName}_${net.name}`;
      try {
        if (await this.dockerExecutor.networkExists(netName)) {
          await this.dockerExecutor.removeNetwork(netName);
          networksRemoved.push(netName);
        }
      } catch (err) {
        log.warn({ network: netName, error: err }, 'Failed to remove network, continuing');
      }
    }

    // 3. Remove volumes
    const volumesRemoved: string[] = [];
    for (const vol of volumes) {
      const volName = `${projectName}_${vol.name}`;
      try {
        if (await this.dockerExecutor.volumeExists(volName)) {
          await this.dockerExecutor.removeVolume(volName);
          volumesRemoved.push(volName);
        }
      } catch (err) {
        log.warn({ volume: volName, error: err }, 'Failed to remove volume, continuing');
      }
    }

    // 4. Record deployment history and mark stack as removed
    const duration = Date.now() - startTime;
    await this.prisma.stackDeployment.create({
      data: {
        stackId,
        action: 'destroy',
        success: true,
        status: 'removed',
        duration,
        triggeredBy: options?.triggeredBy ?? null,
      },
    });

    await this.prisma.stack.update({
      where: { id: stackId },
      data: { status: 'removed', removedAt: new Date() },
    });

    log.info({ containersRemoved, networksRemoved, volumesRemoved, duration }, 'Stack destroyed');
    return {
      success: true,
      stackId,
      containersRemoved,
      networksRemoved,
      volumesRemoved,
      duration,
    };
  }

  private async applyStateful(
    action: ServiceAction,
    svc: any,
    serviceDef: StackServiceDefinition | null,
    projectName: string,
    stackId: string,
    stack: any,
    networkNames: string[],
    serviceHashes: Map<string, string>,
    resolvedConfigsMap: Map<string, StackConfigFile[]>,
    containerByService: Map<string, Docker.ContainerInfo>,
    actionStart: number,
    log: any
  ): Promise<ServiceApplyResult> {
    switch (action.action) {
      case 'create': {
        if (!serviceDef || !svc) throw new Error(`Service ${action.serviceName} not found`);
        log.info({ service: action.serviceName }, 'Creating service');

        await prepareServiceContainer(this.containerManager, svc, resolvedConfigsMap.get(action.serviceName) ?? [], projectName);

        const containerId = await this.containerManager.createAndStartContainer(
          action.serviceName,
          serviceDef,
          {
            projectName,
            stackId,
            stackName: stack.name,
            stackVersion: stack.version,
            environmentId: stack.environmentId,
            definitionHash: serviceHashes.get(action.serviceName)!,
            networkNames,
          }
        );

        // Join external networks if specified (e.g., HAProxy network for cloudflared)
        if (serviceDef.containerConfig.joinNetworks?.length) {
          for (const netName of serviceDef.containerConfig.joinNetworks) {
            try {
              await this.containerManager.connectToNetwork(containerId, netName);
              log.info({ service: action.serviceName, network: netName }, 'Joined external network');
            } catch (err: any) {
              log.warn({ service: action.serviceName, network: netName, error: err.message }, 'Failed to join external network');
            }
          }
        }

        const healthy = await this.containerManager.waitForHealthy(containerId);

        return {
          serviceName: action.serviceName,
          action: 'create',
          success: healthy,
          duration: Date.now() - actionStart,
          containerId,
          error: healthy ? undefined : 'Healthcheck timeout',
        };
      }

      case 'recreate': {
        if (!serviceDef || !svc) throw new Error(`Service ${action.serviceName} not found`);
        log.info({ service: action.serviceName }, 'Recreating service');

        const oldContainer = containerByService.get(action.serviceName);

        if (oldContainer) {
          await this.containerManager.stopAndRemoveContainer(oldContainer.Id).catch(() => {
            log.warn({ service: action.serviceName }, 'Failed to stop old container, continuing');
          });
        }

        await prepareServiceContainer(this.containerManager, svc, resolvedConfigsMap.get(action.serviceName) ?? [], projectName);

        const containerId = await this.containerManager.createAndStartContainer(
          action.serviceName,
          serviceDef,
          {
            projectName,
            stackId,
            stackName: stack.name,
            stackVersion: stack.version,
            environmentId: stack.environmentId,
            definitionHash: serviceHashes.get(action.serviceName)!,
            networkNames,
          }
        );

        // Join external networks if specified (e.g., HAProxy network for cloudflared)
        if (serviceDef.containerConfig.joinNetworks?.length) {
          for (const netName of serviceDef.containerConfig.joinNetworks) {
            try {
              await this.containerManager.connectToNetwork(containerId, netName);
              log.info({ service: action.serviceName, network: netName }, 'Joined external network');
            } catch (err: any) {
              log.warn({ service: action.serviceName, network: netName, error: err.message }, 'Failed to join external network');
            }
          }
        }

        const healthy = await this.containerManager.waitForHealthy(containerId);

        if (!healthy) {
          log.error({ service: action.serviceName, containerId }, 'Healthcheck failed after recreate');
        }

        return {
          serviceName: action.serviceName,
          action: 'recreate',
          success: healthy,
          duration: Date.now() - actionStart,
          containerId,
          error: healthy ? undefined : 'Healthcheck timeout',
        };
      }

      case 'remove': {
        log.info({ service: action.serviceName }, 'Removing service');
        const container = containerByService.get(action.serviceName);
        if (container) {
          await this.containerManager.stopAndRemoveContainer(container.Id);
        }

        return {
          serviceName: action.serviceName,
          action: 'remove',
          success: true,
          duration: Date.now() - actionStart,
        };
      }

      default:
        throw new Error(`Unknown action: ${action.action}`);
    }
  }

  private async applyStatelessWeb(
    action: ServiceAction,
    svc: any,
    serviceDef: StackServiceDefinition,
    projectName: string,
    stackId: string,
    stack: any,
    networkNames: string[],
    serviceHashes: Map<string, string>,
    resolvedConfigsMap: Map<string, StackConfigFile[]>,
    containerByService: Map<string, Docker.ContainerInfo>,
    actionStart: number,
    log: any
  ): Promise<ServiceApplyResult> {
    const routing = serviceDef.routing;
    if (!routing) {
      throw new Error(`StatelessWeb service "${action.serviceName}" requires routing configuration`);
    }

    const routingManager = this.routingManager!;
    const containerName = `${projectName}-${action.serviceName}`;

    switch (action.action) {
      case 'create': {
        log.info({ service: action.serviceName }, 'Creating StatelessWeb service');

        await prepareServiceContainer(this.containerManager, svc, resolvedConfigsMap.get(action.serviceName) ?? [], projectName);

        const containerId = await this.containerManager.createAndStartContainer(
          action.serviceName,
          serviceDef,
          {
            projectName,
            stackId,
            stackName: stack.name,
            stackVersion: stack.version,
            environmentId: stack.environmentId,
            definitionHash: serviceHashes.get(action.serviceName)!,
            networkNames,
          }
        );

        // Connect to HAProxy network
        const haproxyCtx = await routingManager.getHAProxyContext(stack.environmentId);
        await this.containerManager.connectToNetwork(containerId, haproxyCtx.haproxyNetworkName);

        // Wait for healthy
        const healthy = await this.containerManager.waitForHealthy(containerId);
        if (!healthy) {
          log.error({ service: action.serviceName, containerId }, 'Healthcheck failed, rolling back');
          await this.containerManager.stopAndRemoveContainer(containerId);
          return {
            serviceName: action.serviceName,
            action: 'create',
            success: false,
            duration: Date.now() - actionStart,
            containerId,
            error: 'Healthcheck timeout',
          };
        }

        // Setup HAProxy routing
        const haproxyClient = new HAProxyDataPlaneClient();
        const routingCtx: import('./stack-routing-manager').StackRoutingContext = {
          serviceName: action.serviceName,
          containerId,
          containerName,
          routing,
          environmentId: stack.environmentId,
          stackId,
          stackName: stack.name,
        };

        const { backendName, serverName } = await routingManager.setupBackendAndServer(routingCtx, haproxyClient);
        await routingManager.configureRoute(routingCtx, backendName, haproxyClient);
        await routingManager.enableTraffic(backendName, serverName, haproxyClient);

        // Configure DNS if needed
        if (routing.dns) {
          await routingManager.configureDNS(routing.hostname, stack.environmentId, routing);
        }

        return {
          serviceName: action.serviceName,
          action: 'create',
          success: true,
          duration: Date.now() - actionStart,
          containerId,
        };
      }

      case 'recreate': {
        log.info({ service: action.serviceName }, 'Recreating StatelessWeb service (blue-green)');

        const oldContainer = containerByService.get(action.serviceName);

        await prepareServiceContainer(this.containerManager, svc, resolvedConfigsMap.get(action.serviceName) ?? [], projectName);

        // Create green container (blue stays running)
        const greenId = await this.containerManager.createAndStartContainer(
          action.serviceName,
          serviceDef,
          {
            projectName,
            stackId,
            stackName: stack.name,
            stackVersion: stack.version,
            environmentId: stack.environmentId,
            definitionHash: serviceHashes.get(action.serviceName)!,
            networkNames,
          }
        );

        // Connect green to HAProxy network
        const haproxyCtx = await routingManager.getHAProxyContext(stack.environmentId);
        await this.containerManager.connectToNetwork(greenId, haproxyCtx.haproxyNetworkName);

        // Wait for green healthy
        const healthy = await this.containerManager.waitForHealthy(greenId);
        if (!healthy) {
          log.error({ service: action.serviceName, containerId: greenId }, 'Green healthcheck failed, keeping blue');
          await this.containerManager.stopAndRemoveContainer(greenId);
          return {
            serviceName: action.serviceName,
            action: 'recreate',
            success: false,
            duration: Date.now() - actionStart,
            error: 'Healthcheck timeout',
          };
        }

        // Setup HAProxy for green
        const haproxyClient = new HAProxyDataPlaneClient();
        const backendName = `stk-${stack.name}-${action.serviceName}`;
        const greenServerName = `${action.serviceName}-${greenId.slice(0, 8)}`;

        await haproxyClient.addServer(backendName, {
          name: greenServerName,
          address: containerName,
          port: routing.listeningPort,
          check: 'enabled',
        });

        await routingManager.enableTraffic(backendName, greenServerName, haproxyClient);

        // Drain and remove blue
        if (oldContainer) {
          const oldServerName = `${action.serviceName}-${oldContainer.Id.slice(0, 8)}`;
          await routingManager.drainAndRemoveServer(backendName, oldServerName, haproxyClient);
          await this.containerManager.stopAndRemoveContainer(oldContainer.Id);
        }

        return {
          serviceName: action.serviceName,
          action: 'recreate',
          success: true,
          duration: Date.now() - actionStart,
          containerId: greenId,
        };
      }

      case 'remove': {
        log.info({ service: action.serviceName }, 'Removing StatelessWeb service');

        const haproxyClient = new HAProxyDataPlaneClient();
        const routingCtx: import('./stack-routing-manager').StackRoutingContext = {
          serviceName: action.serviceName,
          containerId: '',
          containerName,
          routing,
          environmentId: stack.environmentId,
          stackId,
          stackName: stack.name,
        };

        // Remove HAProxy route
        await routingManager.removeRoute(routingCtx, haproxyClient);

        // Remove DNS
        if (routing.dns) {
          await routingManager.removeDNS(routing.hostname);
        }

        // Remove server from backend and stop container
        const container = containerByService.get(action.serviceName);
        if (container) {
          const backendName = `stk-${stack.name}-${action.serviceName}`;
          const serverName = `${action.serviceName}-${container.Id.slice(0, 8)}`;
          try {
            await haproxyClient.deleteServer(backendName, serverName);
          } catch (err: any) {
            log.warn({ backendName, serverName, error: err.message }, 'Failed to delete server from backend');
          }
          await this.containerManager.stopAndRemoveContainer(container.Id);
        }

        return {
          serviceName: action.serviceName,
          action: 'remove',
          success: true,
          duration: Date.now() - actionStart,
        };
      }

      default:
        throw new Error(`Unknown action: ${action.action}`);
    }
  }

  private async detectConflicts(
    resolvedDefinitions: Map<string, StackServiceDefinition>,
    stackId: string,
    projectName: string,
    docker: Docker
  ): Promise<PlanWarning[]> {
    const warnings: PlanWarning[] = [];

    // List all containers on the host (including stopped for name conflicts)
    const allContainers = await docker.listContainers({ all: true });

    // Partition into "other" containers (not belonging to this stack)
    const otherContainers = allContainers.filter(
      (c) => c.Labels['mini-infra.stack-id'] !== stackId
    );

    // --- Port conflicts (running containers only) ---
    const usedPorts = new Map<string, Docker.ContainerInfo>();
    for (const container of otherContainers) {
      if (container.State !== 'running') continue;
      for (const portInfo of container.Ports ?? []) {
        if (portInfo.PublicPort) {
          usedPorts.set(`${portInfo.PublicPort}/${portInfo.Type}`, container);
        }
      }
    }

    for (const [serviceName, def] of resolvedDefinitions) {
      for (const port of def.containerConfig.ports ?? []) {
        // Skip internal-only ports — they don't bind to host so can't conflict
        if (port.exposeOnHost === false || port.hostPort === 0) continue;

        const key = `${port.hostPort}/${port.protocol}`;
        const conflict = usedPorts.get(key);
        if (!conflict) continue;

        const containerName = conflict.Names?.[0]?.replace(/^\//, '') ?? conflict.Id.slice(0, 12);
        const conflictStackName = conflict.Labels['mini-infra.stack'] || undefined;

        warnings.push({
          type: 'port-conflict',
          serviceName,
          hostPort: port.hostPort,
          protocol: port.protocol,
          conflictingContainerName: containerName,
          conflictingStackName: conflictStackName,
          message: conflictStackName
            ? `Port ${port.hostPort}/${port.protocol} is in use by "${containerName}" (stack: ${conflictStackName})`
            : `Port ${port.hostPort}/${port.protocol} is in use by "${containerName}"`,
        });
      }
    }

    // --- Container name conflicts (all containers, including stopped) ---
    const usedNames = new Map<string, Docker.ContainerInfo>();
    for (const container of otherContainers) {
      for (const name of container.Names ?? []) {
        usedNames.set(name.replace(/^\//, ''), container);
      }
    }

    for (const [serviceName] of resolvedDefinitions) {
      const desiredName = `${projectName}-${serviceName}`;
      const conflict = usedNames.get(desiredName);
      if (!conflict) continue;

      const conflictStackName = conflict.Labels['mini-infra.stack'] || undefined;

      warnings.push({
        type: 'name-conflict',
        serviceName,
        desiredContainerName: desiredName,
        conflictingContainerId: conflict.Id.slice(0, 12),
        conflictingStackName: conflictStackName,
        message: conflictStackName
          ? `Container name "${desiredName}" is taken by a container from stack "${conflictStackName}"`
          : `Container name "${desiredName}" is taken by an existing container (${conflict.Id.slice(0, 12)})`,
      });
    }

    return warnings;
  }

  private generateDiffs(
    serviceName: string,
    snapshot: StackDefinition | null,
    current: StackServiceDefinition
  ): FieldDiff[] {
    if (!snapshot) return [];

    const oldService = snapshot.services.find((s) => s.serviceName === serviceName);
    if (!oldService) return [];

    const diffs: FieldDiff[] = [];

    if (oldService.dockerImage !== current.dockerImage) {
      diffs.push({ field: 'dockerImage', old: oldService.dockerImage, new: current.dockerImage });
    }
    if (oldService.dockerTag !== current.dockerTag) {
      diffs.push({ field: 'dockerTag', old: oldService.dockerTag, new: current.dockerTag });
    }

    const oldConfig = JSON.stringify(oldService.containerConfig);
    const newConfig = JSON.stringify(current.containerConfig);
    if (oldConfig !== newConfig) {
      diffs.push({ field: 'containerConfig', old: oldConfig, new: newConfig });
    }

    const oldFiles = JSON.stringify(oldService.configFiles ?? []);
    const newFiles = JSON.stringify(current.configFiles ?? []);
    if (oldFiles !== newFiles) {
      diffs.push({ field: 'configFiles', old: oldFiles, new: newFiles });
    }

    const oldInit = JSON.stringify(oldService.initCommands ?? []);
    const newInit = JSON.stringify(current.initCommands ?? []);
    if (oldInit !== newInit) {
      diffs.push({ field: 'initCommands', old: oldInit, new: newInit });
    }

    const oldRouting = JSON.stringify(oldService.routing ?? null);
    const newRouting = JSON.stringify(current.routing ?? null);
    if (oldRouting !== newRouting) {
      diffs.push({ field: 'routing', old: oldRouting, new: newRouting });
    }

    return diffs;
  }

  private buildReason(
    currentImage: string,
    desiredImage: string,
    diffs: FieldDiff[]
  ): string {
    if (currentImage !== desiredImage) {
      return `image changed: ${currentImage} -> ${desiredImage}`;
    }
    if (diffs.length > 0) {
      const fields = diffs.map((d) => d.field).join(', ');
      return `configuration changed: ${fields}`;
    }
    return 'definition hash changed';
  }
}
