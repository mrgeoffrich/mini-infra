import type { PrismaClient } from '../../generated/prisma/client';
import type { Logger } from 'pino';
import type { StackResourceOutput } from '@mini-infra/types';
import type { DockerExecutorService } from '../docker-executor';
import { createNetworkManager } from '../networks';

/**
 * Connect the mini-infra container itself to a Docker network by name.
 *
 * Idempotent via `NetworkManager.connect()` — already-attached (whether
 * detected by inspection or by Docker's own 403/409 on the connect call) is
 * treated as success and reported as "no change" (returns false). Returns
 * true only when a fresh attachment was made.
 */
export async function connectSelfToNetwork(
  dockerExecutor: DockerExecutorService,
  selfId: string,
  netName: string,
  log: Logger,
): Promise<boolean> {
  try {
    const networkManager = createNetworkManager(dockerExecutor);
    const result = await networkManager.connect(selfId, netName);
    return result.connected && !result.alreadyConnected;
  } catch (err) {
    log.warn(
      { network: netName, error: err instanceof Error ? err.message : String(err) },
      'Failed to connect self to network',
    );
    return false;
  }
}

/**
 * Re-attach the mini-infra container to every managed infra network it is meant
 * to be on — i.e. every `docker-network` InfraResource whose owning stack
 * declared `joinSelf: true` for that purpose (vault, nats, dataplane, database,
 * and each environment's egress network).
 *
 * These attachments are normally made during stack apply
 * (`StackInfraResourceManager.joinSelfToOutputNetworks`). A container recreate
 * (e.g. a `docker compose up -d` redeploy) wipes them, and the host stacks are
 * already `synced` so they never re-apply — leaving the server unable to reach
 * Vault/NATS/managed DBs. Running this on boot restores those attachments.
 *
 * Best-effort and idempotent: never throws; per-network failures are logged and
 * skipped so one bad network can't block the rest (or boot).
 */
export async function reattachSelfToManagedNetworks(
  dockerExecutor: DockerExecutorService,
  prisma: PrismaClient,
  log: Logger,
): Promise<void> {
  const { getOwnContainerId } = await import('../self-update');
  const selfId = getOwnContainerId();
  if (!selfId) {
    log.debug('Not running in Docker, skipping managed-network re-attach');
    return;
  }

  const resources = await prisma.infraResource.findMany({
    where: { type: 'docker-network' },
    select: {
      name: true,
      purpose: true,
      stack: { select: { resourceOutputs: true } },
    },
  });

  let joined = 0;
  for (const r of resources) {
    const outputs = (r.stack?.resourceOutputs as StackResourceOutput[] | null) ?? [];
    const match = outputs.find(o => o.type === 'docker-network' && o.purpose === r.purpose);
    if (!match?.joinSelf) continue;

    if (await connectSelfToNetwork(dockerExecutor, selfId, r.name, log)) {
      joined++;
      log.info({ network: r.name, purpose: r.purpose }, 'Re-attached mini-infra to managed network on boot');
    }
  }

  if (joined > 0) {
    log.info({ count: joined }, 'Re-attached mini-infra to managed infra networks on boot');
  }
}
