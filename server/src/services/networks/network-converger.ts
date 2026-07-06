/**
 * NetworkConverger — network overhaul Phase 8, the reconciler's "act" half.
 *
 * Phase 7's `network-reconciler.ts` only ever *reports* drift (three read
 * calls: `inspectForReconcile`, `listContainers`, and the DB). This module
 * takes that same report and acts on it — the deliverable the plan calls
 * `NetworkReconciler.converge(scope?)` / `converge(containerId)`. Rather than
 * duplicating the diff logic, every `converge*` function here runs the
 * matching Phase 7 `reconcile*` function first and then walks its
 * `NetworkDriftItem[]`, so the two can never disagree about what's missing —
 * only about whether to act on it.
 *
 * ## The safety model (see the phase brief / design doc §3.5)
 *
 * - **Connect-only by default, always on.** `network-missing` → `ensure()`;
 *   `membership-missing` → `connect()` for every listed container. Always
 *   performed, on every convergence call, regardless of any flag — this is
 *   what makes convergence "self-healing membership" rather than an opt-in
 *   feature.
 * - **Disconnects are gated behind `ManagedNetwork.enforceMemberships`,
 *   default false.** A `membership-stale` item is only acted on
 *   (`disconnect()`) when the OWNING network's row has the flag set; every
 *   other network's stale items are counted in `skippedDisconnects` and left
 *   exactly alone. Since Phase 7's own diff already restricts
 *   `membership-stale` to positively-identified, non-synthetic containers on
 *   a network the current stack owns (see that module's doc comment, rules
 *   1–3), turning the flag on for one network can never affect another, and
 *   the three known Phase 6 coverage gaps (addon/pool-addon sidecars,
 *   AdoptedWeb's dynamic HAProxy join, environment-manager's two
 *   uninstrumented self/gateway-IP connects) never even reach this module as
 *   `membership-stale` items in the first place — they're either excluded
 *   outright (synthetic) or never stale-eligible (shared environment/host
 *   networks) by Phase 7's own rules, unchanged here.
 * - **`spec-mismatch` is never acted on** — matches `NetworkManager.ensure()`'s
 *   own "detect and warn, never recreate" policy (Phase 1/7); full drift
 *   remediation for a changed driver/options is out of scope for this phase.
 * - **Never race a container mid-creation.** A `membership-stale` disconnect
 *   is deferred (counted in `skippedRecentContainers`, not acted on) when the
 *   target container was created/started more recently than
 *   {@link DISCONNECT_GRACE_MS} — the next sweep re-evaluates it. Connects
 *   carry no such guard: they are purely additive, so there is nothing to
 *   race.
 *
 * See `docs/planning/not-shipped/docker-network-overhaul-plan.md` §6 Phase 8
 * and `docs/designs/docker-network-management-redesign.md` §3.2/§3.5.
 */
import type Docker from 'dockerode';
import type {
  AdoptedContainerRef,
  NetworkConvergeResult,
  NetworkReconcileReport,
} from '@mini-infra/types';
import type { PrismaClient } from '../../generated/prisma/client';
import {
  asOptionsRecord,
  desiredLabelPurpose,
  ownerFromManagedNetwork,
  reconcileAll,
  reconcileEnvironment,
  reconcileStack,
  type ManagedNetworkRow,
  type NetworkMembershipRow,
  type NetworkReconcilerDeps,
} from './network-reconciler';
import { resolveMembershipTarget, type MembershipTarget } from './membership-store';
import { getOwnContainerId } from '../self-update';

/**
 * Grace window (ms) protecting a just-created/just-started container from a
 * `membership-stale` disconnect — the "don't let the periodic/event-driven
 * converge race container creation" requirement from the phase brief. Only
 * gates disconnects; connects are always safe to race since they're
 * additive.
 */
const DISCONNECT_GRACE_MS = 30_000;

type ManagedNetworkWithFlag = ManagedNetworkRow & { enforceMemberships: boolean };

function emptyResult(scope: NetworkConvergeResult['scope']): NetworkConvergeResult {
  return {
    scope,
    ranAt: new Date().toISOString(),
    networksEnsured: 0,
    networksCreated: 0,
    membershipsConnected: 0,
    membershipsDisconnected: 0,
    skippedDisconnects: 0,
    skippedRecentContainers: 0,
    errors: 0,
  };
}

