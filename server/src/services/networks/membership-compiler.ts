/**
 * Membership compiler — network overhaul Phase 6, deliverable 1.
 *
 * Compiles a stack's *desired* network membership (the four legacy
 * declaration mechanisms: stack-owned `networks[]` + the synthesised
 * `default`, docker-network resource outputs/inputs, `joinNetworks`, and
 * `joinResourceNetworks`) into `ManagedNetwork` + `NetworkMembership` rows.
 *
 * Called once per stack apply/update, immediately after the imperative
 * network-ensure step (`StackReconciler.ensureStackNetworks` +
 * `StackInfraResourceManager.reconcileOutputs`/`resolveInputs`). Write-only:
 * this function changes nothing about which containers get attached to
 * which networks — the imperative attach pipeline above it in the caller
 * remains the sole source of truth for actual connectivity. It only records
 * that desired state as rows, and never throws (a bookkeeping failure must
 * not fail a stack apply).
 *
 * ## `source: 'user'` and the app connect-to-container-network feature
 *
 * The plan (`docker-network-overhaul-plan.md` §6 Phase 6) calls for the app
 * "connect to a database/container's network" feature (PR #473) to produce
 * `source: 'user'` rows "written by that API route". In the current
 * architecture there is no such route to instrument: PR #473 is a
 * client-only feature that folds the user's container-network pick into
 * `containerConfig.joinNetworks` (a plain `string[]`) before POSTing to the
 * ordinary `stack-templates` create/draft routes — and those routes persist
 * a `StackTemplateVersion`, which has no `StackService` row (and therefore
 * no real `stackServiceId`) to attach a membership to. A `StackService` row
 * only exists once a stack is instantiated/applied from that template — at
 * which point this compiler runs, not "the route".
 *
 * The deliberate, documented deviation: `joinNetworks` entries compiled here
 * are attributed `source: 'user'` (with `createdBy` set to the owning
 * `StackTemplate.createdById`) when the stack was created from a **user**
 * stack template (`StackTemplate.source === 'user'`, i.e. it's an
 * "Application" in product terms) — since every `joinNetworks` entry on an
 * Application flows through the connect-to-container picker (see
 * `client/src/app/applications/new/page.tsx` and
 * `.../[id]/configuration/page.tsx`, both of which only ever populate
 * `joinNetworks` from `linkedContainers`). System-authored stack templates
 * (`source: 'system'`) keep `source: 'template'` for their `joinNetworks`,
 * matching every other declaration mechanism. A stack-owned network that
 * happens to also appear in `joinNetworks` (the edit form intentionally
 * includes the app's own network name, see that file's comment) is
 * unaffected — stack-owned memberships are compiled first, so the
 * `joinNetworks` pass below finds the existing `source: 'template'` row and
 * (per `upsertNetworkMembership`'s contract) leaves its source alone.
 */
import type { Logger } from 'pino';
import type { PrismaClient } from '../../generated/prisma/client';
import type { StackNetwork } from '@mini-infra/types';
import { stackNetworkName } from './network-names';
import {
  findOrCreateManagedNetworkByName,
  resolveMembershipTarget,
  safeMembershipWrite,
  upsertManagedNetworkByIdentity,
  upsertNetworkMembership,
  type StackServiceMembershipInput,
} from './membership-store';

export interface CompileStackMembershipsInput {
  prisma: PrismaClient;
  stack: {
    id: string;
    environmentId: string | null;
    /** `StackTemplate.source` for the template this stack was created from — `null`/absent for ad-hoc stacks with no template. */
    templateSource?: string | null;
    /** `StackTemplate.createdById` — used as `NetworkMembership.createdBy` for `joinNetworks` rows on user-authored ("Application") stacks; see module doc. */
    templateCreatedById?: string | null;
  };
  projectName: string;
  /** Declared stack networks + the synthesised `default`, already resolved by the caller (mirrors `StackReconciler.ensureStackNetworks`'s own input). */
  networks: StackNetwork[];
  /** purpose -> Docker network name, from `StackInfraResourceManager.reconcileOutputs` (this stack/environment owns these). */
  outputNetworkMap: Map<string, string>;
  /** purpose -> Docker network name, from `StackInfraResourceManager.resolveInputs` (owned by some other stack/environment). */
  inputNetworkMap: Map<string, string>;
  services: StackServiceMembershipInput[];
  log: Logger;
}

