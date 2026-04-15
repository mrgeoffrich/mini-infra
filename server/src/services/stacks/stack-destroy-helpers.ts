import { createActor } from 'xstate';
import type { PrismaClient } from "../../generated/prisma/client";
import prisma from '../../lib/prisma';
import { getLogger } from '../../lib/logger-factory';
import { DockerExecutorService } from '../docker-executor';
import DockerService from '../docker';
import { HAProxyFrontendManager } from '../haproxy';
import { removalDeploymentMachine } from '../haproxy/removal-deployment-state-machine';
import { StackRoutingManager, type StackRoutingContext } from './stack-routing-manager';
import type { StackUserEvent } from './stack-user-event';
import type {
  DockerContainerInfo,
  StackNetwork,
  StackServiceRouting,
  StackVolume,
} from '@mini-infra/types';

const logger = getLogger("stacks", "stack-destroy-helpers");

type StackWithRelations = Awaited<ReturnType<PrismaClient['stack']['findUniqueOrThrow']>> & {
  services: Array<{
    serviceName: string;
    serviceType: string;
    routing: unknown;
    adoptedContainer: unknown;
  }>;
  environment: { id: string; name: string } | null;
};

/**
 * Remove HAProxy routing for AdoptedWeb services during stack destroy. Adopted
 * containers are NOT removed — only their routing is cleaned up so they
 * become reachable only through any other frontend that still references them.
 * Failures are logged and swallowed because destroy must continue even if
 * HAProxy is unreachable.
 */
