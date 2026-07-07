import type { PrismaClient } from "../../generated/prisma/client";
import type { StackContainerConfig } from "@mini-infra/types";
import { InternalError } from "../../lib/errors";
import { getNatsControlPlaneService } from "./nats-control-plane-service";
import { getVaultKVService } from "../vault/vault-kv-service";
import {
  natsCredsFileName,
  natsCredsFilePath,
  type NatsCredsFileSpec,
} from "./nats-creds-volume";

export interface NatsInjectorContext {
  /** Stack the calling service belongs to. Required for `nats-signer-seed` /
   *  `nats-account-public` resolution (looks up the per-stack signing-key seed
   *  in Vault KV) and for `nats-creds` (names the per-stack creds file). */
  stackId?: string;
}

/**
 * Result of resolving a service's `dynamicEnv`.
 *
 * `values` are plain env-var overrides merged onto the container's env at
 * create time. `credsFiles` are minted `.creds` blobs the **create path** must
 * persist into the stack's `nats_creds` docker volume (Phase 5, §4.3) — the
 * injector itself performs no Docker side effects, so the same `resolve()` is
 * safe to call from the apply-time dry-run without writing anything. For a
 * `nats-creds` entry the secret is delivered via `credsFiles` (file on a
 * mounted volume) and `values` carries only the file **path**
 * (`NATS_CREDS_FILE`), never the secret itself.
 */
export interface NatsInjectorResult {
  values: Record<string, string>;
  credsFiles: NatsCredsFileSpec[];
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

// Mirrors the seed cache. Account public keys are stable for the life of an
// account (only an orphan-cleanup-driven account regeneration would change
// them), so the TTL is the dominant invalidator. Keyed the same way as the
// seed cache so a service declaring both kinds for one signer hits both
// caches predictably.
type AccountPublicCacheEntry = { signerPublicKey: string; accountPublicKey: string; expiresAt: number };
const signerAccountPublicCache = new Map<string, AccountPublicCacheEntry>();

/** Exposed for tests; production code never needs to call this. */
export function __clearNatsSignerCacheForTests(): void {
  signerSeedCache.clear();
  signerAccountPublicCache.clear();
}

export class NatsCredentialInjector {
  constructor(private readonly prisma: PrismaClient) {}