export async function compileStackNetworkMemberships(input: CompileStackMembershipsInput): Promise<void> {
  const { prisma, stack, projectName, networks, outputNetworkMap, inputNetworkMap, services, log } = input;

  await safeMembershipWrite(log, { stackId: stack.id }, async () => {
    // 1. Stack-owned networks (+ synthesised default) — identity is always
    // known precisely here since this stack is the sole owner.
    const stackNetIds = new Map<string, string>();
    for (const net of networks) {
      const name = stackNetworkName(projectName, net.name);
      const row = await upsertManagedNetworkByIdentity(
        prisma,
        { scope: 'stack', environmentId: stack.environmentId, stackId: stack.id, purpose: net.name },
        name,
        { driver: net.driver, options: net.options ?? undefined },
      );
      stackNetIds.set(net.name, row.id);
    }

    // 2. Resource networks — outputs are owned by this stack/environment;
    // inputs are owned elsewhere (resolved to a name only, via
    // `StackInfraResourceManager.resolveInputs`). Both use the same identity
    // shape (`stackId: null`, mirroring how `InfraResource` itself doesn't
    // key its own uniqueness on `stackId` either) so whichever producer
    // compiles a given purpose first "wins" the identity; the other side's
    // by-name lookup then just finds that same row.
    const resourceScope: 'environment' | 'host' = stack.environmentId ? 'environment' : 'host';
    const resourceNetIds = new Map<string, string>();
    for (const [purpose, name] of outputNetworkMap) {
      const row = await upsertManagedNetworkByIdentity(prisma, {
        scope: resourceScope, environmentId: stack.environmentId, stackId: null, purpose,
      }, name);
      resourceNetIds.set(purpose, row.id);
    }
    for (const [purpose, name] of inputNetworkMap) {
      if (resourceNetIds.has(purpose)) continue;
      // Inputs are owned by *some other* stack/environment — `resourceScope`
      // (derived from *this* stack's own scope) is only a fallback guess.
      // The `InfraResource` row `resolveInputs` already resolved `name` from
      // knows the true owning scope/environmentId; consult it directly so a
      // host-scoped resource consumed by an environment-scoped stack (e.g.
      // vault/nats/dataplane joined by an app) doesn't get mis-recorded as
      // environment-scoped.
      const owningResource = await prisma.infraResource.findFirst({
        where: { type: 'docker-network', purpose, name },
        select: { scope: true, environmentId: true },
      });
      const row = await findOrCreateManagedNetworkByName(prisma, name, {
        scope: (owningResource?.scope as 'environment' | 'host' | undefined) ?? resourceScope,
        environmentId: owningResource ? owningResource.environmentId : stack.environmentId,
        stackId: null,
        purpose,
      });
      resourceNetIds.set(purpose, row.id);
    }

    // 3. Per-service memberships.
    const isUserApp = stack.templateSource === 'user';
    for (const svc of services) {
      const target = resolveMembershipTarget(svc);
      const cfg = svc.containerConfig ?? {};
      const isHostMode = cfg.networkMode === 'host';

      // 3a. Stack-owned networks — every non-host-mode service joins all of
      // them (mirrors `networkNames` passed unconditionally to
      // `createContainer`/`createLongRunningContainer`), aliased by service
      // name (mirrors the stack-owned-network alias policy in
      // `long-running-container.ts`/`stack-container-manager.ts`).
      if (!isHostMode) {
        for (const net of networks) {
          const networkId = stackNetIds.get(net.name);
          if (!networkId) continue;
          await upsertNetworkMembership(prisma, {
            ...target, networkId, source: 'template', aliases: [svc.serviceName],
          });
        }
      }

      // 3b. joinNetworks — literal external network names.
      for (const netName of cfg.joinNetworks ?? []) {
        if (!netName) continue;
        const row = await findOrCreateManagedNetworkByName(prisma, netName, {
          scope: 'host', environmentId: null, stackId: null, purpose: netName,
        });
        await upsertNetworkMembership(prisma, {
          ...target,
          networkId: row.id,
          source: isUserApp ? 'user' : 'template',
          createdBy: isUserApp ? stack.templateCreatedById ?? null : null,
        });
      }

      // 3c. joinResourceNetworks — purpose lookup via the already-resolved
      // infra network maps. Alias only for egressBypass services (mirrors
      // `StackInfraResourceManager.joinResourceNetworks`'s own alias policy
      // so e.g. `egress-gateway:3128` keeps resolving after a recreate).
      for (const purpose of cfg.joinResourceNetworks ?? []) {
        const networkId = resourceNetIds.get(purpose);
        if (!networkId) continue;
        await upsertNetworkMembership(prisma, {
          ...target,
          networkId,
          source: 'template',
          aliases: cfg.egressBypass === true ? [svc.serviceName] : undefined,
        });
      }
    }
  });
}

/**
 * Build the compiler's `services` input from a stack's real `StackService`
 * rows (which carry the `id` used as `stackServiceId`) plus the apply
 * pipeline's already-resolved `StackServiceDefinition`s (post
 * template-substitution and addon expansion, which is what actually gets
 * attached). Services whose resolved definition is missing (shouldn't
 * happen for authored services) are skipped rather than compiled with a
 * stale/empty config.
 *
 * Deliberately does **not** iterate addon-synthesized synthetic sidecar
 * definitions that may also live in `resolvedDefinitions` — those have no
 * backing `StackService` row (same gap `pool-addon-sidecar.ts` already has
 * for its own spawned containers), so they're left uncompiled in Phase 6;
 * see the Phase 6 handoff notes for follow-up.
 */
export function buildMembershipServiceInputs(
  stackServices: Array<{ id: string; serviceName: string; serviceType: string }>,
  resolvedDefinitions: Map<string, { containerConfig: StackServiceMembershipInput['containerConfig']; adoptedContainer?: StackServiceMembershipInput['adoptedContainer'] }>,
): StackServiceMembershipInput[] {
  const result: StackServiceMembershipInput[] = [];
  for (const svc of stackServices) {
    const def = resolvedDefinitions.get(svc.serviceName);
    if (!def) continue;
    result.push({
      id: svc.id,
      serviceName: svc.serviceName,
      serviceType: svc.serviceType,
      containerConfig: def.containerConfig,
      adoptedContainer: def.adoptedContainer ?? null,
    });
  }
  return result;
}
