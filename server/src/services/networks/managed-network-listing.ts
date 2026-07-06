/**
 * Managed-network listing — network overhaul Phase 9 (visibility UI).
 *
 * Surfaces every `ManagedNetwork` row (optionally filtered by scope/owner)
 * with its resolved owner display name, live Docker existence/subnet, and a
 * full desired-vs-actual membership table — each membership's `source`/
 * `createdBy` (provenance), whether it's actually attached right now, and
 * which live container(s) satisfy it. This is the "why is this container on
 * this network" surface the networks tab, the environment detail networks
 * panel, and the application detail connected-networks list all read from.
 *
 * Two deliberate reuse choices, so this view can never disagree with the
 * Phase 7/8 reconciler about the facts that matter:
 *
 * - **Drift status** (`synced`/`drifted`) is computed by calling the Phase 7
 *   `reconcileStack`/`reconcileEnvironment`/`reconcileAll` and counting drift
 *   items per network — never re-derived here.
 * - **Per-membership "is it actually connected right now"** reuses that same
 *   module's target-resolution primitives (`resolveTargetContainers`,
 *   `newContainerCache`, `shortId`) rather than a second implementation of
 *   "resolve a membership target to live containers".
 */
import type { PrismaClient } from '../../generated/prisma/client';
import type {
  ManagedNetworkContainerRef,
  ManagedNetworkListQuery,
  ManagedNetworkMembershipStatus,
  ManagedNetworkMembershipView,
  ManagedNetworkView,
  NetworkMembershipSource,
} from '@mini-infra/types';
import { getOwnContainerId } from '../self-update';
import {
  asOptionsRecord,
  desiredLabelPurpose,
  newContainerCache,
  ownerFromManagedNetwork,
  reconcileAll,
  reconcileEnvironment,
  reconcileStack,
  resolveStackScopedNetworks,
  resolveTargetContainers,
  shortId,
  type ManagedNetworkRow,
  type NetworkReconcilerDeps,
} from './network-reconciler';

/** The full Prisma `NetworkMembership` row shape this module reads — wider than `network-reconciler.ts`'s own narrow `NetworkMembershipRow` (that module only ever needs `stackServiceId`/`containerName` for diffing; this listing also displays `source`/`createdBy`/`aliases`/`staticIp`). */
type FullMembershipRow = Awaited<ReturnType<PrismaClient['networkMembership']['findMany']>>[number];
/** The full Prisma `ManagedNetwork` row shape this module reads — wider than `network-reconciler.ts`'s own narrow `ManagedNetworkRow` (that module only ever needs the identity/label fields for diffing; this listing also displays `status`/`enforceMemberships`). */
type FullManagedNetworkRow = Awaited<ReturnType<PrismaClient['managedNetwork']['findMany']>>[number];

export type ManagedNetworkListingDeps = NetworkReconcilerDeps;

interface DriftScopedNetwork {
  id: string;
  scope: string;
  environmentId: string | null;
  stackId: string | null;
}

/**
 * Counts drift items per `ManagedNetwork.id`, scoped as cheaply as possible
 * for the networks actually in view: a single `stackId`/`environmentId`
 * filter reconciles just that one stack/environment; an unfiltered listing
 * reconciles every distinct stack/environment referenced by the networks in
 * view, falling back to a full `reconcileAll` sweep only when a host-scoped
 * network is present (host scope has no cheaper scoped entry point in the
 * Phase 7 reconciler).
 */
async function computeDriftCounts(
  networks: DriftScopedNetwork[],
  filter: ManagedNetworkListQuery,
  deps: ManagedNetworkListingDeps,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const addItems = (items: { managedNetworkId: string }[]) => {
    for (const item of items) counts.set(item.managedNetworkId, (counts.get(item.managedNetworkId) ?? 0) + 1);
  };

  try {
    if (filter.stackId) {
      const report = await reconcileStack(filter.stackId, deps);
      addItems(report.items);
      return counts;
    }
    if (filter.environmentId) {
      const report = await reconcileEnvironment(filter.environmentId, deps);
      addItems(report.items);
      return counts;
    }

    const hasHostNetworks = networks.some((n) => n.scope === 'host');
    if (hasHostNetworks) {
      // No scoped equivalent for host-scoped networks — one full sweep
      // covers them (and every stack/environment) in one pass.
      const report = await reconcileAll(deps);
      addItems(report.items);
      return counts;
    }

    const stackIds = [...new Set(networks.filter((n) => n.scope === 'stack').map((n) => n.stackId).filter((id): id is string => Boolean(id)))];
    const environmentIds = [...new Set(networks.filter((n) => n.scope === 'environment').map((n) => n.environmentId).filter((id): id is string => Boolean(id)))];

    for (const stackId of stackIds) {
      const report = await reconcileStack(stackId, deps);
      addItems(report.items);
    }
    for (const environmentId of environmentIds) {
      const report = await reconcileEnvironment(environmentId, deps);
      addItems(report.items);
    }
  } catch (err) {
    deps.log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to compute drift counts for managed-network listing (defaulting every network to synced)',
    );
  }

  return counts;
}

