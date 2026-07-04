import type { PrismaClient } from "../../generated/prisma/client";
import type { Logger } from 'pino';
import type {
  StackResourceInput,
  StackResourceOutput,
  StackServiceDefinition,
} from '@mini-infra/types';
import type { DockerExecutorService } from '../docker-executor';
import type { StackContainerManager } from './stack-container-manager';
import { connectSelfToNetwork } from './self-network-connect';
import { createNetworkManager, resourceNetworkName, type NetworkManager } from '../networks';

/**
 * Manages Docker networks and InfraResource records that back a stack's
 * resource outputs and inputs (e.g., shared networks consumed by other stacks).
 *
 * All Docker network operations flow through `NetworkManager` — this class
 * never talks to Docker's network API directly.
 */
export class StackInfraResourceManager {
  private networkManager: NetworkManager;

  constructor(
    private dockerExecutor: DockerExecutorService,
    private prisma: PrismaClient,
    private containerManager: StackContainerManager,
    networkManager?: NetworkManager,
  ) {
    this.networkManager = networkManager ?? createNetworkManager(dockerExecutor);
  }

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

      const scope: 'environment' | 'host' = stack.environmentId ? 'environment' : 'host';
      const name = resourceNetworkName(output.purpose, stack.environmentId ? stack.environment!.name : null);

      const labels: Record<string, string> = {
        'mini-infra.infra-resource': 'true',
        'mini-infra.resource-purpose': output.purpose,
        'mini-infra.stack-id': stack.id,
      };
      if (stack.environmentId) {
        labels['mini-infra.environment'] = stack.environmentId;
      }

      // Every network — egress included — lets Docker's IPAM assign the
      // subnet. The egress network is normally created up-front during
      // environment provisioning (see EnvironmentManager.provisionEgressGateway),
      // so this path only runs as a fallback when it's missing; either way we
      // don't prescribe a subnet, which is what keeps it from overlapping
      // other networks on a shared host. `ensure()` is idempotent — a network
      // that already exists is left alone (mismatches are logged, not
      // recreated) — so no separate exists-check is needed here.
      const ensureResult = await this.networkManager.ensure({
        name,
        owner: { kind: scope, id: stack.environmentId ?? undefined },
        purpose: output.purpose,
        driver: 'bridge',
        extraLabels: labels,
      });
      if (ensureResult.created) {
        log.info({ network: name, purpose: output.purpose, scope }, 'Creating infra resource network');
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
        // For egressBypass services (the egress-gateway itself, fw-agent, etc.),
        // add the service name as a DNS alias so managed containers can resolve
        // `egress-gateway:3128` regardless of which IP the container gets on
        // recreate. The egress-gateway service joins the per-env `egress`
        // network with this alias; non-bypass containers are auto-attached to
        // the same network via attachEgressNetworkIfNeeded.
        const aliases =
          serviceDef.containerConfig.egressBypass === true ? [serviceDef.serviceName] : undefined;
        await this.containerManager.connectToNetwork(containerId, netName, aliases);
        log.info({ service: serviceDef.serviceName, network: netName, purpose, aliases }, 'Joined infra resource network');
      } catch (err) {
        // connectToNetwork delegates to NetworkManager.connect(), which
        // already treats "already connected" as success (status-code driven,
        // not message matching) — anything reaching this catch is a genuine
        // failure, always worth a warning.
        log.warn(
          { service: serviceDef.serviceName, network: netName, purpose, error: err instanceof Error ? err.message : String(err) },
          'Failed to join infra resource network',
        );
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

    for (const output of resourceOutputs) {
      if (!output.joinSelf || output.type !== 'docker-network') continue;

      const netName = outputNetworkMap.get(output.purpose);
      if (!netName) continue;

      if (await connectSelfToNetwork(this.dockerExecutor, this.prisma, selfId, netName, log)) {
        log.info({ network: netName, purpose: output.purpose }, 'Mini-infra joined infra resource network (joinSelf)');
      }
    }
  }
}