function membershipKey(networkId: string, target?: { stackServiceId?: string | null; containerName?: string | null }): string {
  return `${networkId}:${target?.stackServiceId ?? ''}:${target?.containerName ?? ''}`;
}

async function fetchManagedNetworksByIds(
  prisma: PrismaClient,
  ids: string[],
): Promise<Map<string, ManagedNetworkWithFlag>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.managedNetwork.findMany({ where: { id: { in: ids } } });
  return new Map(rows.map((r) => [r.id, r as unknown as ManagedNetworkWithFlag]));
}

async function fetchMembershipLookup(
  prisma: PrismaClient,
  networkIds: string[],
): Promise<Map<string, NetworkMembershipRow & { aliases: unknown; staticIp: string | null }>> {
  if (networkIds.length === 0) return new Map();
  const rows = await prisma.networkMembership.findMany({ where: { networkId: { in: networkIds } } });
  return new Map(rows.map((m) => [membershipKey(m.networkId, m), m as unknown as NetworkMembershipRow & { aliases: unknown; staticIp: string | null }]));
}

/**
 * True when it's safe to disconnect this container right now — false defers
 * the action to a later sweep rather than risking a race with a container
 * that's still mid-create/attach. Never throws: an inspect failure (Docker
 * hiccup, container already gone) is treated as "safe" since there is
 * nothing left to protect.
 */
async function isSafeToDisconnect(docker: Docker, containerId: string): Promise<boolean> {
  try {
    const info = await docker.getContainer(containerId).inspect();
    const startedAt = info.State?.StartedAt ? Date.parse(info.State.StartedAt) : NaN;
    const created = info.Created ? Date.parse(info.Created) : NaN;
    const referenceTime = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : created;
    if (!Number.isFinite(referenceTime)) return true;
    return Date.now() - referenceTime >= DISCONNECT_GRACE_MS;
  } catch {
    return true;
  }
}

/**
 * Act on a `NetworkReconcileReport`'s drift items. Exported standalone (in
 * addition to the scope-specific `converge*` wrappers below) so a caller
 * that already has a report in hand — e.g. the manual admin endpoint, which
 * may want to show the pre-convergence diff and the convergence outcome in
 * one response — doesn't have to re-run the diff.
 */
export async function applyConvergence(
  report: NetworkReconcileReport,
  deps: NetworkReconcilerDeps,
): Promise<NetworkConvergeResult> {
  const { prisma, networkManager, dockerExecutor, log } = deps;
  const result = emptyResult(report.scope);
  if (report.items.length === 0) return result;

  const networkIds = [...new Set(report.items.map((i) => i.managedNetworkId))];
  const [networksById, membershipLookup] = await Promise.all([
    fetchManagedNetworksByIds(prisma, networkIds),
    fetchMembershipLookup(prisma, networkIds),
  ]);
  const docker = dockerExecutor.getDockerClient();

  for (const item of report.items) {
    const netRow = networksById.get(item.managedNetworkId);
    if (!netRow) continue; // row disappeared between diff and converge (e.g. stack destroyed concurrently) — nothing to act on.

    try {
      if (item.type === 'network-missing') {
        const ensureResult = await networkManager.ensure({
          name: netRow.name,
          owner: ownerFromManagedNetwork(netRow),
          purpose: desiredLabelPurpose(netRow),
          driver: netRow.driver,
          options: asOptionsRecord(netRow.options) ?? undefined,
        });
        result.networksEnsured++;
        if (ensureResult.created) {
          result.networksCreated++;
          log.info({ network: netRow.name, scope: netRow.scope }, 'Convergence created missing managed network');
        }
      } else if (item.type === 'membership-missing') {
        const membershipRow = membershipLookup.get(membershipKey(item.managedNetworkId, item.target));
        for (const c of item.containers ?? []) {
          try {
            const connectResult = await networkManager.connect(c.id, netRow.name, {
              aliases: (membershipRow?.aliases as string[] | undefined) ?? undefined,
              staticIp: membershipRow?.staticIp ?? undefined,
            });
            // Only count an actual fresh attachment — `alreadyConnected` means
            // Docker itself considered this a no-op (its own short/full-id
            // resolution or a 403/409 idempotency signal), so counting it
            // would inflate the "restored attachment count" metric with
            // connects that changed nothing.
            if (connectResult.connected && !connectResult.alreadyConnected) {
              result.membershipsConnected++;
            }
          } catch (err) {
            result.errors++;
            log.warn(
              { network: netRow.name, containerId: c.id, error: err instanceof Error ? err.message : String(err) },
              'Convergence: failed to connect container to network',
            );
          }
        }
      } else if (item.type === 'membership-stale') {
        if (!netRow.enforceMemberships) {
          result.skippedDisconnects += item.containers?.length ?? 0;
          continue;
        }
        for (const c of item.containers ?? []) {
          const safe = await isSafeToDisconnect(docker, c.id);
          if (!safe) {
            result.skippedRecentContainers++;
            continue;
          }
          try {
            await networkManager.disconnect(c.id, netRow.name);
            result.membershipsDisconnected++;
            log.info({ network: netRow.name, containerId: c.id, containerName: c.name }, 'Convergence disconnected stale endpoint (enforceMemberships=true)');
          } catch (err) {
            result.errors++;
            log.warn(
              { network: netRow.name, containerId: c.id, error: err instanceof Error ? err.message : String(err) },
              'Convergence: failed to disconnect stale endpoint',
            );
          }
        }
      }
      // 'spec-mismatch': intentionally never acted on this phase (see module doc).
    } catch (err) {
      result.errors++;
      log.warn(
        { network: netRow.name, itemType: item.type, error: err instanceof Error ? err.message : String(err) },
        'Convergence: failed to act on drift item',
      );
    }
  }

  return result;
}

