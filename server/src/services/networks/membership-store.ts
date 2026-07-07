/**
 * Low-level, idempotent read/write helpers for the desired-state tables
 * added in Phase 5 of the network overhaul (`ManagedNetwork` /
 * `NetworkMembership` — see `docs/designs/docker-network-management-redesign.md`
 * §3.1 and `docs/planning/not-shipped/docker-network-overhaul-plan.md` §5/§6).
 *
 * Every Phase 6 producer (the stack-apply membership compiler, egress
 * auto-attach, the HAProxy manual-frontend join, self/monitoring joins, and
 * the backfill) goes through these helpers rather than calling
 * `prisma.managedNetwork`/`prisma.networkMembership` directly, so the
 * idempotency rules only need to be gotten right once:
 *
 * - `ManagedNetwork` identity is `(scope, environmentId, stackId, purpose)`
 *   for networks a caller *owns* (declares), but `name` (globally `@unique`)
 *   is the only identity a caller *joining* someone else's network can rely
 *   on — see {@link upsertManagedNetworkByIdentity} vs
 *   {@link findOrCreateManagedNetworkByName}.
 * - `NetworkMembership` uniqueness is `(networkId, stackServiceId,
 *   containerName)` with exactly one of `stackServiceId`/`containerName` set
 *   — SQLite treats NULLs as distinct in unique indexes, so a naive
 *   `prisma.*.upsert()` on either compound key would not dedupe rows the way
 *   Postgres does. Every helper here uses an explicit `findFirst` +
 *   `create`/`update` instead (mirrors the same pattern already used for
 *   `InfraResource` in `stack-infra-resource-manager.ts`).
 *
 * ## Concurrency: `findFirst`-then-`create` is not itself race-free
 *
 * The `name`-unique constraint on `ManagedNetwork` (and, for
 * `NetworkMembership`, the NULL-distinct compound index above) can't be
 * relied on to reject a concurrent duplicate — for `NetworkMembership` in
 * particular, two rows sharing the same `(networkId, stackServiceId,
 * containerName: null)` never collide at the DB level under SQLite, so a
 * naive concurrent `create` genuinely produces a duplicate row rather than
 * throwing. A bare `prisma.$transaction()` would not close this either:
 * SQLite's default isolation still lets two concurrent transactions each
 * run `findFirst` and observe "no row yet" before either reaches `create`.
 * The fix used here is process-level serialization — an in-process
 * {@link KeyedMutex} (`../../lib/keyed-mutex.ts`) wraps every find-then-write
 * below, keyed on the same identity the row is looked up by, so two
 * concurrent calls for the *same* network/membership always run their
 * find-then-write one at a time (calls for different keys still run fully
 * in parallel). This only protects a single server process — fine here,
 * since Mini Infra runs as one process against one Docker host.
 */
import type { Logger } from 'pino';
import type { PrismaClient, Prisma } from '../../generated/prisma/client';
import type { AdoptedContainerRef, StackContainerConfig } from '@mini-infra/types';
import { KeyedMutex } from '../../lib/keyed-mutex';
import { InternalError } from '../../lib/errors';

/**
 * Serializes the find-then-write section of {@link upsertManagedNetworkByIdentity}
 * and {@link findOrCreateManagedNetworkByName}, keyed on the `ManagedNetwork`
 * row's `name` (its one DB-enforced-unique identity) — see the module doc
 * above.
 */
const managedNetworkMutex = new KeyedMutex();

/**
 * Serializes the find-then-write section of {@link upsertNetworkMembership},
 * keyed on `(networkId, stackServiceId, containerName)` — the row's intended
 * (but, per the module doc above, not DB-enforced under SQLite) identity.
 */
const membershipMutex = new KeyedMutex();

/** Provenance values a `NetworkMembership` row can carry (Phase 5 schema). */
export type NetworkMembershipSource = 'template' | 'user' | 'egress' | 'haproxy' | 'system';

/** Identity fields for a `ManagedNetwork` row — the composite unique key minus `name`. */
export interface NetworkIdentity {
  scope: 'host' | 'environment' | 'stack';
  environmentId?: string | null;
  stackId?: string | null;
  purpose: string;
}

