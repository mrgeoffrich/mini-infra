/**
 * NetworkReconciler — network overhaul Phase 7, dry-run diff.
 *
 * Compares the desired-state rows Phase 6 producers write (`ManagedNetwork` +
 * `NetworkMembership`) against live Docker state (one `listContainers` per
 * reconciled stack plus a handful of targeted lookups, and one
 * `NetworkManager.inspectForReconcile()` per referenced network) and produces
 * a list of typed drift items. **Report-only**: nothing here calls
 * `ensure()`/`connect()`/`disconnect()`/`remove()` — every Docker call is a
 * read (`inspectForReconcile`, `listContainers`). Enforcement is Phase 8.
 *
 * See `docs/planning/not-shipped/docker-network-overhaul-plan.md` §6 Phase 7
 * and `docs/designs/docker-network-management-redesign.md` §3.2/§3.3.
 *
 * ## The conservative `membership-stale` rule
 *
 * A live container endpoint on a `mini-infra.managed=true` network with no
 * matching `NetworkMembership` row is only ever reported as `membership-stale`
 * when **all** of the following hold:
 *
 * 1. The network is **owned by the stack being reconciled**
 *    (`ManagedNetwork.scope === 'stack' && stackId === <this stack>`).
 *    `compileStackNetworkMemberships` (`membership-compiler.ts` §3a) writes a
 *    membership row for *every* non-host-mode `StackService` onto its own
 *    stack's owned networks, unconditionally — this is the one category
 *    Phase 6 achieves complete coverage for. Environment/host-scoped shared
 *    networks (egress, applications/dataplane, vault, nats, ...) are **never**
 *    stale-checked, at any reconcile scope: many different stacks and
 *    producers attach to those, and a single reconcile pass only ever loads
 *    its own subset of the desired rows for a shared network — treating "I
 *    don't have a row for this" as "stale" there would misreport other
 *    stacks'/producers' legitimate attachments as this stack's drift.
 * 2. The connected container can be **positively identified as this stack's
 *    own** — i.e. it appears in the one `listContainers` call scoped to
 *    `mini-infra.stack-id=<this stack>` (so we have its real labels, not just
 *    the id/name Docker's network-inspect payload carries). An endpoint that
 *    doesn't even carry this stack's own label is surfaced as a
 *    low-confidence `NetworkUnmanagedAttachmentNote` instead — informational
 *    only, never a drift item, and never an input to a future Phase 8
 *    disconnect.
 * 3. The container is **not synthetic**
 *    (`mini-infra.synthetic !== 'true'`) — addon-generated sidecars (both the
 *    static-service addon render pipeline and `pool-addon-sidecar.ts`) carry
 *    this label and are never compiled by `buildMembershipServiceInputs()`
 *    (no backing `StackService` row), by design. They are excluded
 *    unconditionally, not even as a note — this is an expected, permanent
 *    omission, not drift.
 *
 * This rule is, by construction, exactly narrow enough to never false-flag
 * the three known Phase 6 coverage gaps called out in the phase brief:
 *
 * - **Gap 1 — addon sidecars / pool-addon sidecars.** Excluded by rule 3
 *   regardless of which network they're on.
 * - **Gap 2 — AdoptedWeb's dynamically-computed HAProxy dataplane join**
 *   (`extraJoinNetworks` in `applyAdoptedWeb`, never compiled). The dataplane
 *   network is environment-scoped, never stack-owned — excluded by rule 1.
 * - **Gap 3 — `environment-manager.ts`'s two uninstrumented `connect()` calls**
 *   (the mini-infra-server self-join and the gateway static-IP reassignment).
 *   Both target the environment's egress network — environment-scoped, never
 *   stack-owned — excluded by rule 1.
 *
 * `network-missing`/`membership-missing`/`spec-mismatch` are not subject to
 * this restriction: they only ever assert something about rows *this stack's
 * own* producers wrote (a network it owns or joined, a membership whose
 * target is one of its own services/adopted containers), so there is no
 * cross-stack/cross-producer leakage risk — a stale check would need to
 * enumerate *every* attacher to be safe; a missing/mismatch check only needs
 * to know about the caller's own declared attachments.
 */