function logSummary(log: NetworkReconcilerDeps['log'], label: string, result: NetworkConvergeResult): void {
  if (result.networksCreated === 0 && result.membershipsConnected === 0 && result.membershipsDisconnected === 0 && result.errors === 0) {
    return; // nothing happened — don't add log noise to every periodic tick.
  }
  log.info(
    {
      scope: result.scope,
      networksCreated: result.networksCreated,
      membershipsConnected: result.membershipsConnected,
      membershipsDisconnected: result.membershipsDisconnected,
      skippedDisconnects: result.skippedDisconnects,
      skippedRecentContainers: result.skippedRecentContainers,
      errors: result.errors,
    },
    label,
  );
}

/** Converge one stack's networks/memberships to desired state. Driven by stack apply (scoped) and the event-driven/periodic sweeps. */
export async function convergeStack(stackId: string, deps: NetworkReconcilerDeps): Promise<NetworkConvergeResult> {
  const report = await reconcileStack(stackId, deps);
  const result = await applyConvergence(report, deps);
  logSummary(deps.log, 'Network convergence (stack) restored attachments', result);
  return result;
}

/** Converge one environment's networks/memberships to desired state. */
export async function convergeEnvironment(environmentId: string, deps: NetworkReconcilerDeps): Promise<NetworkConvergeResult> {
  const report = await reconcileEnvironment(environmentId, deps);
  const result = await applyConvergence(report, deps);
  logSummary(deps.log, 'Network convergence (environment) restored attachments', result);
  return result;
}

/**
 * Full sweep — every stack, every environment, host-scoped networks. This is
 * the general boot converge that replaces the deleted
 * `self-network-reattach.ts`: the mini-infra server's own `containerName:
 * 'self'` membership rows (on whichever scope's `ManagedNetwork` they were
 * written against — host-scoped vault/nats/dataplane, environment-scoped
 * egress/database, ...) are diffed by `reconcileAll` exactly like any other
 * membership, so a lost self-attachment surfaces as an ordinary
 * `membership-missing` item and gets reconnected here — no self-specific
 * code needed. Also used by the periodic sweep and the manual admin
 * endpoint's `scope=all`.
 */
export async function convergeAll(deps: NetworkReconcilerDeps): Promise<NetworkConvergeResult> {
  const report = await reconcileAll(deps);
  const result = await applyConvergence(report, deps);
  logSummary(deps.log, 'Boot/periodic network convergence restored attachments', result);
  return result;
}