export interface ManagedNetworkRef {
  id: string;
}

/** Exactly one of these two identifies who/what a membership row is for. */
export interface MembershipTarget {
  stackServiceId?: string | null;
  containerName?: string | null;
}

/**
 * Find-or-create a `ManagedNetwork` row by its composite identity
 * `(scope, environmentId, stackId, purpose)` — for networks the caller
 * owns/declares (stack-owned `networks[]`, the synthesised `default`, or a
 * docker-network resource output). Uses `findFirst` rather than
 * `prisma.managedNetwork.upsert()` for the SQLite-NULL-uniqueness reason
 * described in the module doc.
 *
 * Falls back to a by-`name` lookup before creating: `name` is globally
 * unique, so if a *different* producer already created this exact network
 * under this exact name (e.g. a consumer's best-effort identity guess in
 * {@link findOrCreateManagedNetworkByName} ran before the true owner ever
 * compiled it), this reuses that row instead of racing the `name` unique
 * constraint.
 */
export async function upsertManagedNetworkByIdentity(
  prisma: PrismaClient,
  identity: NetworkIdentity,
  name: string,
  extra?: { driver?: string; options?: Record<string, unknown> | null },
): Promise<ManagedNetworkRef> {
  const environmentId = identity.environmentId ?? null;
  const stackId = identity.stackId ?? null;

  // `name` is the row's true, DB-enforced-unique identity — the same key
  // `findOrCreateManagedNetworkByName` locks on below — so two calls racing
  // to create the exact same network (whether both guessing by identity, or
  // one guessing by identity and one by name) are serialized against each
  // other, not just against other calls to this same function.
  return managedNetworkMutex.runExclusive(`name:${name}`, async () => {
    const existing = await prisma.managedNetwork.findFirst({
      where: { scope: identity.scope, environmentId, stackId, purpose: identity.purpose },
      select: { id: true },
    });
    if (existing) return existing;

    const byName = await prisma.managedNetwork.findUnique({ where: { name }, select: { id: true } });
    if (byName) return byName;

    return prisma.managedNetwork.create({
      data: {
        scope: identity.scope,
        environmentId,
        stackId,
        purpose: identity.purpose,
        name,
        ...(extra?.driver ? { driver: extra.driver } : {}),
        ...(extra?.options ? { options: extra.options as Prisma.InputJsonValue } : {}),
      },
      select: { id: true },
    });
  });
}

/**
 * Find-or-create a `ManagedNetwork` row by its Docker network `name`
 * (`@unique`) — for networks the caller is merely *joining* (a literal
 * `joinNetworks` entry, a `joinResourceNetworks` purpose resolved from
 * another stack's output, or a self/monitoring join target) rather than
 * declaring. The caller usually doesn't know the true owning `(scope,
 * environmentId, stackId)` tuple, only a resolved name — `fallbackIdentity`
 * is a best-effort guess used only the very first time any producer
 * compiles this network (identity is set once, at creation, and never
 * rewritten — a later compile from the true owner will find this same row
 * by name and leave it as-is).
 */
export async function findOrCreateManagedNetworkByName(
  prisma: PrismaClient,
  name: string,
  fallbackIdentity: NetworkIdentity,
): Promise<ManagedNetworkRef> {
  // Same lock, same key namespace as `upsertManagedNetworkByIdentity` above
  // — both functions ultimately find-or-create the same `ManagedNetwork`
  // table by `name`, so they must serialize against EACH OTHER, not just
  // against same-function calls, or two producers racing on the identical
  // consumer/owner pair for one network could still both `create`.
  return managedNetworkMutex.runExclusive(`name:${name}`, async () => {
    const existing = await prisma.managedNetwork.findUnique({ where: { name }, select: { id: true } });
    if (existing) return existing;

    return prisma.managedNetwork.create({
      data: {
        scope: fallbackIdentity.scope,
        environmentId: fallbackIdentity.environmentId ?? null,
        stackId: fallbackIdentity.stackId ?? null,
        purpose: fallbackIdentity.purpose,
        name,
      },
      select: { id: true },
    });
  });
}

