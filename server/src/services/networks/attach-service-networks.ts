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
  /**
   * Infra-resource purposes to join in addition to whatever
   * `serviceDef.containerConfig.joinResourceNetworks` declares.
   *
   * Exists for callers that derive an extra network requirement at
   * spawn/attach time rather than reading it off the authored template —
   * e.g. the pool spawner joins a freshly-spawned worker to the `vault`
   * network whenever Vault credential resolution actually produced env vars
   * for that instance (regardless of whether the template declared
   * `joinResourceNetworks: ['vault']`), and to `nats` when NATS credential
   * resolution did. Before this field existed that behaviour was an
   * implicit side effect buried inside the pool spawner's own connect loop;
   * it must now be listed here so the attachment is an explicit, documented
   * input to the shared pipeline instead. `infraNetworkMap` must already
   * contain an entry for every purpose named here (and in the service
   * definition) — this function only attaches, it doesn't resolve purposes
   * to network names.
   */
  extraResourcePurposes?: string[];
  /**
   * Literal Docker network names to join in addition to whatever
   * `serviceDef.containerConfig.joinNetworks` declares.
   *
   * Exists for callers whose extra network requirement is a concrete name
   * resolved from context rather than a template-declared purpose — e.g. the
   * AdoptedWeb attach path, which must join the environment's HAProxy
   * dataplane network regardless of whether the adopted service's
   * `joinNetworks` list happens to include it. Like
   * {@link AttachServiceNetworksContext.extraResourcePurposes}, this keeps
   * the requirement visible at the call site instead of a bespoke
   * pre-connect check.
   */
  extraJoinNetworks?: string[];
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
 * Scope: used by the static-service (`Stateful`/`StatelessWeb`) create/
 * recreate paths, the pool worker spawner, the pool addon sidecar spawner,
 * and the AdoptedWeb attach path (overhaul Phases 1–2) — the four
 * previously-separate copy-pasted attach pipelines now all resolve to this
 * one function.
 */
export async function attachServiceNetworks(
  containerId: string,
  serviceName: string,
  serviceDef: StackServiceDefinition,
  ctx: AttachServiceNetworksContext,
): Promise<void> {
  const joinNetworks = [
    ...new Set([...(serviceDef.containerConfig.joinNetworks ?? []), ...(ctx.extraJoinNetworks ?? [])]),
  ];
  for (const netName of joinNetworks) {
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

  const extraResourcePurposes = ctx.extraResourcePurposes ?? [];
  const effectiveServiceDef: StackServiceDefinition =
    extraResourcePurposes.length === 0
      ? serviceDef
      : {
          ...serviceDef,
          containerConfig: {
            ...serviceDef.containerConfig,
            joinResourceNetworks: [
              ...new Set([...(serviceDef.containerConfig.joinResourceNetworks ?? []), ...extraResourcePurposes]),
            ],
          },
        };

  await ctx.infraManager.joinResourceNetworks(containerId, effectiveServiceDef, ctx.infraNetworkMap, ctx.log);

  await attachEgressNetworkIfNeeded(
    ctx.prisma,
    ctx.containerManager,
    containerId,
    ctx.environmentId ?? null,
    serviceDef.containerConfig.egressBypass === true,
    ctx.log,
  );
}