/** Prisma's `ManagedNetwork.aliases`-shaped Json field, narrowed to `string[]` for display — mirrors how every other Phase 6+ reader treats this column. */
function asAliasesArray(json: unknown): string[] | undefined {
  return Array.isArray(json) ? (json as string[]) : undefined;
}

export async function listManagedNetworks(
  deps: ManagedNetworkListingDeps,
  filter: ManagedNetworkListQuery = {},
): Promise<ManagedNetworkView[]> {
  const { prisma, networkManager, dockerExecutor, log } = deps;

  let networks: FullManagedNetworkRow[];
  if (filter.stackId) {
    // A stack's "connected networks" is more than `ManagedNetwork.stackId
    // = X` — that column only ever identifies networks the stack OWNS
    // (`scope: 'stack'`); shared networks it merely joins (egress,
    // applications, resource inputs, ...) have `stackId: null` and are only
    // discoverable via its services'/adopted containers' membership rows.
    // Reuses `resolveStackScopedNetworks` — the exact same owned-or-joined
    // resolution `reconcileStack` diffs against — so an application's
    // connected-networks list can never disagree with its own stack's drift
    // report about which networks are "its own". That helper returns the
    // reconciler's own intentionally-narrow `ManagedNetworkRow` shape, so
    // the ids are re-fetched here for the full row (status/enforceMemberships/
    // timestamps) this listing displays.
    const resolved = await resolveStackScopedNetworks(filter.stackId, prisma);
    const ids = resolved.networksToCheck.map((n) => n.id);
    networks = ids.length > 0
      ? await prisma.managedNetwork.findMany({ where: { id: { in: ids } }, orderBy: [{ scope: 'asc' }, { name: 'asc' }] })
      : [];
  } else {
    const where: Record<string, unknown> = {};
    if (filter.scope) where.scope = filter.scope;
    if (filter.environmentId) where.environmentId = filter.environmentId;
    networks = await prisma.managedNetwork.findMany({ where, orderBy: [{ scope: 'asc' }, { name: 'asc' }] });
  }
  if (networks.length === 0) return [];

  const networkIds = networks.map((n) => n.id);
  const memberships = await prisma.networkMembership.findMany({ where: { networkId: { in: networkIds } } });

  const serviceIds = [...new Set(memberships.map((m) => m.stackServiceId).filter((id): id is string => Boolean(id)))];
  const services = serviceIds.length > 0
    ? await prisma.stackService.findMany({
        where: { id: { in: serviceIds } },
        select: { id: true, stackId: true, serviceName: true, stack: { select: { name: true } } },
      })
    : [];
  const serviceById = new Map(services.map((s) => [s.id, { stackId: s.stackId, serviceName: s.serviceName }]));
  const serviceDisplayById = new Map(
    services.map((s) => [s.id, { stackId: s.stackId, serviceName: s.serviceName, stackName: s.stack?.name as string | undefined }]),
  );

  const createdByIds = [...new Set(memberships.map((m) => m.createdBy).filter((id): id is string => Boolean(id)))];
  const users = createdByIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: createdByIds } }, select: { id: true, name: true, email: true } })
    : [];
  const userNameById = new Map(users.map((u) => [u.id, u.name ?? u.email]));

  const environmentIds = [...new Set(networks.map((n) => n.environmentId).filter((id): id is string => Boolean(id)))];
  const environments = environmentIds.length > 0
    ? await prisma.environment.findMany({ where: { id: { in: environmentIds } }, select: { id: true, name: true } })
    : [];
  const environmentNameById = new Map(environments.map((e) => [e.id, e.name]));

  const networkOwnerStackIds = networks.map((n) => n.stackId).filter((id): id is string => Boolean(id));
  const membershipStackIds = services.map((s) => s.stackId);
  const stackIds = [...new Set([...networkOwnerStackIds, ...membershipStackIds])];
  const stacks = stackIds.length > 0
    ? await prisma.stack.findMany({ where: { id: { in: stackIds } }, select: { id: true, name: true } })
    : [];
  const stackNameById = new Map(stacks.map((s) => [s.id, s.name]));

  const driftCountByNetworkId = await computeDriftCounts(networks, filter, deps);

  const membershipsByNetworkId = new Map<string, FullMembershipRow[]>();
  for (const m of memberships) {
    const list = membershipsByNetworkId.get(m.networkId) ?? [];
    list.push(m);
    membershipsByNetworkId.set(m.networkId, list);
  }

  const docker = dockerExecutor.getDockerClient();
  const cache = newContainerCache();
  const selfContainerId = getOwnContainerId();

  const views: ManagedNetworkView[] = [];
  for (const net of networks) {
    const row: ManagedNetworkRow = {
      id: net.id,
      scope: net.scope,
      environmentId: net.environmentId,
      stackId: net.stackId,
      purpose: net.purpose,
      name: net.name,
      driver: net.driver,
      options: net.options,
    };
    const owner = ownerFromManagedNetwork(row);

    let existence: 'present' | 'absent' | 'unknown' = 'unknown';
    let dockerId: string | undefined;
    let subnet: string | undefined;
    let connectedContainers: ManagedNetworkContainerRef[] = [];
    try {
      const inspectResult = await networkManager.inspectForReconcile(net.name, {
        owner,
        purpose: desiredLabelPurpose(row),
        driver: net.driver,
        options: asOptionsRecord(net.options) ?? undefined,
      });
      existence = inspectResult.existence;
      dockerId = inspectResult.dockerId;
      subnet = inspectResult.subnet;
      connectedContainers = inspectResult.connectedContainers ?? [];
    } catch (err) {
      log.warn(
        { network: net.name, error: err instanceof Error ? err.message : String(err) },
        'Failed to inspect network for managed-network listing',
      );
    }

    const connectedIds = new Set(connectedContainers.map((c) => shortId(c.id)));
    const matchedConnectedIds = new Set<string>();

    const membershipRows = membershipsByNetworkId.get(net.id) ?? [];
    const membershipViews: ManagedNetworkMembershipView[] = [];
    for (const m of membershipRows) {
      const resolved = existence === 'present'
        ? await resolveTargetContainers(
            { stackServiceId: m.stackServiceId, containerName: m.containerName },
            docker,
            cache,
            serviceById,
            selfContainerId,
          )
        : [];
      const attached = resolved.filter((c) => connectedIds.has(shortId(c.id)));
      for (const c of attached) matchedConnectedIds.add(shortId(c.id));

      const status: ManagedNetworkMembershipStatus =
        resolved.length === 0 ? 'not-deployed' : attached.length === resolved.length ? 'connected' : 'missing';

      const svcDisplay = m.stackServiceId ? serviceDisplayById.get(m.stackServiceId) : undefined;
      membershipViews.push({
        id: m.id,
        stackServiceId: m.stackServiceId ?? undefined,
        stackId: svcDisplay?.stackId,
        serviceName: svcDisplay?.serviceName,
        stackName: svcDisplay?.stackName,
        containerName: m.containerName ?? undefined,
        source: m.source as NetworkMembershipSource,
        createdBy: m.createdBy ?? undefined,
        createdByName: m.createdBy ? userNameById.get(m.createdBy) ?? undefined : undefined,
        aliases: asAliasesArray(m.aliases),
        staticIp: m.staticIp ?? undefined,
        status,
        // `resolveTargetContainers` returns the container's full label set
        // too (`ContainerSummary`) — narrow to `{id, name}` before this
        // crosses the API boundary rather than leaking container labels
        // (which can carry other subsystems' bookkeeping) into the response.
        connectedContainers: attached.map((c) => ({ id: c.id, name: c.name })),
      });
    }

    const unattributedContainers = connectedContainers.filter((c) => !matchedConnectedIds.has(shortId(c.id)));

    const driftItemCount = driftCountByNetworkId.get(net.id) ?? 0;

    views.push({
      id: net.id,
      name: net.name,
      scope: net.scope as 'host' | 'environment' | 'stack',
      environmentId: net.environmentId ?? undefined,
      environmentName: net.environmentId ? environmentNameById.get(net.environmentId) : undefined,
      stackId: net.stackId ?? undefined,
      stackName: net.stackId ? stackNameById.get(net.stackId) : undefined,
      purpose: net.purpose,
      driver: net.driver,
      dbStatus: net.status,
      existence,
      dockerId,
      subnet,
      enforceMemberships: net.enforceMemberships,
      driftStatus: driftItemCount > 0 ? 'drifted' : 'synced',
      driftItemCount,
      memberships: membershipViews,
      unattributedContainers,
    });
  }

  return views;
}
