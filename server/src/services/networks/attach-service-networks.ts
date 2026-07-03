import type { Logger } from 'pino';
import type { PrismaClient } from '../../generated/prisma/client';
import type { StackServiceDefinition } from '@mini-infra/types';
import type { NetworkManager } from './network-manager';
import type { StackContainerManager } from '../stacks/stack-container-manager';
import type { StackInfraResourceManager } from '../stacks/stack-infra-resource-manager';
import { attachEgressNetworkIfNeeded } from '../stacks/egress-injection';

export interface AttachServiceNetworksContext {
  networkManager: NetworkManager;
  containerManager: StackContainerManager;
  infraManager: StackInfraResourceManager;
  prisma: PrismaClient;
  /** Purpose → Docker network name, resolved from the stack's resourceOutputs/resourceInputs. */
  infraNetworkMap: Map<string, string>;
  environmentId: string | null | undefined;
  log: Logger;
}

/**
 * Attach a freshly-created (not yet started) service container to every
 * network it declares beyond the stack-owned networks it was already
 * attached to at creation time, in the order the container's own bootstrap
 * depends on: declared external networks (`joinNetworks`) -> infra-resource
 * networks (`joinResourceNetworks`) -> the environment's egress network.
 *
 * Stack-owned networks (mechanism 1 — the stack's `networks[]`, aliased with
 * the service name) are attached by `createContainer` /
 * `createLongRunningContainer` at container-creation time, before this
 * function runs — starting the container before every network is attached
 * would race the container's own bootstrap (e.g. a synchronous DNS lookup
 * against a network that hasn't been hot-attached yet). Callers are
 * responsible for creating the container beforehand and starting it
 * afterward; this only covers the middle "attach" phase of the
 * create -> attach -> start sequence.
 *
 * Alias policy: no alias by default here — these are all shared/external
 * networks (unlike the stack-owned networks aliased at create time).
 * `joinResourceNetworks` opts a service into an alias only when it declares
 * `egressBypass: true` (so `egress-gateway:3128` resolves regardless of
 * which container currently holds that role).
 *
 * Scope: used by the static-service (`Stateful`) create/recreate paths only
 * in this phase. Pools, the pool addon sidecar, and AdoptedWeb reimplement
 * this sequence today and are ported onto this same helper in a later
 * phase — see the module-level extension notes in `network-manager.ts`'s
 * design doc reference.
 */
export async function attachServiceNetworks(
  containerId: string,
  serviceName: string,
  serviceDef: StackServiceDefinition,
  ctx: AttachServiceNetworksContext,
): Promise<void> {
  for (const netName of serviceDef.containerConfig.joinNetworks ?? []) {
    if (!netName) continue;
    try {
      await ctx.networkManager.connect(containerId, netName);
      ctx.log.info({ service: serviceName, network: netName }, 'Joined external network');
    } catch (err) {
      ctx.log.warn(
        {
          service: serviceName,
          network: netName,
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to join external network',
      );
    }
  }

  await ctx.infraManager.joinResourceNetworks(containerId, serviceDef, ctx.infraNetworkMap, ctx.log);

  await attachEgressNetworkIfNeeded(
    ctx.prisma,
    ctx.containerManager,
    containerId,
    ctx.environmentId ?? null,
    serviceDef.containerConfig.egressBypass === true,
    ctx.log,
  );
}
