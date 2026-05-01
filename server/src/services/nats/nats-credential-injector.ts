import type { PrismaClient } from "../../generated/prisma/client";
import type { StackContainerConfig } from "@mini-infra/types";
import { getNatsControlPlaneService } from "./nats-control-plane-service";
import { getVaultKVService } from "../vault/vault-kv-service";

export interface NatsInjectorContext {
  /** Stack the calling service belongs to. Required only for `nats-signer-seed`
   *  resolution (looks up the per-stack signing-key seed in Vault KV). */
  stackId?: string;
}

/**
 * Process-wide cache of resolved signer seeds. Container start is on the
 * hot path; without a cache, every spawn does a DB roundtrip + Vault KV
 * read for every `nats-signer-seed` env var. The cache key is the row's
 * `publicKey` — when the orchestrator rotates a seed it generates a new
 * keypair, so the cache key changes and the old entry naturally drops out
 * (and is evicted on next read of the same `(stackId, name)`).
 */
const SIGNER_CACHE_TTL_MS = 60_000;
type SignerCacheEntry = { publicKey: string; seed: string; expiresAt: number };
const signerSeedCache = new Map<string, SignerCacheEntry>();

/** Exposed for tests; production code never needs to call this. */
export function __clearNatsSignerCacheForTests(): void {
  signerSeedCache.clear();
}

export class NatsCredentialInjector {
  constructor(private readonly prisma: PrismaClient) {}

  async resolve(
    credentialId: string | null,
    containerConfig: StackContainerConfig,
    ctx: NatsInjectorContext = {},
  ): Promise<Record<string, string> | null> {
    const dynamicEnv = containerConfig.dynamicEnv;
    if (!dynamicEnv) return null;

    const hasNatsCreds = Object.values(dynamicEnv).some((src) => src.kind === "nats-creds");
    if (hasNatsCreds && !credentialId) {
      throw new Error("Service declares nats-creds but no NATS credential profile is bound");
    }

    const hasSigner = Object.values(dynamicEnv).some((src) => src.kind === "nats-signer-seed");
    if (hasSigner && !ctx.stackId) {
      throw new Error("Service declares nats-signer-seed but no stackId was provided to the injector");
    }

    const service = getNatsControlPlaneService(this.prisma);
    const values: Record<string, string> = {};
    let mintedCreds: string | null = null;

    for (const [key, src] of Object.entries(dynamicEnv)) {
      if (src.kind === "nats-url") {
        values[key] = await service.getInternalUrl();
      }
      if (src.kind === "nats-creds") {
        if (!credentialId) continue;
        if (!mintedCreds) {
          const profile = await this.prisma.natsCredentialProfile.findUniqueOrThrow({
            where: { id: credentialId },
            include: { account: true },
          });
          mintedCreds = await service.mintCredentials(profile);
        }
        values[key] = mintedCreds;
      }
      if (src.kind === "nats-signer-seed") {
        values[key] = await this.resolveSignerSeed(ctx.stackId!, src.signer);
      }
    }

    return Object.keys(values).length > 0 ? values : null;
  }

  /**
   * Resolve a signer seed with a short-lived cache to keep container start
   * off the DB+Vault hot path. If a row was rotated (publicKey changed) the
   * cached entry no longer matches and a fresh read repopulates the cache.
   */
  private async resolveSignerSeed(stackId: string, signer: string): Promise<string> {
    const cacheKey = `${stackId}/${signer}`;
    const now = Date.now();
    const cached = signerSeedCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.seed;
    }

    // The DB row owns the (stackId, signer) → publicKey/seedKvPath mapping.
    // No fallback path lookup — if the row doesn't exist the apply phase
    // hasn't materialized the signer yet and the service should fail closed
    // rather than silently start without its credential.
    const row = await this.prisma.natsSigningKey.findUnique({
      where: { stackId_name: { stackId, name: signer } },
      select: { seedKvPath: true, publicKey: true },
    });
    if (!row) {
      throw new Error(
        `Service declares nats-signer-seed for signer '${signer}' but no NatsSigningKey row exists for stackId=${stackId} — has the apply phase materialized signers yet?`,
      );
    }

    // If the cached entry is stale-by-rotation (different publicKey), drop
    // it before reading; otherwise we'd pre-populate with the wrong seed.
    if (cached && cached.publicKey !== row.publicKey) {
      signerSeedCache.delete(cacheKey);
    }

    const blob = await getVaultKVService().read(row.seedKvPath);
    const seed = blob && typeof blob.seed === "string" ? blob.seed : null;
    if (!seed) {
      throw new Error(
        `Vault KV at ${row.seedKvPath} does not contain a 'seed' field for signer '${signer}'`,
      );
    }
    signerSeedCache.set(cacheKey, {
      publicKey: row.publicKey,
      seed,
      expiresAt: now + SIGNER_CACHE_TTL_MS,
    });
    return seed;
  }
}
