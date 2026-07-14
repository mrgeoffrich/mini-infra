/**
 * Backfill — network overhaul Phase 6, deliverable 3.
 *
 * Seeds `ManagedNetwork`/`NetworkMembership` rows for infrastructure that
 * predates the Phase 6 producers: every `InfraResource` (`docker-network`
 * type), and every non-removed `Stack`'s current `networks[]` +
 * `containerConfig.joinNetworks`/`joinResourceNetworks`. A stack that gets
 * re-applied after this backfill runs would have its rows written by the
 * compiler anyway — this just seeds rows for stacks that stay `synced`
 * (Drifted/Undeployed only) and won't naturally re-apply on their own.
 *
 * ## Dangling references: log-and-skip, not `status: 'missing'`
 *
 * Design doc §7 leaves open whether a `joinNetworks`/`joinResourceNetworks`/
 * `InfraResource` reference whose target network no longer exists in Docker
 * gets a `ManagedNetwork` row with `status: 'missing'`, or is simply logged
 * and skipped (no row at all). This backfill **logs and skips** — the
 * simpler of the two options, and arguably the more correct one for a
 * write-only phase: Phase 7's reconciler is the component that inspects
 * live Docker state and sets `status` (`design §3.2`: "for each
 * `ManagedNetwork`, ensure existence... inspect and record
 * dockerId/subnet/status"). Pre-guessing `status: 'missing'` here, from a
 * point-in-time snapshot the reconciler doesn't yet exist to re-confirm,
 * would just be stale information Phase 7 immediately overwrites on its
 * first real pass — and inventing a row for a reference this backfill can't
 * confirm ever pointed at a mini-infra-managed network risks fabricating
 * ownership data nothing asked for. Every skip is logged with enough
 * context (stack/service/network name) for an operator to investigate.
 *
 * Idempotent and safe to re-run: every write goes through the same
 * find-or-create helpers as the live producers (`membership-store.ts`), so
 * running this on every boot (the established one-shot-migration idiom in
 * this codebase — see the deleted `system-stack-migrations.ts` and the
 * still-live `reattachSelfToManagedNetworks`) or via the admin endpoint
 * never creates duplicate rows.
 */
import type { Logger } from 'pino';
import type { PrismaClient } from '../../generated/prisma/client';
import type {
  AdoptedContainerRef,
  NetworkMembershipBackfillSummary,
  StackContainerConfig,
  StackNetwork,
  StackResourceOutput,
} from '@mini-infra/types';
import type { DockerExecutorService } from '../docker-executor';
import { NetworkManager } from './network-manager';
import { stackNetworkName } from './network-names';
import {
  findOrCreateManagedNetworkByName,
  resolveMembershipTarget,
  upsertManagedNetworkByIdentity,
  upsertNetworkMembership,
} from './membership-store';
import { getStackProjectName } from '../stacks/template-engine';
import { synthesiseDefaultNetworkIfNeeded } from '../stacks/utils';

export type BackfillSummary = NetworkMembershipBackfillSummary;

/**
 * Resolve a `joinResourceNetworks` purpose to a Docker network name the same
 * way `StackInfraResourceManager.resolveInputs` does (environment-scoped
 * first, then host-scoped fallback) — duplicated here in miniature rather
 * than instantiating the full manager, which requires a
 * `StackContainerManager` this read-only backfill has no other use for.
 */
interface ResolvedResourceNetwork {
  name: string;
  scope: 'environment' | 'host';
  environmentId: string | null;
}

async function resolveResourceNetwork(
  prisma: PrismaClient,
  environmentId: string | null,
  purpose: string,
): Promise<ResolvedResourceNetwork | null> {
  if (environmentId) {
    const envResource = await prisma.infraResource.findFirst({
      where: { type: 'docker-network', purpose, scope: 'environment', environmentId },
      select: { name: true },
    });
    if (envResource) return { name: envResource.name, scope: 'environment', environmentId };
  }
  const hostResource = await prisma.infraResource.findFirst({
    where: { type: 'docker-network', purpose, scope: 'host', environmentId: null },
    select: { name: true },
  });
  return hostResource ? { name: hostResource.name, scope: 'host', environmentId: null } : null;
}

