import { randomBytes } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type {
  ServiceAction,
  StackServiceDefinition,
  StackServiceRouting,
} from '@mini-infra/types';
import type { HAProxyDataPlaneClient } from '../haproxy';
import { EnvironmentValidationService, type HAProxyEnvironmentContext } from '../environment';
import type { StackRoutingManager, StackRoutingContext } from './stack-routing-manager';

export interface StackWithReconcilerContext {
  id: string;
  environmentId: string | null;
  name: string;
  version: number;
}

/**
 * Build state machine context from a stack service definition and routing config.
 * Maps stack fields to the flat context fields expected by deployment state machines.
 */
export async function buildStateMachineContext(
  prisma: PrismaClient,
  action: ServiceAction,
  serviceDef: StackServiceDefinition,
  projectName: string,
  stackId: string,
  stack: StackWithReconcilerContext,
  serviceHashes: Map<string, string>,
  infraNetworkMap: Map<string, string>,
  networkNames: string[] = []
): Promise<Record<string, unknown>> {
  const routing = serviceDef.routing!;
  const suffix = Array.from(randomBytes(5), (b) => String.fromCharCode(97 + (b % 26))).join('');
  const containerName = `${projectName}-${action.serviceName}-${suffix}`;
  const envValidation = new EnvironmentValidationService();
  const haproxyCtx = await envValidation.getHAProxyEnvironmentContext(stack.environmentId!);

  if (!haproxyCtx) {
    throw new Error(`HAProxy environment context not available for environment ${stack.environmentId}`);
  }

  const dockerImage = `${serviceDef.dockerImage}:${serviceDef.dockerTag}`;
  const envRecord = serviceDef.containerConfig.env ?? {};

  // Resolve TLS from stack-level resource if referenced
  let enableSsl = false;
  let tlsCertificateId: string | undefined;
  if (routing.tlsCertificate) {
    const tlsResource = await prisma.stackResource.findFirst({
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
 * Get an initialized HAProxy data plane client for an environment.
 */
export async function getInitializedHAProxyClient(
  routingManager: StackRoutingManager,
  environmentId: string
): Promise<{
  haproxyCtx: HAProxyEnvironmentContext;
  haproxyClient: HAProxyDataPlaneClient;
}> {
  const haproxyCtx = await routingManager.getHAProxyContext(environmentId);
  const { HAProxyDataPlaneClient: Client } = await import('../haproxy');
  const haproxyClient = new Client();
  await haproxyClient.initialize(haproxyCtx.haproxyContainerId);
  return { haproxyCtx, haproxyClient };
}

/**
 * Clean up HAProxy routing for an AdoptedWeb service.
 * Used by both recreate and remove actions.
 */
export async function cleanupAdoptedWebRouting(
  prisma: PrismaClient,
  routingManager: StackRoutingManager,
  serviceName: string,
  adoptedContainerName: string,
  routing: StackServiceRouting,
  stackId: string,
  stack: StackWithReconcilerContext,
  log: Logger,
  drainBeforeRemove: boolean
): Promise<void> {
  const { haproxyClient } = await getInitializedHAProxyClient(routingManager, stack.environmentId!);

  const routingCtx: StackRoutingContext = {
    serviceName,
    containerId: '',
    containerName: adoptedContainerName,
    routing,
    environmentId: stack.environmentId!,
    stackId,
    stackName: stack.name,
  };

  const backendName = `stk-${stack.name}-${serviceName}`;
  const backendRecord = await prisma.hAProxyBackend.findFirst({
    where: { name: backendName, environmentId: stack.environmentId! },
    include: { servers: true },
  });
  if (backendRecord) {
    for (const server of backendRecord.servers) {
      try {
        if (drainBeforeRemove) {
          await routingManager.drainAndRemoveServer(backendName, server.name, haproxyClient);
        } else {
          await haproxyClient.deleteServer(backendName, server.name);
        }
      } catch (err: unknown) {
        log.warn({ server: server.name, error: err instanceof Error ? err.message : String(err) }, 'Failed to remove/drain server');
      }
    }
    if (!drainBeforeRemove) {
      await prisma.hAProxyServer.deleteMany({ where: { backendId: backendRecord.id } });
    }
  }

  await routingManager.removeRoute(routingCtx, haproxyClient);
}
