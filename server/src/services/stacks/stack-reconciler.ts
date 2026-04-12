import { randomBytes } from 'crypto';
import Docker from 'dockerode';
import type { Logger } from 'pino';
import { Prisma, PrismaClient } from '@prisma/client';
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
  StackResourceOutput,
  StackResourceInput,
  StackServiceRouting,
  ApplyOptions,
  ApplyResult,
  UpdateOptions,
  DestroyResult,
  ServiceApplyResult,
  ResourceResult,
  serializeStack,
} from '@mini-infra/types';
import { DockerExecutorService } from '../docker-executor';
import { computeDefinitionHash } from './definition-hash';
import { StackContainerManager } from './stack-container-manager';
import { StackRoutingManager, type StackRoutingContext } from './stack-routing-manager';
import { StackResourceReconciler } from './stack-resource-reconciler';
import { servicesLogger } from '../../lib/logger-factory';
import { initialDeploymentMachine } from '../haproxy/initial-deployment-state-machine';
import { blueGreenDeploymentMachine } from '../haproxy/blue-green-deployment-state-machine';
import { blueGreenUpdateMachine } from '../haproxy/blue-green-update-state-machine';
import { removalDeploymentMachine } from '../haproxy/removal-deployment-state-machine';
import { runStateMachineToCompletion } from './state-machine-runner';
import type { HAProxyDataPlaneClient } from '../haproxy';
import { EnvironmentValidationService, type HAProxyEnvironmentContext } from '../environment';
import {
  buildStackTemplateContext,
  buildContainerMap,
  mergeParameterValues,
  toServiceDefinition,
  resolveServiceConfigs,
  prepareServiceContainer,
} from './utils';
import { runPostInstallActions } from './post-install-actions';

export class StackReconciler {
  private containerManager: StackContainerManager;

  constructor(
    private dockerExecutor: DockerExecutorService,
    private prisma: PrismaClient,
    private routingManager?: StackRoutingManager,
    private resourceReconciler?: StackResourceReconciler
  ) {
    this.containerManager = new StackContainerManager(dockerExecutor);
  }

  /**
   * Create Docker networks and InfraResource records for resource outputs.
   * Returns a map of purpose → Docker network name for outputs.
   */
  private async reconcileInfraOutputs(
    stack: { id: string; environmentId: string | null; environment?: { name: string } | null },
    resourceOutputs: StackResourceOutput[],
    log: any
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    for (const output of resourceOutputs) {
      if (output.type !== 'docker-network') {
        log.warn({ type: output.type }, 'Unsupported infra resource type, skipping');
        continue;
      }

      const scope = stack.environmentId ? 'environment' : 'host';
      const name = stack.environmentId
        ? `${stack.environment!.name}-${output.purpose}`
        : `mini-infra-${output.purpose}`;

      // Ensure Docker network exists
      const exists = await this.dockerExecutor.networkExists(name);
      if (!exists) {
        log.info({ network: name, purpose: output.purpose, scope }, 'Creating infra resource network');
        const labels: Record<string, string> = {
          'mini-infra.infra-resource': 'true',
          'mini-infra.resource-purpose': output.purpose,
          'mini-infra.stack-id': stack.id,
        };
        if (stack.environmentId) {
          labels['mini-infra.environment'] = stack.environmentId;
        }
        await this.dockerExecutor.createNetwork(name, '', { driver: 'bridge', labels });
      }

      // Upsert InfraResource record
      // Use findFirst + create/update instead of upsert because host-scoped resources
      // have environmentId=null, and SQLite treats NULLs as distinct in unique constraints.
      // The upsert approach used a '__host__' sentinel which violates the FK to Environment.
      const existing = await this.prisma.infraResource.findFirst({
        where: {
          type: output.type,
          purpose: output.purpose,
          scope,
          environmentId: stack.environmentId ?? null,
        },
      });
      if (existing) {
        await this.prisma.infraResource.update({
          where: { id: existing.id },
          data: { stackId: stack.id, name },
        });
      } else {
        await this.prisma.infraResource.create({
          data: {
            type: output.type,
            purpose: output.purpose,
            scope,
            environmentId: stack.environmentId ?? null,
            stackId: stack.id,
            name,
          },
        });
      }

      result.set(output.purpose, name);
    }

    return result;
  }

  /**
   * Resolve resource inputs to Docker network names by querying InfraResource.
   * Tries environment-scoped first, then falls back to host-scoped.
   */
  private async resolveInfraInputs(
    environmentId: string | null,
    resourceInputs: StackResourceInput[],
    log: any
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    for (const input of resourceInputs) {
      if (input.type !== 'docker-network') continue;

      let resource = null;

      // Try environment-scoped first
      if (environmentId) {
        resource = await this.prisma.infraResource.findUnique({
          where: {
            type_purpose_scope_environmentId: {
              type: input.type,
              purpose: input.purpose,
              scope: 'environment',
              environmentId,
            },
          },
        });
      }

      // Fall back to host-scoped
      if (!resource) {
        resource = await this.prisma.infraResource.findFirst({
          where: {
            type: input.type,
            purpose: input.purpose,
            scope: 'host',
            environmentId: null,
          },
        });
      }

      if (resource) {
        result.set(input.purpose, resource.name);
      } else if (!input.optional) {
        log.warn({ type: input.type, purpose: input.purpose }, 'Required infra resource input not found');
      }
    }

    return result;
  }

