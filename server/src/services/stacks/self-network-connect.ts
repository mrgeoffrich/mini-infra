import type { PrismaClient } from '../../generated/prisma/client';
import type { Logger } from 'pino';
import type { DockerExecutorService } from '../docker-executor';
import { createNetworkManager } from '../networks';
import { findOrCreateManagedNetworkByName, safeMembershipWrite, upsertNetworkMembership } from '../networks/membership-store';

/**
 * Connect the mini-infra container itself to a Docker network by name.
 *
 * Idempotent via `NetworkManager.connect()` — already-attached (whether
 * detected by inspection or by Docker's own 403/409 on the connect call) is
 * treated as success and reported as "no change" (returns false). Returns
 * true only when a fresh attachment was made.
 *
 * Network overhaul Phase 6: also records a `containerName: 'self'`,
 * `source: 'system'` `NetworkMembership` row whenever the container is
 * confirmed attached — including the already-attached case, not just a
 * fresh connect, so re-running this (a stack re-apply) doesn't leave a gap
 * in desired state just because Docker had nothing to change this time. The
 * row lookup is by network name (`findOrCreateManagedNetworkByName`) since
 * this helper only ever receives a resolved name, never a purpose — the
 * target network almost always already has a `ManagedNetwork` row from
 * whichever stack's own `reconcileOutputs` declared it.
 *
 * Network overhaul Phase 8: this is now the ONLY place the mini-infra
 * server connects itself to a network at apply time (called from
 * `StackInfraResourceManager.joinSelfToOutputNetworks` below). The
 * boot-time re-attach workaround that used to live alongside this function
 * (`self-network-reattach.ts`'s `reattachSelfToManagedNetworks`, which
 * re-ran this in a loop over every `joinSelf` `InfraResource` on every
 * boot) is deleted — the general boot convergence (`convergeAll()` in
 * `services/networks/network-converger.ts`, wired in `server.ts`) now
 * re-derives the same "server lost its network attachments" situation
 * generically from the `containerName: 'self'` `NetworkMembership` rows
 * THIS function writes, rather than re-deriving it from `InfraResource` +
 * `joinSelf` on every boot. Those rows keep getting written on every apply
 * regardless of whether boot convergence ever runs, so deleting the boot
 * workaround does not stop them from existing.
 */
export async function connectSelfToNetwork(
  dockerExecutor: DockerExecutorService,
  prisma: PrismaClient,
  selfId: string,
  netName: string,
  log: Logger,
): Promise<boolean> {
  try {
    const networkManager = createNetworkManager(dockerExecutor);
    const result = await networkManager.connect(selfId, netName);

    await safeMembershipWrite(log, { network: netName }, async () => {
      const row = await findOrCreateManagedNetworkByName(prisma, netName, {
        scope: 'host', environmentId: null, stackId: null, purpose: netName,
      });
      await upsertNetworkMembership(prisma, { containerName: 'self', networkId: row.id, source: 'system' });
    });

    return result.connected && !result.alreadyConnected;
  } catch (err) {
    log.warn(
      { network: netName, error: err instanceof Error ? err.message : String(err) },
      'Failed to connect self to network',
    );
    return false;
  }
}