import type Docker from 'dockerode';
import type { Logger } from 'pino';
import type { PrismaClient } from '../../generated/prisma/client';
import type {
  AdoptedContainerRef,
  NetworkDriftItem,
  NetworkDriftTarget,
  NetworkReconcileReport,
  NetworkSpecMismatch,
  NetworkUnmanagedAttachmentNote,
} from '@mini-infra/types';
import type { DockerExecutorService } from '../docker-executor';
import { getOwnContainerId } from '../self-update';
import type { NetworkManager, NetworkOwner } from './network-manager';

const SYNTHETIC_LABEL = 'mini-infra.synthetic';
const SERVICE_LABEL = 'mini-infra.service';
const STACK_ID_LABEL = 'mini-infra.stack-id';
const SELF_SENTINEL = 'self';

/** Minimal row shape this module reads from `ManagedNetwork` — kept narrow so tests can build fixtures without every Prisma field. */
export interface ManagedNetworkRow {
  id: string;
  scope: string;
  environmentId: string | null;
  stackId: string | null;
  purpose: string;
  name: string;
  driver: string;
  options: unknown;
}

/** Minimal row shape this module reads from `NetworkMembership`. */
export interface NetworkMembershipRow {
  id: string;
  networkId: string;
  stackServiceId: string | null;
  containerName: string | null;
}

interface ContainerSummary {
  id: string;
  name: string;
  labels: Record<string, string>;
}

