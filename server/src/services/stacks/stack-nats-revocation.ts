import type { Logger } from "pino";
import type { PrismaClient } from "../../generated/prisma/client";
import DockerService from "../docker";
import { getNatsControlPlaneService } from "../nats/nats-control-plane-service";
import { getVaultKVService } from "../vault/vault-kv-service";

/**
 * Revoke a stack's scoped NATS signing keys end-to-end on destroy.
 *
 * Cascade-delete on `Stack` removes the `NatsSigningKey` rows on its own,
 * but two side effects need explicit handling first:
 *   1. The parent account's JWT still carries the rendered scope template
 *      until we re-issue it without the entry. `applyConfig()` rebuilds
 *      every account JWT from the live `NatsSigningKey` table, so deleting
 *      the rows up front and calling `applyConfig` is the simplest way to
 *      get the live update pushed via `$SYS.REQ.CLAIMS.UPDATE`.
 *   2. The seed blobs in Vault KV at `shared/nats-signers/<stackId>-<name>`
 *      have no database FK; they have to be wiped manually.
 *
 * If the live push fails the running NATS server still trusts the now-
 * orphan public keys until the container restarts — a leaked seed would
 * still authenticate. To close that gap deterministically we recycle the
 * vault-nats NATS container as a fallback. The next start reads the
 * freshly-rebuilt `shared/nats-accounts-index` from Vault KV and seeds
 * `/data/accounts/`, so the live server comes back without the revoked
 * signers.
 *
 * Best-effort throughout — failures here must not block the destroy itself.
 */
export async function revokeStackNatsSigningKeys(
  prisma: PrismaClient,
  stackId: string,
  log: Logger,
): Promise<void> {
  let signingKeys: Array<{ id: string; seedKvPath: string }>;
  try {
    signingKeys = await prisma.natsSigningKey.findMany({
      where: { stackId },
      select: { id: true, seedKvPath: true },
    });
  } catch (err) {
    log.warn({ err }, "Failed to enumerate stack NATS signing keys for revocation; skipping");
    return;
  }
  if (signingKeys.length === 0) return;

  try {
    await prisma.natsSigningKey.deleteMany({ where: { stackId } });
  } catch (err) {
    log.warn({ err }, "Failed to delete NatsSigningKey rows for stack; cascade will eventually clean them up");
    return;
  }

  let unpropagated: string[];
  try {
    const result = await getNatsControlPlaneService(prisma).applyConfig();
    unpropagated = result.unpropagatedAccountPublicKeys;
  } catch (err) {
    log.warn(
      { err },
      "NATS account claim re-push during stack destroy failed; will recycle the NATS container to apply revocation",
    );
    unpropagated = ["<all>"];
  }

  if (unpropagated.length > 0) {
    log.warn(
      { unpropagatedCount: unpropagated.length },
      "Recycling vault-nats NATS container to complete signer revocation",
    );
    try {
      await recycleManagedNatsContainer(prisma, log);
    } catch (err) {
      log.error(
        { err, stackId, signerCount: signingKeys.length },
        "CRITICAL: scoped signer revocation did not propagate to the running NATS server. Manually restart the vault-nats NATS container to invalidate any leaked seeds.",
      );
    }
  }

  const kv = getVaultKVService();
  for (const sk of signingKeys) {
    try {
      await kv.delete(sk.seedKvPath, { permanent: true });
    } catch (err) {
      log.warn(
        { err, path: sk.seedKvPath },
        "Best-effort Vault KV delete of signer seed during stack destroy failed",
      );
    }
  }
}

/**
 * Restart the host vault-nats NATS service container. Identifies it via
 * the `mini-infra.stack-id` label on the stack recorded in NatsState plus
 * `mini-infra.service=nats`. No-op if NatsState has no stackId yet (the
 * vault-nats stack hasn't applied) or no matching container is running.
 */
async function recycleManagedNatsContainer(
  prisma: PrismaClient,
  log: Logger,
): Promise<void> {
  const state = await prisma.natsState.findUnique({ where: { kind: "primary" } });
  if (!state?.stackId) {
    log.warn("NatsState has no stackId; cannot identify the vault-nats NATS container to recycle");
    return;
  }
  const docker = await DockerService.getInstance().getDockerInstance();
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`mini-infra.stack-id=${state.stackId}`, `mini-infra.service=nats`] },
  });
  if (containers.length === 0) {
    log.warn({ vaultNatsStackId: state.stackId }, "No NATS container found to recycle");
    return;
  }
  for (const c of containers) {
    // dockerode's restart performs a graceful stop+start; we use a 10s
    // stop timeout matching the rest of the reconciler. The container
    // entrypoint reads $NATS_ACCOUNTS_INDEX from Vault KV on startup, so
    // the freshly-rendered claims (which exclude the just-deleted scoped
    // signers) take effect on this restart.
    await docker.getContainer(c.Id).restart({ t: 10 });
    log.info({ containerId: c.Id }, "Recycled vault-nats NATS container to complete signer revocation");
  }
}
