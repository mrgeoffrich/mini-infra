import Docker from 'dockerode';
import { PrismaClient } from '@prisma/client';
import {
  StackPlan,
  ServiceAction,
  FieldDiff,
  StackServiceDefinition,
  StackDefinition,
  StackConfigFile,
  StackContainerConfig,
  StackNetwork,
  StackVolume,
  ApplyOptions,
  ApplyResult,
  ServiceApplyResult,
  serializeStack,
} from '@mini-infra/types';
import { DockerExecutorService } from '../docker-executor';
import { computeDefinitionHash } from './definition-hash';
import { buildTemplateContext, resolveStackConfigFiles } from './template-engine';
import { StackContainerManager } from './stack-container-manager';
import { servicesLogger } from '../../lib/logger-factory';

export class StackReconciler {
  private containerManager: StackContainerManager;

  constructor(
    private dockerExecutor: DockerExecutorService,
    private prisma: PrismaClient
  ) {
    this.containerManager = new StackContainerManager(dockerExecutor);
  }

  async plan(stackId: string): Promise<StackPlan> {
    const log = servicesLogger().child({ operation: 'stack-plan', stackId });

    // 1. Load stack with services and environment
    const stack = await this.prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: { services: { orderBy: { order: 'asc' } }, environment: true },
    });

    log.info({ stackName: stack.name, serviceCount: stack.services.length }, 'Computing plan');

    // 2. Build template context and resolve config files per service
    const templateContext = buildTemplateContext(
      {
        name: stack.name,
        networks: stack.networks as StackNetwork[],
        volumes: stack.volumes as StackVolume[],
      },
      stack.services.map((s) => ({
        serviceName: s.serviceName,
        dockerImage: s.dockerImage,
        dockerTag: s.dockerTag,
        containerConfig: s.containerConfig as StackContainerConfig,
      })),
      stack.environment.name
    );

    // 3. Compute definition hashes per service
    const serviceHashes = new Map<string, string>();
    const resolvedConfigsMap = new Map<string, StackConfigFile[]>();

    for (const svc of stack.services) {
      const resolvedConfigs = resolveStackConfigFiles(
        (svc.configFiles as StackConfigFile[]) ?? [],
        templateContext
      );
      resolvedConfigsMap.set(svc.serviceName, resolvedConfigs);

      const def = this.toServiceDefinition(svc);
      const hash = computeDefinitionHash(def, resolvedConfigs);
      serviceHashes.set(svc.serviceName, hash);
    }

    // 4. Query running containers for this stack
    const docker = this.dockerExecutor.getDockerClient();
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`mini-infra.stack-id=${stackId}`] },
    });

    const containerMap = new Map<string, Docker.ContainerInfo>();
    for (const container of containers) {
      const serviceName = container.Labels['mini-infra.service'];
      if (serviceName) {
        containerMap.set(serviceName, container);
      }
    }

    // 5. Compare desired services against running containers
    const actions: ServiceAction[] = [];
    const snapshot = stack.lastAppliedSnapshot as StackDefinition | null;

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
      const diffs = this.generateDiffs(svc.serviceName, snapshot, this.toServiceDefinition(svc));
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

    const plan: StackPlan = {
      stackId,
      stackName: stack.name,
      stackVersion: stack.version,
      planTime: new Date().toISOString(),
      actions,
      hasChanges: actions.some((a) => a.action !== 'no-op'),
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

    // 1. Get plan
    const plan = await this.plan(stackId);

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

    const projectName = `${stack.environment.name}-${stack.name}`;

    // Build template context for config file resolution
    const templateContext = buildTemplateContext(
      {
        name: stack.name,
        networks: stack.networks as StackNetwork[],
        volumes: stack.volumes as StackVolume[],
      },
      stack.services.map((s) => ({
        serviceName: s.serviceName,
        dockerImage: s.dockerImage,
        dockerTag: s.dockerTag,
        containerConfig: s.containerConfig as StackContainerConfig,
      })),
      stack.environment.name
    );

    // Build maps for service definitions, hashes, and resolved configs
    const serviceMap = new Map(stack.services.map((s) => [s.serviceName, s]));
    const resolvedConfigsMap = new Map<string, StackConfigFile[]>();
    const serviceHashes = new Map<string, string>();

    for (const svc of stack.services) {
      const resolvedConfigs = resolveStackConfigFiles(
        (svc.configFiles as StackConfigFile[]) ?? [],
        templateContext
      );
      resolvedConfigsMap.set(svc.serviceName, resolvedConfigs);
      const def = this.toServiceDefinition(svc);
      serviceHashes.set(svc.serviceName, computeDefinitionHash(def, resolvedConfigs));
    }

    // 5. Ensure infrastructure — create networks and volumes
    const networks = stack.networks as StackNetwork[];
    const volumes = stack.volumes as StackVolume[];
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
    const containerByService = new Map<string, Docker.ContainerInfo>();
    for (const c of currentContainers) {
      const sn = c.Labels['mini-infra.service'];
      if (sn) containerByService.set(sn, c);
    }

    for (const action of actions) {
      const actionStart = Date.now();
      const svc = serviceMap.get(action.serviceName);
      const serviceDef = svc ? this.toServiceDefinition(svc) : null;

      try {
        switch (action.action) {
          case 'create': {
            if (!serviceDef || !svc) throw new Error(`Service ${action.serviceName} not found`);
            log.info({ service: action.serviceName }, 'Creating service');

            await this.containerManager.pullImage(svc.dockerImage, svc.dockerTag);

            const initCmds = (svc.initCommands as StackServiceDefinition['initCommands']) ?? [];
            if (initCmds.length > 0) {
              await this.containerManager.runInitCommands(initCmds, projectName);
            }

            const resolvedConfigs = resolvedConfigsMap.get(action.serviceName) ?? [];
            if (resolvedConfigs.length > 0) {
              await this.containerManager.writeConfigFiles(resolvedConfigs, projectName);
            }

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

            const healthy = await this.containerManager.waitForHealthy(containerId);

            serviceResults.push({
              serviceName: action.serviceName,
              action: 'create',
              success: healthy,
              duration: Date.now() - actionStart,
              containerId,
              error: healthy ? undefined : 'Healthcheck timeout',
            });
            break;
          }

          case 'recreate': {
            if (!serviceDef || !svc) throw new Error(`Service ${action.serviceName} not found`);
            log.info({ service: action.serviceName }, 'Recreating service');

            const oldContainer = containerByService.get(action.serviceName);

            // Stop old container
            if (oldContainer) {
              await this.containerManager.stopAndRemoveContainer(oldContainer.Id).catch(() => {
                // If stop fails, we'll still try to create the new one
                log.warn({ service: action.serviceName }, 'Failed to stop old container, continuing');
              });
            }

            // Run init commands if changed
            const initCmds = (svc.initCommands as StackServiceDefinition['initCommands']) ?? [];
            if (initCmds.length > 0) {
              await this.containerManager.runInitCommands(initCmds, projectName);
            }

            // Write config files if changed
            const resolvedConfigs = resolvedConfigsMap.get(action.serviceName) ?? [];
            if (resolvedConfigs.length > 0) {
              await this.containerManager.writeConfigFiles(resolvedConfigs, projectName);
            }

            await this.containerManager.pullImage(svc.dockerImage, svc.dockerTag);

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

            const healthy = await this.containerManager.waitForHealthy(containerId);

            if (!healthy) {
              log.error({ service: action.serviceName, containerId }, 'Healthcheck failed after recreate');
            }

            serviceResults.push({
              serviceName: action.serviceName,
              action: 'recreate',
              success: healthy,
              duration: Date.now() - actionStart,
              containerId,
              error: healthy ? undefined : 'Healthcheck timeout',
            });
            break;
          }

          case 'remove': {
            log.info({ service: action.serviceName }, 'Removing service');
            const container = containerByService.get(action.serviceName);
            if (container) {
              await this.containerManager.stopAndRemoveContainer(container.Id);
            }

            serviceResults.push({
              serviceName: action.serviceName,
              action: 'remove',
              success: true,
              duration: Date.now() - actionStart,
            });
            break;
          }
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
    }

    // 8. Update stack in DB
    const allSucceeded = serviceResults.every((r) => r.success);
    await this.prisma.stack.update({
      where: { id: stackId },
      data: {
        lastAppliedVersion: stack.version,
        lastAppliedAt: new Date(),
        lastAppliedSnapshot: serializeStack({
          ...stack,
          networks: stack.networks as StackNetwork[],
          volumes: stack.volumes as StackVolume[],
          services: stack.services.map((s) => ({
            ...s,
            serviceType: s.serviceType as StackServiceDefinition['serviceType'],
            containerConfig: s.containerConfig as StackContainerConfig,
            configFiles: (s.configFiles as StackConfigFile[]) ?? null,
            initCommands: (s.initCommands as StackServiceDefinition['initCommands']) ?? null,
            dependsOn: s.dependsOn as string[],
            routing: s.routing as StackServiceDefinition['routing'] ?? null,
          })),
        }) as any,
        status: allSucceeded ? 'synced' : 'error',
      },
    });

    return {
      success: allSucceeded,
      stackId,
      appliedVersion: stack.version,
      serviceResults,
      duration: Date.now() - startTime,
    };
  }

  private toServiceDefinition(svc: {
    serviceName: string;
    serviceType: string;
    dockerImage: string;
    dockerTag: string;
    containerConfig: unknown;
    configFiles: unknown;
    initCommands: unknown;
    dependsOn: unknown;
    order: number;
    routing: unknown;
  }): StackServiceDefinition {
    return {
      serviceName: svc.serviceName,
      serviceType: svc.serviceType as StackServiceDefinition['serviceType'],
      dockerImage: svc.dockerImage,
      dockerTag: svc.dockerTag,
      containerConfig: svc.containerConfig as StackContainerConfig,
      configFiles: (svc.configFiles as StackConfigFile[]) ?? undefined,
      initCommands: (svc.initCommands as StackServiceDefinition['initCommands']) ?? undefined,
      dependsOn: svc.dependsOn as string[],
      order: svc.order,
      routing: (svc.routing as StackServiceDefinition['routing']) ?? undefined,
    };
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