  async resolve(
    credentialId: string | null,
    containerConfig: StackContainerConfig,
    ctx: NatsInjectorContext = {},
  ): Promise<NatsInjectorResult | null> {
    const dynamicEnv = containerConfig.dynamicEnv;
    if (!dynamicEnv) return null;

    // Both `nats-creds` (env-blob delivery) and `nats-creds-file` (file
    // delivery, Phase 5) mint a credential and so require a bound profile.
    const hasNatsCreds = Object.values(dynamicEnv).some(
      (src) => src.kind === "nats-creds" || src.kind === "nats-creds-file",
    );
    // Every guard below is a template/apply-pipeline contract violation: the
    // stack-template layer is responsible for validating that a service
    // declaring one of these dynamicEnv kinds has the matching binding
    // (credential profile / stackId) before the injector ever runs. Reaching
    // here without it means an earlier validation step was skipped — a
    // genuine internal invariant, not something the caller can fix by
    // retrying the same request.
    if (hasNatsCreds && !credentialId) {
      throw new InternalError("Service declares nats-creds but no NATS credential profile is bound");
    }
    // Only the file variant needs the stackId — it names the per-stack creds
    // file (`<stackId>.creds`). Plain `nats-creds` keeps working with no stackId
    // (generic app roles, JobPool runners) so its contract is unchanged.
    const hasNatsCredsFile = Object.values(dynamicEnv).some((src) => src.kind === "nats-creds-file");
    if (hasNatsCredsFile && !ctx.stackId) {
      throw new InternalError("Service declares nats-creds-file but no stackId was provided to the injector");
    }

    const hasSigner = Object.values(dynamicEnv).some((src) => src.kind === "nats-signer-seed");
    if (hasSigner && !ctx.stackId) {
      throw new InternalError("Service declares nats-signer-seed but no stackId was provided to the injector");
    }

    const hasAccountPublic = Object.values(dynamicEnv).some((src) => src.kind === "nats-account-public");
    if (hasAccountPublic && !ctx.stackId) {
      throw new InternalError("Service declares nats-account-public but no stackId was provided to the injector");
    }

    const service = getNatsControlPlaneService(this.prisma);
    const values: Record<string, string> = {};
    const credsFiles: NatsCredsFileSpec[] = [];
    let mintedCreds: string | null = null;

    // Resolve `nats-url` differently for host-mode containers. The default
    // `clientUrl` is a docker-internal DNS name (e.g.
    // `mini-infra-nats-nats:4222`) that doesn't resolve from the host
    // network namespace; a `network_mode: host` service (the egress-fw-agent
    // in ALT-27) needs the host-loopback form (`nats://127.0.0.1:<host-port>`).
    // The host port comes from `NatsState.clientHostUrl`, populated by the
    // nats template's post-install action.
    const isHostMode = containerConfig.networkMode === "host";

    for (const [key, src] of Object.entries(dynamicEnv)) {
      if (src.kind === "nats-url") {
        values[key] = isHostMode ? await service.getHostUrl() : await service.getInternalUrl();
      }
      if (src.kind === "nats-creds" || src.kind === "nats-creds-file") {
        if (!credentialId) continue;
        if (!mintedCreds) {
          const profile = await this.prisma.natsCredentialProfile.findUniqueOrThrow({
            where: { id: credentialId },
            include: { account: true },
          });
          mintedCreds = await service.mintCredentials(profile);
        }
        if (src.kind === "nats-creds") {
          // Legacy env-blob delivery: the `.creds` body rides in the env var,
          // loaded once by the app at connect. Unchanged from before Phase 5 —
          // generic NATS consumers (app roles, JobPool runners) rely on this.
          values[key] = mintedCreds;
        } else {
          // Phase 5, §4.3 file delivery: write the secret to a per-stack file
          // on a mounted volume and expose only its path via the env. nats.go
          // re-reads the file on every reconnect, so a rotated credential is
          // picked up without a container recreate. Queue the file once per
          // stack (mint is cached) so multiple nats-creds-file env keys on one
          // service share the single `<stackId>.creds` file.
          if (!credsFiles.some((f) => f.fileName === natsCredsFileName(ctx.stackId!))) {
            credsFiles.push({ fileName: natsCredsFileName(ctx.stackId!), contents: mintedCreds });
          }
          values[key] = natsCredsFilePath(ctx.stackId!);
        }
      }
      if (src.kind === "nats-signer-seed") {
        values[key] = await this.resolveSignerSeed(ctx.stackId!, src.signer);
      }
      if (src.kind === "nats-account-public") {
        values[key] = await this.resolveSignerAccountPublic(ctx.stackId!, src.signer);
      }
    }

    if (Object.keys(values).length === 0 && credsFiles.length === 0) return null;
    return { values, credsFiles };
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
      throw new InternalError(
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
      throw new InternalError(
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

  /**
   * Resolve the public key of the NATS account that owns the named signer.
   * Required as the `issuer_account` claim by `nats-jwt`'s `encodeUser`
   * whenever a scoped signing key signs a user JWT — without it the server
   * rejects the JWT with "issuer_account required" / similar.
   *
   * Caching matches `resolveSignerSeed`: the (stackId, signer) → SigningKey
   * row mapping is stable across rotations, and an account regeneration
   * (which would change the publicKey) is rare enough that TTL eviction is
   * sufficient. Stored under a parallel cache so a service declaring both
   * `nats-signer-seed` and `nats-account-public` hits independently.
   */
  private async resolveSignerAccountPublic(stackId: string, signer: string): Promise<string> {
    const cacheKey = `${stackId}/${signer}`;
    const now = Date.now();
    const cached = signerAccountPublicCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.accountPublicKey;
    }

    const row = await this.prisma.natsSigningKey.findUnique({
      where: { stackId_name: { stackId, name: signer } },
      select: {
        publicKey: true,
        account: { select: { publicKey: true } },
      },
    });
    if (!row) {
      throw new InternalError(
        `Service declares nats-account-public for signer '${signer}' but no NatsSigningKey row exists for stackId=${stackId} — has the apply phase materialized signers yet?`,
      );
    }
    if (!row.account.publicKey) {
      throw new InternalError(
        `NatsSigningKey for signer '${signer}' (stackId=${stackId}) is bound to an account with no publicKey set — has the account been applied?`,
      );
    }

    if (cached && cached.signerPublicKey !== row.publicKey) {
      signerAccountPublicCache.delete(cacheKey);
    }

    signerAccountPublicCache.set(cacheKey, {
      signerPublicKey: row.publicKey,
      accountPublicKey: row.account.publicKey,
      expiresAt: now + SIGNER_CACHE_TTL_MS,
    });
    return row.account.publicKey;
  }
}
