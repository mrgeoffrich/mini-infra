import type { PrismaClient } from "../../generated/prisma/client";
import type { Logger } from 'pino';
import type {
  StackResourceInput,
  StackResourceOutput,
  StackServiceDefinition,
} from '@mini-infra/types';
import type { DockerExecutorService } from '../docker-executor';
import type { StackContainerManager } from './stack-container-manager';

/**
 * Manages Docker networks and InfraResource records that back a stack's
 * resource outputs and inputs (e.g., shared networks consumed by other stacks).
 */
export class StackInfraResourceManager {
  constructor(
    private dockerExecutor: DockerExecutorService,
    private prisma: PrismaClient,
    private containerManager: StackContainerManager
  ) {}

  /**
   * Create Docker networks and InfraResource records for resource outputs.
   * Returns a map of purpose → Docker network name for outputs.
   */
  async reconcileOutputs(
    stack: { id: string; environmentId: string | null; environment?: { name: string } | null },
    resourceOutputs: StackResourceOutput[],
    log: Logger
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

        // For environment-scoped applications networks, use the subnet pre-allocated
        // by EgressNetworkAllocator and persisted on InfraResource.metadata.subnet.
        // This gives the egress gateway a stable, known network segment.
        let ipamConfig: { subnet: string; gateway?: string } | undefined;
        if (output.purpose === 'applications' && stack.environmentId) {
          // Check for an existing InfraResource record that may carry a pre-allocated subnet
          const existingResource = await this.prisma.infraResource.findFirst({
            where: {
              type: 'docker-network',
              purpose: 'applications',
              scope: 'environment',
              environmentId: stack.environmentId,
            },
            select: { metadata: true },
          });
          const meta = existingResource?.metadata as Record<string, unknown> | null;
          const subnet = meta?.['subnet'];
          const gateway = meta?.['gateway'];
          if (typeof subnet === 'string') {
            ipamConfig = {
              subnet,
              ...(typeof gateway === 'string' ? { gateway } : {}),
            };
            log.info({ network: name, subnet, gateway }, 'Using pre-allocated subnet for applications network');
          }
        }

        await this.dockerExecutor.createNetwork(name, '', { driver: 'bridge', labels, ipam: ipamConfig });
      }

      // Use findFirst + create/update instead of upsert because host-scoped resources
      // have environmentId=null, and SQLite treats NULLs as distinct in unique constraints.
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
  async resolveInputs(
    environmentId: string | null,
    resourceInputs: StackResourceInput[],
    log: Logger
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    for (const input of resourceInputs) {
      if (input.type !== 'docker-network') continue;

      let resource = null;

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
  async joinResourceNetworks(
    containerId: string,
    serviceDef: StackServiceDefinition,
    infraNetworkMap: Map<string, string>,
    log: Logger
  ): Promise<void> {
    for (const purpose of serviceDef.containerConfig.joinResourceNetworks ?? []) {
      const netName = infraNetworkMap.get(purpose);
      if (!netName) continue;
      try {
        // For egressBypass services joining the applications resource network,
        // add the service name as a DNS alias so managed containers can resolve
        // `egress-gateway:3128` regardless of which IP the container gets on recreate.
        const aliases =
          serviceDef.containerConfig.egressBypass === true ? [serviceDef.serviceName] : undefined;
        await this.containerManager.connectToNetwork(containerId, netName, aliases);
        log.info({ service: serviceDef.serviceName, network: netName, purpose, aliases }, 'Joined infra resource network');
      } catch (err) {
        // Ignore "already connected" errors
        const e = err as { message?: string; statusCode?: number };
        const msg = e?.message || '';
        if (!msg.includes('already exists') && e?.statusCode !== 403) {
          log.warn({ service: serviceDef.serviceName, network: netName, purpose, error: msg }, 'Failed to join infra resource network');
        }
      }
    }
  }

  /**
   * Connect the mini-infra container itself to resource output networks
   * that declare joinSelf: true.
   */
  async joinSelfToOutputNetworks(
    resourceOutputs: StackResourceOutput[],
    outputNetworkMap: Map<string, string>,
    log: Logger
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
      } catch (err) {
        const e = err as { message?: string; statusMessage?: string; statusCode?: number };
        const msg = e?.message || e?.statusMessage || '';
        if (!msg.includes('already exists') && e?.statusCode !== 403) {
          log.warn({ network: netName, purpose: output.purpose, error: msg }, 'Failed to join self to infra resource network');
        } else {
          log.debug({ network: netName }, 'Already connected to infra resource network');
        }
      }
    }
  }
}