export interface UpsertMembershipInput extends MembershipTarget {
  networkId: string;
  source: NetworkMembershipSource;
  aliases?: string[];
  staticIp?: string;
  createdBy?: string | null;
}

/**
 * Find-or-create a `NetworkMembership` row, keyed on
 * `(networkId, stackServiceId, containerName)`.
 *
 * `source`/`createdBy` are set only at creation — once a membership's
 * provenance is recorded (e.g. a `source: 'user'` row from the app
 * connect-to-container feature), a later routine re-compile (a scheduled
 * re-apply, the backfill) must never silently relabel it `'template'` just
 * because a different, more generic producer also declares the same
 * network+target. `aliases`/`staticIp` ARE refreshed on every call — those
 * are legitimately re-derived on every apply (e.g. an egress gateway's
 * static IP reassignment, or a service rename that changes its own DNS
 * alias).
 */
export async function upsertNetworkMembership(
  prisma: PrismaClient,
  input: UpsertMembershipInput,
): Promise<{ created: boolean }> {
  const stackServiceId = input.stackServiceId ?? null;
  const containerName = input.containerName ?? null;
  if (!stackServiceId && !containerName) {
    throw new InternalError('upsertNetworkMembership requires exactly one of stackServiceId/containerName');
  }
  if (stackServiceId && containerName) {
    throw new InternalError('upsertNetworkMembership requires exactly one of stackServiceId/containerName, not both');
  }

  // Keyed on the row's intended identity — the exact tuple the compound
  // unique index is meant to enforce, but (per the module doc above) can't
  // under SQLite once one of these two columns is NULL. Serializing here is
  // what actually prevents the duplicate, not the DB constraint.
  return membershipMutex.runExclusive(
    `${input.networkId}:${stackServiceId ?? ''}:${containerName ?? ''}`,
    async () => {
      const existing = await prisma.networkMembership.findFirst({
        where: { networkId: input.networkId, stackServiceId, containerName },
        select: { id: true },
      });

      if (existing) {
        const data: Prisma.NetworkMembershipUpdateInput = {};
        if (input.aliases !== undefined) data.aliases = input.aliases as unknown as Prisma.InputJsonValue;
        if (input.staticIp !== undefined) data.staticIp = input.staticIp;
        if (Object.keys(data).length > 0) {
          await prisma.networkMembership.update({ where: { id: existing.id }, data });
        }
        return { created: false };
      }

      await prisma.networkMembership.create({
        data: {
          networkId: input.networkId,
          stackServiceId,
          containerName,
          aliases: input.aliases ? (input.aliases as unknown as Prisma.InputJsonValue) : undefined,
          staticIp: input.staticIp,
          source: input.source,
          createdBy: input.createdBy ?? null,
        },
      });
      return { created: true };
    },
  );
}

/** A service's shape as needed to resolve a membership target and compile its declared network requirements. */
export interface StackServiceMembershipInput {
  id: string;
  serviceName: string;
  serviceType: string;
  containerConfig: StackContainerConfig;
  adoptedContainer?: AdoptedContainerRef | null;
}

/**
 * Resolve the `NetworkMembership` target for a service: `stackServiceId` for
 * every managed service type (Stateful/StatelessWeb/Pool/JobPool) — matched
 * to live container(s) by label at reconcile time (Phase 7+), which is what
 * lets one row represent every pool worker for a Pool service — or
 * `containerName` for AdoptedWeb, whose container is externally managed and
 * was never created with mini-infra's service labels, so label resolution
 * doesn't apply.
 */
export function resolveMembershipTarget(service: {
  id: string;
  serviceType: string;
  adoptedContainer?: AdoptedContainerRef | null;
}): MembershipTarget {
  if (service.serviceType === 'AdoptedWeb' && service.adoptedContainer?.containerName) {
    return { containerName: service.adoptedContainer.containerName };
  }
  return { stackServiceId: service.id };
}

/** Never-throw wrapper used by every Phase 6 producer — membership bookkeeping must never break the imperative attach path it mirrors. */
export async function safeMembershipWrite(
  log: Logger,
  context: Record<string, unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn(
      { ...context, error: err instanceof Error ? err.message : String(err) },
      'Failed to record network membership row (non-fatal, write-only bookkeeping)',
    );
  }
}
