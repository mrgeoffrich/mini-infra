import type { PrismaClient } from "../../generated/prisma/client";
import type { StackContainerConfig } from "@mini-infra/types";
import { getNatsControlPlaneService } from "./nats-control-plane-service";
import { getVaultKVService } from "../vault/vault-kv-service";

export interface NatsInjectorContext {
  /** Stack the calling service belongs to. Required only for `nats-signer-seed`
   *  resolution (looks up the per-stack signing-key seed in Vault KV). */
  stackId?: string;
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
        // Look up the stack-scoped signing key by name. The DB row owns the
        // mapping; the seed lives in Vault KV at the path the row records.
        // No fallback path lookup — if the row doesn't exist the apply phase
        // hasn't materialized the signer yet and the service should fail
        // closed rather than silently start without its credential.
        const row = await this.prisma.natsSigningKey.findUnique({
          where: { stackId_name: { stackId: ctx.stackId!, name: src.signer } },
          select: { seedKvPath: true, name: true },
        });
        if (!row) {
          throw new Error(
            `Service declares nats-signer-seed for signer '${src.signer}' but no NatsSigningKey row exists for stackId=${ctx.stackId} — has the apply phase materialized signers yet?`,
          );
        }
        const blob = await getVaultKVService().read(row.seedKvPath);
        const seed = blob && typeof blob.seed === "string" ? blob.seed : null;
        if (!seed) {
          throw new Error(
            `Vault KV at ${row.seedKvPath} does not contain a 'seed' field for signer '${src.signer}'`,
          );
        }
        values[key] = seed;
      }
    }

    return Object.keys(values).length > 0 ? values : null;
  }
}
