import Docker from 'dockerode';
import type { Logger } from 'pino';
import { Prisma, PrismaClient } from "../../generated/prisma/client";
import type {
  ServiceAction,
  ServiceApplyResult,
  StackConfigFile,
  StackServiceDefinition,
} from '@mini-infra/types';
import type { DockerExecutorService } from '../docker-executor';
import { initialDeploymentMachine, type InitialDeploymentContext } from '../haproxy/initial-deployment-state-machine';
import { blueGreenDeploymentMachine, type BlueGreenDeploymentContext } from '../haproxy/blue-green-deployment-state-machine';
import { blueGreenUpdateMachine, type BlueGreenUpdateContext } from '../haproxy/blue-green-update-state-machine';
import { removalDeploymentMachine, type RemovalDeploymentContext } from '../haproxy/removal-deployment-state-machine';
import { runStateMachineToCompletion } from './state-machine-runner';
import { prepareServiceContainer } from './utils';
import { removeConflictingContainer } from './stack-conflict-detector';
import type { StackContainerManager } from './stack-container-manager';
import type { StackInfraResourceManager } from './stack-infra-resource-manager';
import { StackRoutingManager, type StackRoutingContext } from './stack-routing-manager';
import {
  buildStateMachineContext,
  getInitializedHAProxyClient,
  cleanupAdoptedWebRouting,
  type StackWithReconcilerContext,
} from './stack-state-machine-context';

/**
 * Shared context passed to every service handler invocation. Contains
 * everything the handler needs beyond the per-call action and service defs.
 */
export interface ServiceHandlerContext {
  action: ServiceAction;
  svc: Prisma.StackServiceGetPayload<true>;
  serviceDef: StackServiceDefinition | null;
  projectName: string;
  stackId: string;
  stack: StackWithReconcilerContext;
  networkNames: string[];
  serviceHashes: Map<string, string>;
  resolvedConfigsMap: Map<string, StackConfigFile[]>;
  containerByService: Map<string, Docker.ContainerInfo>;
  infraNetworkMap: Map<string, string>;
  /**
   * Apply-time dynamic env values resolved by the reconciler between image
   * pull and container creation. Keyed by service name → env var name → value.
   * Used to materialise vault-wrapped-secret-id and similar transient vars.
   */
  resolvedEnvOverrides?: Map<string, Record<string, string>>;
  actionStart: number;
  log: Logger;
}

/**
 * Merge resolved dynamic env values into a service definition's env map.
 * Returns a shallow copy — never mutates the input.
 */
export function mergeDynamicEnv(
  serviceDef: StackServiceDefinition,
  overrides?: Record<string, string>,
): StackServiceDefinition {
  if (!overrides || Object.keys(overrides).length === 0) return serviceDef;
  return {
    ...serviceDef,
    containerConfig: {
      ...serviceDef.containerConfig,
      env: { ...(serviceDef.containerConfig.env ?? {}), ...overrides },
    },
  };
}

/**
 * Orchestrates per-service-type container lifecycle actions (create, recreate, remove).
 * Each service type has different semantics:
 *   - Stateful: plain stop/start container replacement.
 *   - StatelessWeb: blue-green deployment via HAProxy state machines.
 *   - AdoptedWeb: attaches routing to an externally-managed container (never starts/stops it).
 */
export class StackServiceHandlers {
  constructor(
    private prisma: PrismaClient,
    private dockerExecutor: DockerExecutorService,
    private containerManager: StackContainerManager,
    private infraManager: StackInfraResourceManager,
    private routingManager?: StackRoutingManager
  ) {}