function toContainerSummary(raw: Docker.ContainerInfo): ContainerSummary {
  return {
    id: raw.Id,
    name: raw.Names?.[0]?.replace(/^\//, '') ?? raw.Id,
    labels: raw.Labels ?? {},
  };
}

function isSynthetic(labels: Record<string, string>): boolean {
  return labels[SYNTHETIC_LABEL] === 'true';
}

function ownerFromManagedNetwork(net: ManagedNetworkRow): NetworkOwner {
  if (net.scope === 'stack') return { kind: 'stack', id: net.stackId ?? undefined };
  if (net.scope === 'environment') return { kind: 'environment', id: net.environmentId ?? undefined };
  return { kind: 'host' };
}

function asOptionsRecord(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  return json as Record<string, unknown>;
}

/**
 * The Docker label purpose to compare against for a `ManagedNetwork` row.
 * For scope='stack' rows, `ManagedNetworkRow.purpose` is the *DB* identity —
 * the stack's own network name (e.g. `"appnet"`), used to disambiguate
 * multiple declared networks within one stack (§5's
 * `@@unique([scope, environmentId, stackId, purpose])`). It is **not** what
 * gets stamped on Docker: `StackReconciler.ensureStackNetworks()` always
 * passes the literal `purpose: '_stack'` for every stack-owned network,
 * regardless of the network's own name (matching `ownerLabels()`'s own
 * `purpose ?? '_stack'` default — see design doc §4: "`_stack` for
 * stack-owned networks"). Passing `net.purpose` straight through here would
 * make a spec-mismatch fire on *every* stack that declares a non-default
 * network name — a false positive found live in dev while verifying this
 * phase, not a real drift signal.
 */
function desiredLabelPurpose(net: ManagedNetworkRow): string | undefined {
  return net.scope === 'stack' ? undefined : net.purpose;
}

/**
 * Narrows a `NetworkManager.inspectForReconcile()` mismatch down to the
 * `spec-mismatch` drift item's actual contract: **driver/options only** (see
 * the Phase 7 deliverable list and design doc §3.2, both of which describe
 * spec mismatch as "driver/options differ" — labels are deliberately not
 * part of it). Label-only differences are real but expected and permanent
 * for any network created before Phase 1 stamped the modern `mini-infra.*`
 * labels (design doc §4/§7: label immutability means such networks are
 * "back-labelled" only on next create, never in place) — reporting every one
 * of those as visible "Drifted" plan-item noise would make Phase 7 actively
 * unhelpful on any host with pre-Phase-1 networks, which was also verified
 * live in dev (the environment's egress network, created before the
 * NetworkManager labelling convention existed, has none of the modern
 * `mini-infra.owner-kind`/`mini-infra.purpose` labels and would otherwise
 * report a permanent, unfixable-by-the-operator "mismatch" forever).
 */
function driftRelevantMismatch(mismatch: NetworkSpecMismatch | undefined): NetworkSpecMismatch | undefined {
  if (!mismatch) return undefined;
  if (!mismatch.driver && !mismatch.options) return undefined;
  return { driver: mismatch.driver, options: mismatch.options };
}

/** Per-run cache so repeated lookups for the same stack-service/container name don't re-hit Docker. */
interface ContainerCache {
  byStackService: Map<string, ContainerSummary[]>; // key: `${stackId}:${serviceName}`
  byName: Map<string, ContainerSummary[]>;
}

function newContainerCache(): ContainerCache {
  return { byStackService: new Map(), byName: new Map() };
}

/** Seed the cache with containers already fetched for a specific stack (avoids a redundant listContainers call for the common case — the stack being reconciled is almost always the same stack every membership target belongs to). */
function seedStackContainers(cache: ContainerCache, stackId: string, rawContainers: Docker.ContainerInfo[]): void {
  const byService = new Map<string, ContainerSummary[]>();
  for (const raw of rawContainers) {
    if (isSynthetic(raw.Labels ?? {})) continue;
    const serviceName = raw.Labels?.[SERVICE_LABEL];
    if (!serviceName) continue;
    const list = byService.get(serviceName) ?? [];
    list.push(toContainerSummary(raw));
    byService.set(serviceName, list);
  }
  for (const [serviceName, list] of byService) {
    cache.byStackService.set(`${stackId}:${serviceName}`, list);
  }
}

async function resolveStackServiceContainers(
  docker: Docker,
  cache: ContainerCache,
  stackId: string,
  serviceName: string,
): Promise<ContainerSummary[]> {
  const key = `${stackId}:${serviceName}`;
  const cached = cache.byStackService.get(key);
  if (cached) return cached;

  const raw = await docker.listContainers({
    all: true,
    filters: { label: [`${STACK_ID_LABEL}=${stackId}`, `${SERVICE_LABEL}=${serviceName}`] },
  });
  const summaries = raw.filter((c) => !isSynthetic(c.Labels ?? {})).map(toContainerSummary);
  cache.byStackService.set(key, summaries);
  return summaries;
}

async function resolveByName(docker: Docker, cache: ContainerCache, containerName: string): Promise<ContainerSummary[]> {
  const cached = cache.byName.get(containerName);
  if (cached) return cached;

  const raw = await docker.listContainers({ all: true, filters: { name: [containerName] } });
  const exact = raw.filter((c) => c.Names?.some((n) => n.replace(/^\//, '') === containerName));
  const summaries = exact.map(toContainerSummary);
  cache.byName.set(containerName, summaries);
  return summaries;
}

/** Resolves a `{stackServiceId?, containerName?}` membership target to live container(s) — the "match by label at reconcile time" step the design doc calls for (§3.1). Blue-green pairs and every pool worker for a Pool/JobPool service resolve here naturally: they all carry the same `mini-infra.stack-id`/`mini-infra.service` labels, so a `stackServiceId` row matches however many live containers currently carry them. */
async function resolveTargetContainers(
  target: { stackServiceId?: string | null; containerName?: string | null },
  docker: Docker,
  cache: ContainerCache,
  serviceById: Map<string, { stackId: string; serviceName: string }>,
  selfContainerId: string | null,
): Promise<ContainerSummary[]> {
  if (target.containerName) {
    if (target.containerName === SELF_SENTINEL) {
      return selfContainerId ? [{ id: selfContainerId, name: SELF_SENTINEL, labels: {} }] : [];
    }
    return resolveByName(docker, cache, target.containerName);
  }

  if (target.stackServiceId) {
    const svc = serviceById.get(target.stackServiceId);
    if (!svc) return []; // dangling reference (service deleted) — nothing live to check.
    return resolveStackServiceContainers(docker, cache, svc.stackId, svc.serviceName);
  }

  return [];
}

function buildTarget(
  m: NetworkMembershipRow,
  serviceById: Map<string, { stackId: string; serviceName: string }>,
): NetworkDriftTarget {
  return {
    stackServiceId: m.stackServiceId ?? undefined,
    serviceName: m.stackServiceId ? serviceById.get(m.stackServiceId)?.serviceName : undefined,
    containerName: m.containerName ?? undefined,
  };
}

export interface NetworkReconcilerDeps {
  prisma: PrismaClient;
  networkManager: NetworkManager;
  dockerExecutor: Pick<DockerExecutorService, 'getDockerClient'>;
  log: Logger;
}

interface DiffNetworksOptions {
  /** Networks eligible for the `membership-stale` check (must be owned by the stack whose containers were seeded into `primaryStackContainersById` — see module doc rule 1). Empty for environment/host-scope reconciles, which never stale-check. */
  staleEligibleNetworkIds: Set<string>;
  /** The one stack whose full container list is known — used to positively identify "this stack's own" containers for the stale check (rule 2). Omitted when there's no single owning stack in scope (environment/host reconciles). */
  primaryStackContainersById?: Map<string, ContainerSummary>;
  /** Pre-seeded cache, when the caller already fetched the primary stack's containers (avoids a redundant `listContainers` call per service). A fresh cache is created when omitted. */
  seededCache?: ContainerCache;
}

/**
 * Core diff loop shared by every reconcile entry point: given the set of
 * `ManagedNetwork` rows to check and the `NetworkMembership` rows relevant to
 * each, inspects live Docker state and produces drift items + notes. Never
 * mutates anything.
 */
async function diffNetworks(
  networks: ManagedNetworkRow[],
  membershipsByNetworkId: Map<string, NetworkMembershipRow[]>,
  serviceById: Map<string, { stackId: string; serviceName: string }>,
  deps: NetworkReconcilerDeps,
  options: DiffNetworksOptions,
): Promise<{ items: NetworkDriftItem[]; notes: NetworkUnmanagedAttachmentNote[]; membershipsChecked: number }> {
  const { networkManager, dockerExecutor, log } = deps;
  const docker = dockerExecutor.getDockerClient();
  const cache = options.seededCache ?? newContainerCache();
  const selfContainerId = getOwnContainerId();

  const items: NetworkDriftItem[] = [];
  const notes: NetworkUnmanagedAttachmentNote[] = [];
  let membershipsChecked = 0;

  for (const net of networks) {
    const scope = net.scope as 'host' | 'environment' | 'stack';
    const owner = ownerFromManagedNetwork(net);
    const inspectResult = await networkManager.inspectForReconcile(net.name, {
      owner,
      purpose: desiredLabelPurpose(net),
      driver: net.driver,
      options: asOptionsRecord(net.options),
    });

    if (inspectResult.existence === 'unknown') {
      log.warn({ network: net.name }, 'Skipping network reconcile — Docker could not confirm existence');
      continue;
    }

    if (inspectResult.existence === 'absent') {
      items.push({
        type: 'network-missing',
        networkName: net.name,
        purpose: net.purpose,
        scope,
        managedNetworkId: net.id,
        message: `Managed network "${net.name}" (${net.purpose}) does not exist in Docker`,
      });
      continue; // nothing meaningful to say about membership on a network that isn't there.
    }

    const mismatch = driftRelevantMismatch(inspectResult.mismatch);
    if (mismatch) {
      items.push({
        type: 'spec-mismatch',
        networkName: net.name,
        purpose: net.purpose,
        scope,
        managedNetworkId: net.id,
        mismatch,
        message: `Network "${net.name}" exists but its driver/options no longer match the desired spec`,
      });
    }

    const connected = inspectResult.connectedContainers ?? [];
    const connectedIds = new Set(connected.map((c) => c.id));
    const expectedIds = new Set<string>();

    const memberships = membershipsByNetworkId.get(net.id) ?? [];
    for (const m of memberships) {
      membershipsChecked++;
      const resolved = await resolveTargetContainers(
        { stackServiceId: m.stackServiceId, containerName: m.containerName },
        docker,
        cache,
        serviceById,
        selfContainerId,
      );
      if (resolved.length === 0) continue; // service not deployed yet — the existing container-level plan already covers that gap.

      for (const c of resolved) expectedIds.add(c.id);
      const missing = resolved.filter((c) => !connectedIds.has(c.id));
      if (missing.length > 0) {
        items.push({
          type: 'membership-missing',
          networkName: net.name,
          purpose: net.purpose,
          scope,
          managedNetworkId: net.id,
          target: buildTarget(m, serviceById),
          containers: missing.map((c) => ({ id: c.id, name: c.name })),
          message: `${missing.length} container(s) that should be attached to "${net.name}" are not`,
        });
      }
    }

    // Conservative `membership-stale` check — restricted to stack-owned
    // networks belonging to the one stack whose containers we positively
    // know (see module doc). Every other unexplained attachment becomes a
    // low-confidence note instead, never a drift item.
    const staleEligible = options.staleEligibleNetworkIds.has(net.id);
    for (const c of connected) {
      if (expectedIds.has(c.id)) continue;

      const known = options.primaryStackContainersById?.get(c.id);
      if (known && isSynthetic(known.labels)) continue; // Gap 1 — addon/pool-addon sidecars: never flagged, not even a note.

      if (staleEligible && known) {
        items.push({
          type: 'membership-stale',
          networkName: net.name,
          purpose: net.purpose,
          scope,
          managedNetworkId: net.id,
          containers: [{ id: c.id, name: c.name }],
          message: `Container "${c.name}" is attached to "${net.name}" but has no matching desired-state membership`,
        });
      } else {
        notes.push({
          networkName: net.name,
          containerId: c.id,
          containerName: c.name,
          reason: staleEligible
            ? 'Container is attached to a stack-owned network but does not carry this stack\'s own labels; reported for visibility only, never treated as drift.'
            : 'Network is environment/host-scoped (shared) — unattributed attachments are never treated as drift on a shared network; reported for visibility only.',
        });
      }
    }
  }

  return { items, notes, membershipsChecked };
}

/**
 * Reconcile one stack's network desired state against live Docker state.
 * This is the entry point the stack plan computer calls (see
 * `stack-plan-computer.ts`) — it is scoped to exactly the networks this
 * stack owns or has declared a membership on, so drift items only ever
 * describe this stack's own state (see module doc for the cross-stack
 * leakage this deliberately avoids on shared networks).
 */
export async function reconcileStack(stackId: string, deps: NetworkReconcilerDeps): Promise<NetworkReconcileReport> {
  const { prisma, dockerExecutor } = deps;
  const ranAt = new Date().toISOString();

  const stack = await prisma.stack.findUniqueOrThrow({
    where: { id: stackId },
    select: {
      id: true,
      services: { select: { id: true, serviceName: true, serviceType: true, adoptedContainer: true } },
    },
  });

  const serviceIds = stack.services.map((s) => s.id);
  const adoptedContainerNames = stack.services
    .filter((s) => s.serviceType === 'AdoptedWeb')
    .map((s) => (s.adoptedContainer as unknown as AdoptedContainerRef | null)?.containerName)
    .filter((n): n is string => Boolean(n));

  const ownedNetworks = await prisma.managedNetwork.findMany({ where: { scope: 'stack', stackId } });
  const ownedNetworkIds = new Set(ownedNetworks.map((n) => n.id));

  const ownServiceMemberships = serviceIds.length > 0
    ? await prisma.networkMembership.findMany({ where: { stackServiceId: { in: serviceIds } } })
    : [];
  const ownContainerMemberships = adoptedContainerNames.length > 0
    ? await prisma.networkMembership.findMany({ where: { containerName: { in: adoptedContainerNames } } })
    : [];

  const joinedNetworkIds = new Set(
    [...ownServiceMemberships, ...ownContainerMemberships]
      .map((m) => m.networkId)
      .filter((id) => !ownedNetworkIds.has(id)),
  );
  const joinedNetworks = joinedNetworkIds.size > 0
    ? await prisma.managedNetwork.findMany({ where: { id: { in: [...joinedNetworkIds] } } })
    : [];

  const networksToCheck = [...ownedNetworks, ...joinedNetworks];
  if (networksToCheck.length === 0) {
    return { scope: { kind: 'stack', stackId }, ranAt, networksChecked: 0, membershipsChecked: 0, items: [], notes: [] };
  }

  // Every desired membership on this stack's OWNED networks — not just the
  // ones this stack's own services declared — so a row another producer
  // wrote against this same stack-owned network (e.g. a `containerName:
  // 'self'` monitoring self-join onto the monitoring stack's own network) is
  // still checked. Safe because a stack-owned network is private by
  // construction (see module doc rule 1).
  const ownedNetworkMemberships = ownedNetworkIds.size > 0
    ? await prisma.networkMembership.findMany({ where: { networkId: { in: [...ownedNetworkIds] } } })
    : [];

  const membershipsByNetworkId = new Map<string, NetworkMembershipRow[]>();
  for (const m of [...ownedNetworkMemberships, ...ownServiceMemberships, ...ownContainerMemberships]) {
    const list = membershipsByNetworkId.get(m.networkId) ?? [];
    if (!list.some((existing) => existing.id === m.id)) list.push(m);
    membershipsByNetworkId.set(m.networkId, list);
  }

  const referencedServiceIds = [
    ...new Set(
      [...membershipsByNetworkId.values()].flat().map((m) => m.stackServiceId).filter((id): id is string => Boolean(id)),
    ),
  ];
  const resolvedServices = referencedServiceIds.length > 0
    ? await prisma.stackService.findMany({
        where: { id: { in: referencedServiceIds } },
        select: { id: true, stackId: true, serviceName: true },
      })
    : [];
  const serviceById = new Map(resolvedServices.map((s) => [s.id, { stackId: s.stackId, serviceName: s.serviceName }]));

  const docker = dockerExecutor.getDockerClient();
  const rawStackContainers = await docker.listContainers({
    all: true,
    filters: { label: [`${STACK_ID_LABEL}=${stackId}`] },
  });
  const seededCache = newContainerCache();
  seedStackContainers(seededCache, stackId, rawStackContainers);
  const primaryStackContainersById = new Map(rawStackContainers.map((raw) => [raw.Id, toContainerSummary(raw)]));

  const { items, notes, membershipsChecked } = await diffNetworks(
    networksToCheck,
    membershipsByNetworkId,
    serviceById,
    deps,
    { staleEligibleNetworkIds: ownedNetworkIds, primaryStackContainersById, seededCache },
  );

  return {
    scope: { kind: 'stack', stackId },
    ranAt,
    networksChecked: networksToCheck.length,
    membershipsChecked,
    items,
    notes,
  };
}

/**
 * Reconcile every `ManagedNetwork` owned by one environment. Never
 * stale-checks (environment-scoped networks are always excluded by rule 1 —
 * see module doc); unexplained attachments are reported as notes only.
 */
export async function reconcileEnvironment(environmentId: string, deps: NetworkReconcilerDeps): Promise<NetworkReconcileReport> {
  const { prisma } = deps;
  const ranAt = new Date().toISOString();

  const networks = await prisma.managedNetwork.findMany({ where: { scope: 'environment', environmentId } });
  if (networks.length === 0) {
    return { scope: { kind: 'environment', environmentId }, ranAt, networksChecked: 0, membershipsChecked: 0, items: [], notes: [] };
  }

  const networkIds = networks.map((n) => n.id);
  const memberships = await prisma.networkMembership.findMany({ where: { networkId: { in: networkIds } } });
  const membershipsByNetworkId = new Map<string, NetworkMembershipRow[]>();
  for (const m of memberships) {
    const list = membershipsByNetworkId.get(m.networkId) ?? [];
    list.push(m);
    membershipsByNetworkId.set(m.networkId, list);
  }

  const referencedServiceIds = [...new Set(memberships.map((m) => m.stackServiceId).filter((id): id is string => Boolean(id)))];
  const resolvedServices = referencedServiceIds.length > 0
    ? await prisma.stackService.findMany({
        where: { id: { in: referencedServiceIds } },
        select: { id: true, stackId: true, serviceName: true },
      })
    : [];
  const serviceById = new Map(resolvedServices.map((s) => [s.id, { stackId: s.stackId, serviceName: s.serviceName }]));

  const { items, notes, membershipsChecked } = await diffNetworks(
    networks,
    membershipsByNetworkId,
    serviceById,
    deps,
    { staleEligibleNetworkIds: new Set() }, // environment scope: never stale-eligible (rule 1).
  );

  return { scope: { kind: 'environment', environmentId }, ranAt, networksChecked: networks.length, membershipsChecked, items, notes };
}

/**
 * Reconcile every non-removed stack plus every environment — the `scope:
 * 'all'` admin sweep. Runs `reconcileStack` per stack (each call is
 * independently scoped and stale-checked per rule 1) and one
 * `reconcileEnvironment` pass per environment, merging the results. Host-scope
 * `ManagedNetwork` rows (vault/nats/dataplane-at-host-scope, etc.) are checked
 * for existence/mismatch only — no stack or environment owns them, so there is
 * no membership set to diff and no stale-eligible owner either.
 */
export async function reconcileAll(deps: NetworkReconcilerDeps): Promise<NetworkReconcileReport> {
  const { prisma } = deps;
  const ranAt = new Date().toISOString();

  const [stacks, environments, hostNetworks] = await Promise.all([
    prisma.stack.findMany({ where: { removedAt: null }, select: { id: true } }),
    prisma.environment.findMany({ select: { id: true } }),
    prisma.managedNetwork.findMany({ where: { scope: 'host' } }),
  ]);

  const items: NetworkDriftItem[] = [];
  const notes: NetworkUnmanagedAttachmentNote[] = [];
  let networksChecked = 0;
  let membershipsChecked = 0;

  for (const stack of stacks) {
    const report = await reconcileStack(stack.id, deps);
    items.push(...report.items);
    notes.push(...report.notes);
    networksChecked += report.networksChecked;
    membershipsChecked += report.membershipsChecked;
  }

  for (const env of environments) {
    const report = await reconcileEnvironment(env.id, deps);
    items.push(...report.items);
    notes.push(...report.notes);
    networksChecked += report.networksChecked;
    membershipsChecked += report.membershipsChecked;
  }

  if (hostNetworks.length > 0) {
    const { items: hostItems, notes: hostNotes } = await diffNetworks(
      hostNetworks,
      new Map(),
      new Map(),
      deps,
      { staleEligibleNetworkIds: new Set() },
    );
    items.push(...hostItems);
    notes.push(...hostNotes);
    networksChecked += hostNetworks.length;
  }

  return { scope: { kind: 'all' }, ranAt, networksChecked, membershipsChecked, items, notes };
}