  /**
   * Connect a container to infra resource networks declared in joinResourceNetworks.
   */
  private async joinResourceNetworks(
    containerId: string,
    serviceDef: StackServiceDefinition,
    infraNetworkMap: Map<string, string>,
    log: any
  ): Promise<void> {
    for (const purpose of serviceDef.containerConfig.joinResourceNetworks ?? []) {
      const netName = infraNetworkMap.get(purpose);
      if (!netName) continue;
      try {
        await this.containerManager.connectToNetwork(containerId, netName);
        log.info({ service: serviceDef.serviceName, network: netName, purpose }, 'Joined infra resource network');
      } catch (err: any) {
        // Ignore "already connected" errors
        const msg = err?.message || '';
        if (!msg.includes('already exists') && err?.statusCode !== 403) {
          log.warn({ service: serviceDef.serviceName, network: netName, purpose, error: msg }, 'Failed to join infra resource network');
        }
      }
    }
  }

  /**
   * Connect the mini-infra container itself to resource output networks with joinSelf: true.
   */
  private async joinSelfToOutputNetworks(
    resourceOutputs: StackResourceOutput[],
    outputNetworkMap: Map<string, string>,
    log: any
  ): Promise<void> {
    const { getOwnContainerId } = await import('../self-update');
    const selfId = getOwnContainerId();
    if (!selfId) {
      log.debug('Not running in Docker, skipping joinSelf');
      return;
    }

    const docker = this.dockerExecutor.getDockerClient();

    for (const output of resourceOutputs) {
      if (!output.joinSelf || output.type !== 'docker-network') continue;

      const netName = outputNetworkMap.get(output.purpose);
      if (!netName) continue;

      try {
        const network = docker.getNetwork(netName);
        await network.connect({ Container: selfId });
        log.info({ network: netName, purpose: output.purpose }, 'Mini-infra joined infra resource network (joinSelf)');
      } catch (err: any) {
        const msg = err?.message || err?.statusMessage || '';
        if (!msg.includes('already exists') && err?.statusCode !== 403) {
          log.warn({ network: netName, purpose: output.purpose, error: msg }, 'Failed to join self to infra resource network');
        } else {
          log.debug({ network: netName }, 'Already connected to infra resource network');
        }
      }
    }
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

    // 1b. Load current stack resources for resource reconciliation
    const currentResources = this.resourceReconciler
      ? await this.prisma.stackResource.findMany({ where: { stackId } })
      : [];

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
      const desiredHash = serviceHashes.get(svc.serviceName)!;

      // AdoptedWeb services reference external containers — different lookup strategy
      if (svc.serviceType === 'AdoptedWeb') {
        const adopted = svc.adoptedContainer as unknown as { containerName: string; listeningPort: number } | null;
        if (!adopted) {
          planWarnings.push({
            type: 'adopted-container' as const,
            serviceName: svc.serviceName,
            containerName: 'unknown',
            issue: 'missing' as const,
            message: `AdoptedWeb service "${svc.serviceName}" has no adoptedContainer configuration`,
          });
          actions.push({ serviceName: svc.serviceName, action: 'no-op' });
          continue;
        }

        // Look up the adopted container by name
        const adoptedContainers = await docker.listContainers({
          all: true,
          filters: { name: [adopted.containerName] },
        });
        const target = adoptedContainers.find((c) =>
          c.Names.some((n) => n.replace(/^\//, '') === adopted.containerName)
        );

        if (!target) {
          planWarnings.push({
            type: 'adopted-container' as const,
            serviceName: svc.serviceName,
            containerName: adopted.containerName,
            issue: 'missing' as const,
            message: `Adopted container "${adopted.containerName}" not found`,
          });
        } else if (target.State !== 'running') {
          planWarnings.push({
            type: 'adopted-container' as const,
            serviceName: svc.serviceName,
            containerName: adopted.containerName,
            issue: 'not-running' as const,
            message: `Adopted container "${adopted.containerName}" is ${target.State}`,
          });
        }

        // Check if routing has been applied before
        const snapshotSvc = snapshot?.services?.find((s) => s.serviceName === svc.serviceName);
        if (!snapshotSvc) {
          // First deploy — need to set up routing
          actions.push({
            serviceName: svc.serviceName,
            action: 'create',
            reason: 'routing not configured',
            desiredImage: `adopted:${adopted.containerName}`,
          });
        } else {
          // Check if routing config changed by comparing hashes
          const snapshotHash = computeDefinitionHash(snapshotSvc);
          if (snapshotHash === desiredHash) {
            actions.push({ serviceName: svc.serviceName, action: 'no-op' });
          } else {
            const diffs = this.generateDiffs(svc.serviceName, snapshot, toServiceDefinition(svc));
            actions.push({
              serviceName: svc.serviceName,
              action: 'recreate',
              reason: 'routing configuration changed',
              diff: diffs.length > 0 ? diffs : undefined,
              desiredImage: `adopted:${adopted.containerName}`,
            });
          }
        }
        continue;
      }

      const container = containerMap.get(svc.serviceName);
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

    // Compute resource actions (TLS, DNS, Tunnel)
    const resourceActions = this.resourceReconciler
      ? this.resourceReconciler.planResources(
          {
            tlsCertificates: (stack.tlsCertificates as any[]) ?? [],
            dnsRecords: (stack.dnsRecords as any[]) ?? [],
            tunnelIngress: (stack.tunnelIngress as any[]) ?? [],
          },
          currentResources
        )
      : [];

    // Validate resource references (services referencing non-existent resources)
    if (this.resourceReconciler) {
      const serviceDefs = [...resolvedDefinitions.values()];
      const refWarnings = this.resourceReconciler.validateResourceReferences(
        serviceDefs,
        {
          tlsCertificates: (stack.tlsCertificates as any[]) ?? [],
          dnsRecords: (stack.dnsRecords as any[]) ?? [],
          tunnelIngress: (stack.tunnelIngress as any[]) ?? [],
        },
      );
      planWarnings.push(...refWarnings);
    }

    const plan: StackPlan = {
      stackId,
      stackName: stack.name,
      stackVersion: stack.version,
      planTime: new Date().toISOString(),
      actions,
      resourceActions,
      hasChanges: actions.some((a) => a.action !== 'no-op') || resourceActions.some((a) => a.action !== 'no-op'),
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
        resourceResults: [],
        duration: Date.now() - startTime,
      };
    }

    // 4. Load stack for DB updates and service definitions
    const stack = await this.prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: {
        services: { orderBy: { order: 'asc' } },
        environment: true,
        template: { select: { name: true } },
      },
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

      // 5a-i. Reconcile infra resource outputs (creates Docker networks + InfraResource records)
      const resourceOutputs = (stack.resourceOutputs as unknown as StackResourceOutput[]) ?? [];
      const resourceInputs = (stack.resourceInputs as unknown as StackResourceInput[]) ?? [];
      const outputNetworkMap = await this.reconcileInfraOutputs(stack, resourceOutputs, log);

      // 5a-ii. Resolve infra resource inputs from other stacks
      const inputNetworkMap = await this.resolveInfraInputs(stack.environmentId, resourceInputs, log);

      // 5a-iii. Merge output + input into a combined infra network map
      const infraNetworkMap = new Map([...outputNetworkMap, ...inputNetworkMap]);

      // 5b. Ensure stack-owned networks and volumes
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

      // 5c. Reconcile stack-level resources (DNS → TLS → Tunnels)
      const allResourceResults: ResourceResult[] = [];
      if (this.resourceReconciler && plan.resourceActions.some((a) => a.action !== 'no-op')) {
        const definitions = {
          tlsCertificates: (stack.tlsCertificates as any[]) ?? [],
          dnsRecords: (stack.dnsRecords as any[]) ?? [],
          tunnelIngress: (stack.tunnelIngress as any[]) ?? [],
        };

        const progressCallback = (result: ResourceResult) => {
          log.info({ stackId, result }, 'Resource reconciliation progress');
          if (result.action !== 'no-op' && options?.onProgress) {
            try {
              options.onProgress(result, 0, 0);
            } catch { /* never let callback errors break apply */ }
          }
        };

        // DNS first
        const dnsResults = await this.resourceReconciler.reconcileDns(
          plan.resourceActions, stackId, definitions.dnsRecords, progressCallback
        );
        allResourceResults.push(...dnsResults);
        if (dnsResults.some((r) => !r.success)) {
          const failed = dnsResults.find((r) => !r.success);
          throw new Error(`DNS reconciliation failed: ${failed?.error}`);
        }

        // TLS second
        const tlsResults = await this.resourceReconciler.reconcileTls(
          plan.resourceActions, stackId, definitions.tlsCertificates,
          options?.triggeredBy ?? 'system', progressCallback
        );
        allResourceResults.push(...tlsResults);
        if (tlsResults.some((r) => !r.success)) {
          const failed = tlsResults.find((r) => !r.success);
          throw new Error(`TLS reconciliation failed: ${failed?.error}`);
        }

        // Tunnel third
        const tunnelResults = await this.resourceReconciler.reconcileTunnel(
          plan.resourceActions, stackId, definitions.tunnelIngress, progressCallback
        );
        allResourceResults.push(...tunnelResults);
        if (tunnelResults.some((r) => !r.success)) {
          const failed = tunnelResults.find((r) => !r.success);
          throw new Error(`Tunnel reconciliation failed: ${failed?.error}`);
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
        const isAdoptedWeb = svc?.serviceType === 'AdoptedWeb';

        if ((isStatelessWeb || isAdoptedWeb) && !this.routingManager) {
          throw new Error(`StackRoutingManager is required for ${svc?.serviceType} service "${action.serviceName}"`);
        }

        try {
          if (isAdoptedWeb) {
            const result = await this.applyAdoptedWeb(
              action, svc!, serviceDef!, projectName, stackId, stack,
              serviceHashes, actionStart, log, infraNetworkMap
            );
            serviceResults.push(result);
          } else if (isStatelessWeb) {
            const result = await this.applyStatelessWeb(
              action, svc!, serviceDef!, projectName, stackId, stack,
              networkNames, serviceHashes, resolvedConfigsMap, containerByService,
              actionStart, log, infraNetworkMap
            );
            serviceResults.push(result);
          } else {
            const result = await this.applyStateful(
              action, svc, serviceDef, projectName, stackId, stack,
              networkNames, serviceHashes, resolvedConfigsMap, containerByService,
              actionStart, log, infraNetworkMap
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

      // 7b. Connect mini-infra container to resource output networks with joinSelf: true
      await this.joinSelfToOutputNetworks(resourceOutputs, outputNetworkMap, log);

      // 7c. Run post-install actions declared by the template (failures are non-fatal)
      await runPostInstallActions(stack.template?.name, {
        stackName: stack.name,
        projectName,
        parameterValues: (stack.parameterValues as Record<string, string | number | boolean>) ?? {},
        serviceResults,
        triggeredBy: options?.triggeredBy,
        prisma: this.prisma,
      });

      // 8. Update stack in DB
      const allSucceeded = serviceResults.every((r) => r.success);
      const resultStatus = allSucceeded ? 'synced' : 'error';
      await this.prisma.stack.update({
        where: { id: stackId },
        data: {
          lastAppliedVersion: stack.version,
          lastAppliedAt: new Date(),
          lastAppliedSnapshot: this.buildAppliedSnapshot(stack),
          status: resultStatus,
          removedAt: null,
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
          resourceResults: allResourceResults as any,
          triggeredBy: options?.triggeredBy ?? null,
        },
      });

      return {
        success: allSucceeded,
        stackId,
        appliedVersion: stack.version,
        serviceResults,
        resourceResults: allResourceResults,
        duration: Date.now() - startTime,
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      log.error({ error: err.message }, 'Apply failed unexpectedly');
      await this.recordDeploymentFailure(stackId, 'apply', stack.version, duration, err.message, options?.triggeredBy, log);
      throw err;
    }
  }

  async update(stackId: string, options?: UpdateOptions): Promise<ApplyResult> {
    const startTime = Date.now();
    const log = servicesLogger().child({ operation: 'stack-update', stackId });

    const plan = await this.plan(stackId);
    await this.promoteStalePullActions(plan, stackId, log);

    // Force-recreate: promote remaining no-op actions to recreate
    if (options?.forceRecreate) {
      for (const action of plan.actions) {
        if (action.action === 'no-op') {
          log.info({ service: action.serviceName }, 'Force-recreate: promoting no-op to recreate');
          action.action = 'recreate';
          action.reason = 'force recreate';
        }
      }
    }

    const actions = plan.actions.filter((a) => a.action !== 'no-op');

    if (actions.length === 0) {
      log.info('All images are up to date — nothing to update');
      await this.prisma.stackDeployment.create({
        data: {
          stackId,
          action: 'update',
          success: true,
          version: plan.stackVersion,
          status: 'synced',
          duration: Date.now() - startTime,
          serviceResults: [],
          triggeredBy: options?.triggeredBy ?? null,
        },
      });
      return {
        success: true,
        stackId,
        appliedVersion: plan.stackVersion,
        serviceResults: [],
        resourceResults: [],
        duration: Date.now() - startTime,
      };
    }

    const stack = await this.prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: { services: { orderBy: { order: 'asc' } }, environment: true },
    });

    try {
      const projectName = stack.environment ? `${stack.environment.name}-${stack.name}` : stack.name;
      const params = mergeParameterValues(
        (stack.parameters as unknown as StackParameterDefinition[]) ?? [],
        (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {}
      );
      const templateContext = buildStackTemplateContext(stack, params);
      const serviceMap = new Map(stack.services.map((s) => [s.serviceName, s]));
      const { resolvedConfigsMap, resolvedDefinitions, serviceHashes } = resolveServiceConfigs(stack.services, templateContext);

      // Reconcile infra resource outputs and inputs
      const resourceOutputs = (stack.resourceOutputs as unknown as StackResourceOutput[]) ?? [];
      const resourceInputs = (stack.resourceInputs as unknown as StackResourceInput[]) ?? [];
      const outputNetworkMap = await this.reconcileInfraOutputs(stack, resourceOutputs, log);
      const inputNetworkMap = await this.resolveInfraInputs(stack.environmentId, resourceInputs, log);
      const infraNetworkMap = new Map([...outputNetworkMap, ...inputNetworkMap]);

      const docker = this.dockerExecutor.getDockerClient();
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`mini-infra.stack-id=${stackId}`] },
      });
      const containerByService = buildContainerMap(containers);

      const networkNames = (stack.networks as unknown as StackNetwork[]).map(
        (n) => `${projectName}_${n.name}`
      );

      const serviceResults: ServiceApplyResult[] = [];
      let completedCount = 0;

      for (const action of actions) {
        const svc = serviceMap.get(action.serviceName);
        const serviceDef = resolvedDefinitions.get(action.serviceName) ?? null;
        const actionStart = Date.now();

        let result: ServiceApplyResult;

        if (svc?.serviceType === 'AdoptedWeb' && serviceDef) {
          result = await this.applyAdoptedWeb(
            action, svc, serviceDef, projectName, stackId, stack,
            serviceHashes, actionStart, log, infraNetworkMap
          );
        } else if (svc?.serviceType === 'StatelessWeb' && serviceDef && action.action === 'recreate') {
          result = await this.updateStatelessWeb(
            action, svc, serviceDef, projectName, stackId, stack,
            networkNames, serviceHashes, resolvedConfigsMap,
            containerByService, actionStart, log, infraNetworkMap
          );
        } else if (svc?.serviceType === 'StatelessWeb' && serviceDef) {
          // No existing container (create/remove) — use the standard apply path
          result = await this.applyStatelessWeb(
            action, svc, serviceDef, projectName, stackId, stack,
            networkNames, serviceHashes, resolvedConfigsMap,
            containerByService, actionStart, log, infraNetworkMap
          );
        } else {
          result = await this.applyStateful(
            action, svc, serviceDef, projectName, stackId, stack,
            networkNames, serviceHashes, resolvedConfigsMap,
            containerByService, actionStart, log, infraNetworkMap
          );
        }

        result = { ...result, action: 'update' };
        serviceResults.push(result);
        completedCount++;
        options?.onProgress?.(result, completedCount, actions.length);
      }

      const allSucceeded = serviceResults.every((r) => r.success);
      const resultStatus = allSucceeded ? 'synced' : 'error';

      await this.prisma.stack.update({
        where: { id: stackId },
        data: {
          status: resultStatus,
          lastAppliedVersion: stack.version,
          lastAppliedAt: new Date(),
          lastAppliedSnapshot: this.buildAppliedSnapshot(stack),
        },
      });

      await this.prisma.stackDeployment.create({
        data: {
          stackId,
          action: 'update',
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
        resourceResults: [],
        duration: Date.now() - startTime,
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      log.error({ error: err.message }, 'Update failed unexpectedly');
      await this.recordDeploymentFailure(stackId, 'update', stack.version, duration, err.message, options?.triggeredBy, log);
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
  async destroyStack(stackId: string, _options?: { triggeredBy?: string }): Promise<DestroyResult> {
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

    // 0. Destroy stack-level resources (TLS certificates, DNS records, tunnels)
    if (this.resourceReconciler) {
      try {
        await this.resourceReconciler.destroyAllResources(stackId);
      } catch (err: any) {
        log.warn({ error: err.message }, 'Resource destruction failed (non-fatal), continuing with container removal');
      }
    }

    // 0b. Clean up routing for AdoptedWeb services (container is NOT removed)
    const adoptedServices = stack.services.filter((s) => s.serviceType === 'AdoptedWeb');
    if (adoptedServices.length > 0 && this.routingManager && stack.environmentId) {
      for (const svc of adoptedServices) {
        const routing = svc.routing as unknown as StackServiceDefinition['routing'];
        const adopted = svc.adoptedContainer as unknown as StackServiceDefinition['adoptedContainer'];
        if (!routing || !adopted) continue;

        try {
          const haproxyCtx = await this.routingManager.getHAProxyContext(stack.environmentId);
          const haproxyClient = new (await import('../haproxy')).HAProxyDataPlaneClient();
          await haproxyClient.initialize(haproxyCtx.haproxyContainerId);

          const routingCtx: StackRoutingContext = {
            serviceName: svc.serviceName,
            containerId: '',
            containerName: adopted.containerName,
            routing,
            environmentId: stack.environmentId,
            stackId,
            stackName: stack.name,
          };

          // Drain and remove servers
          const backendName = `stk-${stack.name}-${svc.serviceName}`;
          const backendRecord = await this.prisma.hAProxyBackend.findFirst({
            where: { name: backendName, environmentId: stack.environmentId },
            include: { servers: true },
          });
          if (backendRecord) {
            for (const server of backendRecord.servers) {
              try {
                await this.routingManager.drainAndRemoveServer(backendName, server.name, haproxyClient);
              } catch { /* best effort */ }
            }
          }

          await this.routingManager.removeRoute(routingCtx, haproxyClient);
          log.info({ service: svc.serviceName }, 'Removed AdoptedWeb routing');
        } catch (err: any) {
          log.warn({ service: svc.serviceName, error: err.message }, 'Failed to remove AdoptedWeb routing');
        }
      }
    }

    // 1. Stop and remove all containers (AdoptedWeb containers are excluded — they don't have stack labels)
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

    // 4. Delete the stack record (cascades to deployments, services, resources)
    const duration = Date.now() - startTime;
    await this.prisma.stack.delete({
      where: { id: stackId },
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
    log: any,
    infraNetworkMap: Map<string, string> = new Map()
  ): Promise<ServiceApplyResult> {
    switch (action.action) {
      case 'create': {
        if (!serviceDef || !svc) throw new Error(`Service ${action.serviceName} not found`);
        log.info({ service: action.serviceName }, 'Creating service');

        // Remove any pre-existing container with the same name (e.g. from a failed apply or manual creation)
        await this.removeConflictingContainer(`${projectName}-${action.serviceName}`, stackId, log);

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
            if (!netName) continue;
            try {
              await this.containerManager.connectToNetwork(containerId, netName);
              log.info({ service: action.serviceName, network: netName }, 'Joined external network');
            } catch (err: any) {
              log.warn({ service: action.serviceName, network: netName, error: err.message }, 'Failed to join external network');
            }
          }
        }

        // Join infra resource networks by purpose
        await this.joinResourceNetworks(containerId, serviceDef, infraNetworkMap, log);

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
            if (!netName) continue;
            try {
              await this.containerManager.connectToNetwork(containerId, netName);
              log.info({ service: action.serviceName, network: netName }, 'Joined external network');
            } catch (err: any) {
              log.warn({ service: action.serviceName, network: netName, error: err.message }, 'Failed to join external network');
            }
          }
        }

        // Join infra resource networks by purpose
        await this.joinResourceNetworks(containerId, serviceDef, infraNetworkMap, log);

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

  /**
   * Build state machine context from stack service definition and routing config.
   * Maps stack fields to the flat context fields expected by the deployment state machine actions.
   */
  private async buildStateMachineContext(
    action: ServiceAction,
    serviceDef: StackServiceDefinition,
    projectName: string,
    stackId: string,
    stack: any,
    serviceHashes: Map<string, string>,
    infraNetworkMap: Map<string, string>,
    networkNames: string[] = []
  ): Promise<Record<string, unknown>> {
    const routing = serviceDef.routing!;
    const suffix = Array.from(randomBytes(5), b => String.fromCharCode(97 + (b % 26))).join('');
    const containerName = `${projectName}-${action.serviceName}-${suffix}`;
    const envValidation = new EnvironmentValidationService();
    const haproxyCtx = await envValidation.getHAProxyEnvironmentContext(stack.environmentId);

    if (!haproxyCtx) {
      throw new Error(`HAProxy environment context not available for environment ${stack.environmentId}`);
    }

    const dockerImage = `${serviceDef.dockerImage}:${serviceDef.dockerTag}`;
    const envRecord = serviceDef.containerConfig.env ?? {};

    // Resolve TLS from stack-level resource if referenced
    let enableSsl = false;
    let tlsCertificateId: string | undefined;
    if (routing.tlsCertificate) {
      const tlsResource = await this.prisma.stackResource.findFirst({
        where: { stackId, resourceType: 'tls', resourceName: routing.tlsCertificate },
      });
      if (tlsResource?.externalId) {
        enableSsl = true;
        tlsCertificateId = tlsResource.externalId;
      }
    }

    // Build networks list including environment networks, stack networks, and joinNetworks
    const containerNetworks: string[] = [haproxyCtx.haproxyNetworkName];
    for (const dockerName of infraNetworkMap.values()) {
      if (!containerNetworks.includes(dockerName)) {
        containerNetworks.push(dockerName);
      }
    }
    for (const netName of networkNames) {
      if (!containerNetworks.includes(netName)) {
        containerNetworks.push(netName);
      }
    }
    if (serviceDef.containerConfig.joinNetworks?.length) {
      for (const netName of serviceDef.containerConfig.joinNetworks) {
        if (netName && !containerNetworks.includes(netName)) {
          containerNetworks.push(netName);
        }
      }
    }

    return {
      deploymentId: `stack-${stackId}-${action.serviceName}-${Date.now()}`,
      configurationId: stackId,
      sourceType: 'stack',
      applicationName: `stk-${stack.name}-${action.serviceName}`,
      dockerImage,

      environmentId: haproxyCtx.environmentId,
      environmentName: haproxyCtx.environmentName,
      haproxyContainerId: haproxyCtx.haproxyContainerId,
      haproxyNetworkName: haproxyCtx.haproxyNetworkName,

      triggerType: 'manual',
      startTime: Date.now(),

      // Source-agnostic fields
      hostname: routing.hostname,
      enableSsl,
      tlsCertificateId,
      certificateStatus: enableSsl && tlsCertificateId ? 'ACTIVE' : undefined,
      healthCheckEndpoint: routing.healthCheckEndpoint ?? '/',
      healthCheckInterval: serviceDef.containerConfig.healthcheck?.interval
        ? Math.round(serviceDef.containerConfig.healthcheck.interval / 1_000_000)
        : 2000,
      healthCheckRetries: serviceDef.containerConfig.healthcheck?.retries ?? 2,
      containerPorts: serviceDef.containerConfig.ports ?? [],
      containerVolumes: [],
      containerEnvironment: envRecord,
      containerLabels: {
        'mini-infra.stack': stack.name,
        'mini-infra.stack-id': stackId,
        'mini-infra.service': action.serviceName,
        'mini-infra.environment': stack.environmentId,
        'mini-infra.definition-hash': serviceHashes.get(action.serviceName) ?? '',
        'mini-infra.stack-version': String(stack.version),
        ...(serviceDef.containerConfig.labels ?? {}),
      },
      containerNetworks,
      containerPort: routing.listeningPort,
      containerName,
    };
  }

  /**
   * Apply an AdoptedWeb service: find the external container, join it to the
   * HAProxy network, and configure routing. Never creates or removes the container.
   */
  private async applyAdoptedWeb(
    action: ServiceAction,
    svc: any,
    serviceDef: StackServiceDefinition,
    projectName: string,
    stackId: string,
    stack: any,
    serviceHashes: Map<string, string>,
    actionStart: number,
    log: any,
    infraNetworkMap: Map<string, string> = new Map()
  ): Promise<ServiceApplyResult> {
    const routing = serviceDef.routing;
    if (!routing) {
      throw new Error(`AdoptedWeb service "${action.serviceName}" requires routing configuration`);
    }

    const adopted = serviceDef.adoptedContainer;
    if (!adopted) {
      throw new Error(`AdoptedWeb service "${action.serviceName}" requires adoptedContainer configuration`);
    }

    switch (action.action) {
      case 'create':
      case 'recreate': {
        log.info({ service: action.serviceName, containerName: adopted.containerName }, `${action.action === 'create' ? 'Creating' : 'Recreating'} AdoptedWeb routing`);

        // For recreate, remove old routing first
        if (action.action === 'recreate') {
          try {
            await this.cleanupAdoptedWebRouting(
              action.serviceName, adopted.containerName, routing,
              stackId, stack, log, false
            );
          } catch (err: any) {
            log.warn({ service: action.serviceName, error: err.message }, 'Failed to clean up old routing (continuing)');
          }
        }

        // 1. Find the container by name
        const docker = this.dockerExecutor.getDockerClient();
        const containers = await docker.listContainers({
          all: false,
          filters: { name: [adopted.containerName] },
        });
        const target = containers.find((c) =>
          c.Names.some((n) => n.replace(/^\//, '') === adopted.containerName)
        );

        if (!target) {
          return {
            serviceName: action.serviceName,
            action: action.action,
            success: false,
            duration: Date.now() - actionStart,
            error: `Adopted container "${adopted.containerName}" not found or not running`,
          };
        }

        // 2. Get HAProxy context
        const { haproxyCtx, haproxyClient } = await this.getInitializedHAProxyClient(stack.environmentId);

        // 3. Join container to HAProxy applications network
        const haproxyNetworkName = haproxyCtx.haproxyNetworkName;
        const containerNetworks = Object.keys(target.NetworkSettings?.Networks || {});
        if (!containerNetworks.includes(haproxyNetworkName)) {
          log.info({ containerName: adopted.containerName, network: haproxyNetworkName }, 'Joining adopted container to HAProxy network');
          await this.containerManager.connectToNetwork(target.Id, haproxyNetworkName);
        }

        // 4. Join to infra resource networks if specified
        if (serviceDef.containerConfig.joinResourceNetworks?.length) {
          await this.joinResourceNetworks(target.Id, serviceDef, infraNetworkMap, log);
        }

        // 5. Set up backend + server
        const routingCtx: StackRoutingContext = {
          serviceName: action.serviceName,
          containerId: target.Id,
          containerName: adopted.containerName,
          routing: { ...routing, listeningPort: adopted.listeningPort },
          environmentId: stack.environmentId,
          stackId,
          stackName: stack.name,
        };

        const { backendName, serverName } = await this.routingManager!.setupBackendAndServer(
          routingCtx, haproxyClient
        );

        // 6. Resolve TLS and configure route
        let sslOptions: { enableSsl?: boolean; tlsCertificateId?: string } | undefined;
        if (routing.tlsCertificate) {
          const tlsResource = await this.prisma.stackResource.findFirst({
            where: { stackId, resourceType: 'tls', resourceName: routing.tlsCertificate },
          });
          if (tlsResource?.externalId) {
            sslOptions = { enableSsl: true, tlsCertificateId: tlsResource.externalId };
          }
        }

        await this.routingManager!.configureRoute(routingCtx, backendName, haproxyClient, sslOptions);

        // 7. Enable traffic
        await this.routingManager!.enableTraffic(backendName, serverName, haproxyClient);

        log.info({ service: action.serviceName, containerId: target.Id }, 'AdoptedWeb routing configured');

        return {
          serviceName: action.serviceName,
          action: action.action,
          success: true,
          duration: Date.now() - actionStart,
          containerId: target.Id,
        };
      }

      case 'remove': {
        log.info({ service: action.serviceName }, 'Removing AdoptedWeb routing (container will not be stopped)');

        try {
          await this.cleanupAdoptedWebRouting(
            action.serviceName, adopted.containerName, routing,
            stackId, stack, log, true
          );
        } catch (err: any) {
          log.warn({ service: action.serviceName, error: err.message }, 'Failed to remove routing');
          return {
            serviceName: action.serviceName,
            action: 'remove',
            success: false,
            duration: Date.now() - actionStart,
            error: err.message,
          };
        }

        return {
          serviceName: action.serviceName,
          action: 'remove',
          success: true,
          duration: Date.now() - actionStart,
        };
      }

      default:
        return {
          serviceName: action.serviceName,
          action: action.action,
          success: true,
          duration: Date.now() - actionStart,
        };
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
    log: any,
    infraNetworkMap: Map<string, string> = new Map()
  ): Promise<ServiceApplyResult> {
    const routing = serviceDef.routing;
    if (!routing) {
      throw new Error(`StatelessWeb service "${action.serviceName}" requires routing configuration`);
    }

    const baseContext = await this.buildStateMachineContext(
      action, serviceDef, projectName, stackId, stack, serviceHashes, infraNetworkMap, networkNames
    );

    switch (action.action) {
      case 'create': {
        log.info({ service: action.serviceName }, 'Creating StatelessWeb service via initial deployment state machine');

        // Prepare config files and init commands before the state machine runs
        await prepareServiceContainer(
          this.containerManager,
          svc,
          resolvedConfigsMap.get(action.serviceName) ?? [],
          projectName
        );

        const initialContext = {
          ...baseContext,
          containerId: undefined,
          applicationReady: false,
          haproxyConfigured: false,
          healthChecksPassed: false,
          frontendConfigured: false,
          trafficEnabled: false,
          validationErrors: 0,
          error: undefined,
          retryCount: 0,
          frontendName: undefined,
        };

        const finalState = await runStateMachineToCompletion(
          initialDeploymentMachine,
          initialContext,
          (actor) => actor.send({ type: 'START_DEPLOYMENT' })
        );

        const success = finalState.value === 'completed';
        return {
          serviceName: action.serviceName,
          action: 'create',
          success,
          duration: Date.now() - actionStart,
          containerId: (finalState.context as any).containerId,
          error: success ? undefined : (finalState.context as any).error ?? 'Deployment failed',
        };
      }

      case 'recreate': {
        log.info({ service: action.serviceName }, 'Recreating StatelessWeb service via blue-green state machine');

        const oldContainer = containerByService.get(action.serviceName);

        await prepareServiceContainer(
          this.containerManager,
          svc,
          resolvedConfigsMap.get(action.serviceName) ?? [],
          projectName
        );

        const blueGreenContext = {
          ...baseContext,
          blueHealthy: false,
          greenHealthy: false,
          greenBackendConfigured: false,
          frontendConfigured: false,
          trafficOpenedToGreen: false,
          trafficValidated: false,
          blueDraining: false,
          blueDrained: false,
          validationErrors: 0,
          drainStartTime: undefined,
          monitoringStartTime: undefined,
          error: undefined,
          retryCount: 0,
          activeConnections: 0,
          oldContainerId: oldContainer?.Id,
          newContainerId: undefined,
          containerIpAddress: undefined,
          frontendName: undefined,
        };

        const finalState = await runStateMachineToCompletion(
          blueGreenDeploymentMachine,
          blueGreenContext,
          (actor) => actor.send({ type: 'START_DEPLOYMENT' })
        );

        const success = finalState.value === 'completed';
        return {
          serviceName: action.serviceName,
          action: 'recreate',
          success,
          duration: Date.now() - actionStart,
          containerId: (finalState.context as any).newContainerId,
          error: success ? undefined : (finalState.context as any).error ?? 'Blue-green deployment failed',
        };
      }

      case 'remove': {
        log.info({ service: action.serviceName }, 'Removing StatelessWeb service via removal state machine');

        const container = containerByService.get(action.serviceName);

        const removalContext = {
          ...baseContext,
          containerId: container?.Id,
          containersToRemove: container ? [container.Id] : [],
          lbRemovalComplete: false,
          frontendRemoved: false,
          dnsRemoved: false,
          applicationStopped: false,
          applicationRemoved: false,
          error: undefined,
          retryCount: 0,
        };

        const finalState = await runStateMachineToCompletion(
          removalDeploymentMachine,
          removalContext,
          (actor) => actor.send({ type: 'START_REMOVAL' })
        );

        const success = finalState.value === 'completed';
        return {
          serviceName: action.serviceName,
          action: 'remove',
          success,
          duration: Date.now() - actionStart,
          error: success ? undefined : (finalState.context as any).error ?? 'Removal failed',
        };
      }

      default:
        throw new Error(`Unknown action: ${action.action}`);
    }
  }

  private async updateStatelessWeb(
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
    log: any,
    infraNetworkMap: Map<string, string> = new Map()
  ): Promise<ServiceApplyResult> {
    const routing = serviceDef.routing;
    if (!routing) {
      throw new Error(`StatelessWeb service "${action.serviceName}" requires routing configuration`);
    }

    log.info({ service: action.serviceName }, 'Updating StatelessWeb service via blue-green update state machine');

    const baseContext = await this.buildStateMachineContext(
      action, serviceDef, projectName, stackId, stack, serviceHashes, infraNetworkMap, networkNames
    );

    const oldContainer = containerByService.get(action.serviceName);

    await prepareServiceContainer(
      this.containerManager,
      svc,
      resolvedConfigsMap.get(action.serviceName) ?? [],
      projectName
    );

    const blueGreenContext = {
      ...baseContext,
      blueHealthy: false,
      greenHealthy: false,
      greenBackendConfigured: false,
      trafficOpenedToGreen: false,
      trafficValidated: false,
      blueDraining: false,
      blueDrained: false,
      validationErrors: 0,
      drainStartTime: undefined,
      monitoringStartTime: undefined,
      error: undefined,
      retryCount: 0,
      activeConnections: 0,
      oldContainerId: oldContainer?.Id,
      newContainerId: undefined,
      containerIpAddress: undefined,
    };

    const finalState = await runStateMachineToCompletion(
      blueGreenUpdateMachine,
      blueGreenContext,
      (actor) => actor.send({ type: 'START_DEPLOYMENT' })
    );

    const success = finalState.value === 'completed';
    return {
      serviceName: action.serviceName,
      action: 'update',
      success,
      duration: Date.now() - actionStart,
      containerId: (finalState.context as any).newContainerId,
      error: success ? undefined : (finalState.context as any).error ?? 'Blue-green update failed',
    };
  }

  private async removeConflictingContainer(
    containerName: string,
    stackId: string,
    log: any
  ): Promise<void> {
    const docker = this.dockerExecutor.getDockerClient();
    const allContainers = await docker.listContainers({ all: true });
    const conflict = allContainers.find(
      (c) =>
        c.Names?.some((n) => n.replace(/^\//, '') === containerName) &&
        c.Labels['mini-infra.stack-id'] !== stackId
    );
    if (conflict) {
      log.warn(
        { containerName, conflictId: conflict.Id.slice(0, 12) },
        'Removing conflicting container with same name before create'
      );
      await this.containerManager.stopAndRemoveContainer(conflict.Id);
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

  /**
   * Build the lastAppliedSnapshot value from a Prisma stack record.
   * Handles the JSON field casting that Prisma requires — Prisma types JSON
   * columns as `Prisma.JsonValue` but serializeStack expects the lib types.
   */
  private buildAppliedSnapshot(
    stack: { name: string; description: string | null; networks: unknown; volumes: unknown;
      parameters: unknown; resourceOutputs: unknown; resourceInputs: unknown;
      tlsCertificates: unknown; dnsRecords: unknown; tunnelIngress: unknown;
      services: Array<{
        serviceName: string; serviceType: string; dockerImage: string; dockerTag: string;
        order: number; containerConfig: unknown; configFiles: unknown; initCommands: unknown;
        dependsOn: unknown; routing: unknown; adoptedContainer: unknown;
      }>;
    }
  ): Prisma.InputJsonValue {
    return serializeStack({
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
        adoptedContainer: (s.adoptedContainer as unknown as StackServiceDefinition['adoptedContainer']) ?? null,
      })),
    } as any) as unknown as Prisma.InputJsonValue;
  }

  /**
   * Get an initialized HAProxy data plane client for an environment.
   */
  private async getInitializedHAProxyClient(environmentId: string): Promise<{
    haproxyCtx: HAProxyEnvironmentContext;
    haproxyClient: HAProxyDataPlaneClient;
  }> {
    const haproxyCtx = await this.routingManager!.getHAProxyContext(environmentId);
    const { HAProxyDataPlaneClient: Client } = await import('../haproxy');
    const haproxyClient = new Client();
    await haproxyClient.initialize(haproxyCtx.haproxyContainerId);
    return { haproxyCtx, haproxyClient };
  }

  /**
   * Clean up HAProxy routing for an AdoptedWeb service.
   * Used by both recreate and remove actions.
   */
  private async cleanupAdoptedWebRouting(
    serviceName: string,
    adoptedContainerName: string,
    routing: StackServiceRouting,
    stackId: string,
    stack: { environmentId: string; name: string },
    log: Logger,
    drainBeforeRemove: boolean
  ): Promise<void> {
    const { haproxyClient } = await this.getInitializedHAProxyClient(stack.environmentId);

    const routingCtx: StackRoutingContext = {
      serviceName,
      containerId: '',
      containerName: adoptedContainerName,
      routing,
      environmentId: stack.environmentId,
      stackId,
      stackName: stack.name,
    };

    const backendName = `stk-${stack.name}-${serviceName}`;
    const backendRecord = await this.prisma.hAProxyBackend.findFirst({
      where: { name: backendName, environmentId: stack.environmentId },
      include: { servers: true },
    });
    if (backendRecord) {
      for (const server of backendRecord.servers) {
        try {
          if (drainBeforeRemove) {
            await this.routingManager!.drainAndRemoveServer(backendName, server.name, haproxyClient);
          } else {
            await haproxyClient.deleteServer(backendName, server.name);
          }
        } catch (err: any) {
          log.warn({ server: server.name, error: err.message }, 'Failed to remove/drain server');
        }
      }
      if (!drainBeforeRemove) {
        await this.prisma.hAProxyServer.deleteMany({ where: { backendId: backendRecord.id } });
      }
    }

    await this.routingManager!.removeRoute(routingCtx, haproxyClient);
  }

  /**
   * Record a failed deployment and update stack status to error.
   */
  private async recordDeploymentFailure(
    stackId: string,
    actionType: 'apply' | 'update',
    version: number,
    duration: number,
    error: string,
    triggeredBy: string | null | undefined,
    log: Logger
  ): Promise<void> {
    try {
      await this.prisma.stackDeployment.create({
        data: {
          stackId,
          action: actionType,
          success: false,
          version,
          status: 'error',
          duration,
          error,
          triggeredBy: triggeredBy ?? null,
        },
      });
      await this.prisma.stack.update({
        where: { id: stackId },
        data: { status: 'error' },
      });
    } catch (dbErr) {
      log.error({ error: dbErr }, `Failed to record ${actionType} failure`);
    }
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