export async function backfillNetworkMemberships(
  dockerExecutor: DockerExecutorService,
  prisma: PrismaClient,
  log: Logger,
): Promise<BackfillSummary> {
  const networkManager = new NetworkManager(dockerExecutor);
  const summary: BackfillSummary = {
    infraResourcesScanned: 0,
    stacksScanned: 0,
    servicesScanned: 0,
    danglingSkipped: 0,
    managedNetworksTotal: 0,
    networkMembershipsTotal: 0,
  };

  // 1. InfraResource-backed networks (resource outputs, environment egress,
  // vault/nats/dataplane/database, etc.) — these have no per-service
  // membership of their own (that's compiled per-stack below), just the
  // ManagedNetwork row itself.
  const resources = await prisma.infraResource.findMany({ where: { type: 'docker-network' } });

  // Detect which of those resource networks the mini-infra server itself is
  // meant to join (`joinSelf: true` on the producing stack's resource output —
  // dataplane/database/vault/nats). `connectSelfToNetwork` only records the
  // `containerName: 'self'` membership for these at *apply* time, so a stack
  // that stayed `synced` across the network-overhaul deploy never got one; boot
  // convergence (`convergeAll`) then has no self-row to reconnect after the app
  // container is recreated, stranding mini-infra off the dataplane network (and
  // failing every HAProxy-routed deploy with "HAProxy environment context not
  // available"). Seed the row here from the producing stack's declared outputs
  // so the self-heal works for already-applied infra without a re-apply.
  const producingStacks = await prisma.stack.findMany({
        select: { id: true, resourceOutputs: true },
  });
  const resourceOutputsByStackId = new Map<string, StackResourceOutput[]>(
    producingStacks.map((s) => [s.id, (s.resourceOutputs as unknown as StackResourceOutput[]) ?? []]),
  );
  const isJoinSelfResource = (res: { stackId: string | null; purpose: string }): boolean => {
    if (!res.stackId) return false;
    const outputs = resourceOutputsByStackId.get(res.stackId) ?? [];
    return outputs.some(
      (o) => o.type === 'docker-network' && o.purpose === res.purpose && o.joinSelf === true,
    );
  };

  for (const r of resources) {
    summary.infraResourcesScanned++;
    const existence = await networkManager.exists(r.name);
    if (existence === 'absent') {
      log.warn(
        { name: r.name, purpose: r.purpose, scope: r.scope },
        'Backfill: InfraResource network no longer exists in Docker — skipping (dangling)',
      );
      summary.danglingSkipped++;
      continue;
    }
    if (existence === 'unknown') {
      log.warn({ name: r.name }, 'Backfill: could not confirm network existence (Docker unreachable) — skipping this cycle');
      continue;
    }
    const scope: 'environment' | 'host' = r.environmentId ? 'environment' : 'host';

    // Self-heal an identity mismatch on an already-existing-by-name row
    // (network overhaul Phase 9 finding): `InfraResource` rows are only ever
    // written by the actual owning producer (`reconcileOutputs`/
    // `EnvironmentManager` provisioning), so `(scope, environmentId,
    // purpose)` derived from one here is authoritative ground truth for this
    // network — unlike `upsertManagedNetworkByIdentity`'s general "never
    // rewrite once set" rule (which protects producers, like the stack-owned
    // network compiler, that have no independent authority to check
    // against). This repairs rows a different producer's best-effort by-name
    // fallback created first with a wrong guess — e.g. a self-join
    // (`connectSelfToNetwork`'s old hardcoded `scope: 'host'` default) racing
    // ahead of this exact InfraResource-backed identity for an
    // environment-scoped network like `${env}-egress`.
    const existingByName = await prisma.managedNetwork.findUnique({ where: { name: r.name } });
    let managedNetworkId: string;
    if (
      existingByName &&
      (existingByName.scope !== scope ||
        existingByName.environmentId !== (r.environmentId ?? null) ||
        existingByName.purpose !== r.purpose)
    ) {
      log.info(
        {
          name: r.name,
          from: { scope: existingByName.scope, environmentId: existingByName.environmentId, purpose: existingByName.purpose },
          to: { scope, environmentId: r.environmentId, purpose: r.purpose },
        },
        'Backfill: correcting ManagedNetwork identity to match authoritative InfraResource row',
      );
      const corrected = await prisma.managedNetwork.update({
        where: { id: existingByName.id },
        data: { scope, environmentId: r.environmentId ?? null, purpose: r.purpose },
      });
      managedNetworkId = corrected.id;
    } else {
      const row = await upsertManagedNetworkByIdentity(
        prisma,
        { scope, environmentId: r.environmentId, stackId: null, purpose: r.purpose },
        r.name,
      );
      managedNetworkId = row.id;
    }

    // Seed the mini-infra server's own `self` membership for joinSelf resource
    // networks (see the note above the loop). Idempotent — identical to the row
    // `connectSelfToNetwork` writes at apply time, so re-runs here and a later
    // re-apply both no-op rather than duplicating.
    if (isJoinSelfResource(r)) {
      await upsertNetworkMembership(prisma, {
        containerName: 'self',
        networkId: managedNetworkId,
        source: 'system',
      });
    }
  }

  // 2. Stack-owned networks + per-service memberships, from every
  // non-removed stack's *current* definition.
  const stacks = await prisma.stack.findMany({
        include: {
      services: true,
      environment: { select: { name: true } },
      template: { select: { source: true, createdById: true } },
    },
  });

  for (const stack of stacks) {
    summary.stacksScanned++;
    const projectName = getStackProjectName(stack);
    const declaredNetworks = (stack.networks as unknown as StackNetwork[]) ?? [];
    const networks = synthesiseDefaultNetworkIfNeeded(declaredNetworks, stack.services, log);
    const isUserApp = stack.template?.source === 'user';

    const stackNetIds = new Map<string, string>();
    for (const net of networks) {
      const name = stackNetworkName(projectName, net.name);
      const existence = await networkManager.exists(name);
      if (existence === 'absent') {
        log.warn({ stackId: stack.id, name }, 'Backfill: stack-owned network no longer exists in Docker — skipping (dangling)');
        summary.danglingSkipped++;
        continue;
      }
      if (existence === 'unknown') continue;
      const row = await upsertManagedNetworkByIdentity(
        prisma,
        { scope: 'stack', environmentId: stack.environmentId, stackId: stack.id, purpose: net.name },
        name,
        { driver: net.driver, options: net.options ?? undefined },
      );
      stackNetIds.set(net.name, row.id);
    }

    for (const svc of stack.services) {
      summary.servicesScanned++;
      const cfg = (svc.containerConfig as unknown as StackContainerConfig) ?? {};
      const target = resolveMembershipTarget({
        id: svc.id,
        serviceType: svc.serviceType,
        adoptedContainer: (svc.adoptedContainer as unknown as AdoptedContainerRef | null) ?? null,
      });

      if (cfg.networkMode !== 'host') {
        for (const net of networks) {
          const networkId = stackNetIds.get(net.name);
          if (!networkId) continue; // dangling, already logged above
          await upsertNetworkMembership(prisma, {
            ...target, networkId, source: 'template', aliases: [svc.serviceName],
          });
        }
      }

      for (const netName of cfg.joinNetworks ?? []) {
        if (!netName) continue;
        const existence = await networkManager.exists(netName);
        if (existence === 'absent') {
          log.warn(
            { stackId: stack.id, service: svc.serviceName, network: netName },
            'Backfill: joinNetworks target no longer exists in Docker — skipping (dangling)',
          );
          summary.danglingSkipped++;
          continue;
        }
        if (existence === 'unknown') continue;
        const row = await findOrCreateManagedNetworkByName(prisma, netName, {
          scope: 'host', environmentId: null, stackId: null, purpose: netName,
        });
        await upsertNetworkMembership(prisma, {
          ...target,
          networkId: row.id,
          source: isUserApp ? 'user' : 'template',
          createdBy: isUserApp ? stack.template?.createdById ?? null : null,
        });
      }

      for (const purpose of (cfg.joinResourceNetworks ?? []) as string[]) {
        const resolved = await resolveResourceNetwork(prisma, stack.environmentId, purpose);
        if (!resolved) {
          log.warn(
            { stackId: stack.id, service: svc.serviceName, purpose },
            'Backfill: joinResourceNetworks purpose has no matching InfraResource — skipping (dangling)',
          );
          summary.danglingSkipped++;
          continue;
        }
        const { name } = resolved;
        const existence = await networkManager.exists(name);
        if (existence === 'absent') {
          log.warn(
            { stackId: stack.id, service: svc.serviceName, purpose, name },
            'Backfill: joinResourceNetworks target no longer exists in Docker — skipping (dangling)',
          );
          summary.danglingSkipped++;
          continue;
        }
        if (existence === 'unknown') continue;
        const row = await findOrCreateManagedNetworkByName(prisma, name, {
          scope: resolved.scope, environmentId: resolved.environmentId, stackId: null, purpose,
        });
        await upsertNetworkMembership(prisma, {
          ...target,
          networkId: row.id,
          source: 'template',
          aliases: cfg.egressBypass === true ? [svc.serviceName] : undefined,
        });
      }
    }
  }

  const [managedNetworksTotal, networkMembershipsTotal] = await Promise.all([
    prisma.managedNetwork.count(),
    prisma.networkMembership.count(),
  ]);
  summary.managedNetworksTotal = managedNetworksTotal;
  summary.networkMembershipsTotal = networkMembershipsTotal;

  log.info({ ...summary }, 'Network membership backfill complete');
  return summary;
}