/**
 * Converge a single container's own declared memberships — the
 * `converge(containerId)` primitive from the phase brief. Connect-only (no
 * disconnect path at all): the point of this primitive is fast, scoped
 * self-healing right after a container appears (a Docker `start` event), not
 * a full stale-endpoint audit — that's what the scoped/full sweeps above are
 * for. Resolves the container's own target identity (the `self` sentinel,
 * a `StackService` via its `mini-infra.stack-id`/`mini-infra.service`
 * labels, or its own container name for an externally-adopted container),
 * looks up every `NetworkMembership` row for that target, ensures each
 * referenced network exists, and connects.
 *
 * Deliberately NOT wired into the existing create→attach→start sequence in
 * `stack-service-handlers.ts`/`pool-spawner.ts`/`pool-addon-sidecar.ts` — the
 * phase brief is explicit that this ordering must not regress, and those
 * five call sites already attach every declared network via
 * `attachServiceNetworks` before start. Wiring an extra pass into all five
 * would be pure risk with no behavioural gap to close. Instead this is used
 * by the event-driven convergence scheduler's container `start` handler
 * (`network-convergence-scheduler.ts`), which is exactly the
 * "container recreated out-of-band while the server keeps running" case this
 * primitive exists for.
 */
export async function convergeContainer(containerId: string, deps: NetworkReconcilerDeps): Promise<NetworkConvergeResult> {
  const { prisma, networkManager, dockerExecutor, log } = deps;
  const scope = { kind: 'container' as const, containerId };
  const result = emptyResult(scope);

  const target = await resolveContainerTarget(containerId, dockerExecutor.getDockerClient(), prisma);
  if (!target) return result;

  const memberships = await prisma.networkMembership.findMany({
    where: target.stackServiceId ? { stackServiceId: target.stackServiceId } : { containerName: target.containerName },
  });
  if (memberships.length === 0) return result;

  const networkIds = [...new Set(memberships.map((m) => m.networkId))];
  const networksById = await fetchManagedNetworksByIds(prisma, networkIds);

  for (const m of memberships) {
    const netRow = networksById.get(m.networkId);
    if (!netRow) continue;

    try {
      const ensureResult = await networkManager.ensure({
        name: netRow.name,
        owner: ownerFromManagedNetwork(netRow),
        purpose: desiredLabelPurpose(netRow),
        driver: netRow.driver,
        options: asOptionsRecord(netRow.options) ?? undefined,
      });
      result.networksEnsured++;
      if (ensureResult.created) result.networksCreated++;

      const connectResult = await networkManager.connect(containerId, netRow.name, {
        aliases: (m.aliases as unknown as string[] | undefined) ?? undefined,
        staticIp: m.staticIp ?? undefined,
      });
      if (connectResult.connected && !connectResult.alreadyConnected) {
        result.membershipsConnected++;
      }
    } catch (err) {
      result.errors++;
      log.warn(
        { containerId, network: netRow.name, error: err instanceof Error ? err.message : String(err) },
        'Convergence: failed to converge container to network',
      );
    }
  }

  logSummary(deps.log, 'Container-scoped network convergence restored attachments', result);
  return result;
}

/** Resolve `containerId`'s own `NetworkMembership` target identity — the inverse of `resolveTargetContainers` in `network-reconciler.ts` (that resolves a target to containers; this resolves a container to its target). Returns `null` when the container carries none of mini-infra's own labels and isn't the self container — nothing declared for it, so there's nothing to converge. */
async function resolveContainerTarget(
  containerId: string,
  docker: Docker,
  prisma: PrismaClient,
): Promise<MembershipTarget | null> {
  if (getOwnContainerId() === containerId) {
    return { containerName: 'self' };
  }

  let info: Docker.ContainerInspectInfo;
  try {
    info = await docker.getContainer(containerId).inspect();
  } catch {
    return null; // container already gone — nothing to converge.
  }

  const labels = info.Config?.Labels ?? {};
  const stackId = labels['mini-infra.stack-id'];
  const serviceName = labels['mini-infra.service'];
  if (stackId && serviceName) {
    const svc = await prisma.stackService.findFirst({
      where: { stackId, serviceName },
      select: { id: true, adoptedContainer: true, serviceType: true },
    });
    if (svc) {
      // Mirrors `resolveMembershipTarget` in membership-store.ts: AdoptedWeb
      // services are keyed by containerName, everything else by stackServiceId.
      return resolveMembershipTarget({
        id: svc.id,
        serviceType: svc.serviceType,
        adoptedContainer: (svc.adoptedContainer as unknown as AdoptedContainerRef | null) ?? null,
      });
    }
  }

  const name = info.Name?.replace(/^\//, '');
  return name ? { containerName: name } : null;
}
