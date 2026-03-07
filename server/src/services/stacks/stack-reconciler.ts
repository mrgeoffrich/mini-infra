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
} from '@mini-infra/types';
import { DockerExecutorService } from '../docker-executor';
import { computeDefinitionHash } from './definition-hash';
import { buildTemplateContext, resolveStackConfigFiles } from './template-engine';
import { servicesLogger } from '../../lib/logger-factory';

export class StackReconciler {
  constructor(
    private dockerExecutor: DockerExecutorService,
    private prisma: PrismaClient
  ) {}

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