export async function removeAdoptedServiceRouting(
  fullStack: StackWithRelations,
  stackId: string,
): Promise<void> {
  const adoptedServices = fullStack.services.filter((s) => s.serviceType === 'AdoptedWeb');
  if (adoptedServices.length === 0 || !fullStack.environment) return;

  const environmentId = fullStack.environment.id;
  const routingManager = new StackRoutingManager(prisma, new HAProxyFrontendManager());

  for (const svc of adoptedServices) {
    const routing = svc.routing as {
      tunnelIngress?: string;
      tlsCertificate?: string;
      dnsRecord?: string;
    } | null;
    const adopted = svc.adoptedContainer as
      | { containerId?: string; name?: string; containerName?: string }
      | null;
    if (!routing || !adopted) continue;

    try {
      const haproxyCtx = await routingManager.getHAProxyContext(environmentId);
      const { HAProxyDataPlaneClient } = await import('../haproxy');
      const haproxyClient = new HAProxyDataPlaneClient();
      await haproxyClient.initialize(haproxyCtx.haproxyContainerId);

      const routingCtx: StackRoutingContext = {
        serviceName: svc.serviceName,
        containerId: '',
        containerName: adopted.containerName ?? '',
        routing: routing as StackServiceRouting,
        environmentId,
        stackId,
        stackName: fullStack.name,
      };

      const backendName = `stk-${fullStack.name}-${svc.serviceName}`;
      const backendRecord = await prisma.hAProxyBackend.findFirst({
        where: { name: backendName, environmentId },
        include: { servers: true },
      });
      if (backendRecord) {
        for (const server of backendRecord.servers) {
          try {
            await routingManager.drainAndRemoveServer(backendName, server.name, haproxyClient);
          } catch {
            /* best effort */
          }
        }
      }

      await routingManager.removeRoute(routingCtx, haproxyClient);
      logger.info({ service: svc.serviceName }, 'Removed AdoptedWeb routing during destroy');
    } catch (err) {
      logger.warn(
        {
          service: svc.serviceName,
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to remove AdoptedWeb routing during destroy',
      );
    }
  }
}

interface RemovalContextInput {
  stackId: string;
  environmentId: string;
  environmentName: string;
  haproxyContainerId: string;
  haproxyNetworkName: string;
  triggeredBy: string | undefined;
  startTime: number;
}

/**
 * Run the removal state machine for each non-adopted service in the stack.
 * Each service has its own HAProxy backend named `stk-{stackName}-{serviceName}`.
 * Emits progress updates to the passed user event as it works through the services.
 * Returns the total count of containers removed.
 */
export async function removeStackContainers(
  fullStack: StackWithRelations,
  stackContainers: DockerContainerInfo[],
  ctx: RemovalContextInput,
  userEvent: StackUserEvent,
): Promise<number> {
  const nonAdoptedServices = fullStack.services.filter((s) => s.serviceType !== 'AdoptedWeb');
  let totalContainersRemoved = 0;

  for (const svc of nonAdoptedServices) {
    const serviceContainers = stackContainers.filter(
      (c: DockerContainerInfo) => c.labels?.['mini-infra.service'] === svc.serviceName,
    );
    const containerIds = serviceContainers.map((c: DockerContainerInfo) => c.id);

    const applicationName =
      svc.serviceType === 'StatelessWeb'
        ? `stk-${fullStack.name}-${svc.serviceName}`
        : fullStack.name;

    const removalContext = {
      deploymentId: ctx.stackId,
      configurationId: ctx.stackId,
      applicationName,
      environmentId: ctx.environmentId,
      environmentName: ctx.environmentName,
      haproxyContainerId: ctx.haproxyContainerId,
      haproxyNetworkName: ctx.haproxyNetworkName,
      containersToRemove: containerIds,
      lbRemovalComplete: false,
      frontendRemoved: false,
      applicationStopped: false,
      applicationRemoved: false,
      retryCount: 0,
      triggerType: 'manual',
      triggeredBy: ctx.triggeredBy,
      startTime: ctx.startTime,
    };

    logger.info(
      {
        stackId: ctx.stackId,
        service: svc.serviceName,
        applicationName,
        containerCount: containerIds.length,
      },
      'Running removal state machine for service',
    );

    const serviceCount = nonAdoptedServices.length;
    const serviceIndex = nonAdoptedServices.indexOf(svc);

    const removed = await new Promise<number>((resolve, reject) => {
      const machine = removalDeploymentMachine.provide({});
      const actor = createActor(machine, { input: removalContext });

      actor.subscribe((state) => {
        const progressMap: Record<string, number> = {
          idle: 0,
          removingFromLB: 10,
          removingFrontend: 20,
          stoppingApplication: 40,
          removingApplication: 60,
          cleanup: 80,
          completed: 100,
          failed: 0,
        };
        const stateProgress = progressMap[state.value as string] ?? 0;
        const progress = Math.round(
          (serviceIndex / serviceCount) * 100 + stateProgress / serviceCount,
        );
        if (progress > 0) {
          void userEvent.updateProgress(Math.min(progress, 95));
        }

        if (state.status === 'done') {
          if (state.value === 'completed') {
            resolve(containerIds.length);
          } else {
            reject(new Error(state.context.error || 'Removal state machine failed'));
          }
        }
      });

      actor.start();
      actor.send({ type: 'START_REMOVAL' });
    });

    totalContainersRemoved += removed;
  }

  return totalContainersRemoved;
}

export async function listStackContainers(stackId: string): Promise<DockerContainerInfo[]> {
  const dockerService = DockerService.getInstance();
  await dockerService.initialize();
  const allContainers = await dockerService.listContainers(true);
  return allContainers.filter(
    (c: DockerContainerInfo) => c.labels?.['mini-infra.stack-id'] === stackId,
  );
}

export async function removeStackNetworksAndVolumes(
  projectName: string,
  networks: StackNetwork[],
  volumes: StackVolume[],
): Promise<{ networksRemoved: string[]; volumesRemoved: string[] }> {
  const dockerExecutor = new DockerExecutorService();
  await dockerExecutor.initialize();

  const networksRemoved: string[] = [];
  for (const net of networks) {
    const netName = `${projectName}_${net.name}`;
    try {
      if (await dockerExecutor.networkExists(netName)) {
        await dockerExecutor.removeNetwork(netName);
        networksRemoved.push(netName);
      }
    } catch (err) {
      logger.warn({ network: netName, error: err }, 'Failed to remove network, continuing');
    }
  }

  const volumesRemoved: string[] = [];
  for (const vol of volumes) {
    const volName = `${projectName}_${vol.name}`;
    try {
      if (await dockerExecutor.volumeExists(volName)) {
        await dockerExecutor.removeVolume(volName);
        volumesRemoved.push(volName);
      }
    } catch (err) {
      logger.warn({ volume: volName, error: err }, 'Failed to remove volume, continuing');
    }
  }

  return { networksRemoved, volumesRemoved };
}