  async applyStateful(ctx: ServiceHandlerContext): Promise<ServiceApplyResult> {
    const { action, svc, serviceDef, projectName, stackId, stack, networkNames, serviceHashes,
      resolvedConfigsMap, containerByService, infraNetworkMap, resolvedEnvOverrides, actionStart, log } = ctx;

    const overridesForService = resolvedEnvOverrides?.get(action.serviceName);
    const effectiveServiceDef = serviceDef ? mergeDynamicEnv(serviceDef, overridesForService) : null;

    switch (action.action) {
      case 'create': {
        if (!effectiveServiceDef || !svc) throw new Error(`Service ${action.serviceName} not found`);
        log.info({ service: action.serviceName }, 'Creating service');

        await removeConflictingContainer(
          `${projectName}-${action.serviceName}`, stackId,
          this.dockerExecutor.getDockerClient(), this.containerManager, log
        );

        await prepareServiceContainer(this.containerManager, svc, resolvedConfigsMap.get(action.serviceName) ?? [], projectName);

        const containerId = await this.containerManager.createAndStartContainer(
          action.serviceName,
          effectiveServiceDef,
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

        await this.joinJoinNetworks(containerId, action.serviceName, effectiveServiceDef, log);
        await this.infraManager.joinResourceNetworks(containerId, effectiveServiceDef, infraNetworkMap, log);

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
        if (!effectiveServiceDef || !svc) throw new Error(`Service ${action.serviceName} not found`);
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
          effectiveServiceDef,
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

        await this.joinJoinNetworks(containerId, action.serviceName, effectiveServiceDef, log);
        await this.infraManager.joinResourceNetworks(containerId, effectiveServiceDef, infraNetworkMap, log);

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

  async applyAdoptedWeb(ctx: ServiceHandlerContext): Promise<ServiceApplyResult> {
    const { action, serviceDef, stackId, stack, infraNetworkMap, actionStart, log } = ctx;
    if (!serviceDef) throw new Error(`Service ${action.serviceName} not found`);

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

        if (action.action === 'recreate') {
          try {
            await cleanupAdoptedWebRouting(
              this.prisma, this.routingManager!, action.serviceName, adopted.containerName, routing,
              stackId, stack, log, false
            );
          } catch (err: unknown) {
            log.warn({ service: action.serviceName, error: (err instanceof Error ? err.message : String(err)) }, 'Failed to clean up old routing (continuing)');
          }
        }

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

        const { haproxyCtx, haproxyClient } = await getInitializedHAProxyClient(this.routingManager!, stack.environmentId!);

        const haproxyNetworkName = haproxyCtx.haproxyNetworkName;
        const containerNetworks = Object.keys(target.NetworkSettings?.Networks || {});
        if (!containerNetworks.includes(haproxyNetworkName)) {
          log.info({ containerName: adopted.containerName, network: haproxyNetworkName }, 'Joining adopted container to HAProxy network');
          await this.containerManager.connectToNetwork(target.Id, haproxyNetworkName);
        }

        if (serviceDef.containerConfig.joinResourceNetworks?.length) {
          await this.infraManager.joinResourceNetworks(target.Id, serviceDef, infraNetworkMap, log);
        }

        const routingCtx: StackRoutingContext = {
          serviceName: action.serviceName,
          containerId: target.Id,
          containerName: adopted.containerName,
          routing: { ...routing, listeningPort: adopted.listeningPort },
          environmentId: stack.environmentId!,
          stackId,
          stackName: stack.name,
        };

        const { backendName, serverName } = await this.routingManager!.setupBackendAndServer(
          routingCtx, haproxyClient
        );

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
          await cleanupAdoptedWebRouting(
            this.prisma, this.routingManager!, action.serviceName, adopted.containerName, routing,
            stackId, stack, log, true
          );
        } catch (err: unknown) {
          log.warn({ service: action.serviceName, error: (err instanceof Error ? err.message : String(err)) }, 'Failed to remove routing');
          return {
            serviceName: action.serviceName,
            action: 'remove',
            success: false,
            duration: Date.now() - actionStart,
            error: (err instanceof Error ? err.message : String(err)),
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

  async applyStatelessWeb(ctx: ServiceHandlerContext): Promise<ServiceApplyResult> {
    const { action, svc, serviceDef, projectName, stackId, stack, networkNames, serviceHashes,
      resolvedConfigsMap, containerByService, infraNetworkMap, resolvedEnvOverrides, actionStart, log } = ctx;

    if (!serviceDef) throw new Error(`Service ${action.serviceName} not found`);
    if (!serviceDef.routing) {
      throw new Error(`StatelessWeb service "${action.serviceName}" requires routing configuration`);
    }

    const effectiveServiceDef = mergeDynamicEnv(
      serviceDef,
      resolvedEnvOverrides?.get(action.serviceName),
    );

    const baseContext = await buildStateMachineContext(
      this.prisma, action, effectiveServiceDef, projectName, stackId, stack, serviceHashes, infraNetworkMap, networkNames
    );

    switch (action.action) {
      case 'create': {
        log.info({ service: action.serviceName }, 'Creating StatelessWeb service via initial deployment state machine');

        await prepareServiceContainer(
          this.containerManager, svc, resolvedConfigsMap.get(action.serviceName) ?? [], projectName
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

        const finalState = await runStateMachineToCompletion<InitialDeploymentContext>(
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
          containerId: finalState.context.containerId,
          error: success ? undefined : finalState.context.error ?? 'Deployment failed',
        };
      }

      case 'recreate': {
        log.info({ service: action.serviceName }, 'Recreating StatelessWeb service via blue-green state machine');

        const oldContainer = containerByService.get(action.serviceName);

        await prepareServiceContainer(
          this.containerManager, svc, resolvedConfigsMap.get(action.serviceName) ?? [], projectName
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

        const finalState = await runStateMachineToCompletion<BlueGreenDeploymentContext>(
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
          containerId: finalState.context.newContainerId,
          error: success ? undefined : finalState.context.error ?? 'Blue-green deployment failed',
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

        const finalState = await runStateMachineToCompletion<RemovalDeploymentContext>(
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
          error: success ? undefined : finalState.context.error ?? 'Removal failed',
        };
      }

      default:
        throw new Error(`Unknown action: ${action.action}`);
    }
  }

  async updateStatelessWeb(ctx: ServiceHandlerContext): Promise<ServiceApplyResult> {
    const { action, svc, serviceDef, projectName, stackId, stack, networkNames, serviceHashes,
      resolvedConfigsMap, containerByService, infraNetworkMap, resolvedEnvOverrides, actionStart, log } = ctx;

    if (!serviceDef) throw new Error(`Service ${action.serviceName} not found`);
    if (!serviceDef.routing) {
      throw new Error(`StatelessWeb service "${action.serviceName}" requires routing configuration`);
    }

    log.info({ service: action.serviceName }, 'Updating StatelessWeb service via blue-green update state machine');

    const effectiveServiceDef = mergeDynamicEnv(
      serviceDef,
      resolvedEnvOverrides?.get(action.serviceName),
    );

    const baseContext = await buildStateMachineContext(
      this.prisma, action, effectiveServiceDef, projectName, stackId, stack, serviceHashes, infraNetworkMap, networkNames
    );

    const oldContainer = containerByService.get(action.serviceName);

    await prepareServiceContainer(
      this.containerManager, svc, resolvedConfigsMap.get(action.serviceName) ?? [], projectName
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

    const finalState = await runStateMachineToCompletion<BlueGreenUpdateContext>(
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
      containerId: finalState.context.newContainerId,
      error: success ? undefined : finalState.context.error ?? 'Blue-green update failed',
    };
  }

  /**
   * Join a container to `containerConfig.joinNetworks` (external networks like HAProxy).
   * "Already exists" errors are non-fatal.
   */
  private async joinJoinNetworks(
    containerId: string,
    serviceName: string,
    serviceDef: StackServiceDefinition,
    log: Logger
  ): Promise<void> {
    if (!serviceDef.containerConfig.joinNetworks?.length) return;
    for (const netName of serviceDef.containerConfig.joinNetworks) {
      if (!netName) continue;
      try {
        await this.containerManager.connectToNetwork(containerId, netName);
        log.info({ service: serviceName, network: netName }, 'Joined external network');
      } catch (err: unknown) {
        log.warn({ service: serviceName, network: netName, error: (err instanceof Error ? err.message : String(err)) }, 'Failed to join external network');
      }
    }
  }
}
